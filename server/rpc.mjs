import { EventEmitter } from 'node:events'
import { sourceFileByteLimit } from '../shared/source-limits.mjs'

export class AgentRpc extends EventEmitter {
  constructor(child, { maxMessageBytes = 64 * 1024 * 1024 } = {}) {
    super()
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1)
      throw new Error('Lemex message limit must be a positive integer.')
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    let buffered = Buffer.alloc(0),
      bytes = 0
    const fail = (error) => {
      if (this.closed) return
      this.closed = true
      buffered = Buffer.alloc(0)
      bytes = 0
      child.stdout.off('data', receive)
      child.stdout.off('end', end)
      child.stdout.resume()
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
      this.emit('closed', error)
    }
    const invalid = (message) => {
      fail(new Error(message))
      child.kill('SIGTERM')
    }
    const dispatch = (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.emit('log', line)
        return
      }
      if (!message || typeof message !== 'object' || Array.isArray(message))
        throw new Error('Expected a Lemex message object.')
      if (
        (message.method !== undefined &&
          (typeof message.method !== 'string' || !message.method)) ||
        ('id' in message &&
          typeof message.id !== 'string' &&
          !Number.isSafeInteger(message.id))
      )
        throw new Error('Invalid Lemex message envelope.')
      if ('id' in message && !message.method) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error)
          pending.reject(
            Object.assign(
              new Error(
                typeof message.error.message === 'string'
                  ? message.error.message
                  : 'Lemex could not complete this request.',
              ),
              { code: message.error.code, data: message.error.data },
            ),
          )
        else pending.resolve(message.result)
      } else if (message.method && 'id' in message) {
        this.emit('request', message)
      } else if (message.method) this.emit('notification', message)
    }
    const line = () => {
      const content = buffered.toString('utf8', 0, bytes)
      buffered = Buffer.alloc(0)
      bytes = 0
      try {
        dispatch(content.endsWith('\r') ? content.slice(0, -1) : content)
      } catch {
        // Worker output and its event payloads are untrusted. A malformed
        // packet must fail only its assistant session, never the shared server.
        invalid('Lemex returned an invalid message. Start this run again.')
      }
    }
    const receive = (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
      let start = 0
      while (!this.closed && start < buffer.length) {
        const newline = buffer.indexOf(10, start)
        const stop = newline < 0 ? buffer.length : newline
        if (bytes + stop - start > maxMessageBytes) {
          invalid(
            'Lemex returned too much data in one message. Reduce the task or file size and try again.',
          )
          return
        }
        if (stop > start) {
          const size = bytes + stop - start
          if (buffered.length < size) {
            const grown = Buffer.allocUnsafe(
              Math.min(
                maxMessageBytes,
                Math.max(4096, size, buffered.length * 2),
              ),
            )
            buffered.copy(grown, 0, 0, bytes)
            buffered = grown
          }
          buffer.copy(buffered, bytes, start, stop)
          bytes = size
        }
        if (newline < 0) return
        line()
        start = newline + 1
      }
    }
    const end = () => {
      if (!this.closed && bytes) line()
    }
    child.stdout.on('data', receive)
    child.stdout.on('end', end)
    child.stdout.on('error', fail)
    child.on('error', fail)
    child.on('close', (code) =>
      fail(new Error(`Lemex process exited (${code}).`)),
    )
    child.stdin.on('error', (error) => fail(error))
  }
  send(message) {
    if (this.closed || this.child.stdin.destroyed)
      throw new Error('Lemex connection is closed.')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  notify(method, params) {
    this.send({ method, ...(params === undefined ? {} : { params }) })
  }
  respond(id, result) {
    this.send({ id, result })
  }
  call(method, params = {}, timeoutMs = 90_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Lemex timed out during ${method}.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  close() {
    this.child.kill('SIGTERM')
  }
}

function lspMessageObject(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message))
    throw new Error('Lean messages must be JSON objects.')
  return message
}

export class LspFrames {
  constructor(onMessage, maxBytes = 64 * 1024 * 1024) {
    this.buffer = Buffer.alloc(0)
    this.onMessage = onMessage
    this.maxBytes = maxBytes
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > this.maxBytes + 8192)
      throw new Error('Lean message exceeded the transport limit.')
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (this.buffer.length > 8192)
          throw new Error('Invalid Lean message header.')
        return
      }
      const size = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(
        this.buffer.subarray(0, end).toString('ascii'),
      )
      if (!size || Number(size[1]) > this.maxBytes)
        throw new Error('Invalid Lean message length.')
      const length = Number(size[1])
      if (this.buffer.length < end + 4 + length) return
      const body = this.buffer.subarray(end + 4, end + 4 + length)
      this.buffer = this.buffer.subarray(end + 4 + length)
      this.onMessage(lspMessageObject(JSON.parse(body.toString('utf8'))))
    }
  }
}

export function frame(message) {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

export function validateClientUris(message) {
  lspMessageObject(message)
  // The JSON envelope may be larger than the source because of escaping. Keep
  // decoded didOpen/didChange text bounded before passing it to the Lean worker.
  const texts =
    message?.method === 'textDocument/didOpen'
      ? [message.params?.textDocument?.text]
      : message?.method === 'textDocument/didChange' &&
          Array.isArray(message.params?.contentChanges)
        ? message.params.contentChanges.map((change) => change?.text)
        : []
  const uri = message?.params?.textDocument?.uri
  const filename =
    typeof uri === 'string' && uri.startsWith('file:')
      ? decodeURIComponent(new URL(uri).pathname)
      : ''
  const byteLimit = sourceFileByteLimit(filename)
  let sourceBytes = 0
  for (const text of texts) {
    if (typeof text !== 'string') continue
    sourceBytes += Buffer.byteLength(text)
    if (sourceBytes > byteLimit)
      throw Object.assign(
        new Error(
          `Lean source files must be at most ${byteLimit / (1024 * 1024)} MiB. Reduce the file or split Lean sources into smaller modules.`,
        ),
        { sourceTooLarge: true },
      )
  }

  const privateNames = new Set([
    '.git',
    '.lemex',
    '.codex',
    '.ssh',
    '.aws',
    '.azure',
    '.config',
    '.netrc',
    '.npmrc',
    '.pypirc',
    'credentials',
    'credentials.json',
    'auth.json',
    'settings.local.json',
  ])
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === 'uri' || key.endsWith('Uri')) &&
        typeof item === 'string' &&
        item.startsWith('file:')
      ) {
        const parsed = new URL(item)
        const pathname = decodeURIComponent(parsed.pathname)
        if (
          parsed.hostname ||
          (!pathname.startsWith('/workspace/') && pathname !== '/workspace')
        )
          throw new Error('Lean files must be inside this workspace.')
        if (
          pathname.includes('\0') ||
          pathname
            .split('/')
            .some(
              (part) =>
                part === '..' ||
                privateNames.has(part.toLowerCase()) ||
                part.toLowerCase() === '.env' ||
                part.toLowerCase().startsWith('.env.') ||
                /\.(?:pem|key|p12|pfx)$/i.test(part),
            )
        )
          throw new Error('This Lean file path is not allowed.')
      } else if (
        key === 'rootPath' &&
        item !== null &&
        typeof item === 'string' &&
        item !== '/workspace' &&
        item !== '/workspace/'
      )
        throw new Error('Invalid Lean workspace root.')
      walk(item)
    }
  }
  walk(message)
  return message
}
