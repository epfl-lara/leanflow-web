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
    erased = 0,
    restarts = 0,
    running = false
  const clients = []
  const raw = {
    start: async () => {
      running = true
    },
    restart: async () => {
      restarts++
      running = true
    },
    isRunning: () => running,
    stop: async () => {
      stops++
      running = false
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
    get restarts() {
      return restarts
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

test('sleep stops the editor connection and blocks background starts until a single explicit wake', async () => {
  const f = fixture()
  f.gate.resolve(f.raw)
  await f.provider.ensureClient('root')
  await f.lifecycle.suspend()
  assert.equal(f.lifecycle.sleeping, true)
  assert.equal(f.stops, 1)
  assert.equal(f.raw.isRunning(), false)
  assert.deepEqual(await f.provider.ensureClient('background keepalive'), [
    false,
    undefined,
  ])
  assert.equal(f.calls, 1)
  await Promise.all([f.lifecycle.resume('root'), f.lifecycle.resume('root')])
  assert.equal(f.lifecycle.sleeping, false)
  assert.equal(f.restarts, 1)
  assert.equal(f.raw.isRunning(), true)
  assert.equal(f.calls, 1)
  await f.lifecycle.close()
})

test('sleep drains a pending start and waking during shutdown waits before reconnecting', async () => {
  const f = fixture()
  const starting = f.provider.ensureClient('root')
  const sleeping = f.lifecycle.suspend()
  const waking = f.lifecycle.resume('root')
  await Promise.resolve()
  assert.equal(f.restarts, 0)
  f.gate.resolve(f.raw)
  await Promise.all([starting, sleeping, waking])
  assert.equal(f.stops, 1)
  assert.equal(f.restarts, 1)
  assert.equal(f.raw.isRunning(), true)
  await f.lifecycle.close()
})

test('closing a sleeping editor cancels a queued wake instead of reviving its worker', async () => {
  const f = fixture()
  const starting = f.provider.ensureClient('root')
  const sleeping = f.lifecycle.suspend()
  const waking = f.lifecycle.resume('root')
  const closing = f.lifecycle.close()
  f.gate.resolve(f.raw)
  await Promise.all([starting, sleeping, waking, closing])
  assert.equal(f.restarts, 0)
  assert.equal(f.raw.isRunning(), false)
  await f.lifecycle.resume('root')
  assert.equal(f.restarts, 0)
})

test('waking a document without a Lean client does not allocate one unnecessarily', async () => {
  const f = fixture()
  await f.lifecycle.suspend()
  await f.lifecycle.resume('root', false)
  assert.equal(f.lifecycle.sleeping, false)
  assert.equal(f.calls, 0)
  assert.equal(f.restarts, 0)
  await f.lifecycle.close()
})

test('sleep requested during a pending wake waits for it and then releases its worker', async () => {
  const f = fixture()
  f.gate.resolve(f.raw)
  await f.provider.ensureClient('root')
  await f.lifecycle.suspend()
  const gate = deferred()
  f.raw.restart = async () => gate.promise
  const waking = f.lifecycle.resume('root')
  const sleeping = f.lifecycle.suspend()
  gate.resolve()
  await Promise.all([waking, sleeping])
  assert.equal(f.lifecycle.sleeping, true)
  assert.equal(f.raw.isRunning(), false)
  await f.lifecycle.close()
})

test('rapid sleep-wake changes preserve the latest intent and block starts until shutdown finishes', async () => {
  const f = fixture()
  f.gate.resolve(f.raw)
  await f.provider.ensureClient('root')
  const stopping = deferred()
  const stop = f.raw.stop
  f.raw.stop = async () => {
    await stopping.promise
    await stop()
  }
  const firstSleep = f.lifecycle.suspend()
  const firstWake = f.lifecycle.resume('root')
  const secondSleep = f.lifecycle.suspend()
  const lastWake = f.lifecycle.resume('root')
  assert.deepEqual(await f.provider.ensureClient('background event'), [
    false,
    undefined,
  ])
  assert.equal(f.restarts, 0)
  stopping.resolve()
  await Promise.all([firstSleep, firstWake, secondSleep, lastWake])
  assert.equal(f.lifecycle.sleeping, false)
  assert.equal(f.raw.isRunning(), true)
  assert.equal(f.restarts, 1)
  await f.lifecycle.close()
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
