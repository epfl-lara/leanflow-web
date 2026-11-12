import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import {
  patchLeanClientWrapper,
  patchLanguageClientStartup,
} from '../../build/lean-client-compat.mjs'

const { outputText } = ts.transpileModule(
  fs.readFileSync(new URL('./leanClientLifecycle.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
)
const module = { exports: {} }
new Function('module', 'exports', outputText)(module, module.exports)
const { installLeanClientLifecycle } = module.exports
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const gate = deferred(),
    issues = [],
    options = { documentSelector: ['lean4'] }
  let calls = 0,
    stops = 0,
    erased = 0
  const clients = []
  const raw = {
    start: async () => {},
    stop: async () => {
      stops++
    },
  }
  const provider = {
    setupClient(input) {
      assert.equal(this, provider)
      assert.equal(input, options)
      calls++
      return gate.promise
    },
    async ensureClient() {
      const client = await this.setupClient(options)
      await client.start()
      clients.push(client)
      return [false, client]
    },
    getClients() {
      return clients
    },
    async eraseClient(root) {
      assert.equal(root, 'root')
      erased++
      clients.length = 0
    },
  }
  const lifecycle = installLeanClientLifecycle(
    provider,
    'root',
    (error) => issues.push(error),
    20,
  )
  return {
    gate,
    provider,
    lifecycle,
    raw,
    issues,
    get calls() {
      return calls
    },
    get stops() {
      return stops
    },
    get erased() {
      return erased
    },
  }
}

test('closing waits for the existing client factory and then stops its exact result without starting another client', async () => {
  const f = fixture()
  const starting = f.provider.ensureClient('root')
  let closed = false
  const closing = f.lifecycle.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  f.gate.resolve(f.raw)
  assert.equal((await starting)[1], f.raw)
  await closing
  assert.ok(f.stops >= 1)
  assert.equal(f.calls, 1)
  assert.deepEqual(await f.provider.ensureClient('root'), [false, undefined])
  assert.equal(f.calls, 1)
  assert.deepEqual(f.issues, [])
})

test('a cancelled initializing connection is handled and its failed provider entry can reopen', async () => {
  const f = fixture()
  const first = f.provider.ensureClient('root')
  f.gate.reject(
    new Error('Pending response rejected since connection got disposed'),
  )
  assert.deepEqual(await first, [false, undefined])
  assert.equal(f.erased, 1)
  assert.equal(f.issues.length, 1)
  const raw = { start: async () => {}, stop: async () => {} }
  f.provider.setupClient = async () => raw
  assert.equal((await f.provider.ensureClient('root'))[1], raw)
  await f.lifecycle.close()
})

test('an unresolved startup cannot deadlock closing and its eventual client is stopped', async () => {
  const f = fixture()
  const first = f.provider.ensureClient('root')
  await f.lifecycle.close()
  f.gate.resolve(f.raw)
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(f.stops >= 1)
  assert.deepEqual(f.issues, [])
})

test('an unresolved shutdown cannot deadlock the next project opening', async () => {
  const f = fixture()
  f.raw.stop = () => new Promise(() => {})
  f.gate.resolve(f.raw)
  await f.provider.ensureClient('root')
  const started = Date.now()
  await f.lifecycle.close()
  assert.ok(Date.now() - started < 500)
  assert.deepEqual(f.issues, [])
})

test('an unsupported provider shape fails with an actionable pinned-package error', () => {
  assert.throws(
    () =>
      installLeanClientLifecycle(
        { ensureClient() {}, getClients() {} },
        'root',
        () => {},
      ),
    /Restore the pinned editor packages/,
  )
})

test('the actual language client startup preserves its rejection when channel closure clears the shared startup field', async () => {
  const source = fs.readFileSync(
    new URL(
      '../../../node_modules/vscode-languageclient/lib/common/client.js',
      import.meta.url,
    ),
    'utf8',
  )
  const patched = patchLanguageClientStartup(source)
  const start = patched.indexOf('    async start() {')
  const end = patched.indexOf('\n    createOnStartPromise()', start)
  const makeStart = new Function(
    'ClientState',
    'vscode_languageserver_protocol_1',
    `return { ${patched.slice(start, end)} }.start`,
  )
  const failure = new Error(
    'Pending response rejected since connection got disposed',
  )
  const connection = { onNotification() {}, onRequest() {}, listen() {} }
  const gate = deferred()
  const owner = {
    _diagnostics: {},
    _notificationHandlers: new Map(),
    _pendingNotificationHandlers: new Map(),
    _requestHandlers: new Map(),
    _pendingRequestHandlers: new Map(),
    _progressHandlers: new Map(),
    _pendingProgressHandlers: new Map(),
    createOnStartPromise: () => [gate.promise, gate.resolve, gate.reject],
    createConnection: async () => connection,
    async initialize() {
      // handleConnectionClosed runs while initialize is still awaiting its reply.
      this._onStart = undefined
      throw failure
    },
    error() {},
  }
  const startClient = makeStart(
    { Starting: 'starting', Stopping: 'stopping', StartFailed: 'failed' },
    {
      LogMessageNotification: {},
      ShowMessageNotification: {},
      ShowMessageRequest: {},
      TelemetryEventNotification: {},
      ShowDocumentRequest: {},
    },
  )
  await assert.rejects(startClient.call(owner), (error) => error === failure)
  assert.equal(owner._onStart, undefined)
  await new Promise((resolve) => setImmediate(resolve))
  assert.throws(
    () =>
      patchLanguageClientStartup(
        source.replace(
          '    createOnStartPromise()',
          '    changedStartPromise()',
        ),
      ),
    /Review the initialization promise/,
  )
})

test('the actual patched wrapper handles channel closure before and after initialization and preserves unrelated errors', async () => {
  const source = fs.readFileSync(
    new URL(
      '../../../node_modules/monaco-editor-wrapper/dist/languageClientWrapper.js',
      import.meta.url,
    ),
    'utf8',
  )
  const patched = patchLeanClientWrapper(source)
  const start = patched.indexOf(
    'this.languageClient = new MonacoLanguageClient(mlcConfig);',
  )
  const end = patched.indexOf('\n        try {', start)
  const install = new Function(
    'MonacoLanguageClient',
    'mlcConfig',
    patched.slice(start, end),
  )
  for (const running of [false, true]) {
    let listener,
      stops = 0,
      closed = 0
    const raw = {
      isRunning: () => running,
      stop: async () => {
        stops++
        throw new Error('Stopping the server timed out')
      },
    }
    const owner = {
      messageTransports: {
        reader: {
          onClose(value) {
            listener = value
          },
        },
      },
      languageClientConfig: {
        options: {
          $type: 'WebSocketUrl',
          stopOptions: {
            onCall() {
              closed++
            },
          },
        },
      },
      getLanguageClient() {
        return this.languageClient
      },
    }
    install.call(
      owner,
      function () {
        return raw
      },
      {},
    )
    await listener()
    assert.equal(
      stops,
      0,
      'The reader must not send shutdown over its closed channel',
    )
    assert.equal(closed, 1)
    await raw.stop()
    assert.equal(
      stops,
      running ? 1 : 0,
      'Early shutdown is guarded per instance',
    )
  }
  assert.throws(
    () => patchLeanClientWrapper('different upstream implementation'),
    /Review the pinned/,
  )
  let listener
  const raw = {
    isRunning: () => true,
    stop: async () => {
      throw new Error('unrelated cleanup failure')
    },
  }
  const owner = {
    messageTransports: {
      reader: {
        onClose(value) {
          listener = value
        },
      },
    },
    languageClientConfig: {
      options: { $type: 'WebSocketUrl', stopOptions: { onCall() {} } },
    },
    getLanguageClient() {
      return this.languageClient
    },
  }
  install.call(
    owner,
    function () {
      return raw
    },
    {},
  )
  await listener()
  await assert.rejects(raw.stop(), /unrelated cleanup failure/)
})
