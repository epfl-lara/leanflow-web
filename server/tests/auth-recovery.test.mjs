import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createStudio } from '../studio.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-auth-'))
  const studio = await createStudio({
    dataDir,
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
  return { request, login, token, otherToken, expiredCookie }
}

test('session recovery renews an expired cookie only for the expected workspace account', async (t) => {
  const { request, login, token, expiredCookie } = await fixture(t)
  const expired = await request('/api/session', {
    headers: { Cookie: expiredCookie },
  })
  assert.equal(expired.status, 401)

  const renewed = await login({ token, expectedUserId: 'owner' })
  assert.equal(renewed.status, 200)
  assert.deepEqual(await renewed.json(), {
    user: { id: 'owner', name: 'Owner', role: 'owner' },
  })
  const cookie = renewed.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Max-Age=43200/)
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
