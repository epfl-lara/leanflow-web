import assert from 'node:assert/strict'
import { getEventListeners, once } from 'node:events'
import { duplexPair, PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { FramedRpc, PROTOCOL_VERSION, RpcError } from '../cluster/protocol.mjs'

const json = (text) => Buffer.from(text)

function header(length) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(length)
  return bytes
}

function frame(value) {
  const body = Buffer.isBuffer(value) ? value : json(JSON.stringify(value))
  return Buffer.concat([header(body.length), body])
}

function decodeAll(chunks) {
  let bytes = Buffer.concat(chunks)
  const frames = []
  while (bytes.length) {
    const length = bytes.readUInt32BE(0)
    frames.push(JSON.parse(bytes.subarray(4, 4 + length).toString()))
    bytes = bytes.subarray(4 + length)
  }
  return frames
}

async function until(condition) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await tick()
  assert.ok(condition())
}

// Two FramedRpc instances connected by a pair of PassThrough streams.
function pair(t, options = {}, peerOptions = options) {
  const forward = new PassThrough()
  const backward = new PassThrough()
  const left = new FramedRpc(backward, forward, options)
  const right = new FramedRpc(forward, backward, peerOptions)
  t.after(() => {
    left.close()
    right.close()
  })
  return { left, right }
}

// A FramedRpc whose other end is driven by the test with raw frames.
function peer(t, options) {
  const input = new PassThrough()
  const output = new PassThrough()
  const rpc = new FramedRpc(input, output, options)
  const closed = once(rpc, 'close').then(([error]) => error)
  const received = []
  const waiting = []
  let buffered = Buffer.alloc(0)
  output.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk])
    while (
      buffered.length >= 4 &&
      buffered.length >= 4 + buffered.readUInt32BE(0)
    ) {
      const length = buffered.readUInt32BE(0)
      const value = JSON.parse(buffered.subarray(4, 4 + length).toString())
      buffered = buffered.subarray(4 + length)
      if (waiting.length) waiting.shift()(value)
      else received.push(value)
    }
  })
  t.after(() => rpc.close())
  return {
    rpc,
    input,
    output,
    closed,
    send: (value) => input.write(frame(value)),
    next: () =>
      received.length
        ? Promise.resolve(received.shift())
        : new Promise((resolve) => waiting.push(resolve)),
  }
}

// A writable that holds every write until the test releases it.
function gate() {
  const chunks = []
  const callbacks = []
  const writable = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(chunk)
      callbacks.push(callback)
    },
  })
  return { writable, chunks, release: () => callbacks.shift()?.() }
}

function trackAllocations(t) {
  const mocks = ['alloc', 'allocUnsafe', 'allocUnsafeSlow'].map((name) =>
    t.mock.method(Buffer, name),
  )
  return () =>
    mocks.flatMap((mock) => mock.mock.calls.map((call) => call.arguments[0]))
}

function trackUnhandled(t) {
  const reasons = []
  const record = (reason) => reasons.push(reason)
  process.on('unhandledRejection', record)
  t.after(() => process.off('unhandledRejection', record))
  return reasons
}

test('peers exchange requests and replies in both directions', async (t) => {
  const { left, right } = pair(t)
  assert.equal(PROTOCOL_VERSION, 2)
  left.handle('math.add', ({ a, b }) => a + b)
  left.handle('noop', () => {})
  right.handle('worker/status', async () => ({
    state: 'ready',
    sum: await right.request('math.add', { a: 2, b: 3 }),
  }))
  const [status, sum, nothing] = await Promise.all([
    left.request('worker/status'),
    right.request('math.add', { a: 1, b: 1 }),
    right.request('noop'),
  ])
  assert.deepEqual(status, { state: 'ready', sum: 5 })
  assert.equal(sum, 2)
  assert.equal(nothing, undefined)
  assert.equal(left.pendingRequests + right.pendingRequests, 0)
  assert.equal(left.activeHandlers + right.activeHandlers, 0)
})

test('requests, replies and events use the documented frames', async (t) => {
  const { rpc, send, next } = peer(t)
  rpc.handle('echo', (params) => params)
  const reply = rpc.request('project/open', { name: 'Demo' })
  const request = await next()
  assert.equal(typeof request.id, 'string')
  assert.deepEqual(request, {
    type: 'request',
    id: request.id,
    method: 'project/open',
    params: { name: 'Demo' },
  })
  send({ type: 'response', id: request.id, ok: true, result: { opened: 1 } })
  assert.deepEqual(await reply, { opened: 1 })

  await rpc.notify('log', 'ready')
  assert.deepEqual(await next(), {
    type: 'event',
    method: 'log',
    params: 'ready',
  })

  send({ type: 'request', id: 'peer-1', method: 'echo', params: [1, 'two'] })
  assert.deepEqual(await next(), {
    type: 'response',
    id: 'peer-1',
    ok: true,
    result: [1, 'two'],
  })
})

test('events arrive in order as notifications', async (t) => {
  const { left, right } = pair(t)
  const received = []
  left.on('notification', (event) => received.push(event))
  right.handle('ping', () => 'pong')
  await right.notify('progress', { step: 1 })
  await right.notify('progress', { step: 2 })
  await right.notify('done')
  // The reply travels behind the events on the same stream.
  assert.equal(await left.request('ping'), 'pong')
  assert.deepEqual(received, [
    { method: 'progress', params: { step: 1 } },
    { method: 'progress', params: { step: 2 } },
    { method: 'done', params: undefined },
  ])
})

test('handler failures reach the caller with only public details', async (t) => {
  const { left, right } = pair(t)
  right.handle('project/open', async () => {
    throw Object.assign(new Error('Project is being edited.'), {
      code: 'conflict',
      status: 409,
    })
  })
  right.handle('project/import', () =>
    Promise.reject(
      new RpcError('Choose a smaller archive.', {
        code: 'too_large',
        status: 413,
      }),
    ),
  )
  right.handle('project/crash', async () => {
    throw new Error('ENOENT /home/alice/.env token=sk-secret')
  })
  right.handle('project/value', () => {
    throw 'raw string failure'
  })
  await assert.rejects(left.request('project/open'), (error) => {
    assert.ok(error instanceof RpcError)
    assert.deepEqual(
      [error.message, error.code, error.status],
      ['Project is being edited.', 'conflict', 409],
    )
    return true
  })
  await assert.rejects(left.request('project/import'), {
    message: 'Choose a smaller archive.',
    code: 'too_large',
    status: 413,
  })
  for (const method of ['project/crash', 'project/value'])
    await assert.rejects(left.request(method), {
      message: 'The remote operation failed.',
      code: 'internal_error',
      status: 500,
    })
  assert.equal(left.closed || right.closed, false)
})

test('unexpected handler errors are sent without messages or stacks', async (t) => {
  const { rpc, send, next } = peer(t)
  rpc.handle('crash', () => {
    throw Object.assign(new Error('/home/alice/.env token=sk-secret'), {
      code: 'ENOENT',
    })
  })
  send({ type: 'request', id: 'a', method: 'crash' })
  const reply = await next()
  assert.deepEqual(reply, {
    type: 'response',
    id: 'a',
    ok: false,
    error: {
      message: 'The remote operation failed.',
      code: 'ENOENT',
      status: 500,
    },
  })
  assert.doesNotMatch(JSON.stringify(reply), /secret|alice|stack/)
})

test('unknown methods get a safe error without object property lookup', async (t) => {
  const { rpc, send, next } = peer(t)
  rpc.handle('known', () => 'ok')
  for (const method of [
    'missing',
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
  ]) {
    send({ type: 'request', id: method, method })
    const reply = await next()
    assert.equal(reply.id, method)
    assert.equal(reply.ok, false)
    assert.equal(reply.error.code, 'unknown_method')
    assert.equal(reply.error.status, 404)
  }
  send({ type: 'request', id: 'k', method: 'known' })
  assert.deepEqual(await next(), {
    type: 'response',
    id: 'k',
    ok: true,
    result: 'ok',
  })
  assert.equal(rpc.closed, false)
})

test('remote error messages are cleaned before they are raised', async (t) => {
  const { rpc, send, next } = peer(t)
  const reply = rpc.request('job')
  const { id } = await next()
  const breaks = String.fromCharCode(10, 0)
  const message = `Line one${breaks}Line two${breaks}${'x'.repeat(500)}`
  send({
    type: 'response',
    id,
    ok: false,
    error: { message, code: 'job_failed', status: 422 },
  })
  await assert.rejects(reply, (error) => {
    assert.ok(error instanceof RpcError)
    assert.match(error.message, /^Line one Line two x+$/)
    assert.equal(error.message.length, 200)
    assert.equal(error.code, 'job_failed')
    assert.equal(error.status, 422)
    return true
  })
})

const batch = () =>
  Buffer.concat([
    frame({ type: 'event', method: 'note', params: 'λ∀→🙂' }),
    frame({ type: 'request', id: 'r1', method: 'echo', params: { text: 'å' } }),
    frame({ type: 'event', method: 'note', params: 2 }),
  ])
const chunkings = {
  'in one chunk': (bytes) => [bytes],
  'one byte at a time': (bytes) => [...bytes].map((byte) => Buffer.of(byte)),
  'in uneven chunks': (bytes) => {
    const sizes = [1, 2, 3, 5, 7, 11, 13]
    const chunks = []
    let offset = 0
    for (let index = 0; offset < bytes.length; index++) {
      const size = sizes[index % sizes.length]
      chunks.push(bytes.subarray(offset, offset + size))
      offset += size
    }
    return chunks
  },
}

for (const [name, split] of Object.entries(chunkings))
  test(`frames decode when delivered ${name}`, async (t) => {
    const { rpc, input, next } = peer(t)
    const notes = []
    rpc.on('notification', ({ params }) => notes.push(params))
    rpc.handle('echo', (params) => params)
    for (const chunk of split(batch())) input.write(chunk)
    assert.deepEqual(await next(), {
      type: 'response',
      id: 'r1',
      ok: true,
      result: { text: 'å' },
    })
    await until(() => notes.length === 2)
    assert.deepEqual(notes, ['λ∀→🙂', 2])
  })

test('byte-at-a-time input assembles a frame with one body allocation', async (t) => {
  const { rpc, input } = peer(t)
  const params = 'x'.repeat(64 * 1024)
  const bytes = frame({ type: 'event', method: 'bulk', params })
  const received = once(rpc, 'notification')
  const allocations = trackAllocations(t)
  for (let offset = 0; offset < bytes.length; offset++)
    input.write(bytes.subarray(offset, offset + 1))
  const [event] = await received
  assert.equal(event.params, params)
  const large = allocations().filter((size) => size >= params.length)
  assert.equal(large.length, 1)
})

test('frames at the size limit are accepted in both directions', async (t) => {
  const { rpc, send, next } = peer(t, { maxFrameBytes: 1024 })
  const empty = JSON.stringify({ type: 'event', method: 'fill', params: '' })
  const params = 'x'.repeat(1024 - Buffer.byteLength(empty))
  const received = once(rpc, 'notification')
  send({ type: 'event', method: 'fill', params })
  assert.equal((await received)[0].params, params)
  await rpc.notify('fill', params)
  assert.equal((await next()).params, params)
  await assert.rejects(rpc.notify('fill', params + 'x'), {
    code: 'frame_too_large',
  })
  assert.equal(rpc.closed, false)
})

for (const [label, options, length] of [
  ['one byte over a custom limit', { maxFrameBytes: 1024 }, 1025],
  ['of 4 GiB with default limits', {}, 0xffffffff],
])
  test(`a frame length ${label} closes before any body is buffered`, async (t) => {
    const { rpc, input, closed } = peer(t, options)
    const pending = rpc.request('job')
    const bytes = header(length)
    const allocations = trackAllocations(t)
    input.write(bytes)
    assert.equal((await closed).code, 'frame_too_large')
    await assert.rejects(pending, { code: 'frame_too_large' })
    assert.ok(
      allocations().every((size) => size < 1024),
      'no buffer was sized from the advertised length',
    )
    assert.equal(input.destroyed, true)
  })

const errorReply = (error) => ({ type: 'response', id: '1', ok: false, error })
const invalidFrames = [
  ['a JSON array', []],
  ['JSON null', null],
  ['a number', 7],
  ['a string', 'event'],
  ['a frame without a type', { method: 'note' }],
  ['an unknown frame type', { type: 'ping' }],
  ['an inherited property name as type', { type: 'constructor' }],
  ['a numeric request id', { type: 'request', id: 1, method: 'job' }],
  ['an empty request id', { type: 'request', id: '', method: 'job' }],
  [
    'an overlong request id',
    { type: 'request', id: 'a'.repeat(65), method: 'job' },
  ],
  ['a request id with spaces', { type: 'request', id: 'a b', method: 'job' }],
  ['a path-like method', { type: 'request', id: 'a', method: '../job' }],
  ['an empty method', { type: 'event', method: '' }],
  ['a __proto__ method', { type: 'request', id: 'a', method: '__proto__' }],
  ['an overlong method', { type: 'event', method: 'a'.repeat(129) }],
  ['an object method', { type: 'event', method: {} }],
  [
    'an extra request field',
    { type: 'request', id: 'a', method: 'job', extra: true },
  ],
  [
    'a __proto__ field',
    json('{"type":"event","method":"note","__proto__":{}}'),
  ],
  ['an event with an id', { type: 'event', id: 'a', method: 'note' }],
  ['a response without ok', { type: 'response', id: '1', result: 1 }],
  ['a string ok', { type: 'response', id: '1', ok: 'true', result: 1 }],
  [
    'a success with an error',
    { type: 'response', id: '1', ok: true, error: { message: 'no' } },
  ],
  ['a failure without an error', { type: 'response', id: '1', ok: false }],
  ['a failure with a result', { ...errorReply({ message: 'no' }), result: 1 }],
  ['an error without a message', errorReply({ code: 'failed' })],
  ['a numeric error message', errorReply({ message: 5 })],
  ['an invalid error code', errorReply({ message: 'no', code: 'bad code' })],
  ['a success status', errorReply({ message: 'no', status: 200 })],
  ['a string status', errorReply({ message: 'no', status: '500' })],
  ['an error with a stack', errorReply({ message: 'no', stack: 'at x' })],
  ['a reply to a request never sent', { type: 'response', id: '99', ok: true }],
  ['a reply with a foreign id', { type: 'response', id: 'abc', ok: true }],
  ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
  ['an overlong UTF-8 encoding', Buffer.from([0x22, 0xc0, 0xaf, 0x22])],
  [
    'a cut multibyte character',
    Buffer.concat([
      json('{"type":"event","method":"note","params":"'),
      Buffer.from([0xe2, 0x82]),
      json('"}'),
    ]),
  ],
  [
    'a byte order mark',
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      json('{"type":"event","method":"note"}'),
    ]),
  ],
  ['truncated JSON', json('{"type":')],
  ['data after the JSON value', json('{"type":"event","method":"note"} x')],
]

for (const [name, value] of invalidFrames)
  test(`a frame with ${name} closes the connection`, async (t) => {
    const { rpc, input, send, next, closed } = peer(t)
    const notes = []
    rpc.on('notification', (event) => notes.push(event))
    const pending = rpc.request('job')
    assert.equal((await next()).id, '1')
    send(value)
    assert.equal((await closed).code, 'protocol_error')
    await assert.rejects(pending, { code: 'protocol_error' })
    assert.equal(rpc.closed, true)
    assert.equal(input.destroyed, true)
    assert.deepEqual(notes, [])
  })

test('an empty frame closes the connection', async (t) => {
  const { input, closed } = peer(t)
  input.write(header(0))
  assert.equal((await closed).code, 'protocol_error')
})

test('text-mode input is rejected', async (t) => {
  const input = new PassThrough()
  input.setEncoding('utf8')
  const rpc = new FramedRpc(input, new PassThrough())
  t.after(() => rpc.close())
  const closed = once(rpc, 'close')
  input.write(frame({ type: 'event', method: 'note' }))
  assert.equal((await closed)[0].code, 'protocol_error')
})

for (const [name, cut] of [
  ['inside the length', 2],
  ['after the length', 4],
  ['inside the body', 10],
])
  test(`end of input ${name} is a protocol error`, async (t) => {
    const { rpc, input, next, closed } = peer(t)
    const pending = rpc.request('job')
    await next()
    input.end(frame({ type: 'event', method: 'note' }).subarray(0, cut))
    assert.equal((await closed).code, 'protocol_error')
    await assert.rejects(pending, { code: 'protocol_error' })
  })

test('complete frames before a normal end are delivered', async (t) => {
  const { rpc, input, output, next, closed } = peer(t)
  const answered = rpc.request('first')
  const unanswered = rpc.request('second')
  const first = await next()
  await next()
  const notes = []
  rpc.on('notification', ({ params }) => notes.push(params))
  input.end(
    Buffer.concat([
      frame({ type: 'response', id: first.id, ok: true, result: 'one' }),
      frame({ type: 'event', method: 'note', params: 'last' }),
    ]),
  )
  assert.equal(await answered, 'one')
  assert.equal(await closed, undefined)
  assert.deepEqual(notes, ['last'])
  await assert.rejects(unanswered, { code: 'connection_closed' })
  assert.equal(output.writableEnded, true)
})

test('handler overflow answers busy without starting the handler', async (t) => {
  const { rpc, send, next } = peer(t, { maxConcurrentHandlers: 2 })
  const release = Promise.withResolvers()
  let started = 0
  rpc.handle('slow', async (params) => {
    started++
    await release.promise
    return params
  })
  for (const id of ['a', 'b', 'c'])
    send({ type: 'request', id, method: 'slow', params: id })
  const busy = await next()
  assert.equal(busy.id, 'c')
  assert.equal(busy.ok, false)
  assert.equal(busy.error.code, 'busy')
  assert.equal(busy.error.status, 503)
  assert.equal(started, 2)
  assert.equal(rpc.activeHandlers, 2)
  release.resolve()
  const replies = [await next(), await next()]
  assert.deepEqual(replies.map(({ id, result }) => [id, result]).sort(), [
    ['a', 'a'],
    ['b', 'b'],
  ])
  assert.equal(rpc.activeHandlers, 0)
  send({ type: 'request', id: 'c', method: 'slow', params: 'again' })
  assert.deepEqual(await next(), {
    type: 'response',
    id: 'c',
    ok: true,
    result: 'again',
  })
  assert.equal(started, 3)
})

test('a duplicate active request id closes the connection', async (t) => {
  const { rpc, send, closed } = peer(t)
  rpc.handle('slow', () => new Promise(() => {}))
  send({ type: 'request', id: 'same', method: 'slow' })
  send({ type: 'request', id: 'same', method: 'slow' })
  assert.equal((await closed).code, 'protocol_error')
})

test('pending request overflow is rejected before anything is sent', async (t) => {
  const { rpc, send, next } = peer(t, { maxPendingRequests: 2 })
  const first = rpc.request('first')
  const second = rpc.request('second')
  await assert.rejects(rpc.request('third'), {
    code: 'too_many_requests',
    status: 503,
  })
  assert.equal(rpc.pendingRequests, 2)
  const sent = [await next(), await next()]
  assert.deepEqual(
    sent.map(({ method }) => method),
    ['first', 'second'],
  )
  send({ type: 'response', id: sent[0].id, ok: true, result: 1 })
  assert.equal(await first, 1)
  const fourth = rpc.request('fourth')
  const later = await next()
  assert.equal(later.method, 'fourth')
  send({ type: 'response', id: sent[1].id, ok: true, result: 2 })
  send({ type: 'response', id: later.id, ok: true, result: 4 })
  assert.deepEqual(await Promise.all([second, fourth]), [2, 4])
  assert.equal(rpc.pendingRequests, 0)
})

test('aborting a request settles it locally and ignores a late reply', async (t) => {
  const { rpc, send, next } = peer(t)
  const controller = new AbortController()
  const pending = rpc.request('build', null, { signal: controller.signal })
  const build = await next()
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
  controller.abort()
  await assert.rejects(pending, { code: 'aborted' })
  assert.equal(rpc.pendingRequests, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  send({ type: 'response', id: build.id, ok: true, result: 'late' })
  await assert.rejects(
    rpc.request('skipped', null, { signal: AbortSignal.abort() }),
    { code: 'aborted' },
  )
  // Neither abort wrote a frame: the next one is the next request.
  const active = new AbortController()
  const status = rpc.request('status', null, { signal: active.signal })
  const sent = await next()
  assert.equal(sent.method, 'status')
  send({ type: 'response', id: sent.id, ok: true, result: 'ready' })
  assert.equal(await status, 'ready')
  assert.equal(getEventListeners(active.signal, 'abort').length, 0)
  assert.equal(rpc.closed, false)
})

test('a malformed reply to an abandoned request still closes the connection', async (t) => {
  const { rpc, send, next, closed } = peer(t)
  const controller = new AbortController()
  const pending = rpc.request('build', null, { signal: controller.signal })
  const { id } = await next()
  controller.abort()
  await assert.rejects(pending, { code: 'aborted' })
  send({ type: 'response', id, ok: 'yes' })
  assert.equal((await closed).code, 'protocol_error')
})

test('timed-out requests are removed and late replies are ignored', async (t) => {
  const { rpc, send, next } = peer(t, { requestTimeoutMs: 20 })
  const byDefault = rpc.request('slow')
  const byOption = rpc.request('slower', null, { timeoutMs: 200 })
  const sent = [await next(), await next()]
  await assert.rejects(byDefault, { code: 'timeout', status: 504 })
  assert.equal(rpc.pendingRequests, 1)
  await assert.rejects(byOption, { code: 'timeout' })
  assert.equal(rpc.pendingRequests, 0)
  send({ type: 'response', id: sent[0].id, ok: true, result: 'late' })
  send({
    type: 'response',
    id: sent[1].id,
    ok: false,
    error: { message: 'late failure' },
  })
  await assert.rejects(rpc.request('bad', null, { timeoutMs: 0 }), {
    code: 'invalid_argument',
  })
  const later = rpc.request('status')
  const { id } = await next()
  send({ type: 'response', id, ok: true, result: 'ready' })
  assert.equal(await later, 'ready')
  assert.equal(rpc.closed, false)
})

test('outgoing frames keep their order and wait for drain', async (t) => {
  const output = gate()
  const rpc = new FramedRpc(new PassThrough(), output.writable)
  t.after(() => rpc.close())
  const handed = []
  rpc.notify('step', 'a').then(() => handed.push('a'))
  rpc.request('job').catch(() => {})
  rpc.notify('step', 'b').then(() => handed.push('b'))
  await tick()
  assert.deepEqual(handed, ['a'])
  assert.equal(output.chunks.length, 1)
  assert.ok(rpc.queuedBytes > 0)

  output.release()
  await tick()
  assert.equal(output.chunks.length, 2)
  assert.deepEqual(handed, ['a'])

  output.release()
  await tick()
  assert.equal(output.chunks.length, 3)
  assert.deepEqual(handed, ['a', 'b'])
  assert.equal(rpc.queuedBytes, 0)
  const frames = decodeAll(output.chunks)
  assert.deepEqual(
    frames.map(({ type, params, method }) => [type, params ?? method]),
    [
      ['event', 'a'],
      ['request', 'job'],
      ['event', 'b'],
    ],
  )
})

test('the outgoing queue rejects writes past its byte cap', async (t) => {
  const output = gate()
  const rpc = new FramedRpc(new PassThrough(), output.writable, {
    maxFrameBytes: 1024,
    maxQueuedBytes: 1100,
  })
  t.after(() => rpc.close())
  const payload = (label) => label.padEnd(200, 'x')
  await rpc.notify('log', payload('first'))
  const size = output.chunks[0].length
  const count = Math.floor(1100 / size)
  const labels = Array.from({ length: count }, (_, index) => String(index))
  const queued = labels.map((label) => rpc.notify('log', payload(label)))
  assert.equal(rpc.queuedBytes, count * size)
  await assert.rejects(rpc.notify('log', payload('9')), {
    code: 'queue_full',
    status: 503,
  })
  await assert.rejects(rpc.request('job', payload('9')), { code: 'queue_full' })
  assert.equal(rpc.pendingRequests, 0)
  assert.equal(rpc.queuedBytes, count * size)

  for (let step = 0; step < 20 && output.chunks.length <= count; step++) {
    output.release()
    await tick()
  }
  await Promise.all(queued)
  assert.equal(rpc.queuedBytes, 0)
  assert.deepEqual(
    decodeAll(output.chunks).map(({ params }) => params),
    ['first', ...labels].map(payload),
  )
  const after = rpc.notify('log', 'after')
  output.release()
  await after
})

test('values that cannot be framed fail without closing the connection', async (t) => {
  const { left, right } = pair(t, { maxFrameBytes: 4096, maxQueuedBytes: 8192 })
  right.handle('huge', () => 'x'.repeat(5000))
  right.handle('bigint', () => 1n)
  await assert.rejects(left.request('huge'), { code: 'frame_too_large' })
  await assert.rejects(left.request('bigint'), { code: 'invalid_message' })
  await assert.rejects(left.request('echo', 'x'.repeat(5000)), {
    code: 'frame_too_large',
  })
  await assert.rejects(left.notify('log', 1n), { code: 'invalid_message' })
  assert.equal(left.pendingRequests, 0)
  right.handle('echo', (value) => value)
  assert.equal(await left.request('echo', 'still open'), 'still open')
})

for (const side of ['readable', 'writable'])
  test(`a ${side} stream error rejects pending work once`, async (t) => {
    const reasons = trackUnhandled(t)
    const input = new PassThrough()
    const output = gate()
    const rpc = new FramedRpc(input, output.writable)
    t.after(() => rpc.close())
    const closes = []
    rpc.on('close', (error) => closes.push(error))
    const controller = new AbortController()
    const pending = rpc.request('job', null, { signal: controller.signal })
    const queued = rpc.notify('later')
    rpc.notify('ignored')
    assert.ok(rpc.queuedBytes > 0)
    const failure = new Error('fixture stream failed')
    const stream = side === 'readable' ? input : output.writable
    stream.destroy(failure)
    await assert.rejects(
      pending,
      (error) => error.code === 'connection_failed' && error.cause === failure,
    )
    await assert.rejects(queued, { code: 'connection_failed' })
    await tick()
    assert.equal(closes.length, 1)
    assert.equal(closes[0].cause, failure)
    assert.equal(rpc.pendingRequests, 0)
    assert.equal(rpc.queuedBytes, 0)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    assert.equal(input.destroyed, true)
    assert.equal(output.writable.destroyed, true)

    rpc.close(new Error('second close'))
    input.emit('error', new Error('late stream error'))
    await tick()
    assert.equal(closes.length, 1)
    await assert.rejects(rpc.request('again'), { code: 'connection_closed' })
    await assert.rejects(rpc.notify('again'), { code: 'connection_closed' })
    assert.deepEqual(reasons, [])
  })

for (const [name, stop] of [
  ['the readable is destroyed', ({ input }) => input.destroy()],
  ['the writable is ended elsewhere', ({ output }) => output.end()],
])
  test(`pending requests are rejected when ${name}`, async (t) => {
    const fixture = peer(t)
    const pending = fixture.rpc.request('job')
    await fixture.next()
    stop(fixture)
    assert.equal((await fixture.closed).code, 'connection_closed')
    await assert.rejects(pending, { code: 'connection_closed' })
  })

test('closing ends the peer normally and rejects outstanding calls', async (t) => {
  const { left, right } = pair(t)
  left.handle('hang', () => new Promise(() => {}))
  right.handle('hang', () => new Promise(() => {}))
  const fromLeft = left.request('hang')
  const fromRight = right.request('hang')
  await until(() => left.activeHandlers === 1 && right.activeHandlers === 1)
  const closes = Promise.all([once(left, 'close'), once(right, 'close')])
  left.close()
  assert.deepEqual(await closes, [[undefined], [undefined]])
  await assert.rejects(fromLeft, { code: 'connection_closed' })
  await assert.rejects(fromRight, { code: 'connection_closed' })
  await assert.rejects(left.request('hang'), { code: 'connection_closed' })
})

test('one duplex stream can carry both directions', async (t) => {
  const [near, far] = duplexPair()
  const left = new FramedRpc(near, near)
  const right = new FramedRpc(far, far)
  t.after(() => {
    left.close()
    right.close()
  })
  left.handle('echo', (value) => value)
  right.handle('echo', (value) => value)
  const fromLeft = { from: 'left' }
  const fromRight = { from: 'right' }
  assert.deepEqual(await left.request('echo', fromLeft), fromLeft)
  assert.deepEqual(await right.request('echo', fromRight), fromRight)
  const closes = Promise.all([once(left, 'close'), once(right, 'close')])
  right.close()
  assert.deepEqual(await closes, [[undefined], [undefined]])
})

test('work finishing after close leaves no unhandled rejections', async (t) => {
  const reasons = trackUnhandled(t)
  const { rpc, send } = peer(t)
  const release = Promise.withResolvers()
  rpc.handle('fails', async () => {
    await release.promise
    throw new Error('late failure')
  })
  rpc.handle('succeeds', async () => {
    await release.promise
    return 'late'
  })
  send({ type: 'request', id: 'a', method: 'fails' })
  send({ type: 'request', id: 'b', method: 'succeeds' })
  await until(() => rpc.activeHandlers === 2)
  rpc.close()
  rpc.notify('after-close')
  release.resolve()
  await until(() => rpc.activeHandlers === 0)
  await tick()
  assert.deepEqual(reasons, [])
})

test('a throwing notification listener closes the connection', async (t) => {
  const { rpc, send, closed } = peer(t)
  const failure = new Error('listener bug')
  rpc.on('notification', () => {
    throw failure
  })
  assert.doesNotThrow(() => send({ type: 'event', method: 'note' }))
  const error = await closed
  assert.equal(error.code, 'listener_failed')
  assert.equal(error.cause, failure)
})

test('invalid options and registrations are rejected', () => {
  const streams = () => [new PassThrough(), new PassThrough()]
  for (const options of [
    { maxFrameBytes: 0 },
    { maxFrameBytes: 1.5 },
    { maxFrameBytes: 2 ** 32 },
    { maxQueuedBytes: 1024 },
    { maxPendingRequests: -1 },
    { maxConcurrentHandlers: '4' },
    { requestTimeoutMs: 2 ** 31 },
  ])
    assert.throws(() => new FramedRpc(...streams(), options), RangeError)
  assert.throws(() => new FramedRpc(null, new PassThrough()), TypeError)
  const rpc = new FramedRpc(...streams())
  for (const method of ['__proto__', 'a b', '', 'x'.repeat(129)])
    assert.throws(() => rpc.handle(method, () => {}), TypeError)
  assert.throws(() => rpc.handle('job', 'not a function'), TypeError)
  rpc.handle('job', () => {})
  assert.throws(() => rpc.handle('job', () => {}), /already has a handler/)
  rpc.close()
})
