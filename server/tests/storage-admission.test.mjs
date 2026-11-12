import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createStudio } from '../studio.mjs'
import { StorageCapacity } from '../storage-capacity.mjs'
import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-storage-api-'),
  )
  const state = {
    free: 1000,
    unavailable: false,
    hold: null,
    runCalls: 0,
    cleanupFailure: false,
    stopFailure: false,
  }
  const storage = new StorageCapacity({
    dataDir,
    minimumFreeBytes: 100,
    warningFreeBytes: 800,
    allocationBytes: 200,
    sample: async (directory) => {
      assert.equal(directory, await fs.realpath(dataDir))
      if (state.unavailable) throw new Error('Fixture filesystem unavailable')
      return { bavail: BigInt(state.free), bsize: 1n }
    },
  })
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args, options) {
      state.runCalls++
      if (state.cleanupFailure)
        throw Object.assign(
          new Error('Fixture worker cleanup failed. Retry Stop.'),
          { workerCleanup: true },
        )
      if (state.hold) await state.hold(options.signal)
      options.signal?.throwIfAborted()
      if (args[0] === 'lake' && args[1] === 'update')
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          JSON.stringify({ packages: [] }),
        )
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: 'No commit yet' }
      return { code: 0, stdout: 'Lean version 4.34.1\n', stderr: '' }
    },
    async stopProject() {
      if (state.stopFailure)
        throw Object.assign(new Error('Fixture worker cleanup still failed.'), {
          workerCleanup: true,
        })
    },
    async shutdown() {},
  }
  const studio = await createStudio({
    dataDir,
    storage,
    runtime,
    modelDiscoverer: fixtureModelDiscovery,
    config: {
      defaultModel: 'fixture',
      models: [{ id: 'fixture' }],
      provider: {},
      lemex: {},
      redact: String,
    },
    titleGenerator: async () => null,
  })
  t.after(async () => {
    state.hold = null
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: base,
    'Content-Type': 'application/json',
  }
  const request = (url, options) => fetch(base + url, { headers, ...options })
  const project = await studio.workspaces.create('owner', {
    name: 'Storage fixture',
    preset: 'lean',
    autoRepair: false,
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  assert.equal((await storage.status()).reservedBytes, 0)
  return { studio, storage, state, dataDir, project, base, request, token }
}

test('low disk refuses new allocation before mutations while existing saves, downloads and recovery remain available', async (t) => {
  const { studio, storage, state, project, request, dataDir } = await fixture(t)
  state.free = 250
  assert.equal((await request('/api/storage')).status, 200)
  assert.equal((await (await request('/api/storage')).json()).state, 'blocked')
  assert.equal((await request('/api/projects')).status, 200)
  const before = studio.workspaces.get(project.id, 'owner')
  const calls = state.runCalls
  for (const [url, body] of [
    ['/api/projects', { preset: 'lean', name: 'Must not be created' }],
    [`/api/projects/${project.id}/prepare`, {}],
  ]) {
    const refused = await request(url, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    assert.equal(refused.status, 503)
    assert.match((await refused.json()).error, /storage is running low/)
  }
  assert.deepEqual(studio.workspaces.get(project.id, 'owner'), before)
  assert.equal(state.runCalls, calls)
  assert.equal(studio.workspaces.list('owner').length, 1)
  assert.equal((await fs.readdir(path.join(dataDir, 'projects'))).length, 1)
  const snapshot = studio.workspaces.snapshot(
    project.id,
    'owner',
    'low-storage-run',
  )
  await assert.rejects(snapshot, { code: 'STORAGE_PRESSURE' })
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'candidates')), [])
  const source = await (
    await request(`/api/projects/${project.id}/file?path=Main.lean`)
  ).json()
  const saved = await request(
    `/api/projects/${project.id}/file?path=Main.lean`,
    {
      method: 'PUT',
      body: JSON.stringify({ content: '', expectedHash: source.hash }),
    },
  )
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).content, '')
  const exported = await request(`/api/projects/${project.id}/download`)
  assert.equal(exported.status, 200)
  assert.ok((await exported.arrayBuffer()).byteLength > 0)
  const recovery = await request(
    `/api/projects/${project.id}/file-recovery/retry`,
    { method: 'POST', body: '{}' },
  )
  assert.equal(recovery.status, 200)
  assert.equal((await storage.status()).reservedBytes, 0)
})

test('preparation holds one disk reservation until stopped work and cleanup settle', async (t) => {
  const { studio, storage, state, project, request } = await fixture(t)
  let started
  const entered = new Promise((resolve) => {
    started = resolve
  })
  state.hold = async (signal) => {
    started()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 10000)
      const cancelled = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      if (signal?.aborted) cancelled()
      else signal?.addEventListener('abort', cancelled, { once: true })
    })
  }
  const begun = await request(`/api/projects/${project.id}/prepare`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(begun.status, 200)
  await entered
  assert.equal((await storage.status()).reservedBytes, 200)
  state.free = 150
  assert.equal((await (await request('/api/storage')).json()).state, 'blocked')
  const stopped = await request(`/api/projects/${project.id}/prepare/stop`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(stopped.status, 200)
  assert.equal((await storage.status()).reservedBytes, 0)
  assert.equal(studio.workspaces.jobs.has(project.id), false)
  assert.match(
    studio.workspaces.get(project.id, 'owner').error,
    /setup stopped/,
  )
})

test('storage check failures preserve project state and newly added space admits retry without restart', async (t) => {
  const { studio, storage, state, project, request } = await fixture(t)
  const before = studio.workspaces.get(project.id, 'owner')
  state.unavailable = true
  const refused = await request(`/api/projects/${project.id}/prepare`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(refused.status, 503)
  assert.deepEqual(studio.workspaces.get(project.id, 'owner'), before)
  const status = await (await request('/api/storage')).json()
  assert.equal(status.state, 'unavailable')
  assert.equal(status.freeBytes, null)
  assert.doesNotMatch(JSON.stringify(status), /fixture|private|storage-api/)
  state.unavailable = false
  state.free = 2000
  const retry = await request(`/api/projects/${project.id}/prepare`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(retry.status, 200)
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  assert.equal((await storage.status({ refresh: true })).state, 'ready')
})

test('storage status is authenticated and bound to the browser account', async (t) => {
  const { base, request, token } = await fixture(t)
  assert.equal((await fetch(base + '/api/storage')).status, 401)
  const login = await request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal(
    (await fetch(base + '/api/storage', { headers: { Cookie: cookie } }))
      .status,
    428,
  )
  assert.equal(
    (
      await fetch(base + '/api/storage', {
        headers: { Cookie: cookie, 'X-Leanflow-User': 'different-account' },
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await fetch(base + '/api/storage', {
        headers: { Cookie: cookie, 'X-Leanflow-User': 'owner' },
      })
    ).status,
    200,
  )
  const session = await (await request('/api/session')).json()
  assert.equal(session.storage.state, 'ready')
  assert.equal(typeof session.storage.freeBytes, 'number')
  assert.equal(session.storage.message, null)
})

test('a failed private capture releases admission and removes only its incomplete copy', async (t) => {
  const { studio, storage, project, dataDir } = await fixture(t)
  const retained = path.join(dataDir, 'candidates/retained-history')
  await fs.mkdir(retained)
  await fs.writeFile(path.join(retained, 'keep.txt'), 'Retained user review')
  await fs.mkdir(
    path.join(project.root, ...Array.from({ length: 66 }, () => 'deep')),
    { recursive: true },
  )
  await assert.rejects(
    studio.workspaces.snapshot(project.id, 'owner', 'failed-capture'),
    { status: 413 },
  )
  assert.equal((await storage.status()).reservedBytes, 0)
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'candidates')), [
    'retained-history',
  ])
  assert.equal(
    await fs.readFile(path.join(retained, 'keep.txt'), 'utf8'),
    'Retained user review',
  )
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
})

test('failed setup cleanup retains storage until the matching project stop succeeds', async (t) => {
  const { studio, storage, state, project, request } = await fixture(t)
  state.cleanupFailure = true
  state.stopFailure = true
  const begun = await request(`/api/projects/${project.id}/prepare`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(begun.status, 200)
  await studio.workspaces.jobs.get(project.id)
  assert.equal(
    studio.workspaces.get(project.id, 'owner').setupCleanupFailed,
    true,
  )
  assert.equal((await storage.status()).reservedBytes, 200)
  const first = await request(`/api/projects/${project.id}/prepare/stop`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(first.status, 500)
  assert.equal((await storage.status()).reservedBytes, 200)
  state.cleanupFailure = false
  state.stopFailure = false
  const retried = await request(`/api/projects/${project.id}/prepare/stop`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(retried.status, 200)
  assert.equal((await storage.status()).reservedBytes, 0)
  assert.equal(
    studio.workspaces.get(project.id, 'owner').setupCleanupFailed,
    undefined,
  )
  const repeated = await request(`/api/projects/${project.id}/prepare/stop`, {
    method: 'POST',
    body: '{}',
  })
  assert.equal(repeated.status, 200)
  assert.equal((await storage.status()).reservedBytes, 0)
})
