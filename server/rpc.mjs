import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { sourceFileByteLimit } from '../shared/source-limits.mjs'

export class AgentRpc extends EventEmitter {
  constructor(child) {
    super()
    this.child = child
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.emit('log', line)
        return
      }
      if ('id' in message && !message.method) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error)
          pending.reject(
            Object.assign(
              new Error(message.error.message || JSON.stringify(message.error)),
              { code: message.error.code, data: message.error.data },
            ),
          )
        else pending.resolve(message.result)
      } else if (message.method && 'id' in message) {
        this.emit('request', message)
      } else if (message.method) this.emit('notification', message)
    })
    const fail = (error) => {
      if (this.closed) return
      this.closed = true
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
      this.emit('closed', error)
    }
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
