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
  new Function('module', 'exports', outputText)(module, module.exports)
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
