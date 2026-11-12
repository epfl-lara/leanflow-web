import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'
import { loadCapacity } from '../capacity.mjs'

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert(
      Date.now() < deadline,
      'Worker fixture did not reach its expected state.',
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-worker-lanes-'),
  )
  const root = path.join(dataDir, 'project')
  const docker = path.join(dataDir, 'docker-fixture')
  await fs.mkdir(root)
  await fs.writeFile(
    docker,
    `#!${process.execPath}
import fs from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === 'rm' && fs.existsSync(${JSON.stringify(path.join(dataDir, 'fail-cleanup'))})) { console.error('fixture cleanup failed'); process.exit(1) }
if (args[0] === 'run') {
  console.log(JSON.stringify(args))
  if (!args.includes('quick')) setInterval(() => {}, 1000)
}
`,
    { mode: 0o700 },
  )
  const runtime = new Runtime({
    dataDir,
    docker,
    maxConcurrent: 7,
    maxQueue: 128,
    interactiveReserved: 1,
    batchReserved: 3,
    memory: '6g',
    cpus: 2,
    kernelExportMaxBytes: 1024,
    ...options,
  })
  await fs.mkdir(runtime.runtimeDir, { recursive: true })
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  t.after(async () => {
    await runtime.shutdown()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return { runtime, root, dataDir }
}

async function stop(child) {
  child.kill()
  await child.workerStopped
}

const kernelOptions = {
  kernelCheck: true,
  readOnlyWorkspace: true,
  writeLakeCache: true,
  freshHome: true,
}

test('worker reservation settings validate nonnegative integers and keep bounded defaults', () => {
  assert.equal(loadCapacity({}).interactiveWorkers, 1)
  assert.equal(loadCapacity({}).batchWorkers, 3)
  for (const name of [
    'STUDIO_RESERVED_INTERACTIVE_WORKERS',
    'STUDIO_RESERVED_BATCH_WORKERS',
  ]) {
    assert.equal(
      loadCapacity({ [name]: '0' })[
        name.includes('INTERACTIVE') ? 'interactiveWorkers' : 'batchWorkers'
      ],
      0,
    )
    for (const value of ['-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])
      assert.throws(() => loadCapacity({ [name]: value }), new RegExp(name))
  }
  for (const name of ['interactiveReserved', 'batchReserved'])
    for (const value of [-1, 1.5, NaN, Infinity])
      assert.throws(
        () =>
          new Runtime({
            dataDir: '/tmp/unused-capacity-validation',
            [name]: value,
          }),
        new RegExp(name),
      )
})

test('batch saturation leaves a worker available for an editor within the same total memory budget', async (t) => {
  const { runtime, root } = await fixture(t)
  const batch = Array.from({ length: 6 }, (_, index) =>
    runtime.spawn(root, ['hold', String(index)]),
  )
  assert.throws(() => runtime.spawn(root, ['hold-overflow']), { status: 503 })
  const editor = runtime.spawn(root, ['hold-editor'], {
    workload: 'interactive',
  })
  assert.equal(runtime.info().usedSlots, 7)
  assert.deepEqual(runtime.info().workloads, {
    interactiveReserved: 1,
    batchReserved: 3,
    interactiveLimit: 4,
    batchLimit: 6,
    active: { interactive: 1, batch: 6 },
    queued: { interactive: 0, batch: 0 },
  })
  assert.throws(
    () =>
      runtime.spawn(root, ['hold-editor-overflow'], {
        workload: 'interactive',
      }),
    { status: 503 },
  )
  await Promise.all([...batch, editor].map(stop))
  assert.equal(runtime.info().usedSlots, 0)
})

test('four persistent interactive sessions leave enough capacity for a full weighted check', async (t) => {
  const { runtime, root } = await fixture(t)
  const editors = Array.from({ length: 4 }, () =>
    runtime.spawn(root, ['hold-editor'], { workload: 'interactive' }),
  )
  assert.throws(
    () => runtime.spawn(root, ['extra-terminal'], { workload: 'interactive' }),
    /Close an unused editor or terminal/,
  )
  let output = ''
  const kernel = runtime.spawn(root, ['lake', 'check'], {
    ...kernelOptions,
    onOutput: (text) => {
      output += text
    },
  })
  await until(() => output.length > 0)
  const args = JSON.parse(output.trim())
  assert.equal(kernel.workerSlots, 3)
  assert.equal(args[args.indexOf('--memory') + 1], '18g')
  assert.equal(args[args.indexOf('--memory-swap') + 1], '18g')
  assert.equal(args[args.indexOf('--cpus') + 1], '6')
  assert.equal(runtime.info().usedSlots, 7)
  assert.equal(runtime.info().workloads.active.batch, 3)
  await Promise.all([...editors, kernel].map(stop))
})

test('memory-reduced and single-slot hosts cannot strand weighted checks behind impossible reservations', async (t) => {
  for (const slots of [1, 2, 3, 4]) {
    await t.test(String(slots), async (t) => {
      const { runtime, root } = await fixture(t)
      runtime.memoryCapacity = {
        slots,
        memoryBudgetBytes: slots * 6 * 1024 ** 3,
      }
      const limits = runtime.info().workloads
      assert(limits.interactiveLimit >= 1)
      assert(limits.batchLimit >= 1)
      assert(limits.interactiveReserved + limits.batchReserved <= slots)
      const kernel = await runtime.spawnWhenAvailable(
        root,
        ['lake', 'check'],
        kernelOptions,
      )
      assert.equal(kernel.workerSlots, Math.min(3, limits.batchLimit))
      assert(runtime.info().usedSlots <= slots)
      await stop(kernel)
      const editor = runtime.spawn(root, ['hold-editor'], {
        workload: 'interactive',
      })
      await stop(editor)
    })
  }
})

test('a weighted check cannot be overtaken by newer small batch jobs or direct spawns', async (t) => {
  const { runtime, root } = await fixture(t, { maxConcurrent: 3 })
  const editor = runtime.spawn(root, ['hold-editor'], {
    workload: 'interactive',
  })
  const first = runtime.spawn(root, ['hold-first'])
  const pending = runtime.spawnWhenAvailable(
    root,
    ['lake', 'check'],
    kernelOptions,
  )
  let smallStarted = false
  const small = runtime.run(root, ['quick'], {
    onSpawn: () => {
      smallStarted = true
    },
  })
  assert.equal(runtime.info().queued, 2)
  assert.throws(() => runtime.spawn(root, ['quick']), { status: 503 })
  assert.equal(runtime.info().usedSlots, 2)
  await stop(first)
  const kernel = await pending
  assert.equal(kernel.workerSlots, 2)
  assert.equal(smallStarted, false)
  assert.equal(runtime.info().usedSlots, 3)
  await stop(kernel)
  assert.equal((await small).code, 0)
  assert.equal(smallStarted, true)
  await stop(editor)
})

test('cancelling a queued weighted head immediately admits a smaller waiting job without stopping live workers', async (t) => {
  const { runtime, root } = await fixture(t, { maxConcurrent: 3 })
  const first = runtime.spawn(root, ['hold-first'])
  const controller = new AbortController()
  const pending = runtime.spawnWhenAvailable(root, ['lake', 'check'], {
    ...kernelOptions,
    signal: controller.signal,
  })
  const rejected = assert.rejects(pending, /Cancel waiting check/)
  let smallStarted = false
  const small = runtime.run(root, ['quick'], {
    onSpawn: () => {
      smallStarted = true
    },
  })
  assert.equal(smallStarted, false)
  controller.abort(new Error('Cancel waiting check'))
  await rejected
  assert.equal((await small).code, 0)
  assert.equal(first.cancelled, undefined)
  assert.equal(runtime.info().queued, 0)
  await stop(first)
})

test('one work class cannot fill every queue place and queued revocation is checked before any process starts', async (t) => {
  const { runtime, root } = await fixture(t, { maxConcurrent: 3, maxQueue: 4 })
  const live = [
    runtime.spawn(root, ['hold-a']),
    runtime.spawn(root, ['hold-b']),
    runtime.spawn(root, ['hold-editor'], { workload: 'interactive' }),
  ]
  const controllers = Array.from({ length: 3 }, () => new AbortController())
  const batch = controllers.map((controller) =>
    runtime.run(root, ['quick'], { signal: controller.signal }),
  )
  const cancelled = batch.map((promise) =>
    assert.rejects(promise, /Cancel queued batch/),
  )
  await assert.rejects(runtime.run(root, ['quick-overflow']), { status: 503 })
  let authorized = true
  let started = false
  const interactive = runtime.run(root, ['quick'], {
    workload: 'interactive',
    beforeSpawn() {
      if (!authorized)
        throw Object.assign(new Error('Access revoked.'), { status: 403 })
    },
    onSpawn() {
      started = true
    },
  })
  const forbidden = assert.rejects(interactive, { status: 403 })
  assert.equal(runtime.info().queued, 4)
  authorized = false
  await stop(live[2])
  await forbidden
  assert.equal(started, false)
  assert.equal(runtime.children.size, 2)
  controllers.forEach((controller) =>
    controller.abort(new Error('Cancel queued batch')),
  )
  await Promise.all(cancelled)
  assert.equal(runtime.info().queued, 0)
  await Promise.all(live.slice(0, 2).map(stop))
})

test('100 queued project operations preserve reserved editor access, FIFO check progress, bounded slots, and cancellation', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  const jobs = [],
    controllers = [],
    started = []
  const active = Array.from({ length: 6 }, () =>
    runtime.spawn(root, ['hold-initial']),
  )
  for (let index = 0; index < 100; index++) {
    const projectRoot = path.join(dataDir, `project-${index}`)
    await fs.mkdir(projectRoot)
    const controller = new AbortController()
    controllers.push(controller)
    const task = runtime.run(projectRoot, ['quick'], {
      signal: controller.signal,
      onSpawn() {
        started.push(index)
        assert(runtime.info().usedSlots <= 7)
        assert(runtime.info().workloads.active.batch <= 6)
      },
    })
    jobs.push(
      task.then(
        (result) => ({ result }),
        (error) => ({ error }),
      ),
    )
  }
  assert.equal(runtime.info().queued, 100)
  const editor = runtime.spawn(root, ['hold-editor'], {
    workload: 'interactive',
  })
  assert.equal(runtime.info().usedSlots, 7)
  for (let index = 0; index < 100; index += 2)
    controllers[index].abort(new Error('Cancel queued project'))
  assert.equal(runtime.info().queued, 50)
  await Promise.all(active.map(stop))
  const results = await Promise.all(jobs)
  assert.equal(results.filter(({ result }) => result?.code === 0).length, 50)
  assert.equal(
    results.filter(({ error }) => error?.message === 'Cancel queued project')
      .length,
    50,
  )
  assert.deepEqual(
    started,
    Array.from({ length: 50 }, (_, index) => index * 2 + 1),
  )
  assert.equal(editor.cancelled, undefined)
  assert.equal(runtime.info().queued, 0)
  assert.equal(runtime.info().usedSlots, 1)
  await stop(editor)
})

function storageFixture() {
  const state = { reserved: 0, released: 0 }
  state.reserve = async ({ bytes = 200, signal } = {}) => {
    signal?.throwIfAborted()
    state.reserved += bytes
    let released = false
    return {
      release() {
        if (released) return
        released = true
        state.reserved -= bytes
        state.released++
      },
    }
  }
  return state
}

test('queued full checks release their storage claim when cancelled without starting any worker', async (t) => {
  const storage = storageFixture()
  const { runtime, root } = await fixture(t, { storage })
  const live = Array.from({ length: 6 }, () =>
    runtime.spawn(root, ['hold-batch']),
  )
  const controller = new AbortController()
  const task = runtime.checkProject(root, { signal: controller.signal })
  const cancelled = assert.rejects(task, /Cancel queued export/)
  await until(() => runtime.info().queued === 1)
  assert.equal(storage.reserved, runtime.kernelExportMaxBytes)
  controller.abort(new Error('Cancel queued export'))
  await cancelled
  assert.equal(storage.reserved, 0)
  assert.equal(storage.released, 1)
  assert.equal(runtime.info().queued, 0)
  assert.equal(runtime.children.size, 6)
  await Promise.all(live.map(stop))
})

test('full check cleanup failure retains disk and memory claims until verified cleanup succeeds', async (t) => {
  const storage = storageFixture()
  const { runtime, root, dataDir } = await fixture(t, { storage })
  assert.throws(
    () => runtime.spawn(root, ['lake', 'check'], kernelOptions),
    /temporary storage reservation/,
  )
  const controller = new AbortController()
  let output = ''
  const task = runtime.checkProject(root, {
    signal: controller.signal,
    onOutput: (text) => {
      output += text
    },
  })
  const failed = assert.rejects(task, { status: 503, workerCleanup: true })
  await until(() => output.length > 0)
  assert.equal(storage.reserved, runtime.kernelExportMaxBytes)
  assert.equal(runtime.info().usedSlots, 3)
  await fs.writeFile(path.join(dataDir, 'fail-cleanup'), 'refuse cleanup')
  controller.abort(new Error('Stop full check'))
  await failed
  assert.equal(storage.reserved, runtime.kernelExportMaxBytes)
  assert.equal(runtime.info().usedSlots, 3)
  assert.equal(storage.released, 0)
  await fs.rm(path.join(dataDir, 'fail-cleanup'))
  await runtime.stopProject(root)
  assert.equal(storage.reserved, 0)
  assert.equal(storage.released, 1)
  assert.equal(runtime.info().usedSlots, 0)
})

test('asynchronous admission checks cannot launch a worker before authorization finishes', async (t) => {
  const { runtime, root } = await fixture(t)
  await assert.rejects(
    runtime.run(root, ['quick'], {
      beforeSpawn: async () => {
        throw Object.assign(new Error('Access denied.'), { status: 403 })
      },
    }),
    /must finish synchronously/,
  )
  assert.equal(runtime.children.size, 0)
  assert.equal(runtime.info().queued, 0)
})

test('detached temporary builders retain their own disk claim after caller cancellation and while a worker is live', async (t) => {
  const storage = storageFixture()
  const { runtime, dataDir } = await fixture(t, { storage })
  const root = path.join(
    dataDir,
    'runtime/shared-dependency-stages',
    'shared-builder',
  )
  await fs.mkdir(root, { recursive: true })
  const parent = await storage.reserve()
  await runtime.claimTemporaryWorkspace(root)
  assert.equal(storage.reserved, 400)
  const child = runtime.spawn(root, ['hold-builder'])
  parent.release()
  assert.equal(storage.reserved, 200)
  await runtime.releaseTemporaryWorkspace(root)
  assert.equal(storage.reserved, 200)
  assert.equal(runtime.temporaryStorageReservations.size, 1)
  assert((await fs.stat(root)).isDirectory())
  assert.equal(child.cancelled, undefined)
  await stop(child)
  await runtime.releaseTemporaryWorkspace(root)
  assert.equal(storage.reserved, 0)
  assert.equal(runtime.temporaryStorageReservations.size, 0)
  await assert.rejects(fs.stat(root), { code: 'ENOENT' })
})

test('temporary-stage cleanup retains queued work and its storage until the queue is cancelled', async (t) => {
  const storage = storageFixture()
  const { runtime, root, dataDir } = await fixture(t, {
    storage,
    maxConcurrent: 2,
  })
  const stage = path.join(dataDir, 'setup-repairs', 'queued', 'workspace')
  await fs.mkdir(stage, { recursive: true })
  await runtime.claimTemporaryWorkspace(stage)
  const child = runtime.spawn(root, ['hold-batch'])
  const controller = new AbortController()
  const queued = runtime.run(stage, ['quick'], { signal: controller.signal })
  const cancelled = assert.rejects(queued, /Cancel queued repair/)
  assert.equal(runtime.info().queued, 1)
  await runtime.releaseTemporaryWorkspace(stage)
  assert.equal(storage.reserved, 200)
  assert((await fs.stat(stage)).isDirectory())
  controller.abort(new Error('Cancel queued repair'))
  await cancelled
  await runtime.releaseTemporaryWorkspace(stage)
  assert.equal(storage.reserved, 0)
  await assert.rejects(fs.stat(stage), { code: 'ENOENT' })
  assert.equal(child.cancelled, undefined)
  await stop(child)
})

test('a failed temporary claim releases only its own allocation and preserves an existing stage claim', async (t) => {
  const storage = storageFixture()
  const { runtime, dataDir } = await fixture(t, { storage })
  const stage = path.join(
    dataDir,
    'runtime/shared-dependency-stages',
    'existing',
  )
  await fs.mkdir(stage, { recursive: true })
  await fs.writeFile(path.join(stage, 'keep.txt'), 'original stage')
  await runtime.claimTemporaryWorkspace(stage)
  await assert.rejects(runtime.claimTemporaryWorkspace(stage), {
    code: 'EEXIST',
  })
  assert.equal(storage.reserved, 200)
  assert.equal(runtime.temporaryStorageReservations.size, 1)
  assert.equal(
    await fs.readFile(path.join(stage, 'keep.txt'), 'utf8'),
    'original stage',
  )
  await runtime.releaseTemporaryWorkspace(stage)
  assert.equal(storage.reserved, 0)
})

test('temporary cache publication releases stage admission while preserving the published source', async (t) => {
  const storage = storageFixture()
  const { runtime, dataDir } = await fixture(t, { storage })
  const stage = path.join(
    dataDir,
    'runtime/shared-dependency-stages',
    'published',
  )
  const destination = path.join(
    dataDir,
    'runtime/shared-dependencies',
    'published',
  )
  await fs.mkdir(stage, { recursive: true })
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.writeFile(path.join(stage, 'keep.txt'), 'published dependency')
  await runtime.claimTemporaryWorkspace(stage)
  await fs.rename(stage, destination)
  await runtime.releaseTemporaryWorkspace(stage)
  assert.equal(storage.reserved, 0)
  assert.equal(runtime.temporaryStorageReservations.size, 0)
  assert.equal(
    await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'),
    'published dependency',
  )
})

test('temporary cache cleanup keeps its storage claim until all dependent workspaces release the source', async (t) => {
  const storage = storageFixture()
  const { runtime, dataDir } = await fixture(t, { storage })
  const stage = path.join(dataDir, 'setup-repairs', 'referenced', 'workspace')
  const consumer = path.join(dataDir, 'consumer')
  await fs.mkdir(path.join(stage, '.lake/packages/local'), { recursive: true })
  await fs.mkdir(consumer)
  await runtime.claimTemporaryWorkspace(stage)
  await runtime.inheritDependencies(stage, stage)
  await runtime.inheritDependencies(stage, consumer)
  await runtime.releaseTemporaryWorkspace(stage)
  assert.equal(storage.reserved, 200)
  assert((await fs.stat(stage)).isDirectory())
  await fs.rm(consumer, { recursive: true })
  await runtime.releaseTemporaryWorkspace(stage)
  assert.equal(storage.reserved, 0)
  assert.equal(runtime.temporaryStorageReservations.size, 0)
  await assert.rejects(fs.stat(stage), { code: 'ENOENT' })
})

test('concurrent duplicate temporary claims retain exactly the winning allocation', async (t) => {
  const storage = storageFixture()
  const { runtime, dataDir } = await fixture(t, { storage })
  const stage = path.join(
    dataDir,
    'runtime/shared-dependency-stages',
    'concurrent',
  )
  await fs.mkdir(stage, { recursive: true })
  const results = await Promise.allSettled([
    runtime.claimTemporaryWorkspace(stage),
    runtime.claimTemporaryWorkspace(stage),
  ])
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  const denied = results.find((result) => result.status === 'rejected')
  assert.equal(denied.reason.code, 'EEXIST')
  assert.equal(storage.reserved, 200)
  assert.equal(runtime.temporaryStorageReservations.size, 1)
  await runtime.releaseTemporaryWorkspace(stage)
  assert.equal(storage.reserved, 0)
  assert.equal(runtime.temporaryStorageReservations.size, 0)
})

test('a failed temporary worker cleanup keeps stage admission until verified Stop and deletion', async (t) => {
  const storage = storageFixture()
  const { runtime, dataDir } = await fixture(t, { storage })
  const stage = path.join(
    dataDir,
    'runtime/shared-dependency-stages',
    'cleanup-failed',
  )
  await fs.mkdir(stage, { recursive: true })
  await runtime.claimTemporaryWorkspace(stage)
  const child = runtime.spawn(stage, ['hold-builder'])
  await fs.writeFile(path.join(dataDir, 'fail-cleanup'), 'refuse cleanup')
  child.kill()
  await assert.rejects(child.workerStopped, {
    status: 503,
    workerCleanup: true,
  })
  await runtime.releaseTemporaryWorkspace(stage)
  assert((await fs.stat(stage)).isDirectory())
  assert.equal(storage.reserved, 200)
  assert.equal(runtime.temporaryStorageReservations.size, 1)
  await fs.rm(path.join(dataDir, 'fail-cleanup'))
  await runtime.stopProject(stage)
  assert.equal(
    storage.reserved,
    200,
    'Deleting retained data remains part of the allocation lifetime',
  )
  await runtime.releaseTemporaryWorkspace(stage)
  assert.equal(storage.reserved, 0)
  assert.equal(runtime.temporaryStorageReservations.size, 0)
  await assert.rejects(fs.stat(stage), { code: 'ENOENT' })
})
