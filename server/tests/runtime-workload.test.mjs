import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'
import { loadCapacity } from '../capacity.mjs'
import { StorageCapacity } from '../storage-capacity.mjs'
import { TexBuildManager } from '../tex-builds.mjs'
import { createTexAgentTools } from '../tex-agent-tools.mjs'
import { EventStore } from '../events.mjs'

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
  if (args.includes('/opt/tex-compile-worker.py')) {
    const artifacts = {'result.json': Buffer.from('{"success":true}').toString('base64'), 'document.pdf': Buffer.from('%PDF-1.7\\n1 0 obj\\n<<>>\\nendobj\\n%%EOF\\n').toString('base64'), 'document.txt': Buffer.from('Compiled document text').toString('base64')}
    console.log('LEANFLOW_TEX_ARTIFACTS:' + args.at(-1) + ':' + JSON.stringify({artifacts}))
    if (fs.existsSync(${JSON.stringify(path.join(dataDir, 'hold-tex'))})) setInterval(() => {}, 1000)
  } else {
    console.log(JSON.stringify(args))
    if (!args.includes('quick')) setInterval(() => {}, 1000)
  }
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
  const cleanup = []
  t.after(async () => {
    for (const action of cleanup) await action()
    await runtime.shutdown()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return { runtime, root, dataDir, cleanup }
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

test('agent-dependent TeX work can finish behind a weighted check and release its parent slots', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  runtime.texImageId = 'fixture-tex-image'
  const editors = Array.from({ length: 4 }, () =>
    runtime.spawn(root, ['hold-editor'], { workload: 'interactive' }),
  )
  const parents = await Promise.all(
    Array.from({ length: 2 }, () =>
      runtime.spawnAgentWhenAvailable(root, ['hold-agent'], {
        dependentTools: true,
      }),
    ),
  )
  const pendingKernel = runtime.spawnWhenAvailable(
    root,
    ['lake', 'check'],
    kernelOptions,
  )
  pendingKernel.catch(() => {})
  let finished = 0
  const dependent = parents.map(async (parentWorker, index) => {
    const source = path.join(dataDir, `dependent-tex-${index}`)
    const output = path.join(dataDir, `dependent-output-${index}`)
    await fs.mkdir(source)
    await fs.mkdir(output)
    const result = await runtime.runTex(source, output, {
      rootFile: 'main.tex',
      parentWorker,
    })
    assert.equal(result.code, 0)
    finished++
    await stop(parentWorker)
    return result
  })
  dependent.forEach((promise) => promise.catch(() => {}))
  for (let count = 0; count < 100 && finished < 2; count++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(
    finished,
    2,
    'Both parents must receive their dependent compiler results instead of waiting behind the check for their own slots',
  )
  await Promise.all(dependent)
  const kernel = await pendingKernel
  assert.equal(kernel.workerSlots, 3)
  assert.equal(runtime.info().usedSlots, 7)
  assert.equal(runtime.info().queued, 0)
  await Promise.all([...editors, kernel].map(stop))
})

test('real TeX tool callbacks inherit live parent priority while unrelated small work stays behind the full check', async (t) => {
  const f = await fixture(t)
  const { runtime, root, dataDir } = f
  runtime.texImageId = 'fixture-tex-image'
  const events = new EventStore(dataDir)
  const parentRoots = [
    path.join(dataDir, 'agent-one'),
    path.join(dataDir, 'agent-two'),
  ]
  for (const directory of parentRoots) await fs.mkdir(directory)
  const workspaces = {
    get: (id) => ({ id, status: 'ready' }),
    async captureTexSource(projectId, owner, destination, options) {
      const index = Number(projectId.slice(-1))
      assert.equal(owner, 'alice')
      assert.equal(options.sourceRoot, parentRoots[index])
      assert.equal(options.runId, `run-${index}`)
      await fs.mkdir(destination, { recursive: true })
      await fs.writeFile(
        path.join(destination, 'main.tex'),
        '\\documentclass{article}\\begin{document}hello\\end{document}',
      )
      return {
        files: [{ path: 'main.tex' }],
        bytes: 80,
        sourceRevision: `source-${index}`,
        workspaceRevision: `workspace-${index}`,
      }
    },
  }
  const manager = await new TexBuildManager({
    dataDir,
    events,
    runtime,
    workspaces,
  }).init()
  const tools = [],
    responses = [],
    parentStops = []
  f.cleanup.push(async () => {
    await Promise.all(tools.map((tool) => tool.dispose()))
    await manager.shutdown()
    events.close()
  })
  const editors = Array.from({ length: 4 }, () =>
    runtime.spawn(root, ['hold-editor'], { workload: 'interactive' }),
  )
  const parents = await Promise.all(
    parentRoots.map((directory) =>
      runtime.spawnAgentWhenAvailable(directory, ['hold-agent'], {
        dependentTools: true,
      }),
    ),
  )
  const kernelPending = runtime.spawnWhenAvailable(
    root,
    ['lake', 'check'],
    kernelOptions,
  )
  kernelPending.catch(() => {})
  let ordinaryStarted = false
  const ordinary = runtime.run(root, ['quick'], {
    onSpawn: () => {
      ordinaryStarted = true
    },
  })
  ordinary.catch(() => {})
  for (const [index, parentWorker] of parents.entries()) {
    const tool = createTexAgentTools({
      manager,
      parentWorker,
      job: {
        id: `run-${index}`,
        owner: 'alice',
        projectId: `project-${index}`,
      },
      snapshot: { root: parentRoots[index] },
      active: {
        controller: new AbortController(),
        threadId: `thread-${index}`,
        turnId: 'turn',
      },
      rpc: {
        respond(id, result) {
          responses.push({ id, result })
          parentStops.push(stop(parentWorker))
        },
      },
    })
    tools.push(tool)
    tool.handle({
      id: index,
      method: 'item/tool/call',
      params: {
        threadId: `thread-${index}`,
        turnId: 'turn',
        callId: `compile-${index}`,
        tool: 'tex_build',
        arguments: { rootFile: 'main.tex' },
      },
    })
  }
  await until(() => responses.length === 2)
  await Promise.all(parentStops)
  for (const { result } of responses) {
    assert.equal(result.success, true)
    const build = JSON.parse(result.contentItems[0].text)
    assert.equal(build.status, 'completed', JSON.stringify(build))
    assert.equal(build.origin, 'agent')
  }
  const kernel = await kernelPending
  assert.equal(ordinaryStarted, false)
  assert.equal(runtime.info().usedSlots, 7)
  assert.equal(runtime.info().workloads.active.batch, 3)
  assert.equal(runtime.info().queued, 1)
  await stop(kernel)
  assert.equal((await ordinary).code, 0)
  assert.equal(ordinaryStarted, true)
  await Promise.all(editors.map(stop))
})

async function texDirectories(dataDir, name) {
  const source = path.join(dataDir, `tex-source-${name}`),
    output = path.join(dataDir, `tex-output-${name}`)
  await fs.mkdir(source)
  await fs.mkdir(output)
  return { source, output }
}

test('dependent compiler admission rejects forged, interactive and stopped parents and duplicate outstanding work', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  runtime.texImageId = 'fixture-tex-image'
  const parent = await runtime.spawnAgentWhenAvailable(root, ['hold-agent'], {
    dependentTools: true,
  })
  const editor = runtime.spawn(root, ['hold-editor'], {
    workload: 'interactive',
  })
  for (const [index, parentWorker] of [
    null,
    {},
    { ...parent },
    editor,
  ].entries()) {
    const { source, output } = await texDirectories(dataDir, `invalid-${index}`)
    await assert.rejects(
      runtime.runTex(source, output, { rootFile: 'main.tex', parentWorker }),
      { status: 409 },
    )
  }
  const first = await texDirectories(dataDir, 'first')
  const second = await texDirectories(dataDir, 'second')
  const listeners = parent.listenerCount('close')
  let forbiddenNested
  const building = runtime.runTex(first.source, first.output, {
    rootFile: 'main.tex',
    parentWorker: parent,
    onSpawn(child) {
      forbiddenNested = assert.rejects(
        runtime.runTex(second.source, second.output, {
          rootFile: 'main.tex',
          parentWorker: child,
        }),
        { status: 409 },
      )
    },
  })
  await assert.rejects(
    runtime.runTex(second.source, second.output, {
      rootFile: 'main.tex',
      parentWorker: parent,
    }),
    { status: 409 },
  )
  assert.equal((await building).code, 0)
  await forbiddenNested
  assert.equal(parent.listenerCount('close'), listeners)
  assert.equal(runtime.pendingDependentWorkers.has(parent), false)
  assert.equal(
    (
      await runtime.runTex(second.source, second.output, {
        rootFile: 'main.tex',
        parentWorker: parent,
      })
    ).code,
    0,
  )
  await stop(parent)
  const ended = await texDirectories(dataDir, 'ended')
  await assert.rejects(
    runtime.runTex(ended.source, ended.output, {
      rootFile: 'main.tex',
      parentWorker: parent,
    }),
    { status: 409 },
  )
  await stop(editor)
})

test('a parent ending cancels its queued compiler without advancing unrelated work past a weighted check', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  runtime.texImageId = 'fixture-tex-image'
  const editors = Array.from({ length: 4 }, () =>
    runtime.spawn(root, ['hold-editor'], { workload: 'interactive' }),
  )
  const [parent, unrelated] = await Promise.all(
    Array.from({ length: 2 }, () =>
      runtime.spawnAgentWhenAvailable(root, ['hold-agent'], {
        dependentTools: true,
      }),
    ),
  )
  const controller = new AbortController()
  const kernel = runtime.spawnWhenAvailable(root, ['lake', 'check'], {
    ...kernelOptions,
    signal: controller.signal,
  })
  const cancelledKernel = assert.rejects(kernel, /End queued check fixture/)
  await fs.writeFile(path.join(dataDir, 'hold-tex'), 'hold compiler')
  const occupied = await texDirectories(dataDir, 'occupied-child')
  let occupiedChild
  const running = runtime.runTex(occupied.source, occupied.output, {
    rootFile: 'main.tex',
    parentWorker: unrelated,
    onSpawn(child) {
      occupiedChild = child
    },
  })
  const stoppedRunning = assert.rejects(running, /assistant worker ended/)
  await until(() => occupiedChild !== undefined)
  const { source, output } = await texDirectories(dataDir, 'queued-parent')
  const dependent = runtime.runTex(source, output, {
    rootFile: 'main.tex',
    parentWorker: parent,
  })
  const cancelled = assert.rejects(dependent, /assistant worker ended/)
  await until(() => runtime.info().queued === 2)
  await stop(parent)
  await cancelled
  assert.equal(runtime.info().queued, 1)
  assert.equal(runtime.pendingDependentWorkers.has(parent), false)
  assert.equal(unrelated.cancelled, undefined)
  assert.equal(occupiedChild.cancelled, undefined)
  controller.abort(new Error('End queued check fixture'))
  await cancelledKernel
  await stop(unrelated)
  await stoppedRunning
  await Promise.all(editors.map(stop))
})

test('a parent ending cancels an active dependent compiler and returns its slot after verified cleanup', async (t) => {
  const { runtime, root, dataDir } = await fixture(t)
  runtime.texImageId = 'fixture-tex-image'
  const parent = await runtime.spawnAgentWhenAvailable(root, ['hold-agent'], {
    dependentTools: true,
  })
  const unrelated = runtime.spawn(root, ['hold-editor'], {
    workload: 'interactive',
  })
  await fs.writeFile(path.join(dataDir, 'hold-tex'), 'hold compiler')
  const { source, output } = await texDirectories(dataDir, 'active-parent')
  let child
  const dependent = runtime.runTex(source, output, {
    rootFile: 'main.tex',
    parentWorker: parent,
    onSpawn: (value) => {
      child = value
    },
  })
  const cancelled = assert.rejects(dependent, /assistant worker ended/)
  await until(() => child !== undefined)
  assert.equal(child.dependentWorker, true)
  await stop(parent)
  await cancelled
  assert.equal(runtime.pendingDependentWorkers.has(parent), false)
  assert.equal(runtime.info().usedSlots, 1)
  assert.equal(unrelated.cancelled, undefined)
  await stop(unrelated)
})

test('one protected compiler slot keeps a three-slot host progressing instead of admitting two mutually waiting agents', async (t) => {
  const { runtime, root, dataDir } = await fixture(t, { maxConcurrent: 3 })
  runtime.texImageId = 'fixture-tex-image'
  const editor = runtime.spawn(root, ['hold-editor'], {
    workload: 'interactive',
  })
  const first = await runtime.spawnAgentWhenAvailable(root, ['hold-agent'], {
    dependentTools: true,
  })
  assert.equal(runtime.info().usedSlots, 2)
  assert.equal(runtime.info().compilerReservedSlots, 1)
  const waiting = runtime.spawnAgentWhenAvailable(root, ['hold-agent'], {
    dependentTools: true,
  })
  waiting.catch(() => {})
  assert.equal(runtime.info().queued, 1)
  await assert.rejects(
    runtime.run(root, ['quick'], { timeoutMs: 5000, queue: false }),
    { status: 503 },
  )
  const initial = await texDirectories(dataDir, 'three-slot-first')
  let peak = 0
  const compiled = await runtime.runTex(initial.source, initial.output, {
    rootFile: 'main.tex',
    parentWorker: first,
    onSpawn() {
      peak = runtime.info().usedSlots
      assert.equal(runtime.info().compilerReservedSlots, 0)
    },
  })
  assert.equal(compiled.code, 0)
  assert.equal(peak, 3)
  assert.equal(runtime.info().compilerReservedSlots, 1)
  await stop(first)
  const second = await waiting
  const next = await texDirectories(dataDir, 'three-slot-second')
  assert.equal(
    (
      await runtime.runTex(next.source, next.output, {
        rootFile: 'main.tex',
        parentWorker: second,
      })
    ).code,
    0,
  )
  await Promise.all([editor, second].map(stop))
  assert.equal(runtime.info().compilerReservedSlots, 0)
})

test('one-slot batch capacity still runs the assistant and manual TeX but promptly reports unsupported nested compilation', async (t) => {
  for (const slots of [1, 2])
    await t.test(String(slots), async (t) => {
      const { runtime, root, dataDir } = await fixture(t, {
        maxConcurrent: slots,
      })
      runtime.texImageId = 'fixture-tex-image'
      const parent = await runtime.spawnAgentWhenAvailable(
        root,
        ['hold-agent'],
        { dependentTools: true },
      )
      assert.equal(parent.agentWorker, true)
      assert.equal(runtime.info().compilerReservedSlots, 0)
      const nested = await texDirectories(dataDir, 'unsupported')
      await assert.rejects(
        runtime.runTex(nested.source, nested.output, {
          rootFile: 'main.tex',
          parentWorker: parent,
        }),
        (error) => {
          assert.equal(error.status, 503)
          assert.match(
            error.message,
            /cannot run an assistant and its LaTeX compiler together/,
          )
          assert.match(error.message, /project PDF panel/)
          return true
        },
      )
      assert.equal(parent.cancelled, undefined)
      await stop(parent)
      const manual = await texDirectories(dataDir, 'manual')
      assert.equal(
        (
          await runtime.runTex(manual.source, manual.output, {
            rootFile: 'main.tex',
          })
        ).code,
        0,
      )
    })
})

test('bounded work backfills a check blocked by long-lived agents but stops filling as soon as those holders leave', async (t) => {
  const { runtime, root } = await fixture(t, { maxConcurrent: 6 })
  const editors = Array.from({ length: 2 }, () =>
    runtime.spawn(root, ['hold-editor'], { workload: 'interactive' }),
  )
  const parents = await Promise.all(
    Array.from({ length: 2 }, () =>
      runtime.spawnAgentWhenAvailable(root, ['hold-agent']),
    ),
  )
  const kernelPending = runtime.spawnWhenAvailable(
    root,
    ['lake', 'check'],
    kernelOptions,
  )
  kernelPending.catch(() => {})
  assert.equal(
    (await runtime.run(root, ['quick'], { timeoutMs: 1000 })).code,
    0,
  )
  assert.equal(
    runtime.info().queued,
    1,
    'Bounded metadata work progresses while until-done agents hold slots',
  )
  let finishBackfill
  const backfillReady = new Promise((resolve) => {
    finishBackfill = resolve
  })
  const activeBackfill = await runtime.spawnWhenAvailable(
    root,
    ['hold-finite'],
    { timeoutMs: 5000, onSpawn: finishBackfill },
  )
  // This bounded spawn-only worker is still finite and does not introduce a new agent.
  await backfillReady
  await stop(parents[0])
  let nextStarted = false
  const next = runtime.run(root, ['quick'], {
    timeoutMs: 1000,
    onSpawn() {
      nextStarted = true
    },
  })
  next.catch(() => {})
  assert.equal(nextStarted, false)
  assert.equal(runtime.info().queued, 2)
  await stop(activeBackfill)
  const kernel = await kernelPending
  assert.equal(nextStarted, false)
  assert.equal(runtime.info().usedSlots, 6)
  await stop(kernel)
  assert.equal((await next).code, 0)
  await Promise.all([...editors, parents[1]].map(stop))
})

test('bounded one-slot work can use idle capacity while a full check waits for another kernel export', async (t) => {
  const { runtime, root } = await fixture(t, { maxConcurrent: 6 })
  const kernel = runtime.spawn(root, ['lake', 'check'], kernelOptions)
  const next = runtime.spawnWhenAvailable(
    root,
    ['lake', 'check'],
    kernelOptions,
  )
  next.catch(() => {})
  assert.equal(
    (await runtime.run(root, ['quick'], { timeoutMs: 1000 })).code,
    0,
  )
  assert.equal(runtime.info().queued, 1)
  const unbounded = runtime.spawnWhenAvailable(root, ['hold-agent'])
  unbounded.catch(() => {})
  assert.equal(
    runtime.info().queued,
    2,
    'A new unbounded worker cannot backfill the export queue',
  )
  await stop(kernel)
  const resumed = await next
  const background = await unbounded
  assert.equal(resumed.kernelCheck, true)
  await Promise.all([resumed, background].map(stop))
})

function realKernelDisk(freeBytes = 12 * 1024 ** 3) {
  const state = { freeBytes }
  const storage = new StorageCapacity({
    dataDir: '/fixture/kernel-volume',
    resolve: async () => '/fixture/kernel-volume',
    minimumFreeBytes: 2 * 1024 ** 3,
    warningFreeBytes: 8 * 1024 ** 3,
    allocationBytes: 512 * 1024 ** 2,
    sample: async () => ({ bavail: BigInt(state.freeBytes), bsize: 1n }),
  })
  return { storage, state }
}

test('queued full checks share one 8 GiB disk budget on a 12 GiB volume and cancel independently', async (t) => {
  const { storage } = realKernelDisk()
  const { runtime, root } = await fixture(t, {
    storage,
    kernelExportMaxBytes: 8 * 1024 ** 3,
  })
  storage.dataDir = runtime.dataDir
  const live = Array.from({ length: 6 }, () =>
    runtime.spawn(root, ['hold-batch']),
  )
  const a = new AbortController(),
    b = new AbortController()
  const first = runtime.checkProject(root, { signal: a.signal })
  const firstCancelled = assert.rejects(first, /Cancel first queued check/)
  const second = runtime.checkProject(root, { signal: b.signal })
  const secondCancelled = assert.rejects(second, /Cancel second queued check/)
  await until(() => runtime.info().queued === 2)
  assert.equal(storage.reservedBytes, 8 * 1024 ** 3)
  assert.equal(storage.leases.size, 1)
  a.abort(new Error('Cancel first queued check'))
  await firstCancelled
  assert.equal(runtime.info().queued, 1)
  assert.equal(storage.reservedBytes, 8 * 1024 ** 3)
  b.abort(new Error('Cancel second queued check'))
  await secondCancelled
  assert.equal(storage.reservedBytes, 0)
  assert.equal(storage.leases.size, 0)
  assert.equal(storage.allocationObservers.size, 0)
  await Promise.all(live.map(stop))
})

test('growing exports fund their physical blocks once and reset the full budget before the next check starts', async (t) => {
  const GiB = 1024 ** 3,
    MiB = 1024 ** 2
  const baseline = 10 * GiB + 513 * MiB
  const { storage, state } = realKernelDisk(baseline)
  const { runtime, root } = await fixture(t, {
    storage,
    kernelExportMaxBytes: 8 * GiB,
  })
  storage.dataDir = runtime.dataDir
  const a = new AbortController(),
    b = new AbortController()
  let firstWorker, secondWorker
  const first = runtime.checkProject(root, {
    signal: a.signal,
    onSpawn: (child) => {
      firstWorker = child
    },
  })
  await until(() => !!firstWorker)
  const directory = path.join(
    firstWorker.workerHome,
    'kernel-check-tmp',
    'leanflow-project-kernel-fixture',
  )
  await fs.mkdir(directory)
  const filename = path.join(directory, 'project.ndjson')
  await fs.writeFile(filename, Buffer.alloc(4 * MiB, 'x'))
  const stat = await fs.stat(filename, { bigint: true })
  const allocated = Number(stat.blocks * 512n)
  assert(allocated > 0)
  state.freeBytes = baseline - allocated
  const terminal = await storage.reserve()
  assert.equal(storage.reservedBytes, 8 * GiB - allocated + 512 * MiB)
  terminal.release()
  const second = runtime.checkProject(root, {
    signal: b.signal,
    onSpawn: (child) => {
      secondWorker = child
      assert.equal(storage.reservedBytes, 8 * GiB)
    },
  })
  await until(() => runtime.info().queued === 1)
  a.abort(new Error('Finish first export'))
  await first
  await until(() => !!secondWorker)
  assert.notEqual(firstWorker.workerHome, secondWorker.workerHome)
  assert.equal(storage.reservedBytes, 8 * GiB)
  assert.equal(storage.leases.size, 1)
  b.abort(new Error('Finish second export'))
  await second
  assert.equal(storage.reservedBytes, 0)
  assert.equal(storage.leases.size, 0)
})

test('a failed full-check cleanup keeps the shared real disk claim and unrelated editor until verified retry', async (t) => {
  const GiB = 1024 ** 3
  const { storage } = realKernelDisk()
  const { runtime, root, dataDir } = await fixture(t, {
    storage,
    kernelExportMaxBytes: 8 * GiB,
  })
  storage.dataDir = runtime.dataDir
  const otherRoot = path.join(dataDir, 'unrelated-editor')
  await fs.mkdir(otherRoot)
  const editor = runtime.spawn(otherRoot, ['hold-editor'], {
    workload: 'interactive',
  })
  const controller = new AbortController()
  let worker
  const check = runtime.checkProject(root, {
    signal: controller.signal,
    onSpawn: (child) => {
      worker = child
    },
  })
  const failed = assert.rejects(check, { status: 503, workerCleanup: true })
  await until(() => !!worker)
  await fs.writeFile(path.join(dataDir, 'fail-cleanup'), 'refuse cleanup')
  controller.abort(new Error('Stop check for cleanup test'))
  await failed
  assert.equal(storage.reservedBytes, 8 * GiB)
  assert.equal(storage.leases.size, 1)
  assert.equal(editor.cancelled, undefined)
  await fs.rm(path.join(dataDir, 'fail-cleanup'))
  await runtime.stopProject(root)
  assert.equal(storage.reservedBytes, 0)
  assert.equal(storage.leases.size, 0)
  assert.equal(storage.allocationObservers.size, 0)
  assert.equal(editor.cancelled, undefined)
  await stop(editor)
})

test('a Runtime initialized through a data-directory alias tracks its canonical kernel home', async (t) => {
  const { runtime: existing, root, dataDir, cleanup } = await fixture(t)
  const alias = dataDir + '-alias'
  await fs.symlink(dataDir, alias)
  const { storage } = realKernelDisk()
  storage.dataDir = alias
  const runtime = new Runtime({
    dataDir: alias,
    docker: existing.docker,
    storage,
    maxConcurrent: 7,
    kernelExportMaxBytes: 1024,
  })
  cleanup.push(async () => {
    await runtime.shutdown()
    await fs.unlink(alias)
  })
  // The fake Docker command deliberately provides no native image provenance;
  // init still performs the actual data-directory canonicalization first.
  await runtime.init()
  assert.equal(runtime.dataDir, await fs.realpath(dataDir))
  assert.equal(runtime.kernelStorageBudget.runtimeDir, runtime.runtimeDir)
  runtime.ready = true
  runtime.capacityError = null
  runtime.error = null
  runtime.imageId = 'fixture-image'
  const controller = new AbortController()
  let child
  const checking = runtime.checkProject(root, {
    signal: controller.signal,
    onSpawn: (worker) => {
      child = worker
    },
  })
  await until(() => !!child)
  assert(
    child.workerHome.startsWith(path.join(dataDir, 'runtime/homes') + path.sep),
  )
  controller.abort(new Error('Finish aliased kernel fixture'))
  await checking
  assert.equal(storage.reservedBytes, 0)
})
