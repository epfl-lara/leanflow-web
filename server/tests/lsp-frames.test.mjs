import test from 'node:test'
import assert from 'node:assert/strict'
import { LspFrames, frame } from '../rpc.mjs'

test('Lean frames preserve UTF-8 messages across every header and body split', () => {
  const message = {
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: { message: '∀ x, café 🦉 → λ' },
  }
  const bytes = Buffer.from(frame(message))
  for (let split = 0; split <= bytes.length; split++) {
    const received = []
    const parser = new LspFrames((value) => received.push(value))
    parser.push(bytes.subarray(0, split))
    if (split < bytes.length) assert.deepEqual(received, [])
    parser.push(bytes.subarray(split))
    assert.deepEqual(received, [message])
  }
})

test('coalesced Lean frames and a following fragmented body dispatch once in order', () => {
  const messages = [
    { id: 1, result: { goals: ['α'] } },
    { method: 'fixture/update', params: { text: 'x'.repeat(4096) } },
    { id: 2, result: 'complete' },
  ]
  const received = []
  const parser = new LspFrames((value) => received.push(value))
  const first = Buffer.from(frame(messages[0]))
  const second = Buffer.from(frame(messages[1]))
  parser.push(Buffer.concat([first, second.subarray(0, 40)]))
  assert.deepEqual(received, [messages[0]])
  for (let offset = 40; offset < second.length; offset += 7)
    parser.push(second.subarray(offset, offset + 7))
  parser.push(Buffer.from(frame(messages[2])))
  assert.deepEqual(received, messages)
})

test('large Lean bodies remain exact with many small fragments and retain the configured byte limit', () => {
  const message = { id: 1, result: 'x'.repeat(1024 * 1024) }
  const bytes = Buffer.from(frame(message))
  const received = []
  const parser = new LspFrames((value) => received.push(value))
  for (let offset = 0; offset < bytes.length; offset += 257)
    parser.push(bytes.subarray(offset, offset + 257))
  assert.deepEqual(received, [message])
  const bodyLength = Buffer.byteLength(JSON.stringify(message))
  new LspFrames(() => {}, bodyLength).push(bytes)
  assert.throws(
    () => new LspFrames(() => {}, bodyLength - 1).push(bytes),
    /Invalid Lean message length/,
  )
})

test('Lean frame parsing rejects malformed JSON, non-object envelopes and invalid lengths', () => {
  for (const body of ['x', 'null', '[]', '123', '"text"']) {
    const received = []
    const parser = new LspFrames((value) => received.push(value))
    assert.throws(() =>
      parser.push(
        Buffer.from(
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        ),
      ),
    )
    assert.deepEqual(received, [])
  }
  for (const header of [
    'Content-Type: application/json',
    'Content-Length: -1',
    'Content-Length: invalid',
    'Content-Length: 67108865',
  ])
    assert.throws(
      () => new LspFrames(() => {}).push(Buffer.from(header + '\r\n\r\n')),
      /Invalid Lean message length/,
    )
})

test('Lean header bounds apply to completed and fragmented headers', () => {
  const header = 'Content-Length: 2\r\nX-Extra: ' + 'x'.repeat(8192)
  assert.throws(
    () => new LspFrames(() => {}).push(Buffer.from(header + '\r\n\r\n{}')),
    /Invalid Lean message header/,
  )
  const parser = new LspFrames(() => {})
  parser.push(Buffer.from('x'.repeat(8192)))
  assert.throws(
    () => parser.push(Buffer.from('x')),
    /Invalid Lean message header/,
  )
  assert.throws(
    () => new LspFrames(() => {}, 8).push(Buffer.alloc(8 + 8193)),
    /Lean message exceeded the transport limit/,
  )
})
