import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { AgentRpc } from '../rpc.mjs'

function fixture(t, options) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.killed = 0
  child.kill = () => {
    child.killed++
    child.emit('close', 0)
  }
  const rpc = new AgentRpc(child, options)
  t.after(() => {
    child.kill()
    child.stdin.destroy()
    child.stdout.destroy()
  })
  return { child, rpc }
}

for (const value of [
  null,
  false,
  12,
  'worker output',
  [],
  { method: {} },
  { id: {} },
])
  test(`invalid Lemex envelope ${JSON.stringify(value)} fails only its session`, async (t) => {
    const { child, rpc } = fixture(t)
    const first = rpc.call('first'),
      second = rpc.call('second')
    const rejected = Promise.all([
      assert.rejects(first, /invalid message/),
      assert.rejects(second, /invalid message/),
    ])
    let closed = 0
    rpc.on('closed', () => closed++)
    assert.doesNotThrow(() => child.stdout.write(JSON.stringify(value) + '\n'))
    await rejected
    assert.equal(rpc.closed, true)
    assert.equal(rpc.pending.size, 0)
    assert.equal(child.killed, 1)
    assert.equal(closed, 1)
    assert.equal(child.stdout.listenerCount('data'), 0)
    assert.throws(() => rpc.send({ method: 'later' }), /connection is closed/)
  })

test('Lemex notification handler failures cannot escape the worker output listener', async (t) => {
  const { child, rpc } = fixture(t)
  rpc.on('notification', () => {
    throw new Error('Malformed worker event')
  })
  const pending = assert.rejects(rpc.call('first'), /invalid message/)
  assert.doesNotThrow(() => child.stdout.write('{"method":"fixture/event"}\n'))
  await pending
  assert.equal(child.killed, 1)
})

test('Lemex error payloads with non-string messages reject safely without leaking worker content', async (t) => {
  const { child, rpc } = fixture(t)
  const pending = assert.rejects(rpc.call('first'), (error) => {
    assert.equal(error.message, 'Lemex could not complete this request.')
    assert.equal(error.code, -1)
    return true
  })
  assert.doesNotThrow(() =>
    child.stdout.write(
      JSON.stringify({
        id: 1,
        error: {
          code: -1,
          message: { toString: null, secret: 'private-fixture' },
        },
      }) + '\n',
    ),
  )
  await pending
  assert.equal(rpc.closed, false)
  assert.equal(child.killed, 0)
})

test('Lemex byte limit rejects an unterminated message across arbitrarily small chunks', async (t) => {
  const { child, rpc } = fixture(t, { maxMessageBytes: 100 })
  const pending = assert.rejects(rpc.call('first'), /too much data/)
  for (let index = 0; index < 100; index++) child.stdout.write('x')
  assert.equal(rpc.closed, false)
  assert.doesNotThrow(() => child.stdout.write('x'))
  await pending
  assert.equal(child.killed, 1)
  // Output already buffered in the child pipe after cancellation is discarded.
  assert.doesNotThrow(() => child.stdout.write('null\n'.repeat(100)))
  assert.equal(child.killed, 1)
})

test('Lemex byte limit applies to each UTF-8 message, not the aggregate pipe chunk', async (t) => {
  const { child, rpc } = fixture(t, { maxMessageBytes: 100 })
  const first = rpc.call('first'),
    second = rpc.call('second')
  const text = '🧮'.repeat(10)
  const data = Buffer.from(
    JSON.stringify({ id: 2, result: text }) +
      '\r\n' +
      JSON.stringify({ id: 1, result: text }) +
      '\n',
  )
  assert(data.length > 100)
  // Split in the middle of one multi-byte codepoint, then process both lines.
  const split = data.indexOf(Buffer.from('🧮')) + 1
  child.stdout.write(data.subarray(0, split))
  child.stdout.write(data.subarray(split))
  assert.equal(await first, text)
  assert.equal(await second, text)
  assert.equal(rpc.closed, false)
})

test('Lemex keeps diagnostic text separate from responses and accepts a final non-newline response', async (t) => {
  const { child, rpc } = fixture(t)
  const logs = []
  rpc.on('log', (line) => logs.push(line))
  const result = rpc.call('first')
  child.stdout.write('Starting worker\r\n')
  child.stdout.end('{"id":1,"result":{"ready":true}}')
  assert.deepEqual(await result, { ready: true })
  assert.deepEqual(logs, ['Starting worker'])
})

test('Lemex stdout errors close only their session and reject outstanding requests', async (t) => {
  const { child, rpc } = fixture(t)
  const pending = assert.rejects(rpc.call('first'), /pipe failed/)
  assert.doesNotThrow(() =>
    child.stdout.emit('error', new Error('pipe failed')),
  )
  await pending
  assert.equal(rpc.closed, true)
  assert.equal(rpc.pending.size, 0)
})
