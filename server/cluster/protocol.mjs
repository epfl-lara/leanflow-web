import { constants } from 'node:buffer'
import { EventEmitter } from 'node:events'

// Version of the frame format below, for peers to compare in their
// application handshake. Frames themselves carry no version field.
export const PROTOCOL_VERSION = 1

// Each frame is a 4-byte unsigned big-endian length followed by that many
// bytes of UTF-8 JSON. A malformed frame closes the connection, because the
// bytes after it can no longer be trusted to start on a frame boundary.
const HEADER_BYTES = 4
// Error replies stay well under 1 KiB, so every allowed frame limit can
// carry one.
const MIN_FRAME_BYTES = 1024
const MAX_FRAME_BYTES = Math.min(0xffffffff, constants.MAX_LENGTH)
const MAX_TIMEOUT_MS = 0x7fffffff
const MAX_ERROR_MESSAGE = 200
const ID = /^[A-Za-z0-9_-]{1,64}$/
const LOCAL_ID = /^[1-9][0-9]{0,15}$/
const METHOD = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/
const CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const REQUEST_KEYS = new Set(['type', 'id', 'method', 'params'])
const RESPONSE_KEYS = new Set(['type', 'id', 'ok', 'result', 'error'])
const EVENT_KEYS = new Set(['type', 'method', 'params'])
const ERROR_KEYS = new Set(['message', 'code', 'status'])
const GENERIC_FAILURE = 'The remote operation failed.'
const INTERNAL_FAILURE = {
  message: GENERIC_FAILURE,
  code: 'internal_error',
  status: 500,
}
const UNKNOWN_METHOD = {
  message: 'The requested method is not available.',
  code: 'unknown_method',
  status: 404,
}
const BUSY = {
  message: 'Too many requests are running. Try again shortly.',
  code: 'busy',
  status: 503,
}
const noop = () => {}

// Local failures use the codes protocol_error, frame_too_large,
// connection_closed, connection_failed, listener_failed, queue_full,
// too_many_requests, invalid_argument, invalid_message, aborted and timeout.
// Remote failures keep the peer's code and status. A handler that throws an
// RpcError, an error with `expose: true` or one with a 4xx status sends its
// message; any other handler error reaches the peer as a generic failure.
export class RpcError extends Error {
  constructor(message, { code, status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'RpcError'
    if (code !== undefined) this.code = code
    if (status !== undefined) this.status = status
    this.expose = true
  }
}

const protocolError = (message) =>
  new RpcError(message, { code: 'protocol_error' })
const closedError = (message = 'The connection is closed.') =>
  new RpcError(message, { code: 'connection_closed' })
const connectionFailed = (cause) =>
  new RpcError('The connection failed.', { code: 'connection_failed', cause })
const invalidArgument = (message) =>
  new RpcError(message, { code: 'invalid_argument' })
const queueFull = () =>
  new RpcError('Too much outgoing data is waiting to be sent.', {
    code: 'queue_full',
    status: 503,
  })
// Abandoning a request only stops waiting for it. The peer may still be
// running the operation; stopping it takes an explicit application RPC.
const abandoned = (reason) =>
  new RpcError('The request was abandoned before a reply arrived.', {
    code: 'aborted',
    cause: reason,
  })

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOnly = (value, keys) =>
  Object.keys(value).every((key) => keys.has(key))
const isId = (value) => typeof value === 'string' && ID.test(value)
const isMethod = (value) => typeof value === 'string' && METHOD.test(value)
const isCode = (value) => typeof value === 'string' && CODE.test(value)
const isStatus = (value) =>
  Number.isInteger(value) && value >= 400 && value <= 599
const isWireError = (value) =>
  isRecord(value) &&
  hasOnly(value, ERROR_KEYS) &&
  typeof value.message === 'string' &&
  (!Object.hasOwn(value, 'code') || isCode(value.code)) &&
  (!Object.hasOwn(value, 'status') || isStatus(value.status))

function limit(name, value, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`)
  return value
}

function cleanMessage(value) {
  const message = value
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE)
    .toWellFormed()
  return message || GENERIC_FAILURE
}

// Handler failures cross a trust boundary. Only errors meant for users keep
// their message, so paths, tokens and stacks stay on this side.
function wireError(error) {
  try {
    const code = isCode(error?.code) ? error.code : undefined
    const status = isStatus(error?.status) ? error.status : undefined
    if (error?.expose === true || (status !== undefined && status < 500))
      return {
        message:
          typeof error.message === 'string'
            ? cleanMessage(error.message)
            : GENERIC_FAILURE,
        code,
        status,
      }
    return {
      message: GENERIC_FAILURE,
      code: code ?? 'internal_error',
      status: status ?? 500,
    }
  } catch {
    return INTERNAL_FAILURE
  }
}

function encodeFrame(message, maxFrameBytes) {
  let json
  try {
    json = JSON.stringify(message)
  } catch {
    throw new RpcError('The message cannot be encoded as JSON.', {
      code: 'invalid_message',
    })
  }
  const length = Buffer.byteLength(json)
  if (length > maxFrameBytes)
    throw new RpcError('The message exceeds the frame size limit.', {
      code: 'frame_too_large',
    })
  const frame = Buffer.allocUnsafe(HEADER_BYTES + length)
  frame.writeUInt32BE(length, 0)
  frame.write(json, HEADER_BYTES)
  return frame
}

function parseFrame(text) {
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    throw protocolError('Received a frame that is not valid JSON.')
  }
  if (!isRecord(frame))
    throw protocolError('Received a frame that is not a JSON object.')
  if (frame.type === 'request') {
    if (
      !hasOnly(frame, REQUEST_KEYS) ||
      !isId(frame.id) ||
      !isMethod(frame.method)
    )
      throw protocolError('Received an invalid request frame.')
  } else if (frame.type === 'response') {
    if (
      !hasOnly(frame, RESPONSE_KEYS) ||
      !isId(frame.id) ||
      !(frame.ok === true
        ? !Object.hasOwn(frame, 'error')
        : frame.ok === false &&
          !Object.hasOwn(frame, 'result') &&
          isWireError(frame.error))
    )
      throw protocolError('Received an invalid response frame.')
  } else if (frame.type === 'event') {
    if (!hasOnly(frame, EVENT_KEYS) || !isMethod(frame.method))
      throw protocolError('Received an invalid event frame.')
  } else throw protocolError('Received a frame with an unknown type.')
  return frame
}

// Reads frames across arbitrary chunk boundaries. Each byte is copied at most
// once: a frame inside one chunk is returned as a view, and a split frame is
// assembled in one buffer allocated only after its length passes the limit.
class FrameDecoder {
  #limit
  #header = Buffer.alloc(HEADER_BYTES)
  #headerBytes = 0
  #body = null
  #bodyBytes = 0

  constructor(limit) {
    this.#limit = limit
  }

  get partial() {
    return this.#headerBytes > 0 || this.#body !== null
  }

  *frames(chunk) {
    let offset = 0
    while (offset < chunk.length) {
      if (this.#body === null) {
        const count = Math.min(
          HEADER_BYTES - this.#headerBytes,
          chunk.length - offset,
        )
        chunk.copy(this.#header, this.#headerBytes, offset, offset + count)
        this.#headerBytes += count
        offset += count
        if (this.#headerBytes < HEADER_BYTES) return
        this.#headerBytes = 0
        const length = this.#header.readUInt32BE(0)
        if (length === 0) throw protocolError('Received an empty frame.')
        if (length > this.#limit)
          throw new RpcError('Received a frame larger than the size limit.', {
            code: 'frame_too_large',
          })
        if (chunk.length - offset >= length) {
          offset += length
          yield chunk.subarray(offset - length, offset)
          continue
        }
        this.#body = Buffer.allocUnsafe(length)
        this.#bodyBytes = 0
      }
      const count = Math.min(
        this.#body.length - this.#bodyBytes,
        chunk.length - offset,
      )
      chunk.copy(this.#body, this.#bodyBytes, offset, offset + count)
      this.#bodyBytes += count
      offset += count
      if (this.#bodyBytes === this.#body.length) {
        const body = this.#body
        this.#body = null
        yield body
      }
    }
  }
}

// Bidirectional request/reply and event transport over a pair of byte
// streams, which may be one duplex stream. The instance owns the streams:
// close() ends the writable side, and close(error) destroys both.
export class FramedRpc extends EventEmitter {
  #readable
  #writable
  #maxFrameBytes
  #maxQueuedBytes
  #maxPendingRequests
  #maxConcurrentHandlers
  #requestTimeoutMs
  #decoder
  #text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  #handlers = new Map()
  #pending = new Map()
  #active = new Set()
  #queue = []
  #queueStart = 0
  #queuedBytes = 0
  #needDrain
  #nextId = 1
  #closed = false
  #detach = []

  constructor(readable, writable, options = {}) {
    super()
    if (
      typeof readable?.on !== 'function' ||
      typeof readable.resume !== 'function'
    )
      throw new TypeError('FramedRpc needs a readable stream.')
    if (
      typeof writable?.on !== 'function' ||
      typeof writable.write !== 'function'
    )
      throw new TypeError('FramedRpc needs a writable stream.')
    const {
      maxFrameBytes = 1024 * 1024,
      maxQueuedBytes = 4 * 1024 * 1024,
      maxPendingRequests = 128,
      maxConcurrentHandlers = 32,
      requestTimeoutMs = 30_000,
    } = options
    this.#maxFrameBytes = limit(
      'maxFrameBytes',
      maxFrameBytes,
      MIN_FRAME_BYTES,
      MAX_FRAME_BYTES,
    )
    this.#maxQueuedBytes = limit(
      'maxQueuedBytes',
      maxQueuedBytes,
      this.#maxFrameBytes + HEADER_BYTES,
    )
    this.#maxPendingRequests = limit('maxPendingRequests', maxPendingRequests)
    this.#maxConcurrentHandlers = limit(
      'maxConcurrentHandlers',
      maxConcurrentHandlers,
    )
    this.#requestTimeoutMs = limit(
      'requestTimeoutMs',
      requestTimeoutMs,
      1,
      MAX_TIMEOUT_MS,
    )
    this.#readable = readable
    this.#writable = writable
    this.#decoder = new FrameDecoder(this.#maxFrameBytes)
    this.#needDrain = writable.writableNeedDrain === true

    const failed = (error) => this.close(connectionFailed(error))
    const lost = () =>
      this.close(closedError('The connection closed unexpectedly.'))
    this.#listen(readable, 'data', (chunk) => this.#receive(chunk))
    this.#listen(readable, 'end', () =>
      this.close(
        this.#decoder.partial
          ? protocolError('The connection ended inside a frame.')
          : undefined,
      ),
    )
    this.#listen(readable, 'close', lost)
    this.#listen(writable, 'drain', () => {
      this.#needDrain = false
      this.#flush()
    })
    this.#listen(writable, 'finish', lost)
    this.#listen(writable, 'close', lost)
    // Error listeners stay attached after close so late stream errors cannot
    // become unhandled 'error' events.
    readable.on('error', failed)
    if (writable !== readable) writable.on('error', failed)
    readable.resume()
    if (
      readable.destroyed ||
      readable.readableEnded ||
      writable.destroyed ||
      writable.writableEnded
    )
      queueMicrotask(lost)
  }

  get closed() {
    return this.#closed
  }

  get pendingRequests() {
    return this.#pending.size
  }

  get activeHandlers() {
    return this.#active.size
  }

  get queuedBytes() {
    return this.#queuedBytes
  }

  handle(method, handler) {
    if (!isMethod(method))
      throw new TypeError('RPC method names must be short identifiers.')
    if (typeof handler !== 'function')
      throw new TypeError('RPC handlers must be functions.')
    if (this.#handlers.has(method))
      throw new Error(`RPC method ${method} already has a handler.`)
    this.#handlers.set(method, handler)
    return this
  }

  request(method, params, options = {}) {
    return new Promise((resolve, reject) => {
      const { signal, timeoutMs = this.#requestTimeoutMs } = options
      if (this.#closed) throw closedError()
      if (!isMethod(method))
        throw invalidArgument('The RPC method name is invalid.')
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_TIMEOUT_MS
      )
        throw invalidArgument('The request timeout is invalid.')
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw invalidArgument('The abort signal is invalid.')
      if (signal?.aborted) throw abandoned(signal.reason)
      if (this.#pending.size >= this.#maxPendingRequests)
        throw new RpcError('Too many requests are waiting for a reply.', {
          code: 'too_many_requests',
          status: 503,
        })
      const id = String(this.#nextId++)
      const frame = encodeFrame(
        { type: 'request', id, method, params },
        this.#maxFrameBytes,
      )
      // Register before writing, because a peer can answer synchronously.
      const entry = { resolve, reject, signal, onAbort: undefined }
      this.#pending.set(id, entry)
      entry.timer = setTimeout(
        () =>
          this.#settle(
            id,
            false,
            new RpcError('No reply arrived before the request timed out.', {
              code: 'timeout',
              status: 504,
            }),
          ),
        timeoutMs,
      )
      if (signal) {
        entry.onAbort = () => this.#settle(id, false, abandoned(signal.reason))
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      if (!this.#push(frame)) this.#settle(id, false, queueFull())
    })
  }

  // Resolves once the frame is handed to the writable stream. The returned
  // promise is already observed, so a fire-and-forget event that fails when
  // the connection closes does not become an unhandled rejection.
  notify(method, params) {
    let written
    try {
      if (this.#closed) throw closedError()
      if (!isMethod(method))
        throw invalidArgument('The RPC method name is invalid.')
      written = this.#push(
        encodeFrame({ type: 'event', method, params }, this.#maxFrameBytes),
      )
      if (!written) throw queueFull()
    } catch (error) {
      written = Promise.reject(error)
      written.catch(noop)
    }
    return written
  }

  close(error) {
    if (this.#closed) return
    this.#closed = true
    const failure =
      error === undefined || error === null
        ? undefined
        : error instanceof Error
          ? error
          : closedError()
    const reason = failure ?? closedError()
    for (const detach of this.#detach) detach()
    this.#detach = []
    this.#decoder = null
    for (const id of [...this.#pending.keys()]) this.#settle(id, false, reason)
    const queued = this.#queue.slice(this.#queueStart)
    this.#queue = []
    this.#queueStart = 0
    this.#queuedBytes = 0
    for (const item of queued) item.reject(reason)
    if (failure) {
      this.#readable.destroy()
      this.#writable.destroy()
    } else {
      // Ending, rather than destroying, lets the peer see a normal end of
      // input. Its remaining output is read and discarded.
      if (!this.#writable.destroyed && !this.#writable.writableEnded)
        this.#writable.end()
      this.#readable.resume()
    }
    // Streams emit 'close' asynchronously too; this keeps listener failures
    // out of the stream and promise callbacks that trigger a close.
    process.nextTick(() => this.emit('close', failure))
  }

  #listen(stream, event, listener) {
    stream.on(event, listener)
    this.#detach.push(() => stream.off(event, listener))
  }

  #settle(id, ok, value) {
    const entry = this.#pending.get(id)
    if (!entry) return
    this.#pending.delete(id)
    clearTimeout(entry.timer)
    entry.signal?.removeEventListener('abort', entry.onAbort)
    if (ok) entry.resolve(value)
    else entry.reject(value)
  }

  // Queues an encoded frame, or returns null when it would exceed the
  // outgoing byte cap. Queued write promises are observed internally.
  #push(frame) {
    if (this.#queuedBytes + frame.length > this.#maxQueuedBytes) return null
    const { promise, resolve, reject } = Promise.withResolvers()
    promise.catch(noop)
    this.#queue.push({ frame, resolve, reject })
    this.#queuedBytes += frame.length
    this.#flush()
    return promise
  }

  #flush() {
    while (
      !this.#closed &&
      !this.#needDrain &&
      this.#queueStart < this.#queue.length
    ) {
      const item = this.#queue[this.#queueStart]
      this.#queue[this.#queueStart++] = undefined
      this.#queuedBytes -= item.frame.length
      try {
        if (this.#writable.write(item.frame) === false) this.#needDrain = true
      } catch (error) {
        const failure = connectionFailed(error)
        item.reject(failure)
        this.close(failure)
        return
      }
      item.resolve()
    }
    if (this.#queueStart === this.#queue.length) {
      this.#queue = []
      this.#queueStart = 0
    } else if (
      this.#queueStart >= 1024 &&
      this.#queueStart * 2 >= this.#queue.length
    ) {
      this.#queue = this.#queue.slice(this.#queueStart)
      this.#queueStart = 0
    }
  }

  #receive(chunk) {
    if (this.#closed) return
    try {
      if (!(chunk instanceof Uint8Array))
        throw protocolError('The connection must carry binary data.')
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      for (const body of this.#decoder.frames(bytes)) {
        this.#dispatch(body)
        if (this.#closed) return
      }
    } catch (error) {
      this.close(error)
    }
  }

  #dispatch(body) {
    let text
    try {
      text = this.#text.decode(body)
    } catch {
      throw protocolError('Received a frame that is not valid UTF-8.')
    }
    const frame = parseFrame(text)
    if (frame.type === 'request') this.#serve(frame)
    else if (frame.type === 'response') this.#accept(frame)
    else this.#deliver(frame)
  }

  #serve({ id, method, params }) {
    if (this.#active.has(id))
      throw protocolError('Received a duplicate request id.')
    const handler = this.#handlers.get(method)
    if (!handler) return this.#respond(id, { ok: false, error: UNKNOWN_METHOD })
    if (this.#active.size >= this.#maxConcurrentHandlers)
      return this.#respond(id, { ok: false, error: BUSY })
    this.#active.add(id)
    new Promise((resolve) => resolve(handler(params)))
      .then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, error: wireError(error) }),
      )
      .then((outcome) => {
        this.#active.delete(id)
        this.#respond(id, outcome)
      })
  }

  #respond(id, outcome) {
    if (this.#closed) return
    let frame
    try {
      frame = encodeFrame(
        { type: 'response', id, ...outcome },
        this.#maxFrameBytes,
      )
    } catch (error) {
      frame = encodeFrame(
        { type: 'response', id, ok: false, error: wireError(error) },
        this.#maxFrameBytes,
      )
    }
    // A reply that cannot be queued would leave the peer waiting, so the
    // connection fails instead.
    if (!this.#push(frame)) this.close(queueFull())
  }

  #accept({ id, ok, result, error }) {
    if (this.#pending.has(id)) {
      if (ok) this.#settle(id, true, result)
      else
        this.#settle(
          id,
          false,
          new RpcError(cleanMessage(error.message), {
            code: error.code,
            status: error.status,
          }),
        )
    } else if (!LOCAL_ID.test(id) || Number(id) >= this.#nextId)
      throw protocolError('Received a response to an unknown request.')
    // Otherwise this is a late reply to an abandoned or timed-out request.
  }

  #deliver({ method, params }) {
    try {
      this.emit('notification', { method, params })
    } catch (error) {
      this.close(
        new RpcError('A notification listener failed.', {
          code: 'listener_failed',
          cause: error,
        }),
      )
    }
  }
}
