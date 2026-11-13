import assert from 'node:assert/strict'
import test from 'node:test'
import { ReferenceUpdateAdmission } from '../reference-update-admission.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
function gate() {
  let release
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  return { waiting, release }
}

test('shared project scans wait through reference application and retain their arrival order', async () => {
  const admission = new ReferenceUpdateAdmission({ maxConcurrent: 3 })
  const scan = gate(),
    applying = gate(),
    order = []
  const first = admission.run('shared', 'alice', async () => {
    order.push('alice scan')
    await scan.waiting
    order.push('alice apply')
    await applying.waiting
    return 'alice result'
  })
  const second = admission.run('shared', 'bob', () => order.push('bob'))
  const third = admission.run('shared', 'carol', () => order.push('carol'))
  await tick()
  assert.deepEqual(order, ['alice scan'])
  scan.release()
  await tick()
  assert.deepEqual(order, ['alice scan', 'alice apply'])
  applying.release()
  assert.equal(await first, 'alice result')
  await Promise.all([second, third])
  assert.deepEqual(order, ['alice scan', 'alice apply', 'bob', 'carol'])
})

test('per-user capacity spans projects while unrelated eligible work bypasses a waiting task', async () => {
  const admission = new ReferenceUpdateAdmission({ maxConcurrent: 2 })
  const held = gate(),
    order = []
  const first = admission.run('project-a', 'alice', async () => {
    order.push('alice first')
    await held.waiting
  })
  const second = admission.run('project-b', 'alice', () => {
    order.push('alice second')
  })
  const unrelated = admission.run('project-c', 'bob', () => {
    order.push('bob')
  })
  await unrelated
  assert.deepEqual(order, ['alice first', 'bob'])
  held.release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['alice first', 'bob', 'alice second'])
})

test('the global active limit holds capacity across distinct accounts and projects', async () => {
  const admission = new ReferenceUpdateAdmission({ maxConcurrent: 2 })
  const held = gate(),
    started = []
  const first = admission.run('first', 'alice', async () => {
    started.push('first')
    await held.waiting
  })
  const second = admission.run('second', 'bob', async () => {
    started.push('second')
    await held.waiting
  })
  const third = admission.run('third', 'carol', () => started.push('third'))
  await tick()
  assert.deepEqual(started, ['first', 'second'])
  held.release()
  await Promise.all([first, second, third])
  assert.deepEqual(started, ['first', 'second', 'third'])
})

test('a later shared-project task cannot overtake one waiting on its account quota', async () => {
  const admission = new ReferenceUpdateAdmission({ maxConcurrent: 3 })
  const held = gate(),
    order = []
  const active = admission.run('other-alice-project', 'alice', async () => {
    order.push('alice active')
    await held.waiting
  })
  const firstShared = admission.run('shared', 'alice', () => {
    order.push('alice shared')
  })
  const laterShared = admission.run('shared', 'bob', () => {
    order.push('bob shared')
  })
  await admission.run('unrelated', 'carol', () => order.push('carol'))
  assert.deepEqual(order, ['alice active', 'carol'])
  held.release()
  await Promise.all([active, firstShared, laterShared])
  assert.deepEqual(order, [
    'alice active',
    'carol',
    'alice shared',
    'bob shared',
  ])
})

test('a full waiting queue rejects only the extra task without calling its operation', async () => {
  const admission = new ReferenceUpdateAdmission({
    maxConcurrent: 1,
    maxQueued: 1,
  })
  const held = gate()
  const first = admission.run('shared', 'alice', () => held.waiting)
  const waiting = admission.run('second', 'bob', () => 'waiting result')
  await assert.rejects(
    admission.run('third', 'carol', () => assert.fail('Rejected task ran')),
    { status: 429, message: /turn off Update imports and file links/ },
  )
  held.release()
  assert.equal(await first, undefined)
  assert.equal(await waiting, 'waiting result')
  assert.equal(await admission.run('third', 'carol', () => 'retry'), 'retry')
})

test('a full queue does not reject unrelated work that can start immediately', async () => {
  const admission = new ReferenceUpdateAdmission({
    maxConcurrent: 2,
    maxQueued: 1,
  })
  const held = gate()
  const first = admission.run('shared', 'alice', () => held.waiting)
  const waiting = admission.run('shared', 'bob', () => 'same project')
  assert.equal(
    await admission.run('unrelated', 'carol', () => 'unrelated result'),
    'unrelated result',
  )
  held.release()
  await first
  assert.equal(await waiting, 'same project')
})

test('operation failure releases every admission constraint for waiting work', async () => {
  const admission = new ReferenceUpdateAdmission({ maxConcurrent: 1 })
  const held = gate()
  const error = new Error('Fixture application failed')
  const failed = admission.run('shared', 'alice', async () => {
    await held.waiting
    throw error
  })
  const result = assert.rejects(failed, error)
  const waiting = admission.run('shared', 'alice', () => 'recovered')
  held.release()
  await result
  assert.equal(await waiting, 'recovered')
})

test('zero waiting capacity permits immediate work and rejects busy work', async () => {
  const admission = new ReferenceUpdateAdmission({ maxQueued: 0 })
  const held = gate()
  const first = admission.run('shared', 'alice', () => held.waiting)
  await assert.rejects(
    admission.run('shared', 'bob', () => {}),
    {
      status: 429,
    },
  )
  assert.equal(await admission.run('other', 'bob', () => 'other'), 'other')
  held.release()
  await first
})

test('a queued deadline removes its task permanently without interrupting the active operation', async () => {
  const admission = new ReferenceUpdateAdmission({
    maxConcurrent: 1,
    maxWaitMs: 20,
  })
  const held = gate()
  let activeFinished = false,
    queuedRan = false
  const first = admission.run('shared', 'alice', async () => {
    await held.waiting
    activeFinished = true
  })
  const waiting = admission.run('shared', 'bob', () => {
    queuedRan = true
  })
  await assert.rejects(waiting, {
    status: 429,
    message: /Try the move again shortly/,
  })
  assert.equal(activeFinished, false)
  assert.equal(queuedRan, false)
  held.release()
  await first
  await tick()
  assert.equal(queuedRan, false)
  assert.equal(
    await admission.run('shared', 'bob', () => 'retry after timeout'),
    'retry after timeout',
  )
})

test('an overdue task cannot start when release runs before its delayed timeout callback', async (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const admission = new ReferenceUpdateAdmission({
    maxConcurrent: 1,
    maxWaitMs: 1000,
  })
  const held = gate()
  let queuedRan = false
  const first = admission.run('shared', 'alice', () => held.waiting)
  const waiting = admission.run('shared', 'bob', () => {
    queuedRan = true
  })
  const refused = assert.rejects(waiting, { status: 429 })
  await tick()
  now += 1001
  held.release()
  await first
  await refused
  assert.equal(queuedRan, false)
  assert.equal(
    await admission.run('shared', 'bob', () => 'fresh request'),
    'fresh request',
  )
})

test('invalid active or queue limits are rejected before admitting work', () => {
  for (const key of ['maxConcurrent', 'maxPerUser', 'maxWaitMs'])
    for (const value of [0, -1, 1.5, NaN, Infinity, '2'])
      assert.throws(() => new ReferenceUpdateAdmission({ [key]: value }))
  for (const value of [-1, 1.5, NaN, Infinity, '2'])
    assert.throws(() => new ReferenceUpdateAdmission({ maxQueued: value }))
})
