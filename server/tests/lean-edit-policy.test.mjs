import assert from 'node:assert/strict'
import test from 'node:test'
import { LeanEditPolicy } from '../lean-edit-policy.mjs'
import { LeanRequests } from '../lean-requests.mjs'

function fixture() {
  const client = [],
    lean = []
  const requests = new LeanRequests({
    sendToClient: (message) => client.push(message),
  })
  const policy = new LeanEditPolicy({
    sendToClient: (message) => {
      if (requests.receive(message)) client.push(message)
    },
    sendToLean: (message) => lean.push(message),
  })
  const send = (message) => {
    requests.track(message)
    return policy.client(message)
  }
  return { client, lean, requests, policy, send }
}

test('direct rename, code actions, commands and file-operation refactors are rejected without leaking pending requests', () => {
  const f = fixture()
  for (const method of [
    'textDocument/prepareRename',
    'textDocument/rename',
    'textDocument/codeAction',
    'codeAction/resolve',
    'workspace/executeCommand',
    'workspace/willCreateFiles',
    'workspace/willRenameFiles',
    'workspace/willDeleteFiles',
  ]) {
    assert.equal(
      f.send({ id: 1, method, params: { newName: 'blankC' } }),
      false,
    )
    assert.equal(f.client.at(-1).error.code, -32803)
    assert.match(f.client.at(-1).error.message, /program meaning/)
    assert.equal(f.requests.pending.size, 0)
  }
  assert.deepEqual(f.lean, [])
  assert.equal(f.send({ method: 'textDocument/rename', params: {} }), false)
  assert.equal(f.client.length, 8, 'Notifications have no response')
})

test('initialization removes unsafe providers while preserving diagnostics, hover and definition capabilities', () => {
  const f = fixture()
  const request = {
    id: 1,
    method: 'initialize',
    params: { capabilities: { workspace: { applyEdit: true } } },
  }
  assert(f.send(request))
  assert.equal(request.params.capabilities.workspace.applyEdit, false)
  const result = {
    id: 1,
    result: {
      capabilities: {
        renameProvider: { prepareProvider: true },
        codeActionProvider: { resolveProvider: true },
        executeCommandProvider: { commands: ['refactor'] },
        workspace: {
          fileOperations: { willRename: {} },
          workspaceFolders: { supported: true },
        },
        hoverProvider: true,
        definitionProvider: true,
        diagnosticProvider: { interFileDependencies: true },
      },
    },
  }
  assert(f.policy.server(result))
  const caps = result.result.capabilities
  assert.equal(caps.renameProvider, false)
  assert.equal(caps.codeActionProvider, false)
  assert.equal(caps.executeCommandProvider, undefined)
  assert.equal(caps.workspace.fileOperations, undefined)
  assert(caps.workspace.workspaceFolders.supported)
  assert(
    caps.hoverProvider && caps.definitionProvider && caps.diagnosticProvider,
  )
})

test('server-initiated workspace edits are refused for all edit shapes without reaching the browser', () => {
  const f = fixture()
  for (const edit of [
    {
      changes: { 'file:///workspace/Main.lean': [{ newText: 'wrong source' }] },
    },
    {
      documentChanges: [{ kind: 'delete', uri: 'file:///workspace/Main.lean' }],
    },
    {
      documentChanges: [
        {
          textDocument: { uri: 'file:///workspace/Use.lean', version: 3 },
          edits: [],
        },
      ],
    },
  ]) {
    assert.equal(
      f.policy.server({
        id: 'apply',
        method: 'workspace/applyEdit',
        params: { edit },
      }),
      false,
    )
    assert.equal(f.lean.at(-1).id, 'apply')
    assert.equal(f.lean.at(-1).result.applied, false)
    assert.match(f.lean.at(-1).result.failureReason, /disabled/)
  }
  assert.deepEqual(f.client, [])
})

test('mixed dynamic registrations preserve read features and cannot silently re-enable mutations', () => {
  const f = fixture()
  const request = {
    id: 'register',
    method: 'client/registerCapability',
    params: {
      registrations: [
        { id: 'rename', method: 'textDocument/rename' },
        { id: 'commands', method: 'workspace/executeCommand' },
        { id: 'hover', method: 'textDocument/hover' },
      ],
    },
  }
  assert(f.policy.server(request))
  assert.deepEqual(request.params.registrations, [
    { id: 'hover', method: 'textDocument/hover' },
  ])
  const blocked = {
    id: 'unsafe',
    method: 'client/registerCapability',
    params: {
      registrations: [{ id: 'action', method: 'textDocument/codeAction' }],
    },
  }
  assert.equal(f.policy.server(blocked), false)
  assert.deepEqual(f.lean.at(-1), {
    jsonrpc: '2.0',
    id: 'unsafe',
    result: null,
  })
  const unregister = {
    id: 'unregister',
    method: 'client/unregisterCapability',
    params: {
      unregisterations: [{ id: 'rename', method: 'textDocument/rename' }],
    },
  }
  assert.equal(f.policy.server(unregister), false)
  assert.equal(f.lean.at(-1).id, 'unregister')
})

test('normal editing, cancellation, hover, definition and Lean Info RPC stay on the existing transport', () => {
  const f = fixture()
  for (const method of [
    'textDocument/didOpen',
    'textDocument/didChange',
    'textDocument/didSave',
    'textDocument/hover',
    'textDocument/definition',
    '$/lean/rpc/call',
    '$/cancelRequest',
  ])
    assert(f.policy.client({ method, params: {} }))
  assert(
    f.policy.server({ method: 'textDocument/publishDiagnostics', params: {} }),
  )
  f.policy.dispose()
  assert.deepEqual(f.client, [])
  assert.deepEqual(f.lean, [])
})
