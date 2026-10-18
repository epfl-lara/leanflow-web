import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Providers } from '../providers.mjs'
import { createStudio } from '../studio.mjs'
import { AgentManager } from '../agents.mjs'
import { repairProjectSetup } from '../setup-repair.mjs'
import { createChatTitleGenerator } from '../chat-titles.mjs'
import { loadConfig } from '../config.mjs'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { RCP_BASE_URL } from '../provider-endpoint.mjs'

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-accounts-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

test('legacy RCP keys remain unchanged; custom endpoints and keys persist as one authenticated encrypted connection', async (t) => {
  const dir = await temp(t),
    session = 'fixture-session-key'
  const store = await new Providers(dir, session, RCP_BASE_URL).init()
  const iv = randomBytes(12),
    cipher = createCipheriv(
      'aes-256-gcm',
      createHash('sha256')
        .update('leanflow-provider-v1\0' + session)
        .digest(),
      iv,
    )
  cipher.setAAD(Buffer.from('alice'))
  const encrypted = Buffer.concat([
    cipher.update('legacy-rcp-fixture-key', 'utf8'),
    cipher.final(),
  ])
  const legacy = JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    value: encrypted.toString('base64'),
  })
  await fs.writeFile(store.filename('alice'), legacy)
  const restarted = await new Providers(dir, session, RCP_BASE_URL).init()
  assert.equal(restarted.provider('alice').LEMEX_BASE_URL, RCP_BASE_URL)
  assert.equal(
    restarted.provider('alice').LEMEX_API_KEY,
    'legacy-rcp-fixture-key',
  )
  assert.equal(await fs.readFile(store.filename('alice'), 'utf8'), legacy)
  const base = restarted.selection('alice', {
    provider: 'custom',
    baseUrl: 'https://api.example.com/v1/',
  })
  await restarted.save('alice', 'custom-provider-fixture-key', base)
  const ciphertext = await fs.readFile(store.filename('alice'), 'utf8')
  assert(!ciphertext.includes(base))
  assert(!ciphertext.includes('custom-provider-fixture-key'))
  const again = await new Providers(dir, session, RCP_BASE_URL).init()
  assert.equal(again.provider('alice').LEMEX_BASE_URL, base)
  assert.equal(again.status('alice').provider, 'custom')
  assert.equal(again.selection('alice', {}), base)
  assert.equal(again.selection('alice', { provider: 'rcp' }), RCP_BASE_URL)
  assert.equal(again.status('bob').provider, 'rcp')
  for (const input of [
    { provider: 'other' },
    { provider: 'custom', baseUrl: 'http://localhost/v1' },
  ])
    assert.throws(() => again.selection('alice', input), { status: 400 })
  const tampered = JSON.parse(ciphertext)
  tampered.version = 1
  await fs.writeFile(store.filename('alice'), JSON.stringify(tampered))
  assert.equal(
    (await new Providers(dir, session, RCP_BASE_URL).init()).status('alice')
      .configured,
    false,
  )
})

test('account keys are encrypted, private, persistent, isolated and replaceable', async (t) => {
  const dir = await temp(t),
    store = await new Providers(
      dir,
      'fixture-session-key',
      'https://provider.example/v1',
    ).init()
  assert.throws(() => store.provider('alice'), { status: 428 })
  await store.save('alice', 'alice-fixture-private-key')
  await store.save('bob', 'bob-fixture-private-key')
  const text = await fs.readFile(store.filename('alice'), 'utf8')
  assert(!text.includes('alice-fixture-private-key'))
  assert.equal((await fs.stat(store.filename('alice'))).mode & 0o777, 0o600)
  assert(!JSON.stringify(store.status('alice')).includes('key'))
  assert.equal(
    store.provider('alice').LEMEX_API_KEY,
    'alice-fixture-private-key',
  )
  assert.equal(store.provider('bob').LEMEX_API_KEY, 'bob-fixture-private-key')
  await store.save('alice', 'alice-fixture-replacement')
  assert.equal(
    store.redact(
      'alice-fixture-private-key bob-fixture-private-key alice-fixture-replacement',
    ),
    '[redacted] [redacted] [redacted]',
  )
  const restarted = await new Providers(
    dir,
    'fixture-session-key',
    store.baseUrl,
  ).init()
  assert.equal(
    restarted.provider('alice').LEMEX_API_KEY,
    'alice-fixture-replacement',
  )
  assert.equal(
    restarted.provider('bob').LEMEX_API_KEY,
    'bob-fixture-private-key',
  )
  assert.throws(() => restarted.provider('../alice'), { status: 428 })
  await assert.rejects(() => restarted.save('../alice', 'fixture-key'), {
    status: 400,
  })
  // A ciphertext cannot be copied onto another account.
  await fs.copyFile(store.filename('alice'), store.filename('bob'))
  const tampered = await new Providers(
    dir,
    'fixture-session-key',
    store.baseUrl,
  ).init()
  assert.equal(tampered.status('bob').configured, false)
  assert.equal(tampered.status('alice').configured, true)
})

test('legacy shared keys and environment keys are never enabled by web configuration', async (t) => {
  const dir = await temp(t)
  await fs.writeFile(
    path.join(dir, 'provider.json'),
    JSON.stringify({
      LEMEX_API_KEY: 'legacy-private-key',
      LEMEX_BASE_URL: 'https://provider.example/v1',
    }),
  )
  const config = await loadConfig(dir, {
    env: { LEMEX_API_KEY: 'environment-private-key' },
  })
  assert.equal(config.provider.LEMEX_API_KEY, undefined)
  assert.equal(config.lemex.configured, false)
  assert.equal(config.provider.LEMEX_BASE_URL, 'https://provider.example/v1')
  assert.equal(
    config.redact('legacy-private-key environment-private-key'),
    '[redacted] [redacted]',
  )
})

test('validation does no inference, forbids redirects, and never returns provider bodies or credentials', async (t) => {
  const store = await new Providers(
    await temp(t),
    'key',
    'https://provider.example/v1',
  ).init()
  await store.save('alice', 'original-fixture-key')
  const key = 'replacement-fixture-key'
  assert.equal(
    await store.validate(key, async (url, options) => {
      assert.equal(String(url), 'https://provider.example/v1/models')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.authorization, `Bearer ${key}`)
      assert.equal(options.body, undefined)
      return new Response('{}')
    }),
    key,
  )
  await assert.rejects(
    () => store.validate(key, async () => new Response(key, { status: 401 })),
    (error) => error.status === 400 && !error.message.includes(key),
  )
  await assert.rejects(
    () =>
      store.validate(key, async () => {
        throw new Error(key)
      }),
    (error) => error.status === 502 && !error.message.includes(key),
  )
  assert.equal(store.provider('alice').LEMEX_API_KEY, 'original-fixture-key')
  for (const input of [null, {}, '', 'has a space', 'x\nheader:value'])
    await assert.rejects(() => store.validate(input), { status: 400 })
})

async function fixture(t) {
  const dataDir = await temp(t)
  const studio = await createStudio({
    modelDiscoverer: fixtureModelDiscovery,
    dataDir,
    runtime: {
      async init() {},
      async shutdown() {},
      info: () => ({ ready: true }),
      templates: () => [],
    },
    config: {
      defaultModel: 'deepseek-test',
      models: [{ id: 'deepseek-test' }],
      provider: {
        LEMEX_API_KEY: 'forbidden-shared-key',
        LEMEX_BASE_URL: 'https://provider.example/v1',
      },
      redact: String,
      lemex: { configured: true },
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(() => studio.close())
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const request = (endpoint, tokenValue = token, method = 'GET', body) =>
    fetch(`http://127.0.0.1:${studio.server.address().port}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { ...studio, dataDir, token, request }
}

test('tokens identify roles; only owner appoints admins; users cannot list or create accounts', async (t) => {
  const f = await fixture(t)
  let response = await f.request('/api/admin/users', f.token, 'POST', {
    name: 'Viktor',
    role: 'admin',
  })
  assert.equal(response.status, 201)
  const admin = await response.json()
  response = await f.request('/api/admin/users', admin.token, 'POST', {
    name: 'Maryna',
    role: 'user',
  })
  assert.equal(response.status, 201)
  const user = await response.json()
  assert.equal((await f.request('/api/admin/users', user.token)).status, 403)
  assert.equal(
    (
      await f.request('/api/admin/users', user.token, 'POST', {
        name: 'Invalid escalation',
        role: 'admin',
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request('/api/admin/users', admin.token, 'POST', {
        name: 'Another admin',
        role: 'admin',
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request('/api/admin/users', f.token, 'POST', {
        name: {},
        role: 'user',
      })
    ).status,
    400,
  )
  assert.equal(
    (await f.request('/api/admin/users', f.token, 'POST', { name: 'Maryna' }))
      .status,
    409,
  )
  for (const account of [admin, user]) {
    const login = await f.request('/api/login', '', 'POST', {
      token: account.token,
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const session = await fetch(
      `http://127.0.0.1:${f.server.address().port}/api/session`,
      { headers: { Cookie: cookie } },
    )
    const body = await session.json()
    assert.equal(body.user.role, account.user.role)
    assert.equal(body.lemex.configured, false)
    assert(!JSON.stringify(body).includes('forbidden-shared-key'))
  }
  await f.providers.save(user.user.id, 'private-personal-fixture-key')
  assert.equal(
    (await (await f.request('/api/provider', user.token)).json()).configured,
    true,
  )
  assert.equal(
    (await (await f.request('/api/provider', admin.token)).json()).configured,
    false,
  )
  const listing = await (await f.request('/api/admin/users')).text()
  for (const secret of [
    admin.token,
    user.token,
    'private-personal-fixture-key',
    'tokenHash',
  ])
    assert(!listing.includes(secret))
  // Re-read persisted roles on every request, including an already issued cookie.
  await f.auth.mutate(() => {
    f.auth.users.find((u) => u.id === admin.user.id).role = 'user'
  })
  assert.equal((await f.request('/api/admin/users', admin.token)).status, 403)
})

test('provider selection validates the new endpoint and never forwards the saved key to another provider', async (t) => {
  const f = await fixture(t)
  await f.providers.save('owner', 'original-rcp-key')
  const other = await f.auth.createUser({ id: 'owner' }, { name: 'Other' })
  await f.providers.save(other.user.id, 'other-fixture-key')
  const sent = []
  f.providers.validate = async (key, _fetch, base) => {
    f.providers.parseKey(key)
    sent.push({ key, base })
    if (key === 'rejected-fixture-key')
      throw Object.assign(new Error('Rejected'), { status: 400 })
    return key
  }
  assert.equal(
    (
      await f.request('/api/provider', f.token, 'PUT', {
        provider: 'custom',
        baseUrl: 'https://custom.example/v1',
      })
    ).status,
    400,
  )
  assert.equal(sent.length, 0)
  assert.equal(
    (
      await f.request('/api/provider', f.token, 'PUT', {
        provider: 'custom',
        baseUrl: 'https://custom.example/v1',
        apiKey: 'custom-fixture-key',
      })
    ).status,
    200,
  )
  assert.deepEqual(sent, [
    { key: 'custom-fixture-key', base: 'https://custom.example/v1' },
  ])
  assert.equal(
    f.providers.provider(other.user.id).LEMEX_BASE_URL,
    'https://provider.example/v1',
  )
  assert.equal(
    (
      await f.request('/api/provider', f.token, 'PUT', {
        provider: 'custom',
        baseUrl: 'https://different.example/v1',
        apiKey: 'rejected-fixture-key',
      })
    ).status,
    400,
  )
  assert.equal(
    f.providers.provider('owner').LEMEX_BASE_URL,
    'https://custom.example/v1',
  )
  assert.equal(
    f.providers.provider('owner').LEMEX_API_KEY,
    'custom-fixture-key',
  )
  assert.equal(
    (
      await f.request('/api/provider', f.token, 'PUT', {
        apiKey: 'new-custom-fixture-key',
      })
    ).status,
    200,
  )
  assert.equal(
    f.providers.provider('owner').LEMEX_BASE_URL,
    'https://custom.example/v1',
  )
  assert.equal(
    (
      await f.request('/api/provider', f.token, 'PUT', {
        provider: 'rcp',
        apiKey: 'return-default-fixture-key',
      })
    ).status,
    200,
  )
  assert.equal(
    f.providers.provider('owner').LEMEX_BASE_URL,
    f.providers.baseUrl,
  )
})

test('API key updates validate once, stay within the authenticated account, and survive a store restart', async (t) => {
  const f = await fixture(t)
  const other = await f.auth.createUser({ id: 'owner' }, { name: 'Seewoo' })
  let validations = 0
  f.providers.validate = async (key) => {
    validations++
    if (key === 'invalid-key')
      throw Object.assign(new Error('Key rejected'), { status: 400 })
    return key
  }
  const reply = await f.request('/api/provider', other.token, 'PUT', {
    apiKey: 'seewoo-fixture-key',
    owner: 'owner',
  })
  assert.equal(reply.status, 200)
  assert(!JSON.stringify(await reply.json()).includes('seewoo-fixture-key'))
  assert.equal(
    f.providers.provider(other.user.id).LEMEX_API_KEY,
    'seewoo-fixture-key',
  )
  assert.throws(() => f.providers.provider('owner'), { status: 428 })
  assert.equal(
    (
      await f.request('/api/provider', other.token, 'PUT', {
        apiKey: 'invalid-key',
      })
    ).status,
    400,
  )
  assert.equal(
    f.providers.provider(other.user.id).LEMEX_API_KEY,
    'seewoo-fixture-key',
  )
  assert.equal(validations, 2)
  const restarted = await new Providers(
    f.dataDir,
    f.auth.key,
    f.providers.baseUrl,
  ).init()
  assert.equal(
    restarted.provider(other.user.id).LEMEX_API_KEY,
    'seewoo-fixture-key',
  )
})

test('model preferences endpoints stay within the signed-in account and preserve the default and key', async (t) => {
  const f = await fixture(t)
  const other = await f.auth.createUser({ id: 'owner' }, { name: 'Other' })
  await f.providers.save('owner', 'owner-fixture-key')
  await f.providers.save(other.user.id, 'other-fixture-key')
  assert.equal(
    (
      await f.request('/api/models/preferences', 'invalid-token', 'PUT', {
        savedModels: [],
      })
    ).status,
    401,
  )
  const initial = await (await f.request('/api/models')).json()
  assert.deepEqual(initial.savedModels, ['deepseek-test'])
  assert.equal(
    (
      await f.request('/api/models/preferences', other.token, 'PUT', {
        savedModels: [],
        owner: 'owner',
      })
    ).status,
    200,
  )
  assert.deepEqual(
    (await (await f.request('/api/models', other.token)).json()).savedModels,
    [],
  )
  assert.deepEqual(
    (await (await f.request('/api/session')).json()).savedModels,
    ['deepseek-test'],
  )
  assert.equal(
    (
      await f.request('/api/models/preferences', other.token, 'PUT', {
        savedModels: ['unavailable-model'],
      })
    ).status,
    400,
  )
  const refreshed = await (
    await f.request('/api/models/refresh', other.token, 'POST', {})
  ).json()
  assert.deepEqual(refreshed.savedModels, [])
  assert.equal(refreshed.defaultModel, initial.defaultModel)
  assert.deepEqual(refreshed.models, initial.models)
  assert.equal(
    f.providers.provider(other.user.id).LEMEX_API_KEY,
    'other-fixture-key',
  )
  assert.deepEqual(await f.modelPreferences.get(other.user.id, initial), [])
})

test('agent runs, setup repairs, and chat titles cannot fall back to a shared key', async (t) => {
  const f = await fixture(t)
  const manager = new AgentManager({
    config: f.config,
    events: { listMetadata: () => [] },
    workspaces: { get: () => ({ status: 'ready' }) },
  })
  await assert.rejects(
    () =>
      manager.start('missing-key', 'project', {
        mode: 'proofs',
        prompt: 'test',
      }),
    { status: 428 },
  )
  await assert.rejects(
    () => repairProjectSetup({ config: f.config, owner: 'missing-key' }),
    { status: 428 },
  )
  let received
  const generator = createChatTitleGenerator(f.config, {
    fetchImpl: async (_url, options) => {
      received = options.headers.authorization
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Fixture Chat Title' }],
          },
        ],
      })
    },
  })
  await assert.rejects(
    () =>
      generator.generate([{ role: 'user', content: 'test' }], {
        owner: 'missing-key',
      }),
    { status: 428 },
  )
  assert.equal(received, undefined)
  await f.providers.save('owner', 'owner-only-fixture-key')
  await generator.generate([{ role: 'user', content: 'test' }], {
    owner: 'owner',
  })
  assert.equal(received, 'Bearer owner-only-fixture-key')
})

test('event polling is cursor based, bounded, and enforces run ownership', async (t) => {
  const f = await fixture(t),
    other = await f.auth.createUser({ id: 'owner' }, { name: 'Other' })
  const run = f.events.create('owner', { projectId: 'fixture', kind: 'check' })
  for (let i = 0; i < 120; i++)
    f.events.event(run.id, 'message', { text: `part ${i}` })
  const url = `/api/runs/${run.id}/events?transport=poll&after=0`
  assert.equal((await f.request(url, other.token)).status, 404)
  const first = await (await f.request(url)).json()
  assert.equal(first.events.length, 100)
  const after = first.events.at(-1).seq
  const next = await (
    await f.request(`/api/runs/${run.id}/events?transport=poll&after=${after}`)
  ).json()
  assert(next.events.every((event) => event.seq > after))
  assert.equal(
    (await f.request(`/api/runs/${run.id}/events?transport=poll&after=-1`))
      .status,
    400,
  )
})
