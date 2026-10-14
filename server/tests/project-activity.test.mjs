import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventStore, JobManager } from '../events.mjs'
import { AgentManager } from '../agents.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-project-activity-'),
  )
  const events = new EventStore(directory)
  const cleanups = []
  const workspaces = {
    get(id, owner) {
      if (
        !['one', 'two'].includes(id) ||
        !['alice', 'bob'].includes(owner) ||
        (owner === 'bob' && id !== 'one')
      )
        throw Object.assign(new Error('Project not found.'), { status: 404 })
      return {
        id,
        owner,
        root: path.join(directory, owner, id),
        status: 'ready',
      }
    },
  }
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup()
    events.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { events, workspaces, onCleanup: (cleanup) => cleanups.push(cleanup) }
}

test('a queued Lean check can be stopped before it starts any worker', async (t) => {
  const f = await fixture(t)
  let calls = 0
  const manager = new JobManager({
    ...f,
    runtime: {
      run() {
        calls++
        throw new Error('Cancelled check must not launch.')
      },
    },
  })
  const job = manager.check('alice', 'one')
  assert.equal(f.events.getMetadata(job.id).status, 'queued')
  await manager.stop('alice', job.id)
  assert.equal(f.events.getMetadata(job.id).status, 'cancelled')
  assert.equal(calls, 0)
  await manager.shutdown()
})

test('project cancellation stops every owned check together and waits for teardown without touching other work', async (t) => {
  const f = await fixture(t),
    holds = []
  const manager = new JobManager({
    ...f,
    runtime: {
      async run(root, _args, options) {
        const release = deferred()
        holds.push({ root, signal: options.signal, release })
        await release.promise
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  })
  f.onCleanup(async () => {
    for (const hold of holds) hold.release.resolve()
    await manager.shutdown()
  })
  const owned = [manager.check('alice', 'one'), manager.check('alice', 'one')]
  const otherOwner = manager.check('bob', 'one'),
    otherProject = manager.check('alice', 'two')
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(manager.stopProject('bob', 'two'), { status: 404 })
  assert(holds.every((hold) => !hold.signal.aborted))
  let stopped = false
  const stop = manager.stopProject('alice', 'one').then(() => {
    stopped = true
  })
  assert.equal(stopped, false)
  assert(holds.slice(0, 2).every((hold) => hold.signal.aborted))
  assert(holds.slice(2).every((hold) => !hold.signal.aborted))
  assert(
    owned.every((job) => f.events.getMetadata(job.id).status === 'stopping'),
  )
  holds[0].release.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  holds[1].release.resolve()
  await stop
  assert(
    owned.every((job) => f.events.getMetadata(job.id).status === 'cancelled'),
  )
  assert.equal(f.events.getMetadata(otherOwner.id).status, 'running')
  assert.equal(f.events.getMetadata(otherProject.id).status, 'running')
})

test('a terminal Lemex receipt still waits for active writes and worker cleanup before project stop returns', async (t) => {
  const f = await fixture(t)
  const manager = new AgentManager({
    ...f,
    runtime: {},
    settings: {},
    config: {
      provider: {},
      redact: String,
    },
    maxConcurrent: 0,
  })
  const job = f.events.create('alice', { kind: 'agent', projectId: 'one' })
  f.events.updateMetadata(job.id, { status: 'completed' })
  const done = deferred(),
    cleanup = deferred()
  manager.active.set(job.id, {
    done: done.promise,
    workerStopped: cleanup.promise,
    mirror: { async stop() {} },
  })
  let stopped = false
  const stop = manager.stopProject('alice', 'one').then(() => {
    stopped = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  done.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  cleanup.resolve()
  await stop
  assert.equal(stopped, true)
  manager.active.delete(job.id)
  await manager.shutdown()
})
