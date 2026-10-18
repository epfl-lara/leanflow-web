import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LeanWidgetPolicy,
  LEAN_WIDGET_DISABLED_MESSAGE,
} from '../lean-widget-policy.mjs'
import { LeanRequests } from '../lean-requests.mjs'

function fixture() {
  const client = [],
    lean = []
  const requests = new LeanRequests({
    sendToClient: (message) => client.push(message),
  })
  const policy = new LeanWidgetPolicy({
    sendToClient: (message) => {
      if (requests.receive(message)) client.push(message)
    },
    sendToLean: (message) => lean.push(message),
  })
  const send = (message) => {
    requests.track(message)
    if (policy.client(message)) lean.push(message)
  }
  return { client, lean, policy, requests, send }
}

test('widget source RPC and direct requests never reach Lean or leave pending requests', () => {
  const f = fixture()
  for (const method of ['$/lean/rpc/call', 'Lean.Widget.getWidgetSource']) {
    f.send({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        method: 'Lean.Widget.getWidgetSource',
        sessionId: '1',
        params: { hash: '123' },
      },
    })
    assert.deepEqual(f.client.at(-1), {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32803, message: LEAN_WIDGET_DISABLED_MESSAGE },
    })
    assert.equal(f.requests.pending.size, 0)
  }
  f.send({
    method: '$/lean/rpc/call',
    params: { method: 'Lean.Widget.getWidgetSource' },
  })
  assert.equal(f.client.length, 2)
  assert.deepEqual(f.lean, [])
})

test('panel widget enumeration returns an empty list without breaking ordinary interactive RPCs', () => {
  const f = fixture()
  f.send({
    id: 1,
    method: '$/lean/rpc/call',
    params: { method: 'Lean.Widget.getWidgets' },
  })
  assert.deepEqual(f.client[0], {
    jsonrpc: '2.0',
    id: 1,
    result: { widgets: [] },
  })
  for (const [id, method] of [
    [2, 'Lean.Widget.getInteractiveGoals'],
    [3, 'Lean.Widget.getInteractiveTermGoal'],
    [4, 'Lean.Widget.getInteractiveDiagnostics'],
    [5, 'Lean.Widget.getGoToLocation'],
  ]) {
    const request = { id, method: '$/lean/rpc/call', params: { method } }
    f.send(request)
    assert.deepEqual(f.lean.at(-1), request)
    const response = { id, result: { goals: [] } }
    assert(f.policy.server(response))
    assert(f.requests.receive(response))
  }
  assert.equal(f.requests.pending.size, 0)
})

test('forged widget source replies and server widget requests cannot deliver JavaScript to the browser', () => {
  const f = fixture()
  const source =
    'globalThis.untrustedWidgetExecuted = true; export default () => null'
  for (const id of [1, 'unsolicited'])
    assert.equal(f.policy.server({ id, result: { sourcetext: source } }), false)
  assert.equal(
    f.policy.server({
      method: 'Lean.Widget.getWidgetSource',
      params: { sourcetext: source },
    }),
    false,
  )
  assert.equal(
    f.policy.server({
      id: 'server-request',
      method: '$/lean/rpc/call',
      params: { method: 'Lean.Widget.getWidgetSource' },
    }),
    false,
  )
  assert.equal(f.lean.at(-1).error.message, LEAN_WIDGET_DISABLED_MESSAGE)
  assert(!JSON.stringify(f.client).includes(source))
  assert(f.client.every((message) => message.error?.code === -32803))
  assert(
    f.policy.server({
      method: 'textDocument/publishDiagnostics',
      params: { diagnostics: [] },
    }),
  )
})
