import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { EventStore } from '../events.mjs'

const before = '-- original source 🙂\n' + 'x'.repeat(3 * 1024 * 1024)
const after = before.slice(0, -1) + 'y'
const changes = [{ path: 'Large.lean', before, after, beforeHash: 'pinned' }]

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-event-sources-'),
  )
  let events = new EventStore(directory)
  t.after(async () => {
    events.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return {
    directory,
    get events() {
      return events
    },
    restart() {
      events.close()
      events = new EventStore(directory)
    },
  }
}

test('full job reads, updates, lists and snapshots preserve detached change text and owner checks', async (t) => {
  const f = await fixture(t)
  const job = f.events.create('alice', {
    kind: 'agent',
    projectId: 'one',
    liveChanges: changes,
  })
  const updated = f.events.update(job.id, { changes, status: 'running' })
  assert.deepEqual(updated.changes, changes)
  assert.deepEqual(updated.liveChanges, changes)
  f.events.updateMetadata(job.id, {
    progress: { label: 'Working' },
    liveRevision: 2,
  })
  f.events.append(job.id, 'message', 'Preserved response', 'message')
  for (const full of [
    f.events.get(job.id, 'alice'),
    f.events.snapshot(job.id, 'alice'),
    f.events.list('alice', 'one')[0],
  ]) {
    assert.deepEqual(full.changes, changes)
    assert.deepEqual(full.liveChanges, changes)
    assert.equal(full.message, 'Preserved response')
    assert.equal(full.liveRevision, 2)
  }
  assert.throws(() => f.events.get(job.id, 'bob'), { status: 404 })
  assert.throws(() => f.events.getMetadata(job.id, 'bob'), { status: 404 })
  assert.deepEqual(f.events.list('bob', 'one'), [])
  assert.deepEqual(f.events.listMetadata('bob', 'one'), [])
  const raw = f.events.db
    .prepare('SELECT payload FROM jobs WHERE id=?')
    .get(job.id).payload
  assert(raw.length < 10_000)
  assert(!raw.includes('original source'))
  assert(!Object.hasOwn(JSON.parse(raw), 'changes'))
  assert(!Object.hasOwn(JSON.parse(raw), 'liveChanges'))
  assert.deepEqual(f.events.getMetadata(job.id).changes, [
    { path: 'Large.lean' },
  ])
  assert.deepEqual(f.events.listMetadata('alice', 'one')[0].liveChanges, [
    { path: 'Large.lean' },
  ])
  f.restart()
  const restarted = f.events.get(job.id, 'alice')
  assert.equal(restarted.status, 'interrupted')
  assert.deepEqual(restarted.changes, changes)
  assert.deepEqual(restarted.liveChanges, changes)
})

test('hot metadata and text-output updates do not read or rewrite stored change payloads', async (t) => {
  const f = await fixture(t)
  const job = f.events.create('alice', { kind: 'agent', projectId: 'one' })
  f.events.updateMetadata(job.id, { changes, liveChanges: changes })
  const sourceRows = f.events.db
    .prepare('SELECT field,payload FROM job_changes WHERE job=? ORDER BY field')
    .all(job.id)
  // A damaged source row proves these paths do not attempt to hydrate it.
  f.events.db
    .prepare('UPDATE job_changes SET payload=? WHERE job=?')
    .run('unreadable source fixture', job.id)
  for (let i = 0; i < 3; i++) {
    f.events.updateMetadata(job.id, {
      progress: { label: `Update ${i}` },
      status: 'running',
    })
    f.events.append(job.id, 'reasoning', `Reasoning ${i}\n`, 'reasoning')
    assert.equal(f.events.getMetadata(job.id, 'alice').status, 'running')
    assert.equal(f.events.listMetadata('alice', 'one').length, 1)
  }
  assert.throws(() => f.events.get(job.id), SyntaxError)
  assert.throws(() => f.events.get(job.id, 'bob'), { status: 404 })
  for (const row of sourceRows)
    f.events.db
      .prepare('UPDATE job_changes SET payload=? WHERE job=? AND field=?')
      .run(row.payload, job.id, row.field)
  f.events.updateMetadata(job.id, { status: 'cancelled' })
  assert.deepEqual(
    f.events.db
      .prepare(
        'SELECT field,payload FROM job_changes WHERE job=? ORDER BY field',
      )
      .all(job.id),
    sourceRows,
  )
  assert.deepEqual(f.events.get(job.id).liveChanges, changes)
  assert.equal(
    f.events.get(job.id).reasoning,
    'Reasoning 0\nReasoning 1\nReasoning 2\n',
  )
  assert(f.events.snapshot(job.id).reasoningBlocks.length > 0)
})

test('change text and metadata update atomically, and explicit clearing does not discard other history', async (t) => {
  const f = await fixture(t)
  const job = f.events.create('alice', {
    kind: 'agent',
    projectId: 'one',
    liveChanges: changes,
  })
  f.events.updateMetadata(job.id, { changes, liveRevision: 1 })
  f.events.db.exec(
    "CREATE TRIGGER reject_source_update BEFORE UPDATE ON job_changes BEGIN SELECT RAISE(ABORT,'fixture source write failed'); END",
  )
  assert.throws(
    () => f.events.updateMetadata(job.id, { changes: [], liveRevision: 2 }),
    /fixture source write failed/,
  )
  assert.equal(f.events.get(job.id).liveRevision, 1)
  assert.deepEqual(f.events.get(job.id).changes, changes)
  assert.deepEqual(f.events.get(job.id).liveChanges, changes)
  f.events.db.exec('DROP TRIGGER reject_source_update')
  const cleared = f.events.update(job.id, { changes: [], liveUndone: true })
  assert.deepEqual(cleared.changes, [])
  assert.deepEqual(cleared.liveChanges, changes)
  assert.equal(cleared.liveUndone, true)
  const removed = f.events.update(job.id, { liveChanges: undefined })
  assert(!Object.hasOwn(removed, 'liveChanges'))
  assert.deepEqual(removed.changes, [])
})

test('older inline job rows migrate on restart with complete sources and unchanged terminal status', async (t) => {
  const f = await fixture(t)
  const active = f.events.create('alice', { kind: 'agent', projectId: 'one' })
  const done = f.events.create('alice', { kind: 'agent', projectId: 'one' })
  f.events.update(done.id, { status: 'completed' })
  const db = new DatabaseSync(path.join(f.directory, 'activity.sqlite'))
  for (const job of [active, f.events.get(done.id)]) {
    db.prepare('DELETE FROM job_changes WHERE job=?').run(job.id)
    db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(
      JSON.stringify({ ...job, changes, liveChanges: changes }),
      job.id,
    )
  }
  db.close()
  f.restart()
  assert.equal(f.events.get(active.id).status, 'interrupted')
  assert.equal(f.events.get(done.id).status, 'completed')
  for (const job of [active, done]) {
    assert.deepEqual(f.events.get(job.id).changes, changes)
    assert.deepEqual(f.events.get(job.id).liveChanges, changes)
    assert(
      !f.events.db
        .prepare('SELECT payload FROM jobs WHERE id=?')
        .get(job.id)
        .payload.includes('original source'),
    )
  }
  f.restart()
  assert.deepEqual(f.events.get(done.id).liveChanges, changes)
  assert.equal(
    f.events
      .events(active.id)
      .filter((event) => event.data.status === 'interrupted').length,
    1,
  )
})
