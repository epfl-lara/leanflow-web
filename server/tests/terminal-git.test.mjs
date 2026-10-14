import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createTerminalGitBroker,
  terminalGitEnvironment,
} from '../terminal-git.mjs'

async function fixture(t, owner = 'alice', { lookup } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-git-'))
  const home = path.join(directory, 'h'.repeat(100))
  await fs.mkdir(home)
  const calls = []
  const credentials = new Map([
    ['alice:github.com', { username: 'alice', token: 'fixture-alice-token' }],
    ['bob:github.com', { username: 'bob', token: 'fixture-bob-token' }],
    ['alice:gitlab.com', { username: 'oauth2', token: 'fixture-gitlab-token' }],
  ])
  const broker = await createTerminalGitBroker({
    home,
    owner,
    connections: {
      async credentials(user, value) {
        const host = new URL(value).hostname
        calls.push({ user, host, value })
        if (lookup) return await lookup(user, value)
        const found = credentials.get(`${user}:${host}`)
        return found ? { ...found } : null
      },
    },
  })
  const descriptor = await fs.open(home)
  const address = `/proc/self/fd/${descriptor.fd}/.git-credentials.sock`
  t.after(async () => {
    await broker.close()
    await descriptor.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const request = (value) =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(address)
      let output = ''
      socket.on('error', reject)
      socket.on('connect', () =>
        socket.write(
          typeof value === 'string' ? value : JSON.stringify(value) + '\n',
        ),
      )
      socket.on('data', (chunk) => (output += chunk))
      socket.on('end', () => resolve(output ? JSON.parse(output) : {}))
    })
  return { home, broker, credentials, calls, request, address }
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('Credential broker fixture did not settle')
}

test('terminal Git looks up each HTTPS host and honors changes without restarting the shell', async (t) => {
  const f = await fixture(t)
  assert(f.home.length > 108, 'Exercise the real Unix socket path limit')
  const github = {
    protocol: 'https',
    host: 'github.com',
    path: 'team/repo.git',
  }
  assert.deepEqual(await f.request(github), {
    username: 'alice',
    token: 'fixture-alice-token',
  })
  assert.deepEqual(
    await f.request({ ...github, host: 'gitlab.com', path: 'group/repo.git' }),
    { username: 'oauth2', token: 'fixture-gitlab-token' },
  )
  f.credentials.set('alice:github.com', {
    username: 'alice',
    token: 'fixture-replacement-token',
  })
  assert.equal((await f.request(github)).token, 'fixture-replacement-token')
  f.credentials.delete('alice:github.com')
  assert.deepEqual(await f.request(github), {})
  assert.deepEqual(await fs.readdir(f.home), ['.git-credentials.sock'])
})

test('terminal Git connections remain owner and host scoped', async (t) => {
  const alice = await fixture(t)
  const bob = await fixture(t, 'bob')
  const query = { protocol: 'https', host: 'github.com', path: 'team/repo.git' }
  assert.equal((await alice.request(query)).username, 'alice')
  assert.equal((await bob.request(query)).username, 'bob')
  assert.deepEqual(
    await alice.request({ ...query, host: 'github.com.evil.test' }),
    {},
  )
  assert.deepEqual(
    await alice.request({ ...query, host: 'gitlab.example.org' }),
    {},
  )
})

test('terminal Git rejects malformed credential requests before any lookup', async (t) => {
  const f = await fixture(t)
  for (const query of [
    null,
    [],
    { protocol: 'http', host: 'github.com' },
    { protocol: 'ssh', host: 'github.com' },
    { protocol: 'https', host: 'github.com:8443' },
    { protocol: 'https', host: 'github.com@evil.test' },
    { protocol: 'https', host: 'github.com/evil' },
    { protocol: 'https', host: 'github.com\npassword=fixture' },
    { protocol: 'https', host: 'github.com', path: 'repo?token=fixture' },
    { protocol: 'https', host: 'github.com', path: 'repo\npassword=fixture' },
    'invalid json\n',
  ])
    assert.deepEqual(await f.request(query), {})
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await f.request('x'.repeat(16 * 1024 + 1)), {})
  assert.equal(f.calls.length, 0)
})

test('terminal Git startup configuration contains a helper but no repository credentials', () => {
  const env = terminalGitEnvironment()
  assert.equal(env.GIT_CONFIG_COUNT, '5')
  assert.equal(env.GIT_CONFIG_VALUE_0, '')
  assert.match(env.GIT_CONFIG_VALUE_1, /AF_UNIX/)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert(!JSON.stringify(env).includes('fixture-alice-token'))
  assert(!Object.keys(env).some((key) => /TOKEN|PASSWORD/.test(key)))
})

test('a terminal Git broker refuses a replaced or symlinked home', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'terminal-git-link-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const real = path.join(directory, 'real')
  const link = path.join(directory, 'link')
  await fs.mkdir(real)
  await fs.symlink(real, link)
  await assert.rejects(
    createTerminalGitBroker({ home: link, owner: 'alice', connections: {} }),
  )
  assert.deepEqual(await fs.readdir(real), [])
})

test('terminal Git bounds pending lookups even after clients disconnect, and closes without waiting for them', async (t) => {
  const pending = []
  const returned = []
  const f = await fixture(t, 'alice', {
    lookup: () => {
      if (pending.length >= 16)
        return { username: 'alice', token: 'fixture-available-token' }
      return new Promise((resolve) => pending.push(resolve))
    },
  })
  const query = { protocol: 'https', host: 'github.com', path: 'team/repo.git' }
  const clients = Array.from({ length: 16 }, () => {
    const socket = net.createConnection(f.address)
    socket.on('error', () => {})
    socket.on('connect', () => socket.write(JSON.stringify(query) + '\n'))
    return socket
  })
  t.after(() => {
    for (const socket of clients) socket.destroy()
    for (const resolve of pending) resolve(null)
  })
  await until(() => f.calls.length === 16)
  await Promise.all(
    clients.map(
      (socket) =>
        new Promise((resolve) => {
          socket.once('close', resolve)
          socket.destroy()
        }),
    ),
  )
  assert.deepEqual(await f.request(query), {})
  assert.equal(
    f.calls.length,
    16,
    'Disconnected requests retain their lookup slots',
  )
  const released = { username: 'alice', token: 'fixture-released-token' }
  returned.push(released)
  pending[0](released)
  await until(() => released.token === '')
  assert.equal((await f.request(query)).token, 'fixture-available-token')
  assert.equal(f.calls.length, 17)
  let closed = false
  await f.broker.close().then(() => {
    closed = true
  })
  assert.equal(
    closed,
    true,
    'Closing does not await unresolved credential lookups',
  )
  for (const resolve of pending.slice(1)) {
    const credentials = { username: 'alice', token: 'fixture-late-token' }
    returned.push(credentials)
    resolve(credentials)
  }
  await until(() => returned.every((credentials) => credentials.token === ''))
})

test('a terminal Git listener error closes its sockets and fails closed', async (t) => {
  const createServer = net.createServer
  let server
  t.mock.method(net, 'createServer', (...args) => {
    server = createServer(...args)
    return server
  })
  const f = await fixture(t)
  server.emit('error', new Error('Fixture listener failure'))
  await until(() => !server.listening)
  await assert.rejects(
    f.request({ protocol: 'https', host: 'github.com', path: 'repo.git' }),
  )
  assert.equal(f.calls.length, 0)
  await f.broker.close()
})
