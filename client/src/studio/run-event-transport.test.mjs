import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

function transport(api) {
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
    () => ({ api }),
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
  const stream = new PollingRunEvents('/api/runs/fixture/events?after=1')
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
  assert(calls[1].url.endsWith('after=3'))
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
  globalThis.EventSource = class {
    constructor(url) {
      this.url = url
    }
  }
  try {
    assert.equal(openRunEvents('/fixture').url, '/fixture')
  } finally {
    globalThis.EventSource = previous
  }
})
