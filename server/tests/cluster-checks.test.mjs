import test from 'node:test'
import assert from 'node:assert/strict'
import { ClusterChecks } from '../cluster/checks.mjs'

const result = { code: 0, stdout: 'verified', stderr: '' }
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

test('source changes and cancellations do not fall through to another check', async () => {
  const f = fixture('serve')
  f.inputs.capture = async () => {
    throw Object.assign(new Error('Changed'), { code: 'source_changed' })
  }
  await assert.rejects(f.executor.execute(f.context, f.local), {
    code: 'source_changed',
  })
  assert.equal(f.counts().localCalls, 0)
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
