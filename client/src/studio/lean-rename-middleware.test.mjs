import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

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
        return { RenameRequest: { type: 'textDocument/rename' } }
      if (name.includes('leanEditorProvider'))
        return { lean: { leanDocuments: [{ doc: foreign }, { doc: main }] } }
      if (name === './workspaceBuffers') return {}
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
    { indexTimeoutMs: 20 },
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

test('only the visible document is opened or changed in Lean, including during rename preload', async () => {
  const f = fixture(async () => ({})),
    token = new Cancellation().token
  const sent = []
  await f.middleware.didOpen(f.foreign, async () => sent.push('foreign'))
  await f.middleware.didOpen(f.main, async () => sent.push('main'))
  await f.middleware.didChange({ document: f.foreign }, async () =>
    sent.push('hidden change'),
  )
  await f.middleware.prepareRename(f.main, {}, token, async () => ({
    prepared: true,
  }))
  assert.deepEqual(sent, [])
  assert.deepEqual(
    f.notifications.map((n) => [n.method, n.params.textDocument.uri]),
    [['textDocument/didOpen', f.main.uri.toString()]],
  )
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0][1].uri, f.main.uri.toString())
})

test('a crashed index worker times out with a useful error and never opens the rename box', async () => {
  let requestToken
  const f = fixture((_method, _params, token) => {
    requestToken = token
    return new Promise(() => {})
  })
  let prepared = false
  await assert.rejects(
    f.middleware.prepareRename(
      f.main,
      {},
      new Cancellation().token,
      async () => {
        prepared = true
      },
    ),
    /Restart Lean/,
  )
  assert.equal(prepared, false)
  assert.equal(requestToken.isCancellationRequested, true)
})

test('older pinned servers without an index barrier keep their native rename preparation', async () => {
  const f = fixture(async () => {
    throw Object.assign(new Error('method not found'), { code: -32601 })
  })
  const token = new Cancellation().token
  assert.equal(
    await f.middleware.prepareRename(f.main, {}, token, async () => 'prepared'),
    'prepared',
  )
  assert.equal(
    await f.middleware.prepareRename(f.main, {}, token, async () => 'again'),
    'again',
  )
  assert.equal(f.calls.length, 1)
})

test('a second rename cannot silently omit other unsaved hidden buffers', async () => {
  const f = fixture(async () => ({}))
  f.context.hiddenDirty = true
  await assert.rejects(
    f.middleware.prepareRename(f.main, {}, new Cancellation().token, async () =>
      assert.fail(),
    ),
    /Save all/,
  )
  assert.equal(f.calls.length, 0)
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
})
