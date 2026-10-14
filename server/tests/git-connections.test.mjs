import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { GitConnections } from '../git-connections.mjs'
import { validateRepository } from '../workspaces.mjs'

const fixtureToken = 'fixture-connection-secret!+/%@'
const publicHost = async () => [{ address: '140.82.112.3', family: 4 }]
const ownerFile = (store, owner = 'alice') =>
  path.join(
    store.dir,
    `${createHash('sha256').update(owner).digest('hex')}.json`,
  )

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-git-connections-'),
  )
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const settings = {
    dataDir,
    validateRepository,
    resolveHost: publicHost,
    ...options,
  }
  const store = new GitConnections(settings)
  await store.init()
  return { store, settings }
}

async function connect(store, owner = 'alice', overrides = {}) {
  return await store.connect(owner, {
    host: 'github.com',
    provider: 'github',
    token: fixtureToken,
    ...overrides,
  })
}

test('saved Git connections encrypt tokens at rest and disclose only owner metadata', async (t) => {
  const { store } = await fixture(t)
  assert.deepEqual(await store.get('alice'), {
    connections: [],
    identity: { name: '', email: '' },
  })
  const result = await connect(store)
  assert.equal(result.connections.length, 1)
  assert.deepEqual(Object.keys(result.connections[0]).sort(), [
    'host',
    'provider',
    'updatedAt',
    'username',
  ])
  assert.equal(result.connections[0].host, 'github.com')
  assert.equal(result.connections[0].username, 'x-access-token')
  assert(Number.isFinite(Date.parse(result.connections[0].updatedAt)))
  const files = await fs.readdir(store.dir)
  assert.equal(files.length, 2)
  for (const filename of files) {
    const content = await fs.readFile(path.join(store.dir, filename))
    for (const secret of [
      fixtureToken,
      encodeURI(fixtureToken),
      encodeURIComponent(fixtureToken),
      Buffer.from(fixtureToken).toString('base64'),
      Buffer.from('x-access-token:' + fixtureToken).toString('base64'),
    ])
      assert(!content.includes(Buffer.from(secret)))
    assert.equal(
      (await fs.stat(path.join(store.dir, filename))).mode & 0o777,
      0o600,
    )
  }
  assert.equal((await fs.stat(store.dir)).mode & 0o777, 0o700)
  assert.equal(
    (await fs.readFile(path.join(store.dir, 'encryption.key'))).length,
    32,
  )
  assert.deepEqual(await store.get('bob'), {
    connections: [],
    identity: { name: '', email: '' },
  })
  assert.equal(
    await store.credentials('bob', 'https://github.com/example/repo.git'),
    null,
  )
  assert.equal(
    await store.credentials('alice', 'https://gitlab.com/example/repo.git'),
    null,
  )
  assert.deepEqual(
    await store.credentials('alice', 'https://github.com/example/repo.git'),
    {
      token: fixtureToken,
      username: 'x-access-token',
    },
  )
  assert(!JSON.stringify(await store.get('alice')).includes(fixtureToken))
})

test('connection restart, token replacement and revocation preserve identity without sharing credentials', async (t) => {
  const { store, settings } = await fixture(t)
  await connect(store)
  await store.setIdentity('alice', {
    name: ' Alice Example ',
    email: ' alice@example.invalid ',
  })
  const restarted = new GitConnections(settings)
  await restarted.init()
  assert.equal(
    (await restarted.credentials('alice', 'https://github.com/org/repo.git'))
      .token,
    fixtureToken,
  )
  const borrowed = await restarted.credentials(
    'alice',
    'https://github.com/org/repo.git',
  )
  borrowed.token = 'changed-by-caller'
  assert.equal(
    (await restarted.credentials('alice', 'https://github.com/org/repo.git'))
      .token,
    fixtureToken,
  )
  await connect(restarted, 'alice', { token: 'fixture-replacement-token' })
  assert.equal(
    (await store.credentials('alice', 'https://github.com/org/repo.git')).token,
    'fixture-replacement-token',
  )
  assert.equal((await store.get('alice')).connections.length, 1)
  assert.deepEqual((await store.get('alice')).identity, {
    name: 'Alice Example',
    email: 'alice@example.invalid',
  })
  await store.disconnect('alice', 'https://GITHUB.com/')
  assert.equal(
    await restarted.credentials('alice', 'https://github.com/org/repo.git'),
    null,
  )
  assert.equal((await restarted.get('alice')).connections.length, 0)
  assert.equal((await restarted.get('alice')).identity.name, 'Alice Example')
})

test('GitLab and self-managed host connections use exact validated hosts and deployment usernames', async (t) => {
  const lookedUp = []
  const { store } = await fixture(t, {
    resolveHost: async (host) => {
      lookedUp.push(host)
      return await publicHost()
    },
  })
  await connect(store, 'alice', {
    host: ' https://GITLAB.com/ ',
    provider: 'gitlab',
  })
  assert.deepEqual(
    await store.credentials(
      'alice',
      'https://gitlab.com/group/subgroup/repo.git',
    ),
    {
      username: 'oauth2',
      token: fixtureToken,
    },
  )
  assert.equal(
    await store.credentials('alice', 'https://sub.gitlab.com/group/repo.git'),
    null,
  )
  await connect(store, 'alice', {
    host: 'git.example.invalid',
    provider: 'gitlab',
    username: 'gitlab+deploy-token-123',
  })
  assert.equal(
    (
      await store.credentials(
        'alice',
        'https://git.example.invalid/group/repo.git',
      )
    ).username,
    'gitlab+deploy-token-123',
  )
  assert(lookedUp.includes('gitlab.com'))
  assert(lookedUp.includes('git.example.invalid'))
})

test('missing matching connections need no DNS while matching tokens require current public DNS', async (t) => {
  const calls = []
  const { store } = await fixture(t, {
    resolveHost: async (host) => {
      calls.push(host)
      return await publicHost()
    },
  })
  assert.equal(
    await store.credentials('alice', 'https://github.com/org/repo.git'),
    null,
  )
  assert.deepEqual(calls, [])
  await connect(store)
  calls.length = 0
  assert.equal(
    await store.credentials('bob', 'https://github.com/org/repo.git'),
    null,
  )
  assert.equal(
    await store.credentials('alice', 'https://gitlab.com/org/repo.git'),
    null,
  )
  assert.deepEqual(calls, [])
  assert.equal(
    (await store.credentials('alice', 'https://github.com/org/repo.git')).token,
    fixtureToken,
  )
  assert.deepEqual(calls, ['github.com'])
})

test('Git connections reject unsafe hosts, malformed credentials and invalid authors without writing records', async (t) => {
  const { store } = await fixture(t)
  for (const host of [
    '',
    'http://github.com',
    'file:///github.com',
    'github.com/org/repo',
    'https://github.com/../',
    'https://github.com/%2e/',
    'github.com?query',
    'github.com#fragment',
    'user:secret@github.com',
    'github.com:8443',
    'github.com\\evil',
    'local host',
    'localhost',
    '127.0.0.1',
    '[::1]',
    'host.local',
  ])
    await assert.rejects(connect(store, 'alice', { host }), { status: 400 })
  for (const token of [
    '',
    'has space',
    'has\nnewline',
    null,
    1,
    'a'.repeat(16001),
  ])
    await assert.rejects(connect(store, 'alice', { token }), { status: 400 })
  for (const username of ['', 'name:password', 'a\nb', null, 'a'.repeat(201)])
    await assert.rejects(connect(store, 'alice', { username }), { status: 400 })
  for (const overrides of [
    { provider: 'unknown' },
    { provider: 'gitlab' },
    { host: 'gitlab.com', provider: 'github' },
  ])
    await assert.rejects(connect(store, 'alice', overrides), { status: 400 })
  for (const input of [
    undefined,
    {},
    { name: 'Alice', email: '' },
    { name: '', email: 'alice@example.invalid' },
    { name: 'Alice', email: 'bad' },
    { name: 'Alice\nOther', email: 'alice@example.invalid' },
    { name: 'Alice', email: 'alice@example.invalid>injected' },
  ])
    await assert.rejects(store.setIdentity('alice', input), { status: 400 })
  for (const owner of ['', null, '../bad\nowner', 'a'.repeat(201)])
    await assert.rejects(store.get(owner), { status: 401 })
  assert.deepEqual(await fs.readdir(store.dir), ['encryption.key'])
})

test('private and changed DNS answers prevent token lookup while revocation still works offline', async (t) => {
  let address = '140.82.112.3'
  const { store } = await fixture(t, { resolveHost: async () => [{ address }] })
  await connect(store)
  address = '127.0.0.1'
  await assert.rejects(
    store.credentials('alice', 'https://github.com/org/repo.git'),
    { status: 400 },
  )
  await assert.rejects(
    connect(store, 'alice', { token: 'fixture-new-token' }),
    { status: 400 },
  )
  for (const repository of [
    'file:///etc/passwd',
    'https://user:secret@github.com/org/repo',
    'https://github.com:8443/org/repo',
    'https://github.com/org/repo?token=value',
    'https://github.com/org/repo#fragment',
    'https://github.com/',
  ])
    await assert.rejects(store.credentials('alice', repository), {
      status: 400,
    })
  await store.disconnect('alice', 'github.com')
  assert.equal((await store.get('alice')).connections.length, 0)
})

test('account-bound authenticated ciphertext fails closed after tampering, owner swap or key replacement', async (t) => {
  const { store, settings } = await fixture(t)
  await connect(store)
  const original = await fs.readFile(ownerFile(store))
  await fs.writeFile(ownerFile(store, 'bob'), original, { mode: 0o600 })
  await assert.rejects(store.get('bob'), { status: 409 })
  for (const content of [
    '{broken',
    'null',
    '{}',
    JSON.stringify({ version: 10 }),
    JSON.stringify({ ...JSON.parse(original), tag: '0'.repeat(32) }),
    JSON.stringify({ ...JSON.parse(original), data: 'not base64!' }),
    JSON.stringify({ ...JSON.parse(original), data: '' }),
  ]) {
    await fs.writeFile(ownerFile(store), content, { mode: 0o600 })
    await assert.rejects(store.get('alice'), { status: 409 })
    await assert.rejects(
      store.credentials('alice', 'https://github.com/org/repo.git'),
      { status: 409 },
    )
  }
  await fs.writeFile(ownerFile(store), original, { mode: 0o600 })
  await fs.writeFile(path.join(store.dir, 'encryption.key'), randomBytes(32), {
    mode: 0o600,
  })
  await assert.rejects(store.get('alice'), { status: 409 })
  await fs.unlink(path.join(store.dir, 'encryption.key'))
  await assert.rejects(new GitConnections(settings).init(), { status: 409 })
  await assert.rejects(store.get('alice'), { status: 409 })
  assert(
    !(await fs.stat(path.join(store.dir, 'encryption.key')).catch(() => null)),
  )
})

test('connection storage rejects symlinks, hard links and readable key or owner files', async (t) => {
  const { store, settings } = await fixture(t)
  await connect(store)
  const record = ownerFile(store)
  const backup = path.join(settings.dataDir, 'record-backup')
  await fs.rename(record, backup)
  await fs.symlink(backup, record)
  await assert.rejects(store.get('alice'), { status: 409 })
  await assert.rejects(
    store.setIdentity('alice', {
      name: 'Alice',
      email: 'alice@example.invalid',
    }),
    { status: 409 },
  )
  await fs.unlink(record)
  await fs.link(backup, record)
  await assert.rejects(store.get('alice'), { status: 409 })
  await fs.unlink(record)
  await fs.rename(backup, record)
  await fs.chmod(record, 0o644)
  await assert.rejects(store.get('alice'), { status: 409 })
  await fs.chmod(record, 0o600)
  const keyFile = path.join(store.dir, 'encryption.key')
  await fs.chmod(keyFile, 0o644)
  await assert.rejects(new GitConnections(settings).init(), { status: 409 })
  await assert.rejects(
    store.credentials('alice', 'https://github.com/org/repo.git'),
    { status: 409 },
  )
  await fs.chmod(keyFile, 0o600)
  const keyBackup = path.join(settings.dataDir, 'key-backup')
  await fs.rename(keyFile, keyBackup)
  await fs.symlink(keyBackup, keyFile)
  await assert.rejects(new GitConnections(settings).init(), { status: 409 })
  await fs.unlink(keyFile)
  await fs.rename(keyBackup, keyFile)
  const directoryBackup = path.join(settings.dataDir, 'directory-backup')
  await fs.rename(store.dir, directoryBackup)
  await fs.symlink(directoryBackup, store.dir)
  await assert.rejects(new GitConnections(settings).init(), { status: 409 })
  await assert.rejects(store.get('alice'), { status: 409 })
})

test('concurrent connection and identity updates are atomic across service instances and bounded per account', async (t) => {
  const { store, settings } = await fixture(t)
  const second = new GitConnections(settings)
  await second.init()
  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) =>
      connect(index % 2 ? store : second, 'alice', {
        host: `git${index}.example.invalid`,
        provider: 'other',
        token: `fixture-token-${index}`,
      }),
    ),
    store.setIdentity('alice', {
      name: 'Alice',
      email: 'alice@example.invalid',
    }),
  ])
  const state = await second.get('alice')
  assert.equal(state.connections.length, 8)
  assert.equal(state.identity.name, 'Alice')
  await assert.rejects(connect(store, 'alice'), { status: 400 })
  await connect(store, 'alice', {
    host: 'git0.example.invalid',
    provider: 'other',
    token: 'fixture-rotated',
  })
  await Promise.all(
    state.connections.map(({ host }, index) =>
      (index % 2 ? store : second).disconnect('alice', host),
    ),
  )
  assert.deepEqual((await store.get('alice')).connections, [])
  assert.deepEqual(
    (await fs.readdir(store.dir)).filter((name) => name.endsWith('.tmp')),
    [],
  )
})
