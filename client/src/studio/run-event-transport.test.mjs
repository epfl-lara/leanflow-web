import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function transport(api, sessionBoundUrl = (url) => url) {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL('./runEventTransport.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
      },
    },
  )
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputText)(
    () => ({ api, sessionBoundUrl }),
    module,
    module.exports,
  )
  return module.exports
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('JSON event transport replays cursors, retries failures, and aborts cleanly', async (t) => {
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  let next
  globalThis.setTimeout = (callback) => {
    next = callback
    return 42
  }
  globalThis.clearTimeout = () => {
    next = undefined
  }
  t.after(() => Object.assign(globalThis, original))
  const calls = []
  let fail = false
  const { PollingRunEvents } = transport(async (url, options) => {
    calls.push({ url, options })
    if (fail) throw new Error('temporary network failure')
    const after = Number(
      new URL(url, 'https://fixture.example').searchParams.get('after'),
    )
    return {
      events: [1, 2, 3]
        .filter((seq) => seq > after)
        .map((seq) => ({ seq, type: 'message', data: { text: String(seq) } })),
    }
  })
  const stream = new PollingRunEvents(
    '/api/runs/fixture/events?after=1&expectedUserId=alpha',
  )
  const events = [],
    states = []
  stream.addEventListener('open', () => states.push('open'))
  stream.addEventListener('message', (event) =>
    events.push(JSON.parse(event.data)),
  )
  stream.addEventListener('error', () => states.push('error'))
  await settle()
  assert.deepEqual(
    events.map((event) => event.seq),
    [2, 3],
  )
  assert.equal(stream.readyState, 1)
  fail = true
  next()
  await settle()
  const retryUrl = new URL(calls[1].url, 'https://fixture.example')
  assert.equal(retryUrl.searchParams.get('after'), '3')
  assert.equal(retryUrl.searchParams.get('expectedUserId'), 'alpha')
  assert.equal(stream.readyState, 0)
  fail = false
  next()
  await settle()
  assert.deepEqual(states, ['open', 'error', 'open'])
  assert.deepEqual(
    events.map((event) => event.seq),
    [2, 3],
  )
  stream.close()
  assert.equal(stream.readyState, 2)
  assert(calls[0].options.signal.aborted)
  assert.equal(next, undefined)
})

test('SSE remains the default transport', () => {
  const { openRunEvents } = transport(() =>
    assert.fail('No polling by default'),
  )
  const previous = globalThis.EventSource
  globalThis.EventSource = class extends EventTarget {
    constructor(url) {
      super()
      this.url = url
    }
  }
  try {
    assert.equal(openRunEvents('/fixture').url, '/fixture')
  } finally {
    globalThis.EventSource = previous
  }
})

test('fatal SSE errors use bounded retry and cursor-preserving polling fallback', async (t) => {
  const original = {
    EventSource: globalThis.EventSource,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  t.after(() => Object.assign(globalThis, original))
  const sources = [],
    timers = new Map(),
    calls = []
  let nextTimer = 0
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextTimer
    timers.set(id, { callback, delay })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  globalThis.EventSource = class extends EventTarget {
    readyState = 0
    constructor(url) {
      super()
      this.url = url
      sources.push(this)
    }
    close() {
      this.readyState = 2
    }
    fail() {
      this.readyState = 2
      this.dispatchEvent(new Event('error'))
    }
  }
  const { openRunEvents } = transport(
    async (url, options) => {
      calls.push({ url, options })
      return { events: [] }
    },
    (url) => `${url}&expectedUserId=alpha`,
  )
  const stream = openRunEvents('/api/runs/fixture/events?after=4')
  const received = [],
    states = []
  stream.addEventListener('message', (event) =>
    received.push(JSON.parse(event.data)),
  )
  stream.addEventListener('open', () => states.push('open'))
  stream.addEventListener('error', () => states.push('error'))
  sources[0].dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({
        seq: 5,
        type: 'message',
        data: { text: 'saved' },
      }),
    }),
  )
  sources[0].fail()
  assert.equal(
    stream.readyState,
    0,
    'metadata refreshes must see a pending retry instead of a closed source',
  )
  assert.equal(sources.length, 1)
  assert.equal(timers.size, 1)
  const advance = () => {
    const [id, timer] = timers.entries().next().value
    timers.delete(id)
    timer.callback()
    return timer.delay
  }
  assert.equal(advance(), 2000)
  assert.equal(sources.length, 2)
  const retryUrl = new URL(sources[1].url, 'https://fixture.example')
  assert.equal(retryUrl.searchParams.get('after'), '5')
  assert.equal(retryUrl.searchParams.get('expectedUserId'), 'alpha')
  sources[0].dispatchEvent(
    new MessageEvent('message', {
      data: JSON.stringify({ seq: 999, type: 'message' }),
    }),
  )
  assert.deepEqual(
    received.map((event) => event.seq),
    [5],
    'closed sources must not advance the replay cursor',
  )
  sources[1].fail()
  assert.equal(advance(), 4000)
  sources[2].fail()
  assert.equal(advance(), 8000)
  await settle()
  assert.equal(sources.length, 3, 'repeated fatal errors switch to polling')
  const pollingUrl = new URL(calls[0].url, 'https://fixture.example')
  assert.equal(pollingUrl.searchParams.get('after'), '5')
  assert.equal(pollingUrl.searchParams.get('expectedUserId'), 'alpha')
  assert.equal(pollingUrl.searchParams.get('transport'), 'poll')
  assert.equal(stream.readyState, 1)
  assert.deepEqual(states, ['error', 'error', 'error', 'open'])
  stream.close()
  assert.equal(stream.readyState, 2)
  assert.equal(timers.size, 0)
  assert(calls[0].options.signal.aborted)
})

test('closing during SSE retry cancels reconnecting and ignores late events', (t) => {
  const original = {
    EventSource: globalThis.EventSource,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  t.after(() => Object.assign(globalThis, original))
  let pending,
    source,
    count = 0
  globalThis.setTimeout = (callback) => {
    pending = callback
    return 1
  }
  globalThis.clearTimeout = () => {
    pending = undefined
  }
  globalThis.EventSource = class extends EventTarget {
    constructor() {
      super()
      source = this
      count++
    }
    close() {}
  }
  const { LiveRunEvents } = transport(() =>
    assert.fail('No polling after close'),
  )
  const stream = new LiveRunEvents('/api/runs/fixture/events?after=0')
  source.dispatchEvent(new Event('error'))
  const retry = pending
  stream.close()
  assert.equal(pending, undefined)
  retry()
  source.dispatchEvent(new Event('open'))
  assert.equal(count, 1)
  assert.equal(stream.readyState, 2)
})
