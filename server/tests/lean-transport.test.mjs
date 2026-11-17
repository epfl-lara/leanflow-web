import assert from 'node:assert/strict'
import test from 'node:test'
import { Writable } from 'node:stream'
import { leanTransport } from '../lean-transport.mjs'
import { frame } from '../rpc.mjs'

function fixture(t, maxBufferedBytes = 512, options = {}) {
  const sent = [],
    closed = [],
    written = []
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    send(text) {
      sent.push(text)
    },
    close(code, message) {
      closed.push({ code, message })
    },
  }
  const child = {
    stdin: new Writable({
      write(chunk, _encoding, _callback) {
        written.push(chunk.toString())
        // Simulate a Lean worker that has stopped consuming stdin.
      },
    }),
    kills: 0,
    kill() {
      this.kills++
    },
  }
  t.after(() => child.stdin.destroy())
  return {
    ws,
    child,
    sent,
    closed,
    written,
    transport: leanTransport(ws, child, { maxBufferedBytes, ...options }),
  }
}

test('ordinary Lean messages retain their JSON and UTF-8 LSP framing', (t) => {
  const f = fixture(t)
  const message = { jsonrpc: '2.0', method: 'fixture', params: { text: 'αβ' } }
  assert.equal(f.transport.sendToClient(message), true)
  assert.deepEqual(f.sent, [JSON.stringify(message)])
  assert.equal(f.transport.sendToLean(message), true)
  assert.deepEqual(f.written, [frame(message)])
  assert.equal(f.closed.length, 0)
})

test('a non-reading browser cannot grow the Lean websocket backlog without a bound', (t) => {
  const f = fixture(t)
  f.ws.send = (text) => {
    f.sent.push(text)
    f.ws.bufferedAmount += Buffer.byteLength(text)
  }
  const message = {
    jsonrpc: '2.0',
    method: 'fixture',
    params: { text: 'α'.repeat(32) },
  }
  for (let i = 0; i < 20; i++) f.transport.sendToClient(message)
  assert(f.sent.length > 0 && f.sent.length < 20)
  assert(
    f.ws.bufferedAmount <= 512 + Buffer.byteLength(JSON.stringify(message)),
  )
  assert.deepEqual(f.closed, [
    {
      code: 1013,
      message: 'Lean connection is busy. Reopen the project to reconnect.',
    },
  ])
  assert.equal(f.child.kills, 1)
  assert.equal(f.transport.sendToLean(message), false)
  assert.equal(f.written.length, 0)
})

test('a stalled Lean worker cannot queue unbounded edit frames', (t) => {
  const f = fixture(t)
  const message = {
    jsonrpc: '2.0',
    method: 'textDocument/didChange',
    params: { contentChanges: [{ text: 'fixture' }] },
  }
  for (let i = 0; i < 20; i++) f.transport.sendToLean(message)
  assert(
    f.child.stdin.writableLength > 0 &&
      f.child.stdin.writableLength <= 512 + Buffer.byteLength(frame(message)),
  )
  assert.equal(f.child.kills, 1)
  assert.equal(f.closed[0].code, 1013)
  assert.match(f.closed[0].message, /Reopen the project/)
  const before = f.child.stdin.writableLength
  assert.equal(f.transport.sendToLean(message), false)
  assert.equal(f.child.stdin.writableLength, before)
  assert.equal(f.transport.sendToClient(message), false)
})

test('one valid large frame can follow small progress output without changing frame limits', (t) => {
  const f = fixture(t)
  const message = { method: 'fixture', params: { text: 'x'.repeat(1024) } }
  f.ws.bufferedAmount = 32
  f.child.stdin.write('small progress packet')
  assert.equal(f.transport.sendToClient(message), true)
  assert.equal(f.transport.sendToLean(message), true)
  assert.equal(f.closed.length, 0)
  assert.equal(f.transport.sendToLean(message), false)
  assert.equal(f.child.kills, 1)
})

test('drained websocket traffic can continue and disposed transports stop forwarding', (t) => {
  const f = fixture(t)
  const message = { method: 'fixture', params: { text: 'x'.repeat(200) } }
  f.ws.bufferedAmount = 200
  assert.equal(f.transport.sendToClient(message), true)
  f.ws.bufferedAmount = 0
  assert.equal(f.transport.sendToClient(message), true)
  f.transport.dispose()
  assert.equal(f.transport.sendToClient(message), false)
  assert.equal(f.transport.sendToLean(message), false)
  assert.equal(f.sent.length, 2)
  assert.equal(f.closed.length, 0)
})

test('waiting connections have a strict smaller input bound, restored after admission', (t) => {
  let waiting = true
  const f = fixture(t, 1024, {
    isWaiting: () => waiting,
    waitingBufferedBytes: 256,
  })
  const message = { method: 'initialize', params: { text: 'α'.repeat(32) } }
  assert.equal(f.transport.sendToLean(message), true)
  assert.equal(f.transport.sendToLean(message), false)
  assert(f.child.stdin.writableLength <= 256)
  assert.equal(f.child.kills, 1)
  const admitted = fixture(t, 1024, {
    isWaiting: () => waiting,
    waitingBufferedBytes: 256,
  })
  waiting = false
  for (let i = 0; i < 4; i++)
    assert.equal(admitted.transport.sendToLean(message), true)
  assert(admitted.child.stdin.writableLength > 256)
  assert.equal(admitted.child.kills, 0)
})

test('one oversized waiting frame is refused without retaining its source', (t) => {
  const f = fixture(t, 1024, {
    isWaiting: () => true,
    waitingBufferedBytes: 256,
  })
  assert.equal(
    f.transport.sendToLean({
      method: 'fixture',
      params: { text: 'α'.repeat(256) },
    }),
    false,
  )
  assert.equal(f.child.stdin.writableLength, 0)
  assert.equal(f.child.kills, 1)
})
