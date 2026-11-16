import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import {
  ApiNetworkError,
  MAX_API_ATTEMPTS,
  isBrowserNetworkError,
  withApiRetries,
} from './apiTransport.mjs'

class HttpError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const settle = async () => {
  for (let i = 0; i < 2; i++)
    await new Promise((resolve) => setImmediate(resolve))
}

// A scripted stand-in for request() plus body reading. Each attempt takes the
// next step; nothing here reaches a real network service.
function scripted(steps) {
  const calls = []
  const operation = async (attempt) => {
    calls.push(attempt)
    const step = steps[Math.min(calls.length, steps.length) - 1]
    const response = await step()
    return response.json()
  }
  return { calls, operation }
}

const interruptedBody = (error) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"projects":'))
        controller.error(error)
      },
    }),
  )

test('a GET recovers from a failed fetch and a response body interrupted after headers', async () => {
  const controller = new AbortController()
  const { calls, operation } = scripted([
    async () => {
      throw new TypeError('Failed to fetch')
    },
    async () => interruptedBody(new TypeError('network error')),
    async () => Response.json({ projects: ['Alpha'] }),
  ])
  let checks = 0
  const delays = []
  const result = await withApiRetries(operation, {
    signal: controller.signal,
    beforeAttempt: () => checks++,
    delayMs: (retry) => {
      delays.push(retry)
      return 0
    },
  })
  assert.deepEqual(result, { projects: ['Alpha'] })
  assert.deepEqual(calls, [1, 2, 3])
  assert.equal(checks, 3)
  assert.deepEqual(delays, [1, 2])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('browser network failures are recognized while programming TypeErrors propagate unchanged', async () => {
  for (const error of [
    new TypeError('Failed to fetch'),
    new TypeError('network error'),
    new TypeError('Load failed'),
    new TypeError('The network connection was lost.'),
    new TypeError('NetworkError when attempting to fetch resource.'),
    new DOMException('A network error occurred.', 'NetworkError'),
  ])
    assert.equal(isBrowserNetworkError(error), true, error.message)
  const programmingErrors = [
    new TypeError("Cannot read properties of undefined (reading 'json')"),
    new TypeError('Failed to fetch dynamically imported module: /chunk.js'),
    new TypeError('response.json is not a function'),
  ]
  for (const error of [
    ...programmingErrors,
    new Error('Failed to fetch'),
    new DOMException('The operation was aborted.', 'AbortError'),
    'Failed to fetch',
    null,
  ])
    assert.equal(isBrowserNetworkError(error), false, String(error))
  for (const error of programmingErrors) {
    const { calls, operation } = scripted([
      async () => {
        throw error
      },
    ])
    await assert.rejects(
      withApiRetries(operation, { delayMs: () => 0 }),
      (thrown) => thrown === error,
    )
    assert.deepEqual(calls, [1])
  }
})

test('mutations run once, even for HTTP 503 or a lost connection, and never claim the change was applied', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    const unavailable = new HttpError('LeanFlow is busy.', 503)
    const busy = scripted([
      async () => {
        throw unavailable
      },
    ])
    await assert.rejects(
      withApiRetries(busy.operation, { method, delayMs: () => 0 }),
      (error) => error === unavailable,
    )
    assert.deepEqual(busy.calls, [1], method)

    const lost = new TypeError('Failed to fetch')
    const offline = scripted([
      async () => {
        throw lost
      },
    ])
    await assert.rejects(
      withApiRetries(offline.operation, { method, delayMs: () => 0 }),
      (error) => {
        assert.ok(error instanceof ApiNetworkError)
        assert.equal(error.status, 0)
        assert.equal(error.attempts, 1)
        assert.equal(error.method, method.toUpperCase())
        assert.equal(error.cause, lost)
        assert.match(error.message, /may or may not have been applied/)
        assert.match(error.message, /Check the current state before trying/)
        assert.doesNotMatch(error.message, /\bsaved\b/i)
        return true
      },
    )
    assert.deepEqual(offline.calls, [1], method)
  }
})

test('authentication, conflicts, client errors and other failures are not retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 428, 500]) {
    const failure = new HttpError(`Request failed (${status}).`, status)
    const { calls, operation } = scripted([
      async () => {
        throw failure
      },
    ])
    await assert.rejects(
      withApiRetries(operation, { delayMs: () => 0 }),
      (error) => error === failure,
    )
    assert.deepEqual(calls, [1], String(status))
  }
  const wrongType = new Error('This file could not be opened as a PDF.')
  const { calls, operation } = scripted([
    async () => {
      throw wrongType
    },
  ])
  await assert.rejects(
    withApiRetries(operation, { delayMs: () => 0 }),
    (error) => error === wrongType,
  )
  assert.deepEqual(calls, [1])
})

test('transient HTTP statuses retry a bounded number of times and keep the final server error', async () => {
  for (const [method, status] of [
    ['GET', 429],
    ['GET', 502],
    ['get', 503],
    ['HEAD', 504],
  ]) {
    const failures = []
    const { calls, operation } = scripted([
      async () => {
        failures.push(new HttpError('The server is busy. Try again.', status))
        throw failures.at(-1)
      },
    ])
    await assert.rejects(
      withApiRetries(operation, { method, delayMs: () => 0 }),
      (error) => error === failures.at(-1),
    )
    assert.equal(MAX_API_ATTEMPTS, 3)
    assert.deepEqual(calls, [1, 2, 3], `${method} ${status}`)
  }
})

test('a GET that keeps losing its connection stops after three attempts with an actionable message', async () => {
  const failures = []
  const { calls, operation } = scripted([
    async () => {
      failures.push(new TypeError('Load failed'))
      throw failures.at(-1)
    },
  ])
  await assert.rejects(
    withApiRetries(operation, { delayMs: () => 0 }),
    (error) => {
      assert.ok(error instanceof ApiNetworkError)
      assert.equal(error.status, 0)
      assert.equal(error.attempts, 3)
      assert.equal(error.method, 'GET')
      assert.equal(error.cause, failures.at(-1))
      assert.equal(
        error.message,
        'Could not reach LeanFlow after 3 attempts. Check your network connection and try again.',
      )
      return true
    },
  )
  assert.deepEqual(calls, [1, 2, 3])
})

test('cancellation during the retry wait rejects with the caller reason and leaves no timer, listener or extra attempt', async (t) => {
  const { setTimeout: set, clearTimeout: clear } = globalThis
  const waits = new Set()
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = set(callback, ms, ...args)
    if (ms === 60_000) waits.add(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => {
    waits.delete(timer)
    clear(timer)
  }
  t.after(() => {
    globalThis.setTimeout = set
    globalThis.clearTimeout = clear
    for (const timer of waits) clear(timer)
  })
  const controller = new AbortController()
  const reason = new Error('The file preview closed.')
  let checks = 0
  const { calls, operation } = scripted([
    async () => {
      throw new TypeError('Failed to fetch')
    },
  ])
  const pending = withApiRetries(operation, {
    signal: controller.signal,
    beforeAttempt: () => checks++,
    delayMs: () => {
      setImmediate(() => controller.abort(reason))
      return 60_000
    },
  })
  await assert.rejects(pending, (error) => error === reason)
  assert.deepEqual(calls, [1])
  assert.equal(checks, 1)
  assert.equal(waits.size, 0)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await settle()
  assert.deepEqual(calls, [1])
})

test('a signal aborted before or during an attempt is never retried', async () => {
  const before = new AbortController()
  const reason = new Error('Unmounted.')
  before.abort(reason)
  let checks = 0
  const unused = scripted([async () => Response.json({})])
  await assert.rejects(
    withApiRetries(unused.operation, {
      signal: before.signal,
      beforeAttempt: () => checks++,
    }),
    (error) => error === reason,
  )
  assert.deepEqual(unused.calls, [])
  assert.equal(checks, 0)

  const during = new AbortController()
  const interrupted = new TypeError('network error')
  const { calls, operation } = scripted([
    async () => {
      during.abort(reason)
      throw interrupted
    },
  ])
  await assert.rejects(
    withApiRetries(operation, { signal: during.signal, delayMs: () => 0 }),
    (error) => error === reason,
  )
  assert.deepEqual(calls, [1])
})

test('an account change during the retry wait stops before another request', async () => {
  let sessionUserId = 'alpha'
  const requestUserId = sessionUserId
  const accountChanged = new HttpError(
    'The workspace account changed. Try again in this account.',
    409,
  )
  const { calls, operation } = scripted([
    async () => {
      sessionUserId = 'beta'
      throw new TypeError('Failed to fetch')
    },
  ])
  await assert.rejects(
    withApiRetries(operation, {
      beforeAttempt: () => {
        if (sessionUserId !== requestUserId) throw accountChanged
      },
      delayMs: () => 0,
    }),
    (error) => error === accountChanged,
  )
  assert.deepEqual(calls, [1])
})

test('the default backoff waits briefly and finishes within two seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { calls, operation } = scripted([
    async () => {
      throw new TypeError('Failed to fetch')
    },
    async () => {
      throw new HttpError('The server is busy. Try again.', 503)
    },
    async () => Response.json({ ok: true }),
  ])
  const pending = withApiRetries(operation)
  await settle()
  assert.deepEqual(calls, [1])
  t.mock.timers.tick(500)
  await settle()
  assert.deepEqual(calls, [1, 2])
  t.mock.timers.tick(1500)
  assert.deepEqual(await pending, { ok: true })
  assert.deepEqual(calls, [1, 2, 3])
})

test('the declaration infers the caller result type', () => {
  const entry = fileURLToPath(
    new URL('./api-transport-types.ts', import.meta.url),
  )
  const source = `
    import { ApiNetworkError, withApiRetries } from './apiTransport.mjs'
    const blob: Promise<Blob> = withApiRetries(async () => new Blob())
    const text: Promise<string> = withApiRetries(
      async (attempt: number) => String(attempt),
      { method: 'GET', signal: null, beforeAttempt() {}, delayMs: () => 0 },
    )
    const status: 0 = new ApiNetworkError('GET', 3, null).status
    // @ts-expect-error The result type follows the operation.
    const wrong: Promise<number> = withApiRetries(async () => 'text')
  `
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, ...rest) =>
    name === entry
      ? ts.createSourceFile(name, source, ts.ScriptTarget.ES2023)
      : getSourceFile(name, ...rest)
  const program = ts.createProgram([entry], options, host)
  assert.deepEqual(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      ),
    [],
  )
})

test('read recovery respects short Retry-After and leaves long waits to the caller', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const busy = new HttpError('Busy', 429)
  busy.retryAfterMs = 1000
  let calls = 0
  const pending = withApiRetries(
    async () => {
      if (++calls === 1) throw busy
      return 'ready'
    },
    { delayMs: () => 0 },
  )
  await settle()
  t.mock.timers.tick(999)
  await settle()
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(await pending, 'ready')
  assert.equal(calls, 2)
  busy.retryAfterMs = 10000
  calls = 0
  await assert.rejects(
    withApiRetries(
      async () => {
        calls++
        throw busy
      },
      { delayMs: () => 0 },
    ),
    (error) => error === busy,
  )
  assert.equal(calls, 1)
})

test('an operation completing after cancellation cannot publish a stale result', async () => {
  const controller = new AbortController(),
    reason = new Error('Preview closed')
  await assert.rejects(
    withApiRetries(
      async () => {
        controller.abort(reason)
        return 'late data'
      },
      { signal: controller.signal },
    ),
    (error) => error === reason,
  )
})
