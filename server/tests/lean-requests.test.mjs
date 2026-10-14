import assert from 'node:assert/strict'
import test from 'node:test'
import { LeanRequests } from '../lean-requests.mjs'

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lean = [],
    client = []
  const requests = new LeanRequests({
    sendToLean: (message) => lean.push(message),
    sendToClient: (message) => client.push(message),
  })
  t.after(() => requests.dispose())
  return { lean, client, requests }
}

test('slow healthy Lean info replies remain valid after 90 seconds without an error or warning', (t) => {
  const { requests, lean, client } = fixture(t)
  requests.track({ id: 1, method: '$/lean/rpc/call' })
  t.mock.timers.tick(90_000)
  assert.deepEqual(lean, [])
  assert.deepEqual(client, [])
  assert.equal(requests.receive({ id: 1, result: 'valid slow result' }), true)
  assert.equal(
    requests.receive({ method: 'textDocument/publishDiagnostics', params: {} }),
    true,
  )
  requests.track({ id: 2, method: 'textDocument/hover' })
  assert.equal(requests.receive({ id: 2, result: 'still responsive' }), true)
})

test('successful replies clear deadlines and keep completion bounds', (t) => {
  const { requests, lean, client } = fixture(t)
  requests.track({ id: 1, method: 'textDocument/completion' })
  const response = {
    id: 1,
    result: {
      items: Array.from({ length: 301 }, (_, i) => ({ label: String(i) })),
    },
  }
  assert.equal(requests.receive(response), true)
  assert.equal(response.result.items.length, 300)
  assert.equal(response.result.isIncomplete, true)
  t.mock.timers.tick(60_000)
  assert.deepEqual(lean, [])
  assert.deepEqual(client, [])
})

test('closing a connection clears outstanding timers', (t) => {
  const { requests, lean, client } = fixture(t)
  requests.track({ id: 1, method: 'textDocument/hover' })
  requests.dispose()
  t.mock.timers.tick(60_000)
  assert.deepEqual(lean, [])
  assert.deepEqual(client, [])
})

test('client cancellation settles a stalled request without showing a timeout warning later', (t) => {
  const { requests, lean, client } = fixture(t)
  requests.track({ id: 1, method: 'textDocument/documentSymbol' })
  requests.track({ method: '$/cancelRequest', params: { id: 1 } })
  assert.equal(client.length, 1)
  assert.equal(client[0].error.code, -32800)
  t.mock.timers.tick(60_000)
  assert.equal(client.length, 1)
  assert.deepEqual(lean, [])
  assert.equal(
    requests.receive({ id: 1, result: 'late cancelled result' }),
    false,
  )
  requests.track({ id: 1, method: 'textDocument/hover' })
  assert.equal(requests.receive({ id: 1, result: 'new request' }), true)
})
