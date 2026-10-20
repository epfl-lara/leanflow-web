import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createStudio } from '../studio.mjs'

const TOOLCHAIN = 'leanprover/lean4:v4.34.1'
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Fixture project activity did not reach the expected state.')
}

class FixtureRuntime {
  holds = []
  holdBuilds = false
  holdPreparation = false
  async init() {}
  info() {
    return { ready: true }
  }
  templates() {
    return [{ id: 'lean', toolchain: TOOLCHAIN, ready: true }]
  }
  templateRoot() {
    return null
  }
  async prepareToolchain() {}
  spawn() {
    throw new Error(
      'This fixture must not start an inference or editor worker.',
    )
  }
  async run(root, args, options = {}) {
    if (args[0] === 'git' && args.includes('init'))
      await fs.mkdir(path.join(root, '.git'), { recursive: true })
    if (args[0] === 'git' && args.includes('rev-parse'))
      return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'lake' && args[1] === 'update') {
      await fs.mkdir(path.join(root, '.lake'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[]}',
      )
    }
    if (
      (this.holdBuilds && args[0] === 'lake' && args[1] === 'build') ||
      (this.holdPreparation && options.signal)
    ) {
      const release = deferred(),
        aborted = deferred()
      const hold = { root, args, options, release, aborted }
      this.holds.push(hold)
      options.signal.addEventListener('abort', () => aborted.resolve(), {
        once: true,
      })
      await release.promise
      return {
        code: options.signal.aborted ? 130 : 0,
        cancelled: options.signal.aborted,
        stdout: '',
        stderr: '',
      }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  async stopProject() {
    await this.sweep?.promise
  }
  async shutdown() {
    for (const hold of this.holds) hold.release.resolve()
  }
}

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-trash-processes-'),
  )
  const runtime = new FixtureRuntime()
  const studio = await createStudio({
    modelDiscoverer: fixtureModelDiscovery,
    dataDir: directory,
    runtime,
    config: {
      defaultModel: 'fixture',
      models: [{ id: 'fixture' }],
      provider: { LEMEX_API_KEY: 'fixture-key-never-sent' },
      lemex: {},
      redact: String,
    },
    titleGenerator: async () => null,
  })
  await studio.providers.save('owner', 'fixture-key-never-sent')
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const hold of runtime.holds) hold.release.resolve()
    runtime.sweep?.resolve()
    await studio.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const project = await studio.workspaces.create('owner', {
    name: 'Hanging proofs',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  const token = (
    await fs.readFile(path.join(directory, 'auth', 'owner.token'), 'utf8')
  ).trim()
  const otherToken = 'another-fixture-owner'
  studio.auth.users.push({
    id: 'bob',
    name: 'Bob',
    tokenHash: createHash('sha256').update(otherToken).digest('hex'),
  })
  await fs.writeFile(
    path.join(directory, 'auth', 'users.json'),
    JSON.stringify(studio.auth.users),
  )
  const base = `http://127.0.0.1:${studio.server.address().port}`
  function request(endpoint, body = {}, access = token, method = 'POST') {
    return fetch(base + endpoint, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    })
  }
  return { ...studio, runtime, project, base, token, otherToken, request }
}

function rejectedEditor(base, projectId, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      base.replace('http:', 'ws:') + '/websocket/' + projectId,
      {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: 2000,
      },
    )
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode)
    })
    socket.once('open', () => {
      socket.close()
      reject(new Error('A stopping project accepted a new editor.'))
    })
    socket.on('error', (error) => {
      if (!/Unexpected server response/.test(error.message)) reject(error)
    })
  })
}

test('stop-and-trash cancels all checks together and blocks new work until real teardown finishes', async (t) => {
  const f = await fixture(t),
    endpoint = `/api/projects/${f.project.id}`
  f.runtime.holdBuilds = true
  const checks = []
  for (let i = 0; i < 2; i++) {
    const response = await f.request(endpoint + '/check', { path: 'Main.lean' })
    assert.equal(response.status, 202)
    checks.push(await response.json())
  }
  await waitFor(() => f.runtime.holds.length === 2)
  const recovered = await f.request(endpoint + '/checks', {}, f.token, 'GET')
  assert.equal(recovered.status, 200)
  const running = await recovered.json()
  assert.deepEqual(
    new Set(running.map((job) => job.id)),
    new Set(checks.map((job) => job.id)),
  )
  assert(running.every((job) => job.createdAt && job.status === 'running'))
  assert.equal(
    (await f.request(endpoint + '/checks', {}, f.otherToken, 'GET')).status,
    404,
  )
  assert.equal(
    (await f.request(endpoint + '/trash', { stopActive: 'yes' })).status,
    400,
  )
  assert.equal(
    (await f.request(endpoint + '/trash', { stopActive: true }, f.otherToken))
      .status,
    404,
  )
  assert(f.runtime.holds.every((hold) => !hold.options.signal.aborted))
  let archived = false
  const trash = f.request(endpoint + '/trash').then((response) => {
    archived = true
    return response
  })
  await Promise.all(f.runtime.holds.map((hold) => hold.aborted.promise))
  assert.equal(archived, false)
  assert.equal(f.workspaces.get(f.project.id, 'owner').archivedAt, undefined)
  for (const [suffix, body] of [
    ['/check', {}],
    ['/prepare', {}],
    ['/runs', { mode: 'proofs', prompt: 'Continue.' }],
  ])
    assert.equal((await f.request(endpoint + suffix, body)).status, 409)
  assert.equal(await rejectedEditor(f.base, f.project.id, f.token), 409)
  assert.equal(
    (await f.request(endpoint + '/git', {}, f.token, 'GET')).status,
    409,
  )
  f.runtime.sweep = deferred()
  for (const hold of f.runtime.holds) hold.release.resolve()
  await waitFor(() =>
    checks.every((job) => f.events.getMetadata(job.id).status === 'cancelled'),
  )
  assert.equal(archived, false)
  assert.equal((await f.request(endpoint + '/check')).status, 409)
  f.runtime.sweep.resolve()
  const response = await trash
  assert.equal(response.status, 200)
  assert.equal((await response.json()).kind, 'project')
  assert.throws(() => f.workspaces.get(f.project.id, 'owner'), { status: 404 })
  assert(f.runtime.holds.every((hold) => hold.options.signal.aborted))
})

test('stop-and-trash removes queued Lemex work beyond visible history and preserves other owners', async (t) => {
  const f = await fixture(t),
    endpoint = `/api/projects/${f.project.id}`
  f.agents.maxConcurrent = 0
  const response = await f.request(endpoint + '/runs', {
    mode: 'proofs',
    prompt: 'Fix Main.lean.',
    files: ['Main.lean'],
  })
  assert.equal(response.status, 202)
  const queued = await response.json()
  assert.equal(queued.status, 'queued')
  for (let i = 0; i < 105; i++) {
    const job = f.events.create('owner', {
      projectId: f.project.id,
      kind: 'agent',
    })
    f.events.updateMetadata(job.id, { status: 'completed' })
  }
  const other = f.events.create('bob', {
    projectId: f.project.id,
    kind: 'agent',
  })
  const trash = await f.request(endpoint + '/trash', { stopActive: true })
  assert.equal(trash.status, 200)
  assert.equal(f.events.getMetadata(queued.id, 'owner').status, 'cancelled')
  assert.equal(f.agents.queue.includes(queued.id), false)
  assert.equal(f.events.getMetadata(other.id, 'bob').status, 'queued')
})

test('stop-and-trash waits for cancelled preparation before moving the project', async (t) => {
  const f = await fixture(t),
    endpoint = `/api/projects/${f.project.id}`
  f.runtime.holdPreparation = true
  assert.equal((await f.request(endpoint + '/prepare')).status, 200)
  await waitFor(() => f.runtime.holds.length === 1)
  let archived = false
  const trash = f
    .request(endpoint + '/trash', { stopActive: true })
    .then((response) => {
      archived = true
      return response
    })
  await f.runtime.holds[0].aborted.promise
  assert.equal(archived, false)
  assert.equal(f.workspaces.jobs.has(f.project.id), true)
  assert.equal((await f.request(endpoint + '/prepare')).status, 409)
  f.runtime.holds[0].release.resolve()
  const response = await trash
  assert.equal(response.status, 200)
  const receipt = await response.json()
  assert.equal(f.workspaces.jobs.has(f.project.id), false)
  assert.equal(
    (await f.request(`/api/trash/${receipt.trashId}/restore`)).status,
    200,
  )
  assert.equal(f.workspaces.get(f.project.id, 'owner').status, 'error')
  assert.match(f.workspaces.get(f.project.id, 'owner').error, /setup stopped/)
})
