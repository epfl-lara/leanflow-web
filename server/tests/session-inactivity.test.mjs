import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createStudio } from '../studio.mjs'

const HOUR = 3600_000
const START = Date.UTC(2026, 10, 12, 12)

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-idle-'))
  async function start() {
    const previousOrigin = process.env.STUDIO_ORIGIN
    process.env.STUDIO_ORIGIN = 'https://leanflow.example'
    let studio
    try {
      studio = await createStudio({
        dataDir,
        runtime: {
          async init() {},
          async shutdown() {},
          info: () => ({ ready: true }),
          templates: () => [],
        },
        config: { models: [], provider: {}, redact: String, lemex: {} },
      })
    } finally {
      if (previousOrigin === undefined) delete process.env.STUDIO_ORIGIN
      else process.env.STUDIO_ORIGIN = previousOrigin
    }
    await new Promise((resolve) =>
      studio.server.listen(0, '127.0.0.1', resolve),
    )
    return studio
  }
  let studio = await start()
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const request = (endpoint, { cookie, body, headers, ...options } = {}) =>
    fetch(`http://127.0.0.1:${studio.server.address().port}${endpoint}`, {
      ...options,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return {
    get auth() {
      return studio.auth
    },
    token,
    request,
    login: (credential = token) =>
      request('/api/login', { method: 'POST', body: { token: credential } }),
    activity: (cookie, { userId = 'owner', headers, ...options } = {}) =>
      request('/api/session/activity', {
        method: 'POST',
        cookie,
        body: {},
        ...options,
        headers: { 'X-Leanflow-User': userId, ...headers },
      }),
    async restart() {
      await studio.close()
      studio = await start()
    },
  }
}

async function sessionCookie(response) {
  assert.equal(response.status, 200)
  const value = response.headers.get('set-cookie')
  assert(value)
  assert.match(value, /Max-Age=172800(?:;|$)/)
  for (const attribute of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure'])
    assert(value.includes(attribute))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  await response.json()
  return value.split(';')[0]
}

async function statusWithoutRenewal(response, status) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('set-cookie'), null)
  await response.text()
}

test('sign-in lasts 48 hours and background API polling cannot extend inactivity', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const f = await fixture(t)
  const cookie = await sessionCookie(await f.login())
  for (const elapsed of [12 * HOUR + 1, 24 * HOUR, 47 * HOUR, 48 * HOUR - 1]) {
    t.mock.timers.setTime(START + elapsed)
    await statusWithoutRenewal(await f.request('/api/session', { cookie }), 200)
    await statusWithoutRenewal(
      await f.request('/api/templates', {
        cookie,
        headers: { 'X-Leanflow-User': 'owner' },
      }),
      200,
    )
  }
  t.mock.timers.setTime(START + 48 * HOUR)
  await statusWithoutRenewal(await f.request('/api/session', { cookie }), 401)
  await statusWithoutRenewal(await f.activity(cookie), 401)
})

test('activity renews sessions repeatedly beyond sign-in age and renewal survives a restart', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const f = await fixture(t)
  const initial = await sessionCookie(await f.login())
  t.mock.timers.setTime(START + 47 * HOUR)
  const renewed = await sessionCookie(await f.activity(initial))
  t.mock.timers.setTime(START + 60 * HOUR)
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: initial }),
    401,
  )
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: renewed }),
    200,
  )
  await f.restart()
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: renewed }),
    200,
  )
  t.mock.timers.setTime(START + 94 * HOUR)
  const continued = await sessionCookie(await f.activity(renewed))
  t.mock.timers.setTime(START + 142 * HOUR - 1)
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: continued }),
    200,
  )
  t.mock.timers.setTime(START + 142 * HOUR)
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: continued }),
    401,
  )
  await statusWithoutRenewal(await f.activity(continued), 401)
  // Session expiry does not invalidate the administrator-issued access token.
  await statusWithoutRenewal(
    await f.request('/api/session', {
      headers: { Authorization: `Bearer ${f.token}` },
    }),
    200,
  )
  await sessionCookie(await f.login())
})

test('activity upgrades an unexpired legacy cookie but never revives an expired one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const f = await fixture(t)
  const payload = Buffer.from(
    JSON.stringify({ id: 'owner', expires: START + 12 * HOUR }),
  ).toString('base64url')
  const legacy = `lemex_web=${payload}.${f.auth.sign(payload)}`
  t.mock.timers.setTime(START + 11 * HOUR)
  const renewed = await sessionCookie(await f.activity(legacy))
  t.mock.timers.setTime(START + 12 * HOUR)
  await statusWithoutRenewal(await f.activity(legacy), 401)
  t.mock.timers.setTime(START + 59 * HOUR - 1)
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: renewed }),
    200,
  )
  t.mock.timers.setTime(START + 59 * HOUR)
  await statusWithoutRenewal(await f.activity(renewed), 401)
})

test('renewal requires authenticated same-origin JSON activity and validates its empty payload', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const f = await fixture(t)
  const cookie = await sessionCookie(await f.login())
  await statusWithoutRenewal(await f.activity(), 401)
  await statusWithoutRenewal(await f.activity(cookie + 'tampered'), 401)
  await statusWithoutRenewal(
    await f.activity(undefined, {
      headers: { Authorization: 'Bearer invalid-fixture-token' },
    }),
    401,
  )
  await statusWithoutRenewal(
    await f.activity(cookie, {
      headers: { Origin: 'https://another.example' },
    }),
    403,
  )
  await statusWithoutRenewal(
    await f.activity(cookie, { headers: { 'Content-Type': 'text/plain' } }),
    415,
  )
  for (const body of [
    null,
    [],
    'active',
    1,
    { userId: 'owner' },
    { expires: START + 1000 * HOUR },
  ])
    await statusWithoutRenewal(await f.activity(cookie, { body }), 400)
  await statusWithoutRenewal(
    await f.request('/api/session/activity', {
      cookie,
      headers: { 'X-Leanflow-User': 'owner' },
    }),
    404,
  )
  await sessionCookie(
    await f.activity(cookie, {
      headers: { Origin: 'https://leanflow.example' },
    }),
  )
})

test('activity cannot renew a revoked account or extend another account session', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START })
  const f = await fixture(t)
  const invited = await f.auth.createUser(
    { id: 'owner' },
    { name: 'Idle fixture collaborator' },
  )
  const owner = await sessionCookie(await f.login())
  const collaborator = await sessionCookie(await f.login(invited.token))
  t.mock.timers.setTime(START + 47 * HOUR)
  const activeOwner = await sessionCookie(await f.activity(owner))
  t.mock.timers.setTime(START + 48 * HOUR)
  await statusWithoutRenewal(
    await f.activity(collaborator, { userId: invited.user.id }),
    401,
  )
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: activeOwner }),
    200,
  )
  const newCollaborator = await sessionCookie(await f.login(invited.token))
  await f.auth.mutate(() => {
    f.auth.users = f.auth.users.filter((user) => user.id !== invited.user.id)
  })
  await statusWithoutRenewal(
    await f.activity(newCollaborator, { userId: invited.user.id }),
    401,
  )
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: newCollaborator }),
    401,
  )
  await statusWithoutRenewal(
    await f.request('/api/session', { cookie: activeOwner }),
    200,
  )
})
