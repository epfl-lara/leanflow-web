import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { WorkerNode } from '../cluster/node.mjs'
import { FramedRpc, PROTOCOL_VERSION } from '../cluster/protocol.mjs'
import { executionDigest, sha256 } from '../cluster/state.mjs'

const image = 'sha256:' + sha256('image')
const bundle = sha256('bundle')
const version = 'leanprover/lean4:v4.35.0'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function connect(worker) {
  const up = new PassThrough(),
    down = new PassThrough()
  worker.attach(up, down)
  return new FramedRpc(down, up)
}

async function fixture(t, run) {
  const temporaryRoot =
    process.platform === 'darwin' ? '/private/tmp' : os.tmpdir()
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(temporaryRoot, 'lf-node-')),
  )
  const calls = []
  const runtime = {
    toolchains: new Map(),
    async init() {
      return this.info()
    },
    info() {
      return {
        ready: true,
        imageId: image,
        cgroupDriver: 'systemd',
        cgroupVersion: '2',
      }
    },
    async run(root, args, options) {
      calls.push({ root, args })
      return run
        ? run(root, args, options)
        : {
            code: 0,
            stdout: 'passed\n',
            stderr: '',
            timedOut: false,
            cancelled: false,
          }
    },
    async checkProject(root, options) {
      return this.run(root, ['native-project-check'], options)
    },
    async inheritDependencies() {},
    async clearInheritedDependencies() {},
    async shutdown() {},
  }
  const worker = await new WorkerNode({
    config: {
      version: 1,
      nodeId: 'node-1',
      controllerLineage: 'lineage-1',
      dataDir: path.join(directory, 'state'),
      image,
      engineKind: 'docker',
      maxCpus: 8,
      parentMaxCpus: 8,
      workerMemory: '6g',
      memoryBudget: '24g',
    },
    runtime,
    verifyToolchain: async () => {},
    bundleDigest: bundle,
    reap: async () => {},
    boundaryInspector: async () => ({
      memoryBytes: 48 * 1024 ** 3,
      swapBytes: 0,
      tasks: 8192,
    }),
    leaseAcquire: async () => ({ release: async () => {} }),
    certifier: async (node) => ({
      nodeEpoch: node.nodeEpoch,
      bundleDigest: bundle,
      imageDigest: image,
      engineKind: 'docker',
      capabilities: ['check.build', 'check.kernel', 'lean.file'],
    }),
  }).init()
  const rpc = connect(worker)
  const hello = {
    version: PROTOCOL_VERSION,
    bundleDigest: bundle,
    imageDigest: image,
    lineage: 'lineage-1',
    epoch: 1,
  }
  await rpc.request('hello', hello)
  t.after(async () => {
    rpc.close()
    await worker.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  const toolchain = await worker.blobs.seal([], 'toolchain')
  await rpc.request('assets.prepare', {
    toolchain: { version, manifest: toolchain.hash },
  })
  const sourceFile = await worker.blobs.put(version + '\n')
  const source = await worker.blobs.seal([
    {
      path: 'lean-toolchain',
      type: 'file',
      hash: sourceFile.hash,
      size: sourceFile.size,
      mode: 0o600,
    },
  ])
  function request(patch = {}) {
    const value = {
      id: 'attempt-1',
      jobId: 'job-1',
      actor: 'alice',
      projectId: 'project-1',
      lineage: 'lineage-1',
      epoch: 1,
      nodeId: 'node-1',
      nodeEpoch: worker.nodeEpoch,
      bundleDigest: bundle,
      imageDigest: image,
      operation: 'check.build',
      sourceManifest: source.hash,
      toolchain: { version, manifest: toolchain.hash },
      resources: {
        memoryBytes: 6 * 1024 ** 3,
        cpus: 2,
        scratchBytes: 256 * 1024 ** 2,
      },
      timeoutMs: 10000,
      ...patch,
    }
    value.inputDigest = executionDigest(value)
    return value
  }
  return { worker, rpc, runtime, calls, request, hello }
}

async function waitState(rpc, id, expected) {
  for (let i = 0; i < 200; i++) {
    const response = await rpc.request('attempt.get', { id })
    if (expected.includes(response.attempt.state)) return response.attempt
    await delay(5)
  }
  assert.fail('Worker did not reach ' + expected.join('/'))
}

test('a cancel tombstone prevents a delayed start from executing after shutdown was confirmed', async (t) => {
  const f = await fixture(t)
  await f.rpc.request('worker.certify', { toolchain: version })
  const value = f.request()
  const cancelled = await f.rpc.request('attempt.cancel', { id: value.id })
  assert.equal(cancelled.stopped, true)
  assert.equal(cancelled.tombstoned, true)
  await assert.rejects(f.rpc.request('attempt.start', value), {
    code: 'attempt_cancelled',
  })
  assert.equal(f.calls.length, 0)
})

test('an opted-in restart earns fresh certification before advertising its saved toolchain', async (t) => {
  const f = await fixture(t)
  await f.rpc.request('worker.certify', { toolchain: version })
  const oldEpoch = f.worker.nodeEpoch
  await f.worker.close()
  const gate = Promise.withResolvers()
  const restarted = await new WorkerNode({
    config: { ...f.worker.config, certifyToolchain: version },
    runtime: f.runtime,
    bundleDigest: bundle,
    reap: async () => {},
    boundaryInspector: async () => ({}),
    leaseAcquire: async () => ({ release: async () => {} }),
    certifier: async (node) => {
      await gate.promise
      return {
        nodeEpoch: node.nodeEpoch,
        bundleDigest: bundle,
        imageDigest: image,
        engineKind: 'docker',
        capabilities: ['check.build', 'lean.file'],
      }
    },
  }).init()
  t.after(() => restarted.close())
  assert.notEqual(restarted.nodeEpoch, oldEpoch)
  assert.equal(restarted.status().certified, false)
  assert.deepEqual(restarted.status().capabilities, [])
  gate.resolve()
  await restarted.certificationTask
  assert.equal(restarted.status().certified, true)
  assert.deepEqual(restarted.status().capabilities, [
    'check.build',
    'lean.file',
  ])
})

test('a failed automatic certification never restores an older capability report', async (t) => {
  const f = await fixture(t)
  await f.rpc.request('worker.certify', { toolchain: version })
  await f.worker.close()
  const restarted = await new WorkerNode({
    config: { ...f.worker.config, certifyToolchain: version },
    runtime: f.runtime,
    bundleDigest: bundle,
    reap: async () => {},
    boundaryInspector: async () => ({}),
    leaseAcquire: async () => ({ release: async () => {} }),
    certifier: async () => {
      throw new Error('probe failed')
    },
  }).init()
  t.after(() => restarted.close())
  await restarted.certificationTask
  assert.equal(restarted.status().certified, false)
  assert.deepEqual(restarted.status().capabilities, [])
  assert.ok(restarted.certificationError)
})

test('a duplicate start remains idempotent while a worker has entered recovery', async (t) => {
  const f = await fixture(t)
  await f.rpc.request('worker.certify', { toolchain: version })
  const value = f.request()
  await f.rpc.request('attempt.start', value)
  await waitState(f.rpc, value.id, ['completed'])
  f.worker.recoveryError = 'storage failed'
  assert.equal((await f.rpc.request('attempt.start', value)).state, 'completed')
  assert.equal(f.calls.length, 1)
})

test('concurrent confirmed cleanup retries share one cleanup and release the grant', async (t) => {
  let confirmed = false
  let cleanups = 0
  const cleanupGate = Promise.withResolvers()
  const f = await fixture(t, async (_root, _args, options) => {
    options.onSpawn({
      async cleanupWorker() {
        if (!confirmed) throw new Error('not stopped')
        cleanups++
        await cleanupGate.promise
      },
    })
    throw Object.assign(new Error('not stopped'), { workerCleanup: true })
  })
  await f.rpc.request('worker.certify', { toolchain: version })
  const value = f.request()
  await f.rpc.request('attempt.start', value)
  await waitState(f.rpc, value.id, ['lost'])
  assert.equal(f.worker.running.size, 1)
  await assert.rejects(f.rpc.request('attempt.cancel', { id: value.id }))
  confirmed = true
  const cancellations = [
    f.rpc.request('attempt.cancel', { id: value.id }),
    f.rpc.request('attempt.cancel', { id: value.id }),
  ]
  cleanupGate.resolve()
  for (const result of await Promise.all(cancellations)) {
    assert.equal(result.stopped, true)
    assert.equal(result.state, 'cancelled')
  }
  assert.equal(cleanups, 1)
  assert.equal(f.worker.running.size, 0)
  await assert.rejects(fs.stat(f.calls[0].root), { code: 'ENOENT' })
})

test('an image load refuses to overlap an in-flight asset preparation', async (t) => {
  const f = await fixture(t)
  const entered = Promise.withResolvers()
  const gate = Promise.withResolvers()
  f.worker.verifyToolchain = async () => {
    entered.resolve()
    await gate.promise
  }
  const manifest = await f.worker.blobs.seal([], 'toolchain')
  const preparing = f.rpc.request('assets.prepare', {
    toolchain: {
      version: 'leanprover/lean4:v4.34.1',
      manifest: manifest.hash,
    },
  })
  await entered.promise
  try {
    await assert.rejects(
      f.rpc.request('images.load', {
        imageDigest: image,
        archive: sha256('archive'),
      }),
      { code: 'worker_busy' },
    )
  } finally {
    gate.resolve()
    await preparing
  }
})

test('interrupted assets are replaced atomically and equal bytes can serve distinct toolchain pins', async (t) => {
  const f = await fixture(t)
  const manifest = await f.worker.blobs.seal([], 'toolchain')
  const root = path.join(f.worker.config.dataDir, 'runtime/elan/toolchains')
  const abandoned = path.join(root, 'leanprover--lean4---v4.34.1')
  await fs.mkdir(abandoned)
  await fs.writeFile(path.join(abandoned, 'partial'), 'unfinished')
  await Promise.all(
    ['v4.34.1', 'v4.34.2'].map((pin) =>
      f.rpc.request('assets.prepare', {
        toolchain: {
          version: 'leanprover/lean4:' + pin,
          manifest: manifest.hash,
        },
      }),
    ),
  )
  assert.ok(f.runtime.toolchains.has('leanprover/lean4:v4.34.1'))
  assert.ok(f.runtime.toolchains.has('leanprover/lean4:v4.34.2'))
  await assert.rejects(fs.stat(path.join(abandoned, 'partial')), {
    code: 'ENOENT',
  })
  assert.equal(
    (await fs.readdir(root)).some((name) => /\.(stage|abandoned)-/.test(name)),
    false,
  )
})

test('workers require enrollment and real certification before starting any operation', async (t) => {
  const f = await fixture(t)
  const unauthenticated = connect(f.worker)
  t.after(() => unauthenticated.close())
  await assert.rejects(unauthenticated.request('status'), {
    code: 'stale_generation',
  })
  await assert.rejects(f.rpc.request('attempt.start', f.request()), {
    code: 'capability_unavailable',
  })
  assert.equal(f.calls.length, 0)
  await assert.rejects(
    f.rpc.request('hello', { ...f.hello, bundleDigest: sha256('old') }),
    { code: 'release_mismatch' },
  )
  await assert.rejects(f.rpc.request('hello', { ...f.hello, version: 1 }), {
    code: 'release_mismatch',
  })
})

test('a source-pinned duplicate start executes once and retains the exact result object', async (t) => {
  const f = await fixture(t)
  await f.rpc.request('worker.certify', { toolchain: version })
  const request = f.request()
  await f.rpc.request('attempt.start', request)
  await f.rpc.request('attempt.start', request)
  const result = await waitState(f.rpc, request.id, ['completed'])
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.calls[0].args, ['lake', 'build'])
  assert.equal(result.inputDigest, request.inputDigest)
  const chunk = await f.rpc.request('objects.get', { hash: result.result.hash })
  assert.equal(JSON.parse(Buffer.from(chunk.data, 'base64')).code, 0)
  await assert.rejects(
    f.rpc.request('attempt.start', { ...request, timeoutMs: 9000 }),
    { code: 'attempt_conflict' },
  )
})

test('a changed manifest or environment cannot reuse an attempt digest', async (t) => {
  const f = await fixture(t)
  await f.rpc.request('worker.certify', { toolchain: version })
  const value = f.request()
  await assert.rejects(
    f.rpc.request('attempt.start', {
      ...value,
      sourceManifest: sha256('other'),
    }),
  )
  await assert.rejects(
    f.rpc.request('attempt.start', { ...value, dependencies: sha256('other') }),
  )
  await assert.rejects(
    f.rpc.request('attempt.start', {
      ...value,
      resources: { ...value.resources, memoryBytes: 1 },
    }),
  )
  await assert.rejects(
    f.rpc.request('attempt.start', { ...value, operation: 'shell' }),
    { code: 'capability_unavailable' },
  )
  assert.equal(f.calls.length, 0)
})

test('cancellation acknowledges only after the execution promise has stopped', async (t) => {
  let stopped = false
  const f = await fixture(
    t,
    async (_root, _args, options) =>
      new Promise((resolve) => {
        options.signal.addEventListener(
          'abort',
          () => {
            stopped = true
            resolve({ code: 137, stdout: '', stderr: '', cancelled: true })
          },
          { once: true },
        )
      }),
  )
  await f.rpc.request('worker.certify', { toolchain: version })
  const value = f.request()
  await f.rpc.request('attempt.start', value)
  await waitState(f.rpc, value.id, ['running'])
  const result = await f.rpc.request('attempt.cancel', { id: value.id })
  assert.equal(result.stopped, true)
  assert.equal(stopped, true)
  assert.equal(result.state, 'cancelled')
})

test('a newer controller fences the old connection and rejects its late result', async (t) => {
  let finish
  const f = await fixture(
    t,
    async () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await f.rpc.request('worker.certify', { toolchain: version })
  const value = f.request()
  await f.rpc.request('attempt.start', value)
  await waitState(f.rpc, value.id, ['running'])
  const next = connect(f.worker)
  t.after(() => next.close())
  await next.request('hello', { ...f.hello, epoch: 2 })
  await assert.rejects(f.rpc.request('lease.renew', { attempts: [value.id] }), {
    code: 'stale_generation',
  })
  finish({ code: 0, stdout: 'late', stderr: '' })
  assert.equal(
    (await waitState(next, value.id, ['failed', 'lost'])).state,
    'failed',
  )
})

test('expired leases stop offline execution without relying on socket closure', async (t) => {
  const f = await fixture(
    t,
    async (_root, _args, options) =>
      new Promise((resolve) => {
        options.signal.addEventListener(
          'abort',
          () => resolve({ code: 137, stdout: '', stderr: '', cancelled: true }),
          { once: true },
        )
      }),
  )
  await f.rpc.request('worker.certify', { toolchain: version })
  const value = f.request()
  await f.rpc.request('attempt.start', value)
  await waitState(f.rpc, value.id, ['running'])
  f.worker.running.get(value.id).deadline = performance.now() - 1
  assert.equal(
    (await waitState(f.rpc, value.id, ['cancelled'])).state,
    'cancelled',
  )
})

test('certification locks placement while probes are in progress', async (t) => {
  const f = await fixture(t)
  let release
  f.worker.certifier = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const pending = f.rpc.request('worker.certify', { toolchain: version })
  await delay(5)
  assert.equal((await f.rpc.request('status')).status, 'unavailable')
  await assert.rejects(
    f.rpc.request('worker.certify', { toolchain: version }),
    { code: 'worker_busy' },
  )
  release({
    nodeEpoch: f.worker.nodeEpoch,
    bundleDigest: bundle,
    imageDigest: image,
    engineKind: 'docker',
    capabilities: ['check.build'],
  })
  await pending
  assert.equal((await f.rpc.request('status')).status, 'ready')
})
