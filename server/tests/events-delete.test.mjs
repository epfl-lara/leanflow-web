import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventStore } from '../events.mjs'

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-events-delete-'),
  )
  const events = new EventStore(directory)
  t.after(async () => {
    events.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { events, directory }
}

test('run deletion checks every owner and active status before deleting any history', async (t) => {
  const { events } = await fixture(t)
  const done = events.create('alice', { kind: 'agent', projectId: 'one' })
  const active = events.create('alice', { kind: 'agent', projectId: 'one' })
  const other = events.create('bob', { kind: 'agent', projectId: 'one' })
  events.updateMetadata(done.id, {
    status: 'completed',
    changes: [{ path: 'Main.lean', before: 'old', after: 'new' }],
  })
  events.append(done.id, 'reasoning', 'saved explanation', 'reasoning')
  events.updateMetadata(other.id, { status: 'completed' })
  const history = events.events(done.id)
  assert.throws(() => events.deleteRuns('alice', [done.id, other.id]), {
    status: 404,
  })
  assert.throws(() => events.deleteRuns('alice', [done.id, active.id]), {
    status: 409,
  })
  assert.deepEqual(events.events(done.id), history)
  assert.equal(events.get(done.id, 'alice').changes.length, 1)
  events.updateMetadata(active.id, { status: 'cancelled' })
  events.deleteRuns('alice', [done.id, active.id, done.id])
  for (const id of [done.id, active.id]) {
    assert.throws(() => events.get(id, 'alice'), { status: 404 })
    assert.deepEqual(events.events(id), [])
    assert.equal(
      events.db
        .prepare('SELECT COUNT(*) AS count FROM job_changes WHERE job=?')
        .get(id).count,
      0,
    )
  }
  assert.equal(events.get(other.id, 'bob').status, 'completed')
})

test('project history deletion covers all jobs beyond the visible history limit and preserves other owners and projects', async (t) => {
  const { events } = await fixture(t)
  const older = events.create('alice', { kind: 'check', projectId: 'one' })
  for (let i = 0; i < 105; i++) {
    const job = events.create('alice', { kind: 'agent', projectId: 'one' })
    events.updateMetadata(job.id, { status: 'completed' })
  }
  assert.equal(events.activeMetadata('alice', 'one').length, 1)
  assert.throws(() => events.deleteProject('alice', 'one'), { status: 409 })
  events.updateMetadata(older.id, { status: 'cancelled' })
  const otherOwner = events.create('bob', { kind: 'agent', projectId: 'one' })
  const otherProject = events.create('alice', {
    kind: 'agent',
    projectId: 'two',
  })
  events.deleteProject('alice', 'one')
  assert.deepEqual(events.projectMetadata('alice', 'one'), [])
  assert.equal(events.get(otherOwner.id, 'bob').projectId, 'one')
  assert.equal(events.get(otherProject.id, 'alice').projectId, 'two')
})

test('failed deletion rolls back jobs, events, and saved candidate changes together', async (t) => {
  const { events } = await fixture(t)
  const job = events.create('alice', { kind: 'agent', projectId: 'one' })
  events.updateMetadata(job.id, {
    status: 'completed',
    changes: [{ path: 'Main.lean', before: 'old', after: 'new' }],
  })
  const history = events.events(job.id)
  events.db.exec(
    "CREATE TRIGGER reject_job_delete BEFORE DELETE ON jobs BEGIN SELECT RAISE(ABORT,'fixture deletion failed'); END",
  )
  assert.throws(
    () => events.deleteRuns('alice', [job.id]),
    /fixture deletion failed/,
  )
  assert.deepEqual(events.events(job.id), history)
  assert.equal(events.get(job.id, 'alice').changes[0].after, 'new')
})
