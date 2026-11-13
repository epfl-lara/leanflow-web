import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { BlobStore } from '../cluster/blobs.mjs'
import {
  ClusterController,
  SSH_BINARY,
  sshArguments,
} from '../cluster/controller.mjs'
import { WorkerNode } from '../cluster/node.mjs'
import { FramedRpc, RpcError } from '../cluster/protocol.mjs'
import { sha256 } from '../cluster/state.mjs'

const GIB = 1024 ** 3
const IMAGE = `sha256:${'a'.repeat(64)}`
const BUNDLE = 'b'.repeat(64)
const LINEAGE = 'leanflow-test'
const VERSION = 'leanprover/lean4:v4.20.0'
const ALL = ['check.build', 'check.kernel', 'lean.file']
const FAST = {
  pollMs: 40,
  eventPollMs: 10,
  renewMs: 40,
  minBackoffMs: 10,
  maxBackoffMs: 80,
}

async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for the cluster.')
    await delay(5)
  }
}

const options = (overrides = {}) => ({
  operation: 'check.build',
  actor: 'alice',
  projectId: 'project-1',
  jobId: 'job-1',
  timeoutMs: 60_000,
  ...overrides,
})

const counts = ({ active, held, queued }) => ({ active, held, queued })

const refuseCancel = ({ method, params, options, request }) =>
  method === 'attempt.cancel'
    ? Promise.reject(
        new RpcError('Worker shutdown could not be confirmed.', {
          code: 'worker_cleanup',
          status: 503,
        }),
      )
    : request(method, params, options)

// Stands in for the container runtime. Each test decides what a run does.
class FakeRuntime {
  toolchains = new Map()
  instance = null
  runs = []
  behavior = async () => ({
    code: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    cancelled: false,
  })

  async init() {
    return this.info()
  }

  info() {
    return {
      ready: true,
      imageId: IMAGE,
      cgroupDriver: 'systemd',
      cgroupVersion: '2',
    }
  }

  run(workspace, args, options) {
    this.runs.push(path.basename(workspace))
    return this.behavior(options, args)
  }

  checkProject(workspace, options) {
    return this.run(workspace, ['check-project'], options)
  }

  async inheritDependencies() {}
  async clearInheritedDependencies() {}
  async shutdown() {}
}

// Each run reports progress, then waits for its gate or for cancellation.
// Cancellation finishes once `stopping` resolves.
function hold(runtime, { stopping = Promise.resolve() } = {}) {
  const gates = []
  runtime.behavior = (options) =>
    new Promise((resolve) => {
      options.onOutput('started\n', 'stdout')
      const finish = (cancelled) =>
        resolve({
          code: cancelled ? 130 : 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled,
        })
      gates.push(() => finish(false))
      options.signal.addEventListener(
        'abort',
        () => stopping.then(() => finish(true)),
        { once: true },
      )
    })
  return gates
}

const certification = (worker, capabilities) => ({
  version: 1,
  nodeId: worker.config.nodeId,
  nodeEpoch: worker.nodeEpoch,
  bundleDigest: worker.bundleDigest,
  imageDigest: IMAGE,
  engineKind: 'docker',
  checkedAt: new Date().toISOString(),
  capabilities,
  checks: {},
  failures: {},
})

async function startWorker(root, spec) {
  const { id, role, bundle = BUNDLE, memoryBudget = '4g' } = spec
  const capabilities = spec.capabilities ?? ALL
  const runtime = new FakeRuntime()
  const worker = new WorkerNode({
    config: {
      version: 1,
      nodeId: id,
      controllerLineage: LINEAGE,
      dataDir: path.join(root, id),
      image: IMAGE,
      role,
      workerMemory: '1g',
      memoryBudget,
      parentMemoryMax: '8g',
      maxCpus: 8,
      parentMaxCpus: 8,
      workerCpus: 1,
      leaseMs: 5000,
    },
    runtime,
    verifyToolchain: async () => {},
    bundleDigest: bundle,
    certifier: async (node) => certification(node, capabilities),
    reap: async () => {},
    boundaryInspector: async () => ({ relative: 'leanflow-workers.slice' }),
    leaseAcquire: async () => ({ release: async () => {} }),
  })
  await worker.init()
  worker.state.setMeta('certification', certification(worker, capabilities))
  return { worker, runtime }
}

async function snapshot(store, files) {
  const file = async (name, text, mode = 0o600) => ({
    path: name,
    type: 'file',
    ...(await store.put(Buffer.from(text))),
    mode,
  })
  const entries = [await file('lean-toolchain', `${VERSION}\n`)]
  for (const [name, text] of Object.entries(files))
    entries.push(await file(name, text))
  const source = await store.seal(entries, 'source')
  const toolchain = await store.seal(
    [
      { path: 'bin', type: 'directory' },
      await file('bin/lean', '#!/bin/sh\n', 0o700),
    ],
    'toolchain',
  )
  return {
    sourceManifest: source.hash,
    toolchain: { version: VERSION, manifest: toolchain.hash },
  }
}

// Real WorkerNode services behind in-memory FramedRpc pairs. The transport
// records every request and lets a test rewrite replies or go offline.
async function cluster(t, settings = {}) {
  const {
    nodes = [{ id: 'node-a' }],
    files = { 'Main.lean': 'theorem demo : True := trivial\n' },
    config: overrides = {},
  } = settings
  const root = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'lfc-')),
  )
  const workers = new Map()
  const controllers = []
  t.after(async () => {
    for (const controller of controllers) await controller.shutdown()
    for (const { worker } of workers.values()) await worker.close()
    await fsp.rm(root, { recursive: true, force: true })
  })
  const local = await new BlobStore(path.join(root, 'local')).init()
  t.after(() => local.close())
  for (const spec of nodes) workers.set(spec.id, await startWorker(root, spec))
  const transport = {
    calls: 0,
    offline: new Set(),
    opened: [],
    requests: [],
    hook: null,
  }
  const transportFactory = (node, channel) => {
    transport.calls++
    if (transport.offline.has(node.id)) throw new Error('worker offline')
    const forward = new PassThrough()
    const backward = new PassThrough()
    workers.get(node.id).worker.attach(forward, backward)
    const rpc = new FramedRpc(backward, forward)
    const request = rpc.request.bind(rpc)
    rpc.request = (method, params, options) => {
      transport.requests.push({ node: node.id, channel, method, params })
      return transport.hook
        ? transport.hook({ node: node.id, method, params, options, request })
        : request(method, params, options)
    }
    transport.opened.push({ node: node.id, channel, rpc })
    return rpc
  }
  const config = {
    version: 1,
    lineage: LINEAGE,
    mode: 'serve',
    nodes: nodes.map(({ id, role }) => ({
      id,
      role,
      host: 'worker.test',
      user: 'leanflow',
      identityFile: '/etc/leanflow/id_ed25519',
      knownHostsFile: '/etc/leanflow/known_hosts',
    })),
    ...overrides,
  }
  const make = () => {
    const controller = new ClusterController({
      config,
      dataDir: path.join(root, 'controller'),
      blobs: local,
      bundleDigest: BUNDLE,
      imageDigest: IMAGE,
      transportFactory,
      timing: FAST,
    })
    controllers.push(controller)
    return controller
  }
  const controller = make()
  await controller.init()
  const input = await snapshot(local, files)
  const ready = (count = nodes.length) =>
    until(() => controller.status().ready === count)
  return {
    root,
    workers,
    transport,
    controller,
    make,
    input,
    ready,
    blobs: local,
  }
}

test('queued input validation is bounded and cannot reorder an account behind a faster read', async (t) => {
  const { controller, workers, input, ready, blobs } = await cluster(t, {
    nodes: [{ id: 'node-a', memoryBudget: '1g' }],
    config: { maxQueue: 2 },
  })
  const { worker, runtime } = workers.get('node-a'),
    gates = hold(runtime)
  await ready()
  const first = controller.run(input, options({ jobId: 'first' }))
  await until(() => runtime.runs.length === 1)
  const source = await blobs.manifest(input.sourceManifest)
  const pin = source.entries.find(
    (entry) => entry.path === 'lean-toolchain',
  ).hash
  const gate = Promise.withResolvers(),
    read = blobs.read.bind(blobs)
  let pinReads = 0,
    laterRead = false
  blobs.read = async (hash, ...args) => {
    if (hash === pin) {
      if (++pinReads === 1) await gate.promise
      else laterRead = true
    }
    return read(hash, ...args)
  }
  const second = controller.run(input, options({ jobId: 'second' }))
  const third = controller.run(input, options({ jobId: 'third' }))
  assert.equal(controller.status().queued, 2)
  await assert.rejects(
    controller.run(input, options({ actor: 'bob', jobId: 'overflow' })),
    { code: 'cluster_queue_full' },
  )
  await until(() => laterRead)
  gates[0]()
  await first
  assert.equal(runtime.runs.length, 1)
  gate.resolve()
  await until(() => runtime.runs.length === 2)
  gates[1]()
  await second
  await until(() => runtime.runs.length === 3)
  gates[2]()
  await third
  assert.deepEqual(
    runtime.runs.map((id) => worker.state.get(id).jobId),
    ['first', 'second', 'third'],
  )
})

const closeChannel = (transport, node, channel) => {
  for (const entry of transport.opened)
    if (entry.node === node && entry.channel === channel)
      entry.rpc.close(new Error('link down'))
}

test('a delayed start cannot run after an unseen attempt was cancelled and its grant released', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  await ready()
  let rejectStart, deliverLate
  transport.hook = ({ method, params, options, request }) => {
    if (method !== 'attempt.start') return request(method, params, options)
    deliverLate = () => request(method, params, options)
    return new Promise((_resolve, reject) => {
      rejectStart = () => reject(new RpcError('timeout', { code: 'timeout' }))
    })
  }
  const abort = new AbortController()
  const run = controller.run(input, options({ signal: abort.signal }))
  const stopped = assert.rejects(run, /requested stop/)
  await until(() => !!rejectStart)
  abort.abort(new Error('requested stop'))
  rejectStart()
  await stopped
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
  await assert.rejects(deliverLate(), { code: 'attempt_cancelled' })
  assert.equal(workers.get('node-a').runtime.runs.length, 0)
})

test('a check runs remotely and each output event reaches the caller once, in order', async (t) => {
  const { controller, workers, transport, input, ready, root } =
    await cluster(t)
  const lines = Array.from({ length: 40 }, (_, index) => [
    `line ${index}\n`,
    index % 3 ? 'stdout' : 'stderr',
  ])
  workers.get('node-a').runtime.behavior = async (options) => {
    for (const [text, stream] of lines) options.onOutput(text, stream)
    return {
      code: 0,
      stdout: 'built',
      stderr: '',
      timedOut: false,
      cancelled: false,
    }
  }
  // Rewinding the cursor makes the worker resend events already recorded.
  transport.hook = ({ method, params, options, request }) =>
    request(
      method,
      method === 'attempt.get'
        ? { ...params, after: Math.max(0, params.after - 5) }
        : params,
      options,
    )
  await ready()
  const output = []
  const result = await controller.run(
    input,
    options({ onOutput: (text, stream) => output.push([text, stream]) }),
  )
  assert.deepEqual(result, {
    code: 0,
    stdout: 'built',
    stderr: '',
    timedOut: false,
    cancelled: false,
    truncated: false,
  })
  // Stream boundaries may be coalesced, but byte order and stream identity
  // must survive replay without duplication.
  const coalesce = (entries) =>
    entries.reduce((out, [text, stream]) => {
      if (out.at(-1)?.[1] === stream) out.at(-1)[0] += text
      else out.push([text, stream])
      return out
    }, [])
  assert.deepEqual(coalesce(output), coalesce(lines))
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
  for (const channel of ['control', 'bulk']) {
    const first = transport.requests.find((entry) => entry.channel === channel)
    assert.equal(first.method, 'hello')
    assert.deepEqual(first.params, {
      version: 2,
      lineage: LINEAGE,
      epoch: 1,
      bundleDigest: BUNDLE,
      imageDigest: IMAGE,
    })
  }
  for (const { method, channel } of transport.requests) {
    if (method.startsWith('objects.') || method === 'assets.prepare')
      assert.equal(channel, 'bulk')
    if (method.startsWith('attempt.') || method === 'lease.renew')
      assert.equal(channel, 'control')
  }
  await controller.shutdown()
  const db = new DatabaseSync(
    path.join(root, 'controller/cluster-controller.sqlite'),
  )
  try {
    const attempts = db.prepare('SELECT state FROM cluster_attempts').all()
    assert.deepEqual(
      attempts.map((row) => row.state),
      ['completed'],
    )
    const events = db.prepare('SELECT COUNT(*) AS count FROM cluster_events')
    assert.equal(events.get().count, 0)
  } finally {
    db.close()
  }
})

test('a completed attempt that fails its fence is rejected without a fallback', async (t) => {
  const { controller, transport, input, ready } = await cluster(t)
  await ready()
  for (const [field, value] of [
    ['nodeEpoch', 'another-process'],
    ['epoch', 99],
    ['inputDigest', 'c'.repeat(64)],
  ]) {
    transport.hook = async ({ method, params, options, request }) => {
      const reply = await request(method, params, options)
      return method === 'attempt.get' && reply.attempt.state === 'completed'
        ? { ...reply, attempt: { ...reply.attempt, [field]: value } }
        : reply
    }
    await assert.rejects(
      controller.run(input, options({ jobId: `fence-${field}` })),
      { code: 'invalid_result' },
    )
  }
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('a lost control channel keeps the grant until the worker confirms the attempt stopped', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t, {
    nodes: [{ id: 'node-a', memoryBudget: '1g' }],
  })
  const { worker, runtime } = workers.get('node-a')
  const gates = hold(runtime)
  await ready()
  const running = controller.run(input, options())
  await until(() => runtime.runs.length === 1)
  transport.offline.add('node-a')
  closeChannel(transport, 'node-a', 'control')
  await assert.rejects(running, (error) => {
    assert.equal(error.code, 'worker_cleanup')
    assert.equal(error.workerCleanup, true)
    assert.doesNotMatch(error.message, /link|offline|worker\.test|ssh/i)
    return true
  })
  assert.equal(controller.status().held, 1)
  assert.equal(
    await controller.run(input, options({ jobId: 'job-2' })),
    null,
    'an unassigned check may still run locally',
  )

  const cancel = Promise.withResolvers()
  transport.hook = async ({ method, params, options, request }) => {
    if (method === 'attempt.cancel') await cancel.promise
    return request(method, params, options)
  }
  transport.offline.delete('node-a')
  await ready()
  const queued = controller.run(
    input,
    options({ actor: 'bob', jobId: 'job-3' }),
  )
  await until(() => controller.status().queued === 1)
  assert.equal(controller.status().held, 1)
  assert.equal(runtime.runs.length, 1)
  cancel.resolve()
  await until(() => controller.status().held === 0)
  assert.equal(worker.state.list()[0].state, 'cancelled')
  await until(() => runtime.runs.length === 2)
  gates[1]()
  assert.equal((await queued).code, 0)
})

test('cancelling a running check waits for the worker to confirm it stopped', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  const { worker, runtime } = workers.get('node-a')
  const stopping = Promise.withResolvers()
  hold(runtime, { stopping: stopping.promise })
  await ready()
  const abort = new AbortController()
  let settled = false
  const running = controller.run(input, options({ signal: abort.signal }))
  running.then(
    () => (settled = true),
    () => (settled = true),
  )
  await until(() => runtime.runs.length === 1)
  const reason = new Error('Stopped by the user.')
  abort.abort(reason)
  await until(() =>
    transport.requests.some((entry) => entry.method === 'attempt.cancel'),
  )
  await delay(100)
  assert.equal(settled, false)
  assert.equal(controller.status().active, 1)
  stopping.resolve()
  await assert.rejects(running, (error) => error === reason)
  assert.equal(worker.state.list()[0].state, 'cancelled')
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('an unconfirmed cancellation keeps capacity reserved and takes the worker out of service', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  const { worker, runtime } = workers.get('node-a')
  hold(runtime)
  await ready()
  const abort = new AbortController()
  const running = controller.run(input, options({ signal: abort.signal }))
  await until(() => runtime.runs.length === 1)
  transport.hook = refuseCancel
  abort.abort(new Error('Stopped by the user.'))
  await assert.rejects(running, { code: 'worker_cleanup', workerCleanup: true })
  const status = controller.status()
  assert.equal(status.held, 1)
  assert.equal(status.workers[0].state, 'unavailable')
  assert.equal(await controller.run(input, options({ jobId: 'job-2' })), null)
  transport.hook = null
  await until(() => controller.status().held === 0)
  await ready()
  assert.equal(worker.state.list()[0].state, 'cancelled')
})

test('queued checks rotate between accounts within the queue and account caps', async (t) => {
  const { controller, workers, input, ready } = await cluster(t, {
    nodes: [{ id: 'node-a', memoryBudget: '1g' }],
    config: { maxQueue: 5, maxPerActor: 3 },
  })
  const { worker, runtime } = workers.get('node-a')
  const gates = hold(runtime)
  await ready()
  const runs = new Map()
  const submit = (actor, jobId, extra = {}) =>
    runs.set(jobId, controller.run(input, options({ actor, jobId, ...extra })))
  submit('alice', 'a1')
  await until(() => runtime.runs.length === 1)
  submit('alice', 'a2')
  submit('alice', 'a3')
  await until(() => controller.status().queued === 2)
  await assert.rejects(
    controller.run(input, options({ actor: 'alice', jobId: 'a4' })),
    { code: 'cluster_actor_limit', status: 429 },
  )
  const abort = new AbortController()
  submit('bob', 'b1')
  submit('bob', 'b2', { signal: abort.signal })
  submit('carol', 'c1')
  await until(() => controller.status().queued === 5)
  await assert.rejects(
    controller.run(input, options({ actor: 'dave', jobId: 'd1' })),
    { code: 'cluster_queue_full', status: 429 },
  )
  const reason = new Error('No longer needed.')
  abort.abort(reason)
  await assert.rejects(runs.get('b2'), (error) => error === reason)
  assert.equal(controller.status().queued, 4)
  for (let index = 0; index < 5; index++) {
    await until(() => runtime.runs.length === index + 1)
    gates[index]()
  }
  const finished = ['a1', 'a2', 'a3', 'b1', 'c1'].map((id) => runs.get(id))
  for (const result of await Promise.all(finished)) assert.equal(result.code, 0)
  assert.deepEqual(
    runtime.runs.map((id) => worker.state.get(id).jobId),
    ['a1', 'b1', 'c1', 'a2', 'a3'],
  )
})

test('a lost start reply retries the same attempt on the same worker process', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  let replies = 0
  transport.hook = async ({ method, params, options, request }) => {
    const reply = await request(method, params, options)
    if (method === 'attempt.start' && replies++ === 0)
      throw new RpcError('No reply arrived.', { code: 'timeout', status: 504 })
    return reply
  }
  await ready()
  assert.equal((await controller.run(input, options())).code, 0)
  const starts = transport.requests.filter(
    (entry) => entry.method === 'attempt.start',
  )
  assert.equal(starts.length, 2)
  assert.deepEqual(starts[0].params, starts[1].params)
  assert.equal(workers.get('node-a').worker.state.list().length, 1)
})

test('a busy refusal requeues the check as a new attempt', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  let refused = false
  transport.hook = ({ method, params, options, request }) => {
    if (method !== 'attempt.start' || refused)
      return request(method, params, options)
    refused = true
    return Promise.reject(
      new RpcError('Worker resource budget is busy.', {
        code: 'worker_busy',
        status: 429,
      }),
    )
  }
  await ready()
  assert.equal((await controller.run(input, options())).code, 0)
  const starts = transport.requests.filter(
    (entry) => entry.method === 'attempt.start',
  )
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].params.id, starts[1].params.id)
  assert.equal(workers.get('node-a').worker.state.list().length, 1)
})

test('mode off and reserve workers make no connections unless reserve use is explicit', async (t) => {
  const off = await cluster(t, { config: { mode: 'off' } })
  assert.equal(await off.controller.run(off.input, options()), null)
  await assert.rejects(off.controller.prepareNode('node-a', off.input), {
    code: 'cluster_off',
  })
  assert.equal(off.controller.status().mode, 'off')
  assert.equal(off.transport.calls, 0)

  const spare = [{ id: 'spare', role: 'reserve' }]
  const reserve = await cluster(t, { nodes: spare })
  await delay(100)
  assert.equal(await reserve.controller.run(reserve.input, options()), null)
  await assert.rejects(reserve.controller.prepareNode('spare', reserve.input), {
    code: 'node_unavailable',
  })
  assert.equal(reserve.transport.calls, 0)
  assert.equal(reserve.controller.status().workers.length, 0)

  const allowed = await cluster(t, {
    nodes: spare,
    config: { allowReserve: true },
  })
  await allowed.ready()
  const result = await allowed.controller.run(allowed.input, options())
  assert.equal(result.code, 0)
})

test('uploads resume from the worker offset in bulk-channel chunks', async (t) => {
  const content = Buffer.from('x'.repeat(600 * 1024))
  const { controller, workers, transport, input, ready } = await cluster(t, {
    files: { 'Big.lean': content.toString() },
  })
  const { worker } = workers.get('node-a')
  const hash = sha256(content)
  await worker.blobs.writeChunk({
    hash,
    offset: 0,
    data: content.subarray(0, 256 * 1024).toString('base64'),
    totalBytes: content.length,
    final: false,
  })
  await ready()
  assert.equal((await controller.run(input, options())).code, 0)
  const puts = transport.requests.filter(
    (entry) => entry.method === 'objects.put' && entry.params.hash === hash,
  )
  assert.deepEqual(
    puts.map(({ channel, params }) => [channel, params.offset, params.final]),
    [
      ['bulk', 256 * 1024, false],
      ['bulk', 512 * 1024, true],
    ],
  )
  assert.deepEqual(await worker.blobs.has([hash]), [hash])
})

test('concurrent checks share an input upload even when one waiting check is cancelled', async (t) => {
  const content = 'x'.repeat(600 * 1024),
    hash = sha256(content)
  const { controller, workers, transport, input, ready } = await cluster(t, {
    files: { 'Big.lean': content },
  })
  await ready()
  const gate = Promise.withResolvers()
  let paused = false
  transport.hook = async ({ method, params, options, request }) => {
    if (
      method === 'objects.put' &&
      params.hash === hash &&
      params.offset === 0
    ) {
      paused = true
      await gate.promise
    }
    return request(method, params, options)
  }
  const abort = new AbortController()
  const first = controller.run(input, options({ signal: abort.signal }))
  const stopped = assert.rejects(first, /upload cancelled/)
  await until(() => paused)
  const second = controller.run(
    input,
    options({ actor: 'bob', jobId: 'job-2' }),
  )
  await until(() => controller.status().active === 2)
  abort.abort(new Error('upload cancelled'))
  await stopped
  gate.resolve()
  assert.equal((await second).code, 0)
  assert.equal(workers.get('node-a').runtime.runs.length, 1)
  const chunks = transport.requests.filter(
    (r) => r.method === 'objects.put' && r.params.hash === hash,
  )
  assert.deepEqual(
    chunks.map((r) => r.params.offset),
    [0, 256 * 1024, 512 * 1024],
  )
})

test('native checks wait for the previous native check while ordinary work can fill remaining capacity', async (t) => {
  const { controller, workers, input, ready } = await cluster(t, {
    nodes: [{ id: 'node-a', memoryBudget: '8g' }],
  })
  const { runtime } = workers.get('node-a'),
    gates = hold(runtime)
  await ready()
  const first = controller.run(
    input,
    options({ operation: 'check.kernel', jobId: 'kernel-1' }),
  )
  await until(() => runtime.runs.length === 1)
  const next = controller.run(
    input,
    options({ operation: 'check.kernel', actor: 'bob', jobId: 'kernel-2' }),
  )
  const ordinary = controller.run(
    input,
    options({ actor: 'carol', jobId: 'ordinary' }),
  )
  await until(
    () => runtime.runs.length === 2 && controller.status().queued === 1,
  )
  gates[1]()
  assert.equal((await ordinary).code, 0)
  assert.equal(runtime.runs.length, 2)
  gates[0]()
  await first
  await until(() => runtime.runs.length === 3)
  gates[2]()
  assert.equal((await next).code, 0)
})

test('a wrong upload acknowledgement fails the check before it starts', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  transport.hook = async ({ method, params, options, request }) => {
    const reply = await request(method, params, options)
    return method === 'objects.put'
      ? { ...reply, offset: reply.offset + 1 }
      : reply
  }
  await ready()
  await assert.rejects(controller.run(input, options()), {
    code: 'worker_upload_failed',
  })
  assert.equal(workers.get('node-a').runtime.runs.length, 0)
  assert.ok(
    !transport.requests.some((entry) => entry.method === 'attempt.start'),
  )
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('a worker with another release or image is never used', async (t) => {
  const other = await cluster(t, {
    nodes: [{ id: 'node-a', bundle: 'c'.repeat(64) }],
  })
  await until(
    () => other.controller.status().workers[0].error === 'release_mismatch',
  )
  assert.equal(other.controller.status().ready, 0)
  assert.equal(await other.controller.run(other.input, options()), null)
  assert.ok(other.transport.requests.every((entry) => entry.method === 'hello'))

  const image = await cluster(t)
  image.transport.hook = async ({ method, params, options, request }) => {
    const reply = await request(method, params, options)
    return method === 'hello'
      ? { ...reply, imageDigest: `sha256:${'d'.repeat(64)}` }
      : reply
  }
  image.transport.opened.forEach(({ rpc }) => rpc.close(new Error('reset')))
  await until(
    () => image.controller.status().workers[0].error === 'release_mismatch',
  )
  assert.equal(await image.controller.run(image.input, options()), null)
})

test('losing the bulk channel keeps leases and cancellation on the control channel', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  const { worker, runtime } = workers.get('node-a')
  const gates = hold(runtime)
  await ready()
  const abort = new AbortController()
  const running = controller.run(input, options({ signal: abort.signal }))
  await until(() => runtime.runs.length === 1)
  closeChannel(transport, 'node-a', 'bulk')
  const renewals = () =>
    transport.requests.filter((entry) => entry.method === 'lease.renew').length
  const before = renewals()
  await until(() => renewals() >= before + 3)
  assert.equal(controller.status().ready, 1)
  const reason = new Error('Stopped by the user.')
  abort.abort(reason)
  await assert.rejects(running, (error) => error === reason)
  assert.equal(worker.state.list()[0].state, 'cancelled')
  for (const { method, channel } of transport.requests)
    if (['lease.renew', 'attempt.get', 'attempt.cancel'].includes(method))
      assert.equal(channel, 'control')

  const next = controller.run(input, options({ jobId: 'job-2' }))
  await until(() => runtime.runs.length === 2)
  gates[1]()
  assert.equal((await next).code, 0)
  const bulk = transport.opened.filter((entry) => entry.channel === 'bulk')
  assert.equal(bulk.length, 2)
})

test('worker results are validated and only documented fields are returned', async (t) => {
  const { controller, workers, input, ready } = await cluster(t)
  const { runtime } = workers.get('node-a')
  await ready()
  runtime.behavior = async () =>
    JSON.parse(
      '{"__proto__":{"polluted":true},"code":0,"stdout":"ok","stderr":"","extra":"ignored"}',
    )
  const result = await controller.run(input, options())
  assert.deepEqual(result, {
    code: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    cancelled: false,
    truncated: false,
  })
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(result.polluted, undefined)
  const malformed = [
    [1, 2],
    { code: '0', stdout: '', stderr: '' },
    { code: null, stdout: '', stderr: '' },
    { code: 0, stdout: 1, stderr: '' },
    { code: 0, stdout: '', stderr: '', timedOut: 'no' },
  ]
  for (const [index, value] of malformed.entries()) {
    runtime.behavior = async () => value
    await assert.rejects(
      controller.run(input, options({ jobId: `bad-${index}` })),
      { code: 'invalid_result' },
    )
  }
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('kernel checks reserve three slots and never fall back to a weaker check', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t, {
    nodes: [
      { id: 'node-a', capabilities: ['check.build', 'lean.file'] },
      { id: 'node-b', memoryBudget: '2g' },
      { id: 'node-c' },
    ],
  })
  await ready(3)
  const kernel = await controller.run(
    input,
    options({ operation: 'check.kernel' }),
  )
  assert.equal(kernel.code, 0)
  const [attempt] = workers.get('node-c').worker.state.list()
  assert.equal(attempt.operation, 'check.kernel')
  assert.deepEqual(attempt.resources, {
    memoryBytes: 3 * GIB,
    cpus: 3,
    scratchBytes: 16 * GIB,
  })
  for (const id of ['node-a', 'node-b'])
    assert.deepEqual(workers.get(id).worker.state.list(), [])

  transport.offline.add('node-c')
  closeChannel(transport, 'node-c', 'control')
  await ready(2)
  assert.equal(
    await controller.run(
      input,
      options({ operation: 'check.kernel', jobId: 'job-2' }),
    ),
    null,
  )
  const file = await controller.run(
    input,
    options({ operation: 'lean.file', file: 'Main.lean', jobId: 'job-3' }),
  )
  assert.equal(file.code, 0)
})

test('one controller owns the database and each start advances its generation', async (t) => {
  const { controller, make, ready } = await cluster(t)
  assert.equal(controller.status().epoch, 1)
  const rival = make()
  await assert.rejects(rival.init(), { code: 'controller_locked' })
  await ready()
  await controller.shutdown()
  const next = make()
  await next.init()
  assert.equal(next.status().epoch, 2)
  await until(() => next.status().ready === 1)
})

test('shutdown resolves queued checks and leaves unconfirmed attempts to the next controller', async (t) => {
  const { controller, workers, transport, input, make, ready } = await cluster(
    t,
    { nodes: [{ id: 'node-a', memoryBudget: '1g' }] },
  )
  const { worker, runtime } = workers.get('node-a')
  hold(runtime)
  await ready()
  const active = controller.run(input, options())
  const interrupted = assert.rejects(active, {
    code: 'worker_cleanup',
    workerCleanup: true,
  })
  await until(() => runtime.runs.length === 1)
  const queued = controller.run(
    input,
    options({ actor: 'bob', jobId: 'job-2' }),
  )
  await until(() => controller.status().queued === 1)
  transport.hook = refuseCancel
  const summary = await controller.shutdown()
  assert.equal(await queued, null)
  await interrupted
  assert.deepEqual(summary, { cancelled: 1, unresolved: 1 })
  assert.equal(await controller.run(input, options({ jobId: 'job-3' })), null)

  transport.hook = null
  transport.offline.add('node-a')
  const next = make()
  await next.init()
  assert.equal(next.status().held, 1)
  transport.offline.delete('node-a')
  await until(() => next.status().held === 0 && next.status().ready === 1)
  assert.equal(worker.state.list()[0].state, 'cancelled')
})

test('shutdown rejects active checks only after the worker confirms they stopped', async (t) => {
  const { controller, workers, input, ready } = await cluster(t)
  const { worker, runtime } = workers.get('node-a')
  hold(runtime)
  await ready()
  const active = controller.run(input, options())
  await until(() => runtime.runs.length === 1)
  assert.deepEqual(await controller.shutdown(), {
    cancelled: 1,
    unresolved: 0,
  })
  await assert.rejects(active, { code: 'cluster_stopping' })
  assert.equal(worker.state.list()[0].state, 'cancelled')
})

test('worker SSH uses fixed options and only the protocol commands', () => {
  const node = {
    id: 'node-a',
    host: 'worker.example',
    user: 'leanflow',
    port: 2222,
    identityFile: '/etc/leanflow/.ssh/id_ed25519',
    knownHostsFile: '/etc/leanflow/known_hosts',
    sshOptions: ['-oProxyCommand=sh'],
    command: 'sh',
  }
  assert.equal(SSH_BINARY, '/usr/bin/ssh')
  const args = sshArguments(node)
  assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null'])
  assert.deepEqual(args.slice(-8), [
    '-p',
    '2222',
    '-l',
    'leanflow',
    '-T',
    '--',
    'worker.example',
    'leanflow-node-control',
  ])
  assert.equal(sshArguments(node, 'bulk').at(-1), 'leanflow-node-bulk')
  for (const option of [
    'StrictHostKeyChecking=yes',
    'UserKnownHostsFile=/etc/leanflow/known_hosts',
    'IdentitiesOnly=yes',
    'IdentityAgent=none',
    'IdentityFile=/etc/leanflow/.ssh/id_ed25519',
    'BatchMode=yes',
    'RequestTTY=no',
    'ClearAllForwardings=yes',
  ])
    assert.ok(args.includes(option), option)
  assert.ok(!args.includes('sh'))
  assert.ok(!args.some((arg) => arg.includes('ProxyCommand=sh')))
  assert.throws(() => sshArguments(node, 'shell'))
  for (const change of [
    { knownHostsFile: '/etc/known hosts' },
    { identityFile: '/etc/%d/id' },
    { identityFile: '/etc/leanflow/../id' },
    { host: '-oProxyCommand=sh' },
    { user: 'root;sh' },
  ])
    assert.throws(() => sshArguments({ ...node, ...change }))
})
