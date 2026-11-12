import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'
import { Runtime } from '../runtime.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('Capture fixture did not reach its requested phase')
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-capture-cancel-'),
  )
  const bindings = new Map(),
    released = []
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args) {
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: 'No commit yet' }
      return { code: 0, stdout: '', stderr: '' }
    },
    async inheritDependencies(source, destination) {
      bindings.set(destination, source)
    },
    async clearInheritedDependencies(root, options) {
      assert.equal(options.force, true)
      released.push(root)
      bindings.delete(root)
    },
    home() {
      assert.fail('Cancelled capture must not prepare provider credentials')
    },
    spawn() {
      assert.fail('Cancelled capture must not launch a provider worker')
    },
  }
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  const project = await store.create('alice', {
    preset: 'lean',
    autoRepair: false,
  })
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return { dataDir, store, project, runtime, bindings, released }
}

function managerFixture(t, f) {
  const events = new EventStore(f.dataDir)
  const manager = new AgentManager({
    events,
    workspaces: f.store,
    runtime: f.runtime,
    settings: {},
    maxConcurrent: 1,
    config: {
      provider: { LEMEX_API_KEY: 'fixture-never-used' },
      models: [{ id: 'fixture-model' }],
      defaultModel: 'fixture-model',
      redact: String,
    },
  })
  t.after(async () => {
    await manager.shutdown()
    events.close()
  })
  return { manager, events }
}

const start = (manager, project) =>
  manager.start('alice', project.id, {
    mode: 'proofs',
    prompt: 'Fixture capture only',
    files: ['Main.lean'],
    liveEdits: false,
  })

test('optional snapshot revision does not queue behind an occupied editor worker', async (t) => {
  const f = await fixture(t)
  const scheduler = new Runtime({ dataDir: f.dataDir, maxConcurrent: 1 })
  scheduler.ready = true
  const editor = {
    workerSlots: 1,
    workspaceRoot: path.join(f.dataDir, 'editor'),
  }
  scheduler.children.add(editor)
  const run = f.runtime.run.bind(f.runtime)
  f.runtime.run = (root, args, options) =>
    args[0] === 'git' && args.includes('rev-parse')
      ? scheduler.run(root, args, options)
      : run(root, args, options)
  t.after(() => {
    for (const queued of scheduler.queue.splice(0))
      queued.reject(new Error('Fixture cleanup'))
    scheduler.children.delete(editor)
  })
  const snapshot = await f.store.snapshot(f.project.id, 'alice', 'busy-editor')
  assert.equal(scheduler.queue.length, 0)
  assert.equal(scheduler.children.has(editor), true)
  assert.equal(snapshot.sourceRevision, null)
  const source = await f.store.readFile(f.project.id, 'alice', 'Main.lean')
  assert.equal(
    snapshot.files.find((file) => file.path === 'Main.lean').hash,
    source.hash,
  )
  assert.equal(
    await fs.readFile(path.join(snapshot.root, 'Main.lean'), 'utf8'),
    source.content,
  )
})

test('Stop cancels a held agent capture and releases only its incomplete copy bindings', async (t) => {
  const f = await fixture(t)
  const retained = await f.store.snapshot(
    f.project.id,
    'alice',
    'retained-candidate',
  )
  const before = await fs.readFile(
    path.join(path.dirname(retained.root), 'manifest.json'),
    'utf8',
  )
  const entered = deferred(),
    release = deferred()
  t.after(() => release.resolve())
  const inherit = f.runtime.inheritDependencies.bind(f.runtime)
  f.runtime.inheritDependencies = async (source, destination) => {
    await inherit(source, destination)
    entered.resolve(destination)
    await release.promise
  }
  const { manager, events } = managerFixture(t, f)
  const job = await start(manager, f.project)
  const partialRoot = await entered.promise
  assert.equal(f.bindings.has(partialRoot), true)
  const stopping = manager.stop('alice', job.id)
  assert.equal(manager.active.get(job.id).controller.signal.aborted, true)
  release.resolve()
  const stopped = await stopping
  assert.equal(stopped.status, 'cancelled')
  assert.equal(manager.active.has(job.id), false)
  assert.equal(events.getMetadata(job.id).snapshot, undefined)
  await assert.rejects(fs.stat(path.dirname(partialRoot)), { code: 'ENOENT' })
  assert.equal(f.bindings.has(partialRoot), false)
  assert.equal(f.bindings.has(retained.root), true)
  assert.deepEqual(f.released, [partialRoot])
  assert.equal(
    await fs.readFile(
      path.join(path.dirname(retained.root), 'manifest.json'),
      'utf8',
    ),
    before,
  )
})

test('an aborted snapshot exits during source copying and removes its claimed incomplete directory', async (t) => {
  const f = await fixture(t)
  const original = await f.store.readFile(f.project.id, 'alice', 'Main.lean')
  await fs.mkdir(path.join(f.project.root, 'Many'))
  await Promise.all(
    Array.from({ length: 256 }, (_, index) =>
      fs.writeFile(
        path.join(f.project.root, 'Many', `${index}.lean`),
        'example : True := by trivial\n',
      ),
    ),
  )
  const controller = new AbortController()
  const root = path.join(f.store.snapshotsDir, 'copying-candidate', 'workspace')
  const copying = f.store.snapshot(f.project.id, 'alice', 'copying-candidate', {
    signal: controller.signal,
  })
  await until(async () =>
    (await fs.stat(root).catch(() => null))?.isDirectory(),
  )
  controller.abort(new Error('Cancelled source copy'))
  await assert.rejects(copying, /Cancelled source copy/)
  await assert.rejects(fs.stat(path.dirname(root)), { code: 'ENOENT' })
  assert.equal(f.bindings.has(root), false)
  assert.equal(
    (await f.store.readFile(f.project.id, 'alice', 'Main.lean')).content,
    original.content,
  )
})

test('an existing candidate and a pre-aborted capture are never cleaned as a new partial copy', async (t) => {
  const f = await fixture(t)
  const retained = await f.store.snapshot(
    f.project.id,
    'alice',
    'existing-candidate',
  )
  const original = await fs.readFile(
    path.join(path.dirname(retained.root), 'manifest.json'),
    'utf8',
  )
  await assert.rejects(
    f.store.snapshot(f.project.id, 'alice', 'existing-candidate'),
    { status: 409 },
  )
  const controller = new AbortController()
  controller.abort(new Error('Cancelled before capture'))
  await assert.rejects(
    f.store.snapshot(f.project.id, 'alice', 'never-claimed', {
      signal: controller.signal,
    }),
    /Cancelled before capture/,
  )
  await assert.rejects(
    fs.stat(path.join(f.store.snapshotsDir, 'never-claimed')),
    { code: 'ENOENT' },
  )
  assert.equal(
    await fs.readFile(
      path.join(path.dirname(retained.root), 'manifest.json'),
      'utf8',
    ),
    original,
  )
  assert.equal(f.bindings.has(retained.root), true)
  assert.deepEqual(f.released, [])
})

test('verification capture observes cancellation and preserves its original candidate', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.store.snapshot(
    f.project.id,
    'alice',
    'proof-candidate',
  )
  const controller = new AbortController()
  let partialRoot
  const inherit = f.runtime.inheritDependencies.bind(f.runtime)
  f.runtime.inheritDependencies = async (source, destination) => {
    await inherit(source, destination)
    partialRoot = destination
    controller.abort(new Error('Cancelled independent verification capture'))
  }
  await assert.rejects(
    f.store.verificationCopy(snapshot, [], { signal: controller.signal }),
    /Cancelled independent verification capture/,
  )
  assert.ok(partialRoot)
  await assert.rejects(fs.stat(path.dirname(partialRoot)), { code: 'ENOENT' })
  assert.equal(f.bindings.has(partialRoot), false)
  assert.equal(f.bindings.has(snapshot.root), true)
  assert.deepEqual(await f.store.changes(snapshot), [])
  assert.deepEqual(f.released, [partialRoot])
})

test('verification cleanup validates purpose and actor and refuses active or queued workers', async (t) => {
  const f = await fixture(t)
  const source = await f.store.snapshot(f.project.id, 'alice', 'cleanup-source')
  const verified = await f.store.verificationCopy(source, [])
  const manifestPath = path.join(path.dirname(verified.root), 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert.equal(manifest.purpose, 'verification')
  assert.equal(manifest.sourceRunId, source.runId)
  await assert.rejects(f.store.cleanupVerificationCopy(source), { status: 403 })
  await assert.rejects(
    f.store.cleanupVerificationCopy({ ...verified, actor: 'bob' }),
    { status: 403 },
  )
  await assert.rejects(
    f.store.cleanupVerificationCopy({
      ...verified,
      projectId: 'another-project',
    }),
    { status: 403 },
  )
  const worker = { workspaceRoot: verified.root }
  f.runtime.children = new Set([worker])
  await assert.rejects(f.store.cleanupVerificationCopy(verified), {
    status: 409,
  })
  assert.equal(f.bindings.has(verified.root), true)
  assert.deepEqual(f.released, [])
  f.runtime.children.clear()
  f.runtime.queue = [{ root: verified.root }]
  await assert.rejects(f.store.cleanupVerificationCopy(verified), {
    status: 409,
  })
  assert((await fs.stat(verified.root)).isDirectory())
  f.runtime.queue.length = 0
  await f.store.cleanupVerificationCopy(verified)
  await f.store.cleanupVerificationCopy(verified)
  await assert.rejects(fs.stat(path.dirname(verified.root)), { code: 'ENOENT' })
  assert.equal(f.bindings.has(verified.root), false)
  assert.equal(f.bindings.has(source.root), true)
  assert((await fs.stat(source.root)).isDirectory())
  assert.deepEqual(f.released, [verified.root])
})

test('verification cleanup removes its real runtime binding and home without touching the source cache or home', async (t) => {
  const f = await fixture(t)
  const source = await f.store.snapshot(
    f.project.id,
    'alice',
    'runtime-cleanup-source',
  )
  const verified = await f.store.verificationCopy(source, [])
  const runtime = new Runtime({ dataDir: f.dataDir })
  await fs.mkdir(runtime.runtimeDir, { recursive: true })
  await fs.mkdir(path.join(f.project.root, '.lake/packages/Fixture'), {
    recursive: true,
  })
  await runtime.inheritDependencies(f.project.root, source.root)
  await runtime.inheritDependencies(f.project.root, verified.root)
  const { createHash } = await import('node:crypto')
  const homeFor = (root) =>
    path.join(
      runtime.runtimeDir,
      'homes',
      createHash('sha256').update(root).digest('hex'),
    )
  for (const root of [source.root, verified.root]) {
    await fs.mkdir(homeFor(root), { recursive: true })
    await fs.writeFile(
      path.join(homeFor(root), 'fixture-marker'),
      'owned test home',
    )
  }
  f.runtime.releaseVerificationWorkspace = (root) =>
    runtime.releaseVerificationWorkspace(root)
  await f.store.cleanupVerificationCopy(verified)
  await assert.rejects(fs.stat(verified.root), { code: 'ENOENT' })
  await assert.rejects(fs.stat(homeFor(verified.root)), { code: 'ENOENT' })
  const registry = JSON.parse(
    await fs.readFile(
      path.join(runtime.runtimeDir, 'dependencies.json'),
      'utf8',
    ),
  )
  assert.equal(registry[verified.root], undefined)
  assert.equal(registry[source.root], f.project.root)
  assert.equal(
    await fs.readFile(
      path.join(homeFor(source.root), 'fixture-marker'),
      'utf8',
    ),
    'owned test home',
  )
  assert(
    (await fs.stat(path.join(f.project.root, '.lake/packages'))).isDirectory(),
  )
})

test('verification cleanup validates invalid retries before stopping workers and stops only its validated copy', async (t) => {
  const f = await fixture(t)
  const source = await f.store.snapshot(
    f.project.id,
    'alice',
    'cleanup-containment-source',
  )
  const verified = await f.store.verificationCopy(source, [])
  const unrelated = { workspaceRoot: f.project.root }
  const own = { workspaceRoot: verified.root }
  f.runtime.children = new Set([unrelated, own])
  const stopped = []
  f.runtime.stopProject = async (root) => {
    stopped.push(root)
    for (const worker of f.runtime.children)
      if (worker.workspaceRoot === root) f.runtime.children.delete(worker)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const invalid of [
      { ...verified, actor: 'bob' },
      { ...verified, projectId: 'another-project' },
      { ...verified, root: f.project.root },
      { ...verified, runId: source.runId, root: source.root },
    ])
      await assert.rejects(
        f.store.cleanupVerificationCopy(invalid, { stopWorkers: true }),
        { status: 403 },
      )
  }
  assert.deepEqual(stopped, [])
  assert.equal(f.runtime.children.has(unrelated), true)
  assert.equal(f.runtime.children.has(own), true)
  assert.equal(f.bindings.has(verified.root), true)
  await assert.rejects(f.store.cleanupVerificationCopy(verified), {
    status: 409,
  })
  assert.deepEqual(stopped, [])
  await f.store.cleanupVerificationCopy(verified, { stopWorkers: true })
  assert.deepEqual(stopped, [verified.root])
  assert.equal(f.runtime.children.has(unrelated), true)
  assert.equal(f.runtime.children.has(own), false)
  await assert.rejects(fs.stat(verified.root), { code: 'ENOENT' })
  assert((await fs.stat(source.root)).isDirectory())
  assert((await fs.stat(f.project.root)).isDirectory())
})
