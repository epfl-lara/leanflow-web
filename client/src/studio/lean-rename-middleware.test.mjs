import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import * as editPolicy from '../../../shared/lean-edit-policy.mjs'

const code = ts.transpileModule(
  fs.readFileSync(
    new URL('./leanRenameMiddleware.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText
const visibleCode = ts.transpileModule(
  fs.readFileSync(
    new URL('./visibleLeanDocuments.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText
class Cancellation {
  constructor() {
    this.listeners = new Set()
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: (f) => {
        this.listeners.add(f)
        return { dispose: () => this.listeners.delete(f) }
      },
    }
  }
  cancel() {
    this.token.isCancellationRequested = true
    for (const f of this.listeners) f()
  }
  dispose() {
    this.listeners.clear()
  }
}
function fixture(sendRequest) {
  const main = {
    uri: { toString: () => 'file:///workspace/Main.lean' },
    version: 3,
  }
  const foreign = {
    uri: { toString: () => 'file:///outside/Library.lean' },
    version: 7,
  }
  const module = { exports: {} },
    issues = [],
    calls = []
  new Function('exports', 'module', 'require', code)(
    module.exports,
    module,
    (name) => {
      if (name === 'monaco-editor')
        return { CancellationTokenSource: Cancellation }
      if (name === 'vscode-languageserver-protocol')
        return { CancellationToken: { None: new Cancellation().token } }
      if (name.includes('leanEditorProvider'))
        return { lean: { leanDocuments: [{ doc: foreign }, { doc: main }] } }
      if (name === './workspaceBuffers') return {}
      if (name === '../../../shared/lean-edit-policy.mjs') return editPolicy
      if (name === './visibleLeanDocuments') {
        const visibleModule = { exports: {} }
        new Function('exports', 'module', visibleCode)(
          visibleModule.exports,
          visibleModule,
        )
        return visibleModule.exports
      }
      throw new Error('Unexpected import ' + name)
    },
  )
  const notifications = []
  const client = {
    isRunning: () => true,
    onDidChangeState: () => ({ dispose() {} }),
    sendNotification: async (method, params) => {
      notifications.push({ method, params })
    },
    code2ProtocolConverter: {
      asOpenTextDocumentParams: (doc) => ({
        textDocument: {
          uri: doc.uri.toString(),
          version: doc.version,
          languageId: 'lean4',
          text: doc.text ?? 'initial',
        },
      }),
      asCloseTextDocumentParams: (doc) => ({
        textDocument: { uri: doc.uri.toString() },
      }),
    },
    clientOptions: {},
    sendRequest: (...args) => {
      calls.push(args)
      return sendRequest(...args)
    },
  }
  const context = { uri: main.uri.toString(), hiddenDirty: false }
  const controller = module.exports.installLeanRenameMiddleware(
    client,
    () => context,
    (text) => issues.push(text),
    async () => {},
  )
  return {
    client,
    controller,
    notifications,
    context,
    main,
    foreign,
    issues,
    calls,
    middleware: client.clientOptions.middleware,
  }
}

test('only the visible document is opened or changed in Lean while rename is disabled', async () => {
  const f = fixture(async () => ({})),
    token = new Cancellation().token
  const sent = []
  await f.middleware.didOpen(f.foreign, async () => sent.push('foreign'))
  await f.middleware.didOpen(f.main, async () => sent.push('main'))
  await f.middleware.didChange({ document: f.foreign }, async () =>
    sent.push('hidden change'),
  )
  await assert.rejects(
    async () =>
      f.middleware.prepareRename(f.main, {}, token, () => assert.fail()),
    /disabled/,
  )
  assert.deepEqual(sent, [])
  assert.deepEqual(
    f.notifications.map((n) => [n.method, n.params.textDocument.uri]),
    [['textDocument/didOpen', f.main.uri.toString()]],
  )
  assert.equal(f.calls.length, 0)
})

test('rename cannot prepare or apply edits, including when Lean or an older client advertised support', async () => {
  const f = fixture(async () =>
    assert.fail('No rename or index request may reach Lean'),
  )
  const token = new Cancellation().token
  await assert.rejects(
    async () =>
      f.middleware.prepareRename(f.main, {}, token, () => assert.fail()),
    /disabled/,
  )
  assert.equal(
    await f.middleware.provideRenameEdits(f.main, {}, 'blankC', token, () =>
      assert.fail(),
    ),
    null,
  )
  assert.equal(f.calls.length, 0)
  assert.match(f.issues.at(-1), /program meaning/)
})

test('cancelled rename neither edits buffers nor presents an error', async () => {
  const f = fixture(async () => assert.fail()),
    cancellation = new Cancellation()
  cancellation.cancel()
  assert.equal(
    await f.middleware.prepareRename(f.main, {}, cancellation.token, () =>
      assert.fail(),
    ),
    null,
  )
  assert.equal(
    await f.middleware.provideRenameEdits(
      f.main,
      {},
      'blankC',
      cancellation.token,
      () => assert.fail(),
    ),
    null,
  )
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.issues, [])
})

test('code actions and command-backed refactors cannot bypass the disabled rename path', async () => {
  const f = fixture(async () => assert.fail()),
    token = new Cancellation().token
  assert.deepEqual(
    await f.middleware.provideCodeActions(f.main, {}, {}, token, () =>
      assert.fail(),
    ),
    [],
  )
  assert.throws(
    () => f.middleware.resolveCodeAction({}, token, () => assert.fail()),
    /disabled/,
  )
  assert.throws(
    () =>
      f.middleware.executeCommand('unsafe.refactor', [], () => assert.fail()),
    /disabled/,
  )
  assert.equal(f.calls.length, 0)
})

test('dynamic capabilities keep navigation but cannot re-enable edit providers', async () => {
  const f = fixture(async () => assert.fail())
  let forwarded
  await f.middleware.handleRegisterCapability(
    {
      registrations: [
        { id: 'rename', method: 'textDocument/rename' },
        { id: 'action', method: 'textDocument/codeAction' },
        { id: 'hover', method: 'textDocument/hover' },
      ],
    },
    async (params) => {
      forwarded = params
    },
  )
  assert.deepEqual(forwarded.registrations, [
    { id: 'hover', method: 'textDocument/hover' },
  ])
})

test('switching files explicitly closes the old document before opening the new one', async () => {
  const f = fixture(async () => ({}))
  await f.controller.showVisible()
  f.foreign.uri.toString = () => 'file:///workspace/Use.lean'
  f.context.uri = f.foreign.uri.toString()
  await f.controller.closeHidden()
  await f.controller.showVisible()
  assert.deepEqual(
    f.notifications.map((entry) => [
      entry.method,
      entry.params.textDocument.uri,
    ]),
    [
      ['textDocument/didOpen', 'file:///workspace/Main.lean'],
      ['textDocument/didClose', 'file:///workspace/Main.lean'],
      ['textDocument/didOpen', 'file:///workspace/Use.lean'],
    ],
  )
})

test('typing during an import refresh is included once in the new document, without replaying old changes', async () => {
  const f = fixture(async () => ({}))
  await f.controller.showVisible()
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const send = f.client.sendNotification
  f.client.sendNotification = async (...args) => {
    if (args[0] === 'textDocument/didClose') await gate
    return send(...args)
  }
  const refreshing = f.controller.refreshVisible()
  await Promise.resolve()
  f.main.version++
  f.main.text = 'typed during refresh'
  let replayed = false
  const changed = f.middleware.didChange(
    { document: f.main, contentChanges: [{ text: 'new text' }] },
    async () => {
      replayed = true
    },
  )
  release()
  await refreshing
  await changed
  assert.equal(replayed, false)
  assert.equal(
    f.notifications.at(-1).params.textDocument.text,
    'typed during refresh',
  )
  assert.equal(
    f.notifications.at(-1).params.textDocument.version,
    f.main.version,
  )
  assert(
    f.notifications
      .filter((entry) => entry.method === 'textDocument/didOpen')
      .every((entry) => entry.params.dependencyBuildMode === 'always'),
    'normal and refreshed workers must still build imports after later header edits',
  )
})

test('returning to a retained document reuses its worker and protocol version', async () => {
  const f = fixture(async () => ({}))
  const retained = new Set([f.main.uri.toString()])
  f.context.retained = (uri) => retained.has(uri)
  await f.controller.showVisible()
  f.foreign.uri.toString = () => 'file:///workspace/Use.lean'
  f.context.uri = f.foreign.uri.toString()
  await f.controller.closeHidden()
  await f.controller.showVisible()
  retained.add(f.foreign.uri.toString())
  f.context.uri = f.main.uri.toString()
  await f.controller.closeHidden()
  await f.controller.showVisible()
  assert.deepEqual(
    f.notifications.map((entry) => [
      entry.method,
      entry.params.textDocument.uri,
    ]),
    [
      ['textDocument/didOpen', 'file:///workspace/Main.lean'],
      ['textDocument/didOpen', 'file:///workspace/Use.lean'],
    ],
  )
  retained.delete(f.foreign.uri.toString())
  await f.controller.closeHidden()
  assert.equal(f.notifications.at(-1).method, 'textDocument/didClose')
  assert.equal(
    f.notifications.at(-1).params.textDocument.uri,
    'file:///workspace/Use.lean',
  )
})
