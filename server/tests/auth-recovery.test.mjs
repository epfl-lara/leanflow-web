import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { createStudio } from '../studio.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-auth-'))
  const studio = await createStudio({
    dataDir,
    entraConfig: null,
    runtime: {
      async init() {},
      async shutdown() {},
      info: () => ({ ready: true }),
      templates: () => [],
    },
    config: {
      defaultModel: 'fixture',
      models: [],
      provider: {},
      redact: String,
      lemex: {},
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const otherToken = 'isolated-test-collaborator-token'
  const usersFile = path.join(dataDir, 'auth/users.json')
  const users = JSON.parse(await fs.readFile(usersFile, 'utf8'))
  users.push({
    id: 'collaborator',
    name: 'Collaborator',
    tokenHash: createHash('sha256').update(otherToken).digest('hex'),
  })
  await fs.writeFile(usersFile, JSON.stringify(users))
  const payload = Buffer.from(
    JSON.stringify({
      id: 'owner',
      expires: Date.now() - 1000,
    }),
  ).toString('base64url')
  const expiredCookie = `lemex_web=${payload}.${studio.auth.sign(payload)}`
  const request = (endpoint, options = {}) =>
    fetch(
      `http://127.0.0.1:${studio.server.address().port}${endpoint}`,
      options,
    )
  const login = (body, cookie = expiredCookie) =>
    request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    })
  return { studio, request, login, token, otherToken, expiredCookie }
}

test('disabled EPFL sign-in is public only at its own routes and keeps token sessions working', async (t) => {
  const { request, login, token } = await fixture(t)
  const status = await request('/api/auth/entra')
  assert.equal(status.status, 200)
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await status.json(), { enabled: false })
  const start = await request('/api/auth/entra/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(start.status, 404)
  assert.equal(start.headers.get('set-cookie'), null)
  const callback = await request('/api/auth/entra/callback?state=fixture')
  assert.equal(callback.status, 404)
  assert.equal(callback.headers.get('set-cookie'), null)
  assert.equal((await request('/api/auth/entra/private')).status, 401)
  const crossOrigin = await request('/api/auth/entra/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://untrusted.example',
    },
    body: '{}',
  })
  assert.equal(crossOrigin.status, 403)
  const signedIn = await login({ token })
  assert.equal(signedIn.status, 200)
  const session = await request('/api/session', {
    headers: { Cookie: signedIn.headers.get('set-cookie').split(';')[0] },
  })
  assert.equal((await session.json()).user.id, 'owner')
})

test('session recovery renews an expired cookie only for the expected workspace account', async (t) => {
  const { request, login, token, expiredCookie } = await fixture(t)
  const expired = await request('/api/session', {
    headers: { Cookie: expiredCookie },
  })
  assert.equal(expired.status, 401)

  const renewed = await login({ token, expectedUserId: 'owner' })
  assert.equal(renewed.status, 200)
  assert.deepEqual(await renewed.json(), {
    user: { id: 'owner', name: 'Owner', role: 'owner', profileComplete: false },
  })
  const cookie = renewed.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Max-Age=172800/)
  const session = await request('/api/session', {
    headers: { Cookie: cookie.split(';')[0] },
  })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).user.id, 'owner')
})

test('private API responses and authentication failures never enter HTTP caches, including route casing aliases', async (t) => {
  const { request, login, token } = await fixture(t)
  const signedIn = await login({ token })
  assert.equal(signedIn.headers.get('cache-control'), 'no-store')
  const cookie = signedIn.headers.get('set-cookie').split(';')[0]
  await signedIn.text()
  for (const route of [
    '/api/session',
    '/API/session',
    '/Api/Session',
    '/api',
    '/API',
  ]) {
    for (const headers of [{}, { Cookie: cookie }]) {
      const response = await request(route, { headers })
      assert.equal(response.headers.get('cache-control'), 'no-store', route)
      await response.text()
    }
  }
})

test('recovery rejects another valid account without replacing a browser cookie', async (t) => {
  const { request, login, token, otherToken } = await fixture(t)
  const initial = await login({ token })
  const originalCookie = initial.headers.get('set-cookie').split(';')[0]
  for (const cookie of [undefined, originalCookie]) {
    const rejected = await login(
      { token: otherToken, expectedUserId: 'owner' },
      cookie,
    )
    assert.equal(rejected.status, 409)
    assert.equal(rejected.headers.get('set-cookie'), null)
    const body = await rejected.text()
    assert.match(body, /different account/)
    assert(!body.includes(otherToken))
  }
  const unchanged = await request('/api/session', {
    headers: { Cookie: originalCookie },
  })
  assert.equal((await unchanged.json()).user.id, 'owner')
  // Normal login still permits intentional account changes outside recovery.
  const ordinary = await login({ token: otherToken })
  assert.equal(ordinary.status, 200)
  assert.equal((await ordinary.json()).user.id, 'collaborator')
})

test('invalid credentials and malformed recovery identities never issue cookies', async (t) => {
  const { login, token } = await fixture(t)
  const invalid = await login({ token: 'invalid', expectedUserId: 'owner' })
  assert.equal(invalid.status, 401)
  assert.equal(invalid.headers.get('set-cookie'), null)
  for (const expectedUserId of [null, 3, {}, ['owner']]) {
    const malformed = await login({ token, expectedUserId })
    assert.equal(malformed.status, 409)
    assert.equal(malformed.headers.get('set-cookie'), null)
  }
})

test('anonymous logout clears expired or invalid cookies even when the tab keeps its account binding', async (t) => {
  const { studio, request, expiredCookie } = await fixture(t)
  studio.providers.status = () =>
    assert.fail('Anonymous logout must not read provider data')
  for (const cookie of [
    expiredCookie,
    'lemex_web=invalid-fixture-session',
    undefined,
  ]) {
    const response = await request('/api/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Leanflow-User': 'owner',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: '{}',
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie'), /lemex_web=;.*Max-Age=0/)
    assert.deepEqual(await response.json(), { ok: true })
  }
})

test('a tab account binding rejects another cookie before private reads, writes, logout, and streams', async (t) => {
  const { studio, request, login, token, otherToken } = await fixture(t)
  const alpha = await login({ token })
  const alphaCookie = alpha.headers.get('set-cookie').split(';')[0]
  const beta = await login({ token: otherToken })
  const betaCookie = beta.headers.get('set-cookie').split(';')[0]
  const before = await studio.settings.get('collaborator')
  const run = studio.events.create('collaborator', {
    kind: 'agent',
    prompt: 'BETA_PRIVATE_PROMPT',
  })
  studio.events.updateMetadata(run.id, { status: 'completed' })
  for (const [endpoint, method, body] of [
    ['/api/session', 'GET'],
    ['/api/settings', 'GET'],
    ['/api/settings', 'PUT', { ...before, extraInstructions: 'Alpha draft' }],
    ['/api/session/activity', 'POST', {}],
    ['/api/logout', 'POST', {}],
    [`/api/runs/${run.id}/events?expectedUserId=owner`, 'GET'],
    [`/api/runs/${run.id}/events?transport=poll&expectedUserId=owner`, 'GET'],
  ]) {
    const response = await request(endpoint, {
      method,
      headers: {
        Cookie: betaCookie,
        'X-Leanflow-User': 'owner',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    assert.equal(response.status, 401, `${method} ${endpoint}`)
    assert.equal(response.headers.get('set-cookie'), null)
    assert(
      !JSON.stringify(await response.json()).includes('BETA_PRIVATE_PROMPT'),
    )
  }
  assert.deepEqual(await studio.settings.get('collaborator'), before)
  const unchanged = await request('/api/session', {
    headers: { Cookie: betaCookie },
  })
  assert.equal((await unchanged.json()).user.id, 'collaborator')
  for (const [cookie, expected] of [
    [alphaCookie, 'owner'],
    [betaCookie, 'collaborator'],
  ]) {
    const response = await request('/api/session', {
      headers: { Cookie: cookie, 'X-Leanflow-User': expected },
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).user.id, expected)
  }
  // Headerless bearer API clients keep the existing authentication contract.
  const bearer = await request('/api/session', {
    headers: { Authorization: `Bearer ${otherToken}` },
  })
  assert.equal((await bearer.json()).user.id, 'collaborator')
})

test('all editor, collaboration, and terminal upgrades reject a changed account before opening a project', async (t) => {
  const { studio, login, otherToken } = await fixture(t)
  const beta = await login({ token: otherToken })
  const cookie = beta.headers.get('set-cookie').split(';')[0]
  const origin = `http://127.0.0.1:${studio.server.address().port}`
  async function status(endpoint, headers = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(origin.replace('http:', 'ws:') + endpoint, {
        headers: { Cookie: cookie, Origin: origin, ...headers },
      })
      socket.on('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode)
      })
      socket.on('error', reject)
      socket.on('open', () => {
        socket.close()
        reject(new Error('Unexpected WebSocket upgrade'))
      })
    })
  }
  for (const endpoint of [
    '/websocket/missing',
    '/websocket/collaboration/missing',
    '/websocket/terminal/missing?openingId=8d3d06a9-5f01-477d-a588-e571150cd1b5',
  ]) {
    const separator = endpoint.includes('?') ? '&' : '?'
    assert.equal(await status(endpoint), 428)
    assert.equal(
      await status(endpoint, { Authorization: 'Basic stale-client' }),
      428,
    )
    assert.equal(
      await status(endpoint, { Authorization: `Bearer ${otherToken}` }),
      404,
    )
    assert.equal(
      await status(`${endpoint}${separator}expectedUserId=owner`),
      401,
    )
    assert.equal(
      await status(`${endpoint}${separator}expectedUserId=collaborator`),
      404,
    )
    assert.equal(
      await status(
        `${endpoint}${separator}expectedUserId=owner&expectedUserId=owner`,
      ),
      400,
    )
  }
})
