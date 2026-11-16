import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LspFrames, frame, validateClientUris } from '../rpc.mjs'
import {
  sourceFileByteLimit,
  MAX_SOURCE_JSON_BYTES,
} from '../../shared/source-limits.mjs'
import { clusterError, sha256 } from './state.mjs'
import {
  EDITOR_CHUNK_BYTES,
  editorChunk,
  writeEditorBytes,
} from './editor-stream.mjs'

// The initial serving class has exactly one editable Lean module. Repository
// editors need a separate import/build synchronization contract before admission.
export function editorSource(manifest) {
  return (
    manifest.kind === 'source' &&
    manifest.totalBytes <= 16 * 1024 ** 2 &&
    manifest.entries.length <= 100 &&
    manifest.entries.every(
      (entry) =>
        entry.type !== 'symlink' &&
        (!entry.path.endsWith('.lean') ||
          ['Main.lean', 'lakefile.lean'].includes(entry.path)),
    ) &&
    manifest.entries.some(
      (entry) => entry.path === 'Main.lean' && entry.type === 'file',
    )
  )
}

export class WorkerEditor {
  constructor({ id, peer, abort }) {
    Object.assign(this, { id, peer, abort })
    this.inputSequence = 0
    this.revision = 0
    this.inputQueue = Promise.resolve()
    this.syncQueue = Promise.resolve()
    this.closed = false
    this.frames = new LspFrames((message) => {
      validateClientUris(message)
      // Definition navigation opens read-only dependency and configuration
      // buffers too. The same URI policy as the VM applies to all LSP traffic;
      // only the canonical disk-mirroring API is restricted to Main.lean.
      this.messages.push(frame(message))
    }, MAX_SOURCE_JSON_BYTES)
  }

  input(value) {
    const data = editorChunk(value?.data)
    if (
      !this.child ||
      this.closed ||
      this.ending ||
      this.abort.signal.aborted ||
      value?.sequence !== this.inputSequence + 1
    )
      throw clusterError('Stale editor input.', 'editor_protocol', 409)
    this.inputSequence++
    const task = this.inputQueue.then(async () => {
      this.abort.signal.throwIfAborted()
      if (this.closed)
        throw clusterError('Editor stopped.', 'editor_closed', 409)
      this.messages = []
      this.frames.push(data)
      for (const message of this.messages)
        await writeEditorBytes(this.child.stdin, message)
      this.messages = []
      return { sequence: value.sequence }
    })
    this.inputQueue = task.catch((error) => this.abort.abort(error))
    return task
  }

  end(value) {
    if (!this.child || value?.sequence !== this.inputSequence)
      throw clusterError('Invalid editor EOF.', 'editor_protocol', 409)
    if (!this.endPromise) {
      this.ending = true
      this.endPromise = this.inputQueue.then(async () => {
        if (!this.closed && !this.child.stdin.destroyed)
          await new Promise((resolve, reject) =>
            this.child.stdin.end((error) =>
              error && error.code !== 'EPIPE' ? reject(error) : resolve(),
            ),
          )
        return { sequence: this.inputSequence }
      })
      this.endPromise.catch((error) => this.abort.abort(error))
    }
    return this.endPromise
  }

  sync(value) {
    if (
      !Number.isSafeInteger(value?.revision) ||
      value.revision !== this.revision + 1 ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      value.size > sourceFileByteLimit('Main.lean') ||
      !/^[a-f0-9]{64}$/.test(value.hash) ||
      !this.workspace ||
      !this.child ||
      this.closed ||
      this.ending ||
      this.abort.signal.aborted
    )
      throw clusterError(
        'Invalid editor source revision.',
        'editor_protocol',
        409,
      )
    const bytes =
      value.size === 0 && value.data === ''
        ? Buffer.alloc(0)
        : editorChunk(value.data)
    this.pendingSync ||= {
      revision: value.revision,
      hash: value.hash,
      size: value.size,
      bytes: 0,
      chunks: [],
    }
    const pending = this.pendingSync
    if (
      pending.revision !== value.revision ||
      pending.hash !== value.hash ||
      pending.size !== value.size ||
      value.offset !== pending.bytes ||
      pending.bytes + bytes.length > pending.size
    )
      throw clusterError(
        'Out-of-order editor source chunk.',
        'editor_protocol',
        409,
      )
    pending.bytes += bytes.length
    pending.chunks.push(bytes)
    if (pending.bytes < pending.size) return { offset: pending.bytes }
    this.pendingSync = null
    this.revision++
    const content = Buffer.concat(pending.chunks, pending.size)
    if (sha256(content) !== value.hash)
      throw clusterError('Editor source hash changed.', 'editor_protocol', 409)
    const task = this.syncQueue.then(async () => {
      this.abort.signal.throwIfAborted()
      if (this.closed)
        throw clusterError('Editor stopped.', 'editor_closed', 409)
      const filename = path.join(this.workspace, 'Main.lean')
      const current = await fs.lstat(filename)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1)
        throw clusterError(
          'The disposable source changed unexpectedly.',
          'editor_protocol',
          409,
        )
      const temporary = path.join(
        this.workspace,
        '.editor-save-' + randomUUID(),
      )
      try {
        await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
        this.abort.signal.throwIfAborted()
        if (this.closed)
          throw clusterError('Editor stopped.', 'editor_closed', 409)
        await fs.rename(temporary, filename)
      } finally {
        await fs.rm(temporary, { force: true })
      }
      return { revision: value.revision, hash: value.hash, offset: value.size }
    })
    this.syncQueue = task.catch((error) => this.abort.abort(error))
    return task
  }

  async run(runtime, workspace, options) {
    this.workspace = workspace
    const child = runtime.spawn(workspace, ['lake', 'serve', '--'], {
      ...options,
      workload: 'interactive',
      editor: true,
    })
    this.child = child
    options.onSpawn?.(child)
    child.stdin.on('error', (error) => {
      if (!(this.ending && error.code === 'EPIPE')) this.abort.abort(error)
    })
    const closed = new Promise((resolve, reject) => {
      child.once('close', (code) => {
        this.closed = true
        this.pendingSync = null
        resolve(code)
      })
      child.once('error', reject)
    })
    closed.catch(() => {})
    const output = async (stream) => {
      let sequence = 0
      for await (const bytes of child[stream]) {
        for (
          let offset = 0;
          offset < bytes.length;
          offset += EDITOR_CHUNK_BYTES
        ) {
          const current = ++sequence
          const reply = await this.peer.request('editor.output', {
            id: this.id,
            stream,
            sequence: current,
            data: bytes
              .subarray(offset, offset + EDITOR_CHUNK_BYTES)
              .toString('base64'),
          })
          if (reply?.sequence !== current)
            throw clusterError(
              'Invalid editor acknowledgement.',
              'editor_protocol',
              409,
            )
        }
      }
    }
    const forwarding = Promise.all([output('stdout'), output('stderr')])
    forwarding.catch((error) => this.abort.abort(error))
    try {
      await this.peer.request('editor.ready', { id: this.id })
      const code = await closed
      await forwarding
      await Promise.all([this.inputQueue, this.syncQueue, this.endPromise])
      await child.workerStopped
      return {
        code: code ?? 1,
        stdout: '',
        stderr: '',
        timedOut: !!child.timedOut,
        cancelled: this.abort.signal.aborted,
      }
    } finally {
      this.closed = true
      child.kill()
      await child.cleanupWorker()
      await Promise.allSettled([
        forwarding,
        this.inputQueue,
        this.syncQueue,
        this.endPromise,
      ])
    }
  }
}
