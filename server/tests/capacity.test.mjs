import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import WebSocket from 'ws'
import { loadCapacity } from '../capacity.mjs'
import { createStudio } from '../studio.mjs'

test('invalid capacity settings fail before startup rather than disabling admission limits', () => {
  for (const name of [
    'STUDIO_MAX_WORKERS',
    'STUDIO_MAX_WORKER_QUEUE',
    'STUDIO_MAX_EDITORS',
    'STUDIO_MAX_EDITORS_PER_PROJECT',
    'STUDIO_MAX_AGENTS',
    'STUDIO_MAX_AGENT_QUEUE',
    'STUDIO_MAX_SEARCHES',
    'STUDIO_MAX_SOURCE_REQUESTS',
    'STUDIO_MAX_SOURCE_REQUESTS_PER_USER',
    'STUDIO_MAX_SMALL_SOURCE_REQUESTS',
    'STUDIO_MAX_SMALL_SOURCE_REQUESTS_PER_USER',
  ]) {
    for (const value of ['0', '-1', 'NaN', 'Infinity', '1.5'])
      assert.throws(() => loadCapacity({ [name]: value }), new RegExp(name))
  }
  assert.throws(
    () => loadCapacity({ STUDIO_WORKER_MEMORY: '0g' }),
    /STUDIO_WORKER_MEMORY/,
  )
  assert.throws(
    () => loadCapacity({ STUDIO_WORKER_CPUS: '-2' }),
    /STUDIO_WORKER_CPUS/,
  )
  assert.equal(loadCapacity({ STUDIO_WORKER_CPUS: '1.5' }).workerCpus, 1.5)
  assert.equal(
    loadCapacity({ STUDIO_WORKER_MEMORY: '8192m' }).workerMemory,
    '8192m',
  )
})

async function fixture(t, extraCapacity = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-capacity-'))
  const children = new Set()
  const capacity = loadCapacity({
    STUDIO_MAX_WORKERS: '12',
    STUDIO_MAX_EDITORS: '6',
    STUDIO_MAX_AGENTS: '3',
    STUDIO_MAX_AGENT_QUEUE: '2',
    STUDIO_MAX_SOURCE_REQUESTS_PER_USER: '2',
    ...extraCapacity,
  })
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [],
    spawn(_root, args) {
      assert.deepEqual(
        args,
        ['lake', 'serve', '--'],
        'No inference workers in this fixture',
      )
      const child = new EventEmitter()
      for (const name of ['stdin', 'stdout', 'stderr'])
        child[name] = new PassThrough()
      child.kill = () => {
        if (!children.delete(child)) return
        queueMicrotask(() => child.emit('close', 0))
      }
      children.add(child)
      return child
    },
    async shutdown() {
      for (const child of children) child.kill()
    },
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    capacity,
    config: {
      defaultModel: 'test',
      models: [{ id: 'test' }],
      provider: { LEMEX_API_KEY: 'fixture-not-a-provider-key' },
      lemex: {},
      redact: String,
    },
    titleGenerator: async () => null,
  })
  const sockets = []
  t.after(async () => {
    for (const socket of sockets) socket.terminate()
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const headers = { Authorization: `Bearer ${token}`, Origin: base }
  const projects = []
  for (let i = 0; i < 7; i++) {
    const id = randomUUID(),
      root = path.join(dataDir, 'projects', id)
    await fs.mkdir(root)
    const project = {
      id,
      root,
      owner: 'owner',
      name: `Fixture ${i}`,
      status: 'ready',
    }
    studio.workspaces.db
      .prepare('INSERT INTO projects VALUES(?,?,?)')
      .run(id, 'owner', JSON.stringify(project))
    projects.push(project)
  }
  function connect(project) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        base.replace('http:', 'ws:') + '/websocket/' + project.id,
        { headers },
      )
      sockets.push(ws)
      ws.once('error', reject)
      ws.once('open', () => resolve(ws))
      ws.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode)
      })
    })
  }
  return { studio, capacity, children, projects, headers, base, connect }
}

test('six editors can connect, project and global limits reject overflow and recover on disconnect', async (t) => {
  const f = await fixture(t)
  const first = await f.connect(f.projects[0])
  const second = await f.connect(f.projects[0])
  assert(first instanceof WebSocket)
  assert(second instanceof WebSocket)
  assert.equal(await f.connect(f.projects[0]), 429)
  for (let i = 1; i < 5; i++)
    assert((await f.connect(f.projects[i])) instanceof WebSocket)
  assert.equal(f.children.size, 6)
  assert.equal(await f.connect(f.projects[5]), 429)
  await new Promise((resolve) => {
    first.once('close', resolve)
    first.close()
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert((await f.connect(f.projects[5])) instanceof WebSocket)
  const response = await fetch(f.base + '/api/session', { headers: f.headers })
  assert.deepEqual((await response.json()).capacity, f.capacity)
})

test('configured assistant queue rejects overflow and releases a place when a queued task is cancelled', async (t) => {
  const f = await fixture(t),
    manager = f.studio.agents
  assert.equal(manager.maxConcurrent, 3)
  manager.maxConcurrent = 0
  const input = { mode: 'prove', prompt: 'Complete the proof.', model: 'test' }
  const first = await manager.start('owner', f.projects[0].id, input)
  await manager.start('owner', f.projects[1].id, input)
  await assert.rejects(manager.start('owner', f.projects[2].id, input), {
    status: 429,
  })
  await manager.stop('owner', first.id)
  const next = await manager.start('owner', f.projects[2].id, input)
  assert.equal(next.status, 'queued')
})

test('three assistant tasks execute concurrently while a fourth waits for capacity', async (t) => {
  const f = await fixture(t),
    manager = f.studio.agents,
    pending = []
  f.studio.workspaces.snapshot = () =>
    new Promise((_resolve, reject) => pending.push(reject))
  try {
    const input = {
      mode: 'prove',
      prompt: 'Complete the proof.',
      model: 'test',
    }
    for (let i = 0; i < 4; i++)
      await manager.start('owner', f.projects[i].id, input)
    const deadline = Date.now() + 2000
    while (pending.length < 3 && Date.now() < deadline)
      await new Promise((resolve) => setImmediate(resolve))
    assert.equal(pending.length, 3)
    assert.equal(manager.running, 3)
    assert.equal(manager.queue.length, 1)
  } finally {
    manager.stopping = true
    for (const reject of pending) reject(new Error('End of capacity fixture'))
    await manager.shutdown()
  }
})

test('setup repairs share assistant capacity and queue admission, and queued cancellation releases its slot', async (t) => {
  const f = await fixture(t),
    manager = f.studio.agents
  manager.maxConcurrent = 1
  let finish
  const first = manager.runSetupRepair(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.running, 1)
  const controller = new AbortController()
  const cancelled = manager.runSetupRepair(
    () => assert.fail('Cancelled repair executed'),
    { signal: controller.signal },
  )
  cancelled.catch(() => {})
  const ordinary = await manager.start('owner', f.projects[0].id, {
    mode: 'prove',
    prompt: 'Complete the proof.',
    model: 'test',
  })
  assert.equal(ordinary.status, 'queued')
  await assert.rejects(
    manager.runSetupRepair(() => {}),
    { status: 429 },
  )
  controller.abort(new Error('Cancelled queued setup'))
  await assert.rejects(cancelled, /Cancelled queued setup/)
  assert.equal(manager.queue.length, 1)
  await manager.stop('owner', ordinary.id)
  finish()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(manager.running, 0)
})

test('shutdown cancels both queued and active setup repairs without provider calls', async (t) => {
  const f = await fixture(t),
    manager = f.studio.agents
  manager.maxConcurrent = 1
  const first = manager.runSetupRepair(
    (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  )
  first.catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  const queued = manager.runSetupRepair(() =>
    assert.fail('Queued setup executed during shutdown'),
  )
  queued.catch(() => {})
  await manager.shutdown()
  await assert.rejects(first, /shutting down/)
  await assert.rejects(queued, /shutting down/)
  assert.equal(manager.running, 0)
})

test('source body capacity fails fast, leaves ordinary APIs responsive and releases aborted requests', async (t) => {
  const f = await fixture(t)
  assert.equal(f.capacity.sourceRequests, 2)
  const held = []
  t.after(() => held.forEach((request) => request.destroy()))
  const hold = (endpoint) =>
    new Promise((resolve, reject) => {
      const request = http.request(f.base + endpoint, {
        method: 'POST',
        headers: {
          ...f.headers,
          'Content-Type': 'application/json',
          'Content-Length': 10 * 1024 * 1024,
          Expect: '100-continue',
        },
      })
      request.on('error', () => {})
      request.once('response', (response) => {
        response.resume()
        reject(
          new Error(
            `Held body unexpectedly completed with ${response.statusCode}`,
          ),
        )
      })
      request.once('continue', () => {
        held.push(request)
        resolve(request)
      })
      request.flushHeaders()
    })
  const first = await hold('/api/projects')
  await hold(`/api/projects/${f.projects[0].id}/upload`)
  const overflow = (
    endpoint = `/api/projects/${f.projects[0].id}/file?path=Main.lean`,
  ) =>
    fetch(f.base + endpoint, {
      method: 'PUT',
      headers: { ...f.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'a'.repeat(3_200_000),
        expectedHash: null,
      }),
    })
  const denied = await overflow()
  assert.equal(denied.status, 429)
  assert.equal(denied.headers.get('Retry-After'), '1')
  assert.match((await denied.json()).error, /unsaved edits are preserved/)
  const creationDenied = await fetch(f.base + '/api/projects', {
    method: 'POST',
    headers: { ...f.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ path: 'Large.lean', content: 'a'.repeat(3_200_000) }],
    }),
  })
  assert.equal(creationDenied.status, 429)
  assert.match(
    (await creationDenied.json()).error,
    /Project creation and uploads are busy/,
  )
  assert.equal(
    (await overflow(`/API/PROJECTS/${f.projects[0].id}/FILE/?path=Main.lean`))
      .status,
    429,
    'Alternate accepted route spelling cannot bypass admission',
  )
  assert.equal(
    (await fetch(f.base + '/api/session', { headers: f.headers })).status,
    200,
  )
  const ordinary = await fetch(f.base + '/api/settings', {
    method: 'PUT',
    headers: { ...f.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      extraInstructions: 'Ordinary requests remain responsive.',
      tools: { lean: true, lean_explore: true, exa: false },
    }),
  })
  assert.equal(ordinary.status, 200)
  const smallSave = await fetch(
    f.base + `/api/projects/${f.projects[0].id}/file?path=Small.lean`,
    {
      method: 'PUT',
      headers: { ...f.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '-- ordinary save', expectedHash: null }),
    },
  )
  assert.equal(smallSave.status, 200)
  const compressed = await fetch(
    f.base + `/api/projects/${f.projects[0].id}/file?path=Compressed.lean`,
    {
      method: 'PUT',
      headers: {
        ...f.headers,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: gzipSync(
        Buffer.from(
          JSON.stringify({ content: '-- compressed', expectedHash: null }),
        ),
      ),
    },
  )
  assert.equal(
    compressed.status,
    429,
    'Compressed input cannot claim small-body admission',
  )
  first.destroy()
  const deadline = Date.now() + 2000
  let recovered
  do {
    recovered = await fetch(
      f.base + `/api/projects/${f.projects[0].id}/upload`,
      {
        method: 'POST',
        headers: { ...f.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [{ path: 'Recovered.lean', content: 'a'.repeat(3_200_000) }],
        }),
      },
    )
    if (recovered.status !== 429) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  assert.equal(recovered.status, 200, await recovered.text())
  assert.equal(
    (
      await f.studio.workspaces.readFile(
        f.projects[0].id,
        'owner',
        'Recovered.lean',
      )
    ).content,
    'a'.repeat(3_200_000),
  )
})

test('setup build timeouts retain the 30 minute default and validate bounded overrides', () => {
  assert.equal(loadCapacity({}).setupBuildTimeoutMs, 1800000)
  assert.equal(
    loadCapacity({ STUDIO_SETUP_BUILD_TIMEOUT_MS: '5400000' })
      .setupBuildTimeoutMs,
    5400000,
  )
  assert.equal(
    loadCapacity({ STUDIO_SETUP_BUILD_TIMEOUT_MS: '21600000' })
      .setupBuildTimeoutMs,
    21600000,
  )
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1.5', '21600001'])
    assert.throws(
      () => loadCapacity({ STUDIO_SETUP_BUILD_TIMEOUT_MS: value }),
      /STUDIO_SETUP_BUILD_TIMEOUT_MS/,
    )
})

test('one account cannot occupy all source lanes and block another account saves', async (t) => {
  const f = await fixture(t, { STUDIO_MAX_SOURCE_REQUESTS_PER_USER: '1' })
  assert.equal(f.capacity.sourceRequestsPerUser, 1)
  assert.equal(f.capacity.smallSourceRequests, 8)
  assert.equal(f.capacity.smallSourceRequestsPerUser, 2)
  const otherToken = 'source-capacity-collaborator'
  f.studio.auth.users.push({
    id: 'bob',
    name: 'Bob',
    tokenHash: createHash('sha256').update(otherToken).digest('hex'),
  })
  await fs.writeFile(
    path.join(f.studio.auth.dir, 'users.json'),
    JSON.stringify(f.studio.auth.users),
  )
  const otherHeaders = {
    Authorization: `Bearer ${otherToken}`,
    Origin: f.base,
  }
  const project = {
    ...f.projects[0],
    id: randomUUID(),
    owner: 'bob',
    root: path.join(path.dirname(f.projects[0].root), randomUUID()),
  }
  await fs.mkdir(project.root)
  f.studio.workspaces.db
    .prepare('INSERT INTO projects VALUES(?,?,?)')
    .run(project.id, project.owner, JSON.stringify(project))
  const held = []
  const pending = []
  const saves = []
  t.after(async () => {
    held.forEach((request) => request.destroy())
    await Promise.all(pending.splice(0).map((release) => release()))
    await Promise.allSettled(saves)
  })
  const hold = (headers) =>
    new Promise((resolve, reject) => {
      const request = http.request(f.base + '/api/projects', {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': 10 * 1024 * 1024,
          Expect: '100-continue',
        },
      })
      request.on('error', () => {})
      request.once('response', (response) => {
        response.resume()
        reject(new Error(`Held body returned ${response.statusCode}`))
      })
      request.once('continue', () => {
        held.push(request)
        resolve(request)
      })
      request.flushHeaders()
    })
  await hold(f.headers)
  const save = (ownerProject, headers, filename, content = '-- small save') =>
    fetch(f.base + `/api/projects/${ownerProject.id}/file?path=${filename}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, expectedHash: null }),
      signal: AbortSignal.timeout(5000),
    })
  assert.equal(
    (await save(f.projects[0], f.headers, 'Large.lean', 'a'.repeat(3_200_000)))
      .status,
    429,
    'The account cannot use the remaining global bulk place',
  )
  await hold(otherHeaders)
  const writeFile = f.studio.workspaces.writeFile.bind(f.studio.workspaces)
  f.studio.workspaces.writeFile = (...args) =>
    args[1] === 'owner'
      ? new Promise((resolve, reject) => {
          pending.push(() => writeFile(...args).then(resolve, reject))
        })
      : writeFile(...args)
  saves.push(
    save(f.projects[0], f.headers, 'First.lean'),
    save(f.projects[0], f.headers, 'Second.lean'),
  )
  const deadline = Date.now() + 2000
  while (pending.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pending.length, 2)
  assert.equal((await save(f.projects[0], f.headers, 'Third.lean')).status, 429)
  assert.equal(
    (await save(project, otherHeaders, 'Other.lean')).status,
    200,
    'Another account can save while both bulk places and the first account small places are held',
  )
  assert.equal(
    (await fetch(f.base + '/api/session', { headers: otherHeaders })).status,
    200,
  )
  f.studio.workspaces.writeFile = writeFile
  await Promise.all(pending.splice(0).map((release) => release()))
  assert.deepEqual(
    (await Promise.all(saves)).map((response) => response.status),
    [200, 200],
  )
})
