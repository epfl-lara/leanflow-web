import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

// Execute the actual hook with controlled effect, network and timer boundaries.
// This exercises polling/SSE behavior without a browser, provider or Lean worker.
function loadHook(mocks) {
  const require = createRequire(import.meta.url)
  const modules = new Map(Object.entries(mocks))
  function load(name) {
    if (modules.has(name)) return modules.get(name)
    const filename = new URL(name, import.meta.url)
    const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
      fileName: fileURLToPath(filename),
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    })
    const module = { exports: {} }
    modules.set(name, module.exports)
    new Function('require', 'module', 'exports', outputText)(
      (id) => {
        if (id.endsWith('.mjs')) return require(id)
        if (id.startsWith('.')) {
          const suffix = existsSync(new URL(`${id}.ts`, import.meta.url))
            ? '.ts'
            : '.tsx'
          return load(`${id}${suffix}`)
        }
        return modules.has(id) ? modules.get(id) : require(id)
      },
      module,
      module.exports,
    )
    return module.exports
  }
  const api = load('./api.ts')
  modules.set('./api.ts', { ...api, api: mocks.api })
  return load('./useRunStream.ts').useRunStream
}

const settle = async () => {
  for (let i = 0; i < 4; i++)
    await new Promise((resolve) => setImmediate(resolve))
}

function harness(t, api) {
  const previous = {
    EventSource: globalThis.EventSource,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  }
  const effects = []
  const streams = []
  let poll,
    cleared = false
  globalThis.setInterval = (callback) => {
    poll = callback
    return 42
  }
  globalThis.clearInterval = (value) => {
    if (value === 42) cleared = true
    else previous.clearInterval(value)
  }
  globalThis.EventSource = class extends EventTarget {
    static CLOSED = 2
    constructor(url) {
      super()
      this.url = url
      this.readyState = 1
      streams.push(this)
    }
    close() {
      this.readyState = 2
    }
    emit(event) {
      this.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify(event) }),
      )
    }
  }
  const useRunStream = loadHook({
    api,
    react: {
      startTransition: (callback) => callback(),
      useRef: (value) => ({ current: value }),
      useState: (value) => [value, () => {}],
      useEffect: (callback) => {
        effects.push(callback())
      },
    },
  })
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    for (const effect of effects) effect?.()
  }
  t.after(() => {
    cleanup()
    Object.assign(globalThis, previous)
  })
  return {
    useRunStream,
    streams,
    cleanup,
    poll: () => poll(),
    cleared: () => cleared,
  }
}

test('active polling and saved-file/status refreshes request metadata and preserve replay, file callbacks and final output', async (t) => {
  const requests = [],
    published = [],
    files = [],
    errors = []
  let terminal = 0
  let snapshot = {
    id: 'run',
    status: 'running',
    eventCursor: 5,
    liveEdits: true,
    liveRevision: 1,
    liveChangeCount: 1,
    liveChangePaths: ['Main.lean'],
    message: 'Working.',
    reasoningBlocks: [],
  }
  const fixture = harness(t, async (url) => {
    requests.push(url)
    assert.equal(url, '/api/runs/run?view=metadata')
    return structuredClone(snapshot)
  })
  fixture.useRunStream('run', {
    onRun: (run) => published.push(structuredClone(run)),
    onFilesUpdated: async (paths) => {
      files.push(paths)
    },
    onTerminal: () => {
      terminal++
    },
    onError: (error) => errors.push(error),
    onRecovered: () => {},
  })
  await settle()
  assert.equal(fixture.streams[0].url, '/api/runs/run/events?after=5')
  assert.deepEqual(files[0], ['Main.lean'])
  snapshot = { ...snapshot, eventCursor: 6, message: 'Still working.' }
  fixture.poll()
  await settle()
  assert.equal(published.at(-1).message, 'Still working.')
  snapshot = {
    ...snapshot,
    eventCursor: 8,
    liveRevision: 2,
    liveChangeCount: 2,
    liveChangePaths: ['Main.lean', 'Helper.lean'],
  }
  fixture.streams[0].emit({
    seq: 7,
    type: 'files-updated',
    data: { paths: ['Helper.lean'], live: true },
  })
  fixture.streams[0].emit({
    seq: 8,
    type: 'status',
    data: { status: 'running' },
  })
  await settle()
  assert.equal(published.at(-1).liveRevision, 2)
  assert(files.some((paths) => paths.includes('Helper.lean')))
  assert.equal(published.at(-1).liveChanges, undefined)
  snapshot = {
    ...snapshot,
    status: 'completed',
    eventCursor: 10,
    message: 'Final verified output.',
  }
  fixture.streams[0].emit({
    seq: 9,
    type: 'status',
    data: { status: 'completed' },
  })
  await settle()
  assert.equal(published.at(-1).status, 'completed')
  assert.equal(published.at(-1).message, 'Final verified output.')
  assert.equal(published.at(-1).eventCursor, 10)
  assert.equal(terminal, 1)
  assert.equal(fixture.streams[0].readyState, 2)
  assert(fixture.cleared())
  assert.equal(requests.length, 4)
  assert.deepEqual(errors, [])
})

test('cancelling a pending metadata poll prevents publication and stream startup', async (t) => {
  let finish
  const published = []
  const fixture = harness(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  fixture.useRunStream('run', {
    onRun: (run) => published.push(run),
    onFilesUpdated: async () => {},
    onTerminal: () => {},
    onError: () => {},
    onRecovered: () => {},
  })
  fixture.cleanup()
  finish({ id: 'run', status: 'running', eventCursor: 1, reasoningBlocks: [] })
  await settle()
  assert.deepEqual(published, [])
  assert.equal(fixture.streams.length, 0)
  assert(fixture.cleared())
})

test('slow metadata requests coalesce polling and keep one trailing refresh', async (t) => {
  const requests = [],
    published = [],
    errors = []
  const fixture = harness(
    t,
    (url, options) =>
      new Promise((resolve, reject) => {
        requests.push({ url, options, resolve, reject })
      }),
  )
  fixture.useRunStream('run', {
    onRun: (run) => published.push(run),
    onFilesUpdated: async () => {},
    onTerminal: () => {},
    onError: (error) => errors.push(error),
    onRecovered: () => {},
  })
  for (let tick = 0; tick < 20; tick++) fixture.poll()
  assert.equal(requests.length, 1)
  requests[0].resolve({
    id: 'run',
    status: 'running',
    eventCursor: 1,
    reasoningBlocks: [],
  })
  await settle()
  assert.equal(requests.length, 2)
  for (let tick = 0; tick < 20; tick++) fixture.poll()
  assert.equal(requests.length, 2)
  requests[1].reject(new Error('Temporary network failure'))
  await settle()
  assert.equal(requests.length, 3)
  assert.equal(errors.length, 1)
  requests[2].resolve({
    id: 'run',
    status: 'completed',
    eventCursor: 3,
    message: 'Final output',
    reasoningBlocks: [],
  })
  await settle()
  assert.equal(published.at(-1).message, 'Final output')
  fixture.poll()
  assert.equal(requests.length, 3)
  fixture.cleanup()
  assert(requests.every(({ options }) => options.signal.aborted))
})
