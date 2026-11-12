import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Auth } from '../auth.mjs'
import { createStudio } from '../studio.mjs'
import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-profile-'))
  const studio = await createStudio({
    dataDir,
    modelDiscoverer: fixtureModelDiscovery,
    runtime: {
      async init() {},
      async shutdown() {},
      info: () => ({ ready: true }),
      templates: () => [],
    },
    config: {
      models: [],
      provider: { LEMEX_BASE_URL: 'https://provider.example/v1' },
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
  const request = (
    endpoint,
    { token: credential = token, body, ...options } = {},
  ) =>
    fetch(`http://127.0.0.1:${studio.server.address().port}${endpoint}`, {
      ...options,
      headers: {
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const profile = (name, credential = token) =>
    request('/api/profile', {
      token: credential,
      method: 'PUT',
      body: { name },
    })
  return { ...studio, dataDir, token, request, profile }
}

test('profile names persist without changing account identity, tokens, sessions or personal data', async (t) => {
  const f = await fixture(t)
  const invited = await f.auth.createUser(
    { id: 'owner' },
    { name: 'Invited user' },
  )
  assert.equal(invited.user.profileComplete, false)
  const before = await (await f.request('/api/session')).json()
  assert.equal(before.user.profileComplete, false)
  const login = await f.request('/api/login', {
    method: 'POST',
    token: null,
    body: { token: invited.token },
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  await login.text()
  const id = invited.user.id
  const settings = await f.settings.save(id, {
    extraInstructions: 'Keep my personal proof guidance.',
    tools: { lean: true, lean_explore: false, exa: false },
  })
  await f.providers.save(id, 'profile-fixture-private-key')
  const tokenHash = f.auth.users.find((user) => user.id === id).tokenHash
  const response = await f.request('/api/profile', {
    method: 'PUT',
    token: null,
    headers: { Cookie: cookie },
    body: { name: '  Émilie O’Neill-Smith  ' },
  })
  assert.equal(response.status, 200)
  const expected = {
    id,
    name: 'Émilie O’Neill-Smith',
    role: 'user',
    profileComplete: true,
  }
  assert.deepEqual(await response.json(), { user: expected })
  const session = await (
    await f.request('/api/session', {
      token: null,
      headers: { Cookie: cookie },
    })
  ).json()
  assert.deepEqual(session.user, expected)
  assert.equal(session.lemex.configured, true)
  assert.deepEqual(await f.settings.get(id), settings)
  assert.equal(
    f.providers.provider(id).LEMEX_API_KEY,
    'profile-fixture-private-key',
  )
  assert.equal(f.auth.users.find((user) => user.id === id).tokenHash, tokenHash)
  const restarted = new Auth(f.dataDir)
  await restarted.init()
  assert.deepEqual(
    restarted.public(await restarted.login(invited.token, 'fixture')),
    expected,
  )
  assert.deepEqual(
    restarted.public(restarted.identify({ headers: { cookie } })),
    expected,
  )
  assert.deepEqual(
    (await (await f.request('/api/session')).json()).user,
    before.user,
  )
  assert.equal(
    (await f.request('/api/admin/users', { token: invited.token })).status,
    403,
  )
  const sameName = await f.profile('Émilie O’Neill-Smith', invited.token)
  assert.equal(sameName.status, 200)
})

test('profile updates require authentication and same-origin JSON requests', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.profile('Anonymous', null)).status, 401)
  assert.equal((await f.profile('Unknown', 'invalid-token')).status, 401)
  const crossOrigin = await f.request('/api/profile', {
    method: 'PUT',
    headers: { Origin: 'https://another.example' },
    body: { name: 'Changed' },
  })
  assert.equal(crossOrigin.status, 403)
  const nonJson = await f.request('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: { name: 'Changed' },
  })
  assert.equal(nonJson.status, 415)
  const session = await (await f.request('/api/session')).json()
  assert.equal(session.user.name, 'Owner')
  assert.equal(session.user.profileComplete, false)
})

test('profile validation rejects malformed names, identity changes and another account name without changing either account', async (t) => {
  const f = await fixture(t)
  const invited = await f.auth.createUser(
    { id: 'owner' },
    { name: "Anne O'Neil" },
  )
  const filename = path.join(f.dataDir, 'auth/users.json')
  const before = await fs.readFile(filename, 'utf8')
  for (const body of [
    null,
    [],
    'Changed',
    {},
    { name: null },
    { name: {} },
    { name: 5 },
    { name: '' },
    { name: '   ' },
    { name: 'a'.repeat(81) },
    { name: 'Bad\nName' },
    { name: '<script>' },
    { name: 'Changed', id: 'owner' },
    { name: 'Changed', role: 'owner' },
    { name: 'Changed', tokenHash: 'replacement' },
    { name: 'Changed', profileComplete: true },
  ]) {
    const response = await f.request('/api/profile', {
      method: 'PUT',
      token: invited.token,
      body,
    })
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    await response.text()
    assert.equal(await fs.readFile(filename, 'utf8'), before)
  }
  assert.equal((await f.profile('owner', invited.token)).status, 409)
  assert.equal((await f.profile("anne o'neil")).status, 409)
  assert.equal(await fs.readFile(filename, 'utf8'), before)
  const valid = await f.profile("Renée O'Neil", invited.token)
  assert.equal(valid.status, 200)
  assert.equal((await valid.json()).user.role, 'user')
  assert.equal(
    (await f.request('/api/admin/users', { token: invited.token })).status,
    403,
  )
})

test('concurrent profile updates preserve unique names and revoked accounts cannot update profiles', async (t) => {
  const f = await fixture(t)
  const invited = await f.auth.createUser({ id: 'owner' }, { name: 'Invited' })
  const responses = await Promise.all([
    f.profile('Shared name'),
    f.profile('shared NAME', invited.token),
  ])
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  )
  await Promise.all(responses.map((response) => response.text()))
  await f.auth.mutate(() => {
    f.auth.users = f.auth.users.filter((user) => user.id !== invited.user.id)
  })
  await assert.rejects(
    f.auth.updateProfile(invited.user, { name: 'Revoked' }),
    { status: 401 },
  )
  assert.equal((await f.profile('Revoked', invited.token)).status, 401)
})
