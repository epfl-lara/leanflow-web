import test from 'node:test'
import assert from 'node:assert/strict'
import { ClusterChecks } from '../cluster/checks.mjs'

const result = { code: 0, stdout: 'verified', stderr: '' }

test('service-owned editor warm-up keeps admission local and does not delay local opens', async () => {
  const gate = Promise.withResolvers()
  let observedEnvironment,
    signal,
    captures = 0
  const checks = new ClusterChecks({
    mode: 'serve',
    controller: {
      status: () => ({ editors: { placement: 'prefer' } }),
      editorCapacity: (environment) => {
        observedEnvironment = environment
        return 6
      },
      shutdown: async () => ({ unresolved: 0 }),
    },
    inputs: {
      prepareEditorAssets: async (options) => {
        captures++
        signal = options.signal
        return gate.promise
      },
    },
  })
  checks.startEditorWarmup()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(checks.editorCapacity(), 0)
  let local = 0
  const child = new (await import('node:events')).EventEmitter()
  child.kill = () => child.emit('close')
  assert.equal(
    checks.openEditor({ project: { kind: 'single-file' } }, () => {
      local++
      return child
    }),
    child,
  )
  assert.equal(local, 1)
  assert.equal(captures, 1)
  assert.equal(signal.aborted, false)
  const environment = {
    toolchain: {
      version: 'leanprover/lean4:v4.35.0',
      manifest: 'a'.repeat(64),
    },
    dependencies: 'b'.repeat(64),
  }
  gate.resolve(environment)
  await checks.editorWarmup.task
  assert.equal(checks.editorCapacity(), 6)
  assert.deepEqual(observedEnvironment, environment)
  assert.deepEqual(checks.audit.at(-1).toolchain, environment.toolchain)
  assert.equal(checks.audit.at(-1).dependencies, environment.dependencies)
  await checks.close()
  assert.equal(signal.aborted, true)
})
function fixture(mode, run = async () => result) {
  const calls = []
  let captures = 0,
    localCalls = 0
  const controller = {
    async run(input, options) {
      calls.push({ input, options })
      return run(input, options)
    },
  }
  const input = {
    sourceManifest: 'frozen-source',
    toolchain: { version: 'pin', manifest: 'frozen-environment' },
  }
  const inputs = {
    async capture() {
      captures++
      return input
    },
  }
  const executor = new ClusterChecks({ controller, inputs, mode })
  const context = {
    project: { id: 'project', root: '/coordinator/source' },
    owner: 'alice',
    jobId: 'job',
    file: 'Main.lean',
    kernelCheck: true,
    fingerprint: 'canonical',
    options: {
      timeoutMs: 60000,
      signal: new AbortController().signal,
      onOutput: () => {},
    },
  }
  const local = async () => {
    localCalls++
    return { ...result, stdout: 'local' }
  }
  return {
    executor,
    controller,
    inputs,
    input,
    context,
    calls,
    local,
    counts: () => ({ captures, localCalls }),
  }
}

test('snapshot work is bounded before capture and a cancelled queued capture starts no process', async () => {
  const f = fixture('serve')
  f.executor.maxCaptures = 1
  f.executor.maxQueue = 2
  f.executor.maxPerActor = 1
  let release,
    captures = 0
  f.inputs.capture = () => {
    captures++
    return new Promise((resolve) => {
      release = () => resolve(f.input)
    })
  }
  const first = f.executor.execute(f.context, f.local)
  await new Promise((resolve) => setImmediate(resolve))
  const abort = new AbortController()
  const second = f.executor.execute(
    {
      ...f.context,
      owner: 'bob',
      options: { ...f.context.options, signal: abort.signal },
    },
    f.local,
  )
  const cancelled = assert.rejects(second, /queued stop/)
  await assert.rejects(
    f.executor.execute({ ...f.context, owner: 'carol' }, f.local),
    { status: 429 },
  )
  await assert.rejects(f.executor.execute(f.context, f.local), { status: 429 })
  abort.abort(new Error('queued stop'))
  await cancelled
  assert.equal(captures, 1)
  release()
  assert.equal((await first).code, 0)
  assert.equal(f.executor.admitted, 0)
})

test('off and unavailable classes retain the existing local path without making a snapshot', async () => {
  for (const mode of ['off', 'serve']) {
    const f = fixture(mode)
    f.controller.canRun = () => false
    assert.equal((await f.executor.execute(f.context, f.local)).stdout, 'local')
    assert.deepEqual(f.counts(), { captures: 0, localCalls: 1 })
    assert.equal(f.calls.length, 0)
  }
})

test('the exact kernel method and selected file share one frozen remote attempt', async () => {
  const f = fixture('serve')
  assert.equal(await f.executor.execute(f.context, f.local), result)
  assert.equal(f.calls[0].options.operation, 'check.kernel')
  assert.equal(f.calls[0].options.file, 'Main.lean')
  assert.equal(f.calls[0].input, f.input)
  assert.deepEqual(f.counts(), { captures: 1, localCalls: 0 })
})

test('local fallback is available only before assignment and never masks uncertain cleanup', async () => {
  const unavailable = fixture('serve', async () => null)
  assert.equal(
    (await unavailable.executor.execute(unavailable.context, unavailable.local))
      .stdout,
    'local',
  )
  const failure = Object.assign(new Error('Cleanup could not be confirmed.'), {
    workerCleanup: true,
  })
  const uncertain = fixture('serve', async () => {
    throw failure
  })
  await assert.rejects(
    uncertain.executor.execute(uncertain.context, uncertain.local),
    { workerCleanup: true },
  )
  assert.equal(uncertain.counts().localCalls, 0)
})

test('a change during capture keeps project checks anchored and permits a fresh local selected-file check', async () => {
  const f = fixture('serve')
  f.inputs.capture = async () => {
    throw Object.assign(new Error('Changed'), { code: 'source_changed' })
  }
  await assert.rejects(f.executor.execute(f.context, f.local), {
    code: 'source_changed',
  })
  assert.equal(f.counts().localCalls, 0)
  assert.equal(
    (await f.executor.execute({ ...f.context, fileOnly: true }, f.local))
      .stdout,
    'local',
  )
  assert.equal(
    f.calls.length,
    0,
    'no remote check began before the new local snapshot',
  )
  const cancellation = new AbortController()
  cancellation.abort(new Error('Stopped'))
  f.context.options.signal = cancellation.signal
  await assert.rejects(f.executor.execute(f.context, f.local), /Stopped/)
})

test('shadow checks keep local output authoritative and retain bounded comparison evidence', async () => {
  const f = fixture('shadow')
  const local = await f.executor.execute(f.context, f.local)
  assert.equal(local.stdout, 'local')
  await f.executor.settleShadows()
  assert.notEqual(f.calls[0].options.onOutput, f.context.options.onOutput)
  assert.equal(f.executor.audit.at(-1).matched, true)
  const g = fixture('shadow', async () => ({ ...result, code: 1 }))
  assert.equal((await g.executor.execute(g.context, g.local)).code, 0)
  await g.executor.settleShadows()
  assert.equal(g.executor.audit.at(-1).matched, false)
})

test('a slow shadow worker never delays the authoritative local check', async () => {
  const gate = Promise.withResolvers()
  const f = fixture('shadow', () => gate.promise)
  assert.equal((await f.executor.execute(f.context, f.local)).stdout, 'local')
  assert.equal(f.executor.background.size, 1)
  assert.equal(f.executor.audit.length, 0)
  gate.resolve(result)
  await f.executor.settleShadows()
  assert.equal(f.executor.audit.at(-1).matched, true)
  assert.equal(f.executor.admitted, 0)
})

test('remote dependency errors quarantine only their frozen input and never run a local retry', async () => {
  const remote = {
    code: 1,
    stdout: '',
    stderr:
      "error: object file '.lake/packages/mathlib/Mathlib.olean' does not exist",
  }
  const f = fixture('serve', async () => remote)
  const quarantined = []
  f.controller.quarantineResult = (value) => quarantined.push(value)
  await assert.rejects(f.executor.execute(f.context, f.local), {
    code: 'worker_environment',
  })
  assert.deepEqual(quarantined, [remote])
  assert.equal(f.executor.isRemoteResult(remote), true)
  assert.equal(f.counts().localCalls, 0)
  const success = fixture('serve', async () => ({ ...remote, code: 0 }))
  assert.equal(
    (await success.executor.execute(success.context, success.local)).code,
    0,
  )
})

test('a pending editor warm-up never holds a request capture slot', async () => {
  const gate = Promise.withResolvers()
  const f = fixture('serve')
  f.executor.maxCaptures = 1
  f.controller.status = () => ({ editors: { placement: 'prefer' } })
  f.inputs.prepareEditorAssets = () => gate.promise
  f.executor.startEditorWarmup()
  // Immutable captures wait in the inputs' service-owned lane, so this check's
  // source snapshot uses the only slot while warm-up is still pending.
  assert.equal(await f.executor.execute(f.context, f.local), result)
  assert.deepEqual(f.counts(), { captures: 1, localCalls: 0 })
  assert.equal(f.executor.editorWarmup.state, 'warming')
  const closing = f.executor.close()
  gate.resolve(null)
  await closing
})

test('closing stops and drains shared asset captures before their store closes', async () => {
  const f = fixture('serve')
  const order = []
  const drained = Promise.withResolvers()
  f.inputs.close = async () => {
    order.push('assets-stopping')
    await drained.promise
    order.push('assets-drained')
  }
  f.inputs.blobs = { close: () => order.push('store-closed') }
  const closing = f.executor.close()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['assets-stopping'])
  drained.resolve()
  await closing
  assert.deepEqual(order, ['assets-stopping', 'assets-drained', 'store-closed'])
})

test('25 checks share a frozen source capture across two files, each keeping its own execution and identity', async () => {
  const f = fixture('serve')
  const { promise, resolve } = Promise.withResolvers()
  let captures = 0
  f.inputs.capture = async (_root, options) => {
    assert.equal(options.fingerprint, 'a'.repeat(64))
    captures++
    await promise
    return f.input
  }
  const jobs = Array.from({ length: 25 }, (_, i) =>
    f.executor.execute(
      {
        ...f.context,
        fingerprint: 'a'.repeat(64),
        owner: 'participant' + i,
        jobId: 'check' + i,
        file: i % 2 ? 'Main.lean' : 'Main/Facts.lean',
      },
      f.local,
    ),
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(captures, 1)
  resolve()
  await Promise.all(jobs)
  assert.equal(new Set(f.calls.map((c) => c.options.jobId)).size, 25)
  assert.equal(new Set(f.calls.map((c) => c.options.actor)).size, 25)
  assert.equal(new Set(f.calls.map((c) => c.options.file)).size, 2)
  await f.executor.execute(
    { ...f.context, fingerprint: 'a'.repeat(64) },
    f.local,
  )
  assert.equal(captures, 2, 'later jobs prepare a fresh immutable source')
})

test('source captures are isolated by project and fingerprint and the last cancellation stops the shared read', async () => {
  const f = fixture('serve')
  const captureSignals = []
  f.inputs.capture = async (_root, { signal }) => {
    captureSignals.push(signal)
    return await new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    )
  }
  const aborts = Array.from({ length: 4 }, () => new AbortController())
  f.executor.maxCaptures = 4
  const jobs = aborts.map((abort, i) =>
    f.executor.execute(
      {
        ...f.context,
        owner: 'reader' + i,
        jobId: 'shared' + i,
        project:
          i === 3 ? { ...f.context.project, id: 'another' } : f.context.project,
        fingerprint: (i === 2 ? 'b' : 'a').repeat(64),
        options: { ...f.context.options, signal: abort.signal },
      },
      f.local,
    ),
  )
  const stopped = jobs.map((job) => assert.rejects(job, /participant left/))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(captureSignals.length, 3)
  aborts[0].abort(new Error('participant left'))
  await stopped[0]
  assert(!captureSignals[0].aborted)
  aborts.slice(1).forEach((abort) => abort.abort(new Error('participant left')))
  await Promise.all(stopped)
  assert(captureSignals.every((signal) => signal.aborted))
  assert.equal(f.calls.length, 0)
  assert.equal(f.executor.checkCaptures.size, 0)
})

test('a file-only request uses the existing worker single-file operation only for matching frozen inputs', async (t) => {
  const f = fixture('serve')
  const context = { ...f.context, fileOnly: true }
  f.inputs.mayCheckFile = async () => false
  const capture = f.inputs.capture
  f.inputs.capture = () =>
    assert.fail('an incompatible project must not be captured')
  assert.equal((await f.executor.execute(context, f.local)).stdout, 'local')
  f.inputs.capture = capture
  f.inputs.mayCheckFile = async () => true
  f.inputs.canCheckFile = async () => false
  assert.equal((await f.executor.execute(context, f.local)).stdout, 'local')
  assert.equal(f.calls.length, 0)
  f.inputs.canCheckFile = async (snapshot, file) =>
    snapshot === f.input && file === 'Main.lean'
  await f.executor.execute(context, f.local)
  assert.equal(f.calls[0].options.operation, 'lean.file')
  assert.equal(f.calls[0].options.file, 'Main.lean')
})
