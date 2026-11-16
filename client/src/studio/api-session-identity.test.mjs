import * as apiTransport from './apiTransport.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function clientApi() {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL('./api.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
      },
    },
  )
  const module = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(
    module,
    module.exports,
    (name) => {
      if (name === './apiTransport.mjs') return apiTransport
      throw new Error('Unexpected module ' + name)
    },
  )
  return module.exports
}

function withFetch(t, fetch) {
  const previous = globalThis.fetch
  globalThis.fetch = fetch
  t.after(() => {
    globalThis.fetch = previous
  })
}

test('browser requests and connection URLs stay bound to the tab account until explicit logout', async (t) => {
  const client = clientApi()
  const calls = []
  withFetch(t, async (url, options) => {
    calls.push({ url, expected: options.headers.get('X-Leanflow-User') })
    return Response.json({ ok: true })
  })
  await client.api('/api/session')
  client.bindSessionUser('alpha')
  await client.api('/api/settings')
  await client.post('/api/login', {
    token: 'reauthentication',
    expectedUserId: 'alpha',
  })
  await client.api('/api/session')
  assert.deepEqual(
    calls.map((call) => call.expected),
    [null, 'alpha', null, 'alpha'],
  )
  for (const endpoint of [
    '/api/runs/run/events?after=4',
    'ws://fixture/websocket/project',
    'ws://fixture/websocket/collaboration/project',
    'ws://fixture/websocket/terminal/project?openingId=original',
    '/api/projects/project/terminal-recoveries/run/download?path=Proof.lean',
  ]) {
    const bound = new URL(client.sessionBoundUrl(endpoint), 'https://fixture')
    assert.equal(bound.searchParams.get('expectedUserId'), 'alpha')
    if (endpoint.includes('openingId'))
      assert.equal(bound.searchParams.get('openingId'), 'original')
    if (endpoint.includes('after'))
      assert.equal(bound.searchParams.get('after'), '4')
  }
  client.bindSessionUser(null)
  await client.api('/api/session')
  assert.equal(calls.at(-1).expected, null)
})

test('responses from a previous explicit account visit cannot populate the replacement visit', async (t) => {
  const client = clientApi()
  let respond
  withFetch(
    t,
    () =>
      new Promise((resolve) => {
        respond = resolve
      }),
  )
  client.bindSessionUser('alpha')
  const pending = client.api('/api/projects')
  client.bindSessionUser(null)
  client.bindSessionUser('beta')
  respond(Response.json([{ name: 'ALPHA_PRIVATE_PROJECT' }]))
  await assert.rejects(pending, (error) => error.status === 409)
})

test('a changed-cookie 401 opens recovery without rebinding the tab', async (t) => {
  const client = clientApi()
  const previous = globalThis.window
  const events = []
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) }
  t.after(() => {
    globalThis.window = previous
  })
  withFetch(t, async () =>
    Response.json({ error: 'Another account is signed in.' }, { status: 401 }),
  )
  client.bindSessionUser('alpha')
  await assert.rejects(
    client.api('/api/session'),
    (error) => error.status === 401,
  )
  assert.deepEqual(events, [client.SESSION_EXPIRED_EVENT])
  assert.equal(
    new URL(
      client.sessionBoundUrl('/api/runs/run/events'),
      'https://fixture',
    ).searchParams.get('expectedUserId'),
    'alpha',
  )
})

test('a read retry cannot cross logout and return to the same account', async (t) => {
  const client = clientApi()
  client.bindSessionUser('alpha')
  let calls = 0
  withFetch(t, async () => {
    calls++
    client.bindSessionUser(null)
    client.bindSessionUser('alpha')
    throw new TypeError('Failed to fetch')
  })
  await assert.rejects(
    client.api('/api/projects'),
    (error) => error.status === 409,
  )
  assert.equal(calls, 1)
})

test('a response body cannot populate a later visit to the same account', async (t) => {
  const client = clientApi()
  client.bindSessionUser('alpha')
  let finish
  const body = new ReadableStream({
    start(controller) {
      finish = controller
    },
  })
  withFetch(t, async () => new Response(body))
  const pending = client.api('/api/projects')
  await new Promise((resolve) => setImmediate(resolve))
  client.bindSessionUser(null)
  client.bindSessionUser('alpha')
  finish.enqueue(new TextEncoder().encode('[]'))
  finish.close()
  await assert.rejects(pending, (error) => error.status === 409)
})

test('real api wiring retries a safe GET after an interrupted body', async (t) => {
  const client = clientApi()
  let calls = 0
  withFetch(t, async () => {
    calls++
    if (calls === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('network error'))
          },
        }),
      )
    return Response.json({ ok: true })
  })
  assert.deepEqual(await client.api('/api/projects'), { ok: true })
  assert.equal(calls, 2)
})

test('real api wiring never repeats mutations after a connection failure', async (t) => {
  const client = clientApi()
  let calls = 0
  withFetch(t, async () => {
    calls++
    throw new TypeError('Failed to fetch')
  })
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const before = calls
    await assert.rejects(
      client.api('/api/fixture', { method }),
      (error) => error.name === 'ApiNetworkError' && error.status === 0,
    )
    assert.equal(calls, before + 1, method)
  }
})

test('real api wiring parses Retry-After and does not repeat reads with a long wait', async (t) => {
  const client = clientApi()
  let calls = 0
  withFetch(t, async () => {
    calls++
    return Response.json(
      { error: 'Busy' },
      {
        status: 429,
        headers: { 'Retry-After': '10' },
      },
    )
  })
  await assert.rejects(
    client.api('/api/projects'),
    (error) => error.status === 429 && error.retryAfterMs === 10000,
  )
  assert.equal(calls, 1)
})

test('image and HTML previews reject responses from a replaced account, including delayed response bodies', async (t) => {
  let currentFetch
  withFetch(t, (...args) => currentFetch(...args))
  for (const [method, mime, body] of [
    ['apiImage', 'image/png', 'fixture image'],
    ['apiHtml', 'text/html', '<p>Private preview</p>'],
  ]) {
    const client = clientApi()
    client.bindSessionUser('alpha')
    let stream
    const response = new Response(
      new ReadableStream({
        start(controller) {
          stream = controller
        },
      }),
      {
        headers: { 'Content-Type': mime },
      },
    )
    currentFetch = async (_url, options) => {
      assert.equal(options.headers.get('X-Leanflow-User'), 'alpha')
      return response
    }
    const pending = client[method](
      '/api/projects/private/file-preview?path=figure.png',
      new AbortController().signal,
    )
    // Let request authentication finish while the resource body stays pending.
    await new Promise((resolve) => setImmediate(resolve))
    client.bindSessionUser('beta')
    stream.enqueue(new TextEncoder().encode(body))
    stream.close()
    await assert.rejects(pending, (error) => error.status === 409)
  }
})

test('media preview requests surface server errors and reject a mismatched content type', async (t) => {
  const client = clientApi()
  const signal = new AbortController().signal
  let currentFetch = async () =>
    new Response('<script>untrusted</script>', {
      headers: { 'Content-Type': 'text/html' },
    })
  withFetch(t, (...args) => currentFetch(...args))
  await assert.rejects(client.apiImage('/preview', signal), /supported image/)
  currentFetch = async () =>
    new Response('not HTML', { headers: { 'Content-Type': 'text/plain' } })
  await assert.rejects(client.apiHtml('/preview', signal), /HTML document/)
  currentFetch = async () =>
    Response.json({ error: 'Project access changed.' }, { status: 403 })
  await assert.rejects(
    client.apiImage('/preview', signal),
    (error) =>
      error.status === 403 && error.message === 'Project access changed.',
  )
  await assert.rejects(
    client.apiHtml('/preview', signal),
    (error) => error.status === 403,
  )
})
