import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { clusterError } from './state.mjs'

export const EDITOR_CHUNK_BYTES = 64 * 1024
export const EDITOR_BUFFER_BYTES = 16 * 1024 * 1024

export function editorChunk(value) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(EDITOR_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw clusterError('Invalid editor stream chunk.', 'editor_protocol', 400)
  const bytes = Buffer.from(value, 'base64')
  if (
    !bytes.length ||
    bytes.length > EDITOR_CHUNK_BYTES ||
    bytes.toString('base64') !== value
  )
    throw clusterError('Invalid editor stream chunk.', 'editor_protocol', 400)
  return bytes
}

export function writeEditorBytes(stream, bytes) {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : resolve()))
  })
}

// Child-process shaped adapter. The writable callback is the remote ACK: a
// stalled peer cannot make the browser's already bounded queue grow forever.
export class RemoteEditor extends EventEmitter {
  constructor({ rpc, id, cancel, sync }) {
    super()
    this.rpc = rpc
    this.id = id
    this.cancel = cancel
    this.sync = sync
    this.stdout = new PassThrough({ highWaterMark: EDITOR_CHUNK_BYTES })
    this.stderr = new PassThrough({ highWaterMark: EDITOR_CHUNK_BYTES })
    this.closed = false
    this.sequence = 0
    this.outputSequence = { stdout: 0, stderr: 0 }
    this.stdin = new Writable({
      highWaterMark: EDITOR_CHUNK_BYTES,
      write: (bytes, _encoding, callback) => {
        this.#input(bytes).then(() => callback(), callback)
      },
      final: (callback) => {
        rpc
          .request('editor.end', { id, sequence: this.sequence })
          .then((reply) => {
            if (reply?.sequence !== this.sequence)
              throw clusterError(
                'Invalid editor EOF acknowledgement.',
                'editor_protocol',
                409,
              )
          })
          .then(() => callback(), callback)
      },
    })
    // Consumers attach their handlers after asynchronous preparation starts.
    this.stdin.on('error', () => this.kill())
    rpc.handle('editor.output', async (value) => {
      if (
        this.closed ||
        value?.id !== id ||
        !['stdout', 'stderr'].includes(value.stream) ||
        value.sequence !== this.outputSequence[value.stream] + 1
      )
        throw clusterError('Stale editor output.', 'editor_protocol', 409)
      const bytes = editorChunk(value.data)
      this.outputSequence[value.stream]++
      await writeEditorBytes(this[value.stream], bytes)
      return { sequence: value.sequence }
    })
    rpc.once('close', () => this.kill())
  }

  async #input(bytes) {
    await this.beforeInput?.()
    for (let offset = 0; offset < bytes.length; offset += EDITOR_CHUNK_BYTES) {
      if (this.closed)
        throw clusterError('Editor connection closed.', 'editor_closed', 409)
      const sequence = ++this.sequence
      const reply = await this.rpc.request('editor.input', {
        id: this.id,
        sequence,
        data: bytes
          .subarray(offset, offset + EDITOR_CHUNK_BYTES)
          .toString('base64'),
      })
      if (reply?.sequence !== sequence)
        throw clusterError(
          'Invalid editor acknowledgement.',
          'editor_protocol',
          409,
        )
    }
  }

  syncMain(content, revision) {
    return this.sync(content, revision)
  }

  kill() {
    if (this.closed || this.stopping) return false
    this.stopping = true
    this.cancel()
    return true
  }

  finish(error) {
    if (this.closed) return
    this.closed = true
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    this.rpc.close()
    // Keep a failed cleanup visible through the controller's held grant.
    this.emit('close', error ? 1 : 0)
  }
}

// Accept and bound initialize/didOpen while a disposable snapshot is prepared.
// It also closes a late child when the browser disconnects during preparation.
export class DeferredEditor extends EventEmitter {
  constructor(start) {
    super()
    this.abort = new AbortController()
    this.stdout = new PassThrough({ highWaterMark: EDITOR_CHUNK_BYTES })
    this.stderr = new PassThrough({ highWaterMark: EDITOR_CHUNK_BYTES })
    this.closed = false
    this.child = null
    this.ready = Promise.resolve()
      .then(() => start(this.abort.signal))
      .then((child) => {
        this.child = child
        child.once('close', () => this.#finish())
        child.once('error', () => this.#finish())
        child.stdout.pipe(this.stdout)
        child.stderr.pipe(this.stderr)
        if (this.closed) child.kill()
        return child
      })
    this.ready.catch((error) => this.#finish(error))
    this.stdin = new Writable({
      highWaterMark: EDITOR_CHUNK_BYTES,
      write: (bytes, _encoding, callback) => {
        this.ready
          .then(async (child) => {
            if (this.closed) throw new Error('Editor closed.')
            await writeEditorBytes(child.stdin, bytes)
          })
          .then(() => callback(), callback)
      },
    })
    this.stdin.on('error', () => this.kill())
  }

  kill() {
    if (this.closed) return false
    this.closed = true
    this.abort.abort(
      clusterError('Editor connection closed.', 'editor_closed', 409),
    )
    this.child?.kill()
    this.#finish()
    return true
  }

  #finish(error) {
    if (this.finished) return
    this.finished = true
    this.closed = true
    this.startupError = error || null
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    this.emit('close', 0)
  }
}
