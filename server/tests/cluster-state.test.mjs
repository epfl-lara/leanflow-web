import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ClusterState, chooseNode, sha256 } from '../cluster/state.mjs'

const resources = { memoryBytes: 1024, cpus: 1, scratchBytes: 128 }
const base = {
  id: 'attempt-1',
  jobId: 'job-1',
  lineage: 'controller-1',
  epoch: 1,
  inputDigest: sha256('source'),
  operation: 'check.build',
  resources,
  actor: 'alice',
  projectId: 'project-1',
  nodeId: 'node-1',
  nodeEpoch: 'boot-1',
  bundleDigest: sha256('release'),
  imageDigest: 'sha256:' + sha256('image'),
}

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-cluster-state-'),
  )
  const filename = path.join(directory, 'state.sqlite')
  const state = new ClusterState({ filename })
  t.after(async () => {
    state.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { state, directory, filename }
}

test('controller restart fences durable in-flight attempts without accepting old results', async (t) => {
  const { state, filename } = await fixture(t)
  assert.deepEqual(state.startController(base.lineage), {
    lineage: base.lineage,
    epoch: 1,
  })
  state.create(base)
  state.transition(base.id, 'assigned')
  state.transition(base.id, 'running')
  assert.equal(state.assertFence(base.id, base).state, 'running')
  const second = new ClusterState({ filename })
  t.after(() => second.close())
  assert.equal(second.startController(base.lineage).epoch, 2)
  assert.equal(second.get(base.id).state, 'lost')
  assert.throws(() => second.assertFence(base.id, base), {
    code: 'stale_generation',
  })
  assert.equal(second.startController(base.lineage).epoch, 3)
  assert.equal(second.get(base.id).state, 'lost')
})

test('idle compaction removes only resolved older generations and preserves uncertain work and current cancellations', async (t) => {
  const { state } = await fixture(t)
  state.startController(base.lineage)
  state.create(base)
  state.transition(base.id, 'assigned')
  state.transition(base.id, 'running')
  state.transition(base.id, 'completed')
  state.appendEvent(base.id, 1, { text: 'done' })
  state.create({ ...base, id: 'uncertain' })
  state.transition('uncertain', 'assigned')
  state.cancelBeforeStart('old-cancel', { lineage: base.lineage, epoch: 1 })
  state.startController(base.lineage)
  state.cancelBeforeStart('current-cancel', { lineage: base.lineage, epoch: 2 })
  state.create({ ...base, id: 'current', epoch: 2 })
  assert.deepEqual(state.compactHistory(2), { receipts: 1 })
  assert.equal(state.get(base.id), null)
  assert.deepEqual(state.events(base.id), [])
  assert.equal(state.get('uncertain').state, 'lost')
  assert.ok(state.get('current'))
  assert.deepEqual(
    state.db
      .prepare('SELECT id FROM cluster_cancelled_starts')
      .all()
      .map((row) => row.id),
    ['current-cancel'],
  )
  state.create({ ...base, id: 'old-late', epoch: 1 })
  assert.throws(
    () => state.assertFence('old-late', { ...base, id: 'old-late' }),
    { code: 'stale_generation' },
  )
})

test('duplicate assignment is durable and cannot change immutable work or actor', async (t) => {
  const { state, filename } = await fixture(t)
  assert.equal(state.create(base).duplicate, false)
  state.transition(base.id, 'assigned')
  assert.equal(state.create(base).duplicate, true)
  const reopened = new ClusterState({ filename })
  t.after(() => reopened.close())
  assert.equal(reopened.create(base).attempt.state, 'assigned')
  for (const patch of [
    { inputDigest: sha256('other') },
    { actor: 'bob' },
    { resources: { ...resources, memoryBytes: 2048 } },
  ])
    assert.throws(() => reopened.create({ ...base, ...patch }), {
      code: 'attempt_conflict',
    })
})

test('terminal outcomes cannot be overwritten by late completion or cancellation', async (t) => {
  const { state } = await fixture(t)
  state.startController(base.lineage)
  state.create(base)
  state.transition(base.id, 'assigned')
  state.transition(base.id, 'running')
  state.transition(base.id, 'stopping')
  state.transition(base.id, 'cancelled')
  assert.throws(() => state.transition(base.id, 'completed'), {
    code: 'attempt_state',
  })
  assert.throws(() => state.assertFence(base.id, base), {
    code: 'stale_attempt',
  })
})

test('worker enrollment rejects a different lineage and a replayed older epoch', async (t) => {
  const { state } = await fixture(t)
  assert.throws(
    () => state.acceptController({ lineage: 'other', epoch: 1 }, base.lineage),
    { status: 403 },
  )
  state.acceptController({ lineage: base.lineage, epoch: 3 }, base.lineage)
  assert.throws(
    () =>
      state.acceptController({ lineage: base.lineage, epoch: 2 }, base.lineage),
    { code: 'stale_generation' },
  )
  assert.equal(
    state.acceptController({ lineage: base.lineage, epoch: 3 }, base.lineage)
      .epoch,
    3,
  )
  assert.throws(() =>
    state.acceptController({ lineage: base.lineage, epoch: 0 }, base.lineage),
  )
})

test('event replay deduplicates identical frames and rejects gaps or changed frames', async (t) => {
  const { state } = await fixture(t)
  state.create(base)
  assert.equal(state.appendEvent(base.id, 1, { text: 'first' }), true)
  assert.equal(state.appendEvent(base.id, 1, { text: 'first' }), false)
  assert.throws(() => state.appendEvent(base.id, 1, { text: 'changed' }), {
    code: 'sequence_conflict',
  })
  assert.throws(() => state.appendEvent(base.id, 3, { text: 'third' }), {
    code: 'sequence_gap',
  })
  state.appendEvent(base.id, 2, { text: 'second' })
  assert.deepEqual(state.events(base.id, 1), [
    { sequence: 2, value: { text: 'second' } },
  ])
})

test('node boot, content and controller fences all participate in result acceptance', async (t) => {
  const { state } = await fixture(t)
  state.startController(base.lineage)
  state.create(base)
  for (const patch of [
    { nodeId: 'node-2' },
    { nodeEpoch: 'boot-2' },
    { inputDigest: sha256('changed') },
    { lineage: 'restored' },
    { epoch: 2 },
  ])
    assert.throws(() => state.assertFence(base.id, { ...base, ...patch }), {
      code: 'stale_attempt',
    })
})

test('invalid resources and oversized metadata fail without creating attempts', async (t) => {
  const { state } = await fixture(t)
  for (const patch of [
    { cpus: NaN },
    { memoryBytes: -1 },
    { memoryBytes: 1.5 },
    { scratchBytes: -1 },
  ])
    assert.throws(() =>
      state.create({ ...base, resources: { ...resources, ...patch } }),
    )
  assert.throws(() => state.create({ ...base, actor: 'a'.repeat(201) }))
  assert.deepEqual(state.list(), [])
})

test('database paths cannot follow a symlink or use a hardlinked database', async (t) => {
  const { directory } = await fixture(t)
  const target = path.join(directory, 'sentinel')
  await fs.writeFile(target, 'unchanged')
  const link = path.join(directory, 'link.sqlite')
  await fs.symlink(target, link)
  assert.throws(() => new ClusterState({ filename: link }))
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged')
})

function node(overrides = {}) {
  return {
    id: 'node-1',
    status: 'ready',
    role: 'primary',
    lastSeen: 10000,
    capabilities: ['check.build'],
    bundleDigest: base.bundleDigest,
    imageDigest: base.imageDigest,
    budget: { memoryBytes: 4096, cpus: 4, scratchBytes: 1024 },
    ...overrides,
  }
}

test('placement excludes reserve, stale, incompatible and draining nodes', () => {
  for (const patch of [
    { role: 'reserve' },
    { lastSeen: 0, heartbeatTimeoutMs: 100 },
    { bundleDigest: sha256('wrong') },
    { imageDigest: 'sha256:' + sha256('wrong') },
    { capabilities: [] },
    { draining: true },
  ])
    assert.equal(chooseNode([node(patch)], base, [], { now: 10000 }), null)
  assert.equal(
    chooseNode([node({ role: 'reserve' })], base, [], {
      now: 10000,
      allowReserve: true,
    }).id,
    'node-1',
  )
})

test('placement respects per-node CPU, RAM and scratch rather than aggregate memory', () => {
  const occupied = [
    {
      ...base,
      state: 'running',
      resources: { memoryBytes: 3500, cpus: 1, scratchBytes: 0 },
    },
  ]
  assert.equal(chooseNode([node()], base, occupied, { now: 10000 }), null)
  assert.equal(
    chooseNode([node({ id: 'node-2' }), node()], base, occupied, { now: 10000 })
      .id,
    'node-2',
  )
  assert.equal(
    chooseNode(
      [node({ budget: { memoryBytes: 4096, cpus: 0.5, scratchBytes: 1024 } })],
      base,
      [],
      { now: 10000 },
    ),
    null,
  )
  assert.equal(
    chooseNode(
      [node({ budget: { memoryBytes: 4096, cpus: 4, scratchBytes: 64 } })],
      base,
      [],
      { now: 10000 },
    ),
    null,
  )
})
