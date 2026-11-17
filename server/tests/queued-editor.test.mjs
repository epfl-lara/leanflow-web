import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { EditorAdmission } from '../editor-admission.mjs'
import { queuedEditor } from '../queued-editor.mjs'

function fixture(t, options = {}) {
  const admission = new EditorAdmission({
    capacity: () => 1,
    maxPerUser: 1,
    maxPerProject: 1,
    pollMs: 5,
    ...options,
  })
  const children = [],
    editors = [],
    notices = []
  const spawn = () => {
    const child = new EventEmitter()
    for (const stream of ['stdin', 'stdout', 'stderr'])
      child[stream] = new PassThrough()
    child.workerStopped = new Promise((resolve) => {
      child.confirmStopped = resolve
    })
    child.kill = () => {
      if (child.closed) return
      child.closed = true
      child.emit('close', 0)
    }
    children.push(child)
    return child
  }
  const open = (projectId, extra = {}) => {
    const editor = queuedEditor({
      admission,
      actor: projectId,
      projectId,
      canStart: () => true,
      start: spawn,
      onStatus: (value) => notices.push({ projectId, ...value }),
      ...extra,
    })
    editors.push(editor)
    return editor
  }
  t.after(() => {
    admission.close()
    for (const editor of editors) editor.kill()
    for (const child of children) {
      child.kill()
      child.confirmStopped()
      for (const stream of ['stdin', 'stdout', 'stderr'])
        child[stream].destroy()
    }
  })
  return { admission, children, notices, spawn, open }
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('disconnect holds its slot until worker cleanup is confirmed, then promotes the existing waiter', async (t) => {
  const f = fixture(t)
  const first = f.open('first')
  await first.ready
  const next = f.open('next')
  await flush()
  assert.equal(f.children.length, 1)
  assert.deepEqual(f.admission.info(), { active: 1, queued: 1, maxQueued: 128 })
  first.kill()
  await flush()
  assert.equal(
    f.children.length,
    1,
    'A socket close is not proof the container stopped',
  )
  f.children[0].confirmStopped()
  await next.ready
  assert.equal(f.children.length, 2)
  assert(
    f.notices.some(
      (notice) => notice.projectId === 'next' && notice.state === 'active',
    ),
  )
})

test('one free worker promotes only one tab when the logical limit is four', async (t) => {
  const f = fixture(t, { capacity: () => 4 })
  let occupied = 0,
    calls = 0
  const options = {
    canStart: () => occupied < 1,
    start: () => {
      calls++
      assert.equal(
        occupied,
        0,
        'No speculative second start for the same free worker',
      )
      occupied++
      const child = f.spawn()
      const confirm = child.confirmStopped
      child.confirmStopped = () => {
        occupied--
        confirm()
      }
      return child
    },
  }
  const editors = ['one', 'two', 'three', 'four'].map((id) =>
    f.open(id, options),
  )
  await editors[0].ready
  await flush()
  assert.equal(calls, 1)
  assert.equal(f.admission.info().queued, 3)
  for (let i = 1; i < editors.length; i++) {
    editors[i - 1].kill()
    f.children[i - 1].confirmStopped()
    await editors[i].ready
    await flush()
    assert.equal(calls, i + 1)
    assert.equal(f.admission.info().queued, 3 - i)
  }
})

test('admission follows final cleanup rather than an obsolete failed cleanup attempt', async (t) => {
  const f = fixture(t)
  const child = f.spawn()
  let confirm
  child.workerReleased = new Promise((resolve) => {
    confirm = resolve
  })
  const first = f.open('first', { start: () => child })
  await first.ready
  child.workerStopped = Promise.reject(new Error('First cleanup failed'))
  child.workerStopped.catch(() => {})
  first.kill()
  await flush()
  assert.equal(f.admission.info().active, 1)
  confirm()
  await flush()
  assert.equal(f.admission.info().active, 0)
})

test('unconfirmed startup cleanup holds only its own lease and permits healthy editors to start', async (t) => {
  const f = fixture(t, { capacity: () => 4 })
  let confirm
  const workerReleased = new Promise((resolve) => {
    confirm = resolve
  })
  const failed = f.open('offline', {
    start: () => {
      throw Object.assign(new Error('Worker cleanup pending'), {
        status: 503,
        workerCleanup: true,
        workerReleased,
      })
    },
  })
  const rejected = assert.rejects(failed.ready, /cleanup pending/)
  await flush()
  const healthy = f.open('healthy')
  await healthy.ready
  assert.equal(f.children.length, 1)
  assert.equal(
    f.admission.info().active,
    2,
    'The uncertain worker keeps its own slot',
  )
  confirm()
  await rejected
  assert.equal(f.admission.info().active, 1)
})

test('a cancelled waiting tab never starts after capacity returns', async (t) => {
  const f = fixture(t)
  await f.open('first').ready
  const cancelled = f.open('cancelled')
  await flush()
  const stopped = assert.rejects(cancelled.ready, /Editor connection closed/)
  cancelled.kill()
  await stopped
  assert.equal(f.admission.info().queued, 0)
  f.children[0].confirmStopped()
  await flush()
  assert.equal(f.children.length, 1)
})

test('resource recovery starts a waiter, while a revoked project never creates a process', async (t) => {
  const f = fixture(t)
  let available = false
  const waiting = f.open('waiting', { canStart: () => available })
  await flush()
  assert.equal(f.children.length, 0)
  available = true
  await new Promise((resolve) => setTimeout(resolve, 15))
  await waiting.ready
  assert.equal(f.children.length, 1)
  f.children[0].confirmStopped()
  await flush()
  const refused = f.open('revoked', {
    canStart: () => {
      throw Object.assign(new Error('Access removed'), { status: 403 })
    },
  })
  await assert.rejects(refused.ready, { status: 403 })
  assert.equal(f.children.length, 1)
  assert.equal(f.admission.info().active, 0)
})

test('a pre-start capacity race queues with backoff but cannot reset the original deadline', async (t) => {
  const f = fixture(t, { maxWaitMs: 40 })
  let calls = 0
  const editor = f.open('racing', {
    start: () => {
      calls++
      throw Object.assign(new Error('Interactive capacity is full'), {
        status: 503,
      })
    },
  })
  const rejected = assert.rejects(editor.ready, { status: 429 })
  // Keep the test alive while admission's intentionally unref'd poll expires.
  await new Promise((resolve) => setTimeout(resolve, 60))
  await rejected
  assert.equal(calls, 1)
  assert.equal(f.admission.info().active, 0)
  assert.equal(f.admission.info().queued, 0)
})

test('one shared editor retrying placement leaves other members free to use ready workers', async (t) => {
  const f = fixture(t, { capacity: () => 2, maxPerProject: 2 })
  let now = Date.now(),
    attempts = 0
  t.mock.method(Date, 'now', () => now)
  const first = f.open('competition', {
    actor: 'alice',
    start: () => {
      if (++attempts === 1)
        throw Object.assign(new Error('Worker filled during placement'), {
          status: 503,
        })
      return f.spawn()
    },
  })
  await flush()
  const other = f.open('competition', { actor: 'bob' })
  await flush()
  assert.equal(f.children.length, 1, 'Bob starts while Alice waits to retry')
  await other.ready
  assert.equal(attempts, 1)
  assert.equal(f.admission.info().queued, 1)
  now += 1001
  await new Promise((resolve) => setTimeout(resolve, 15))
  await first.ready
  assert.equal(attempts, 2)
  assert.equal(f.admission.info().active, 2)
})

test('uncertain cleanup failures never retry another process on a second worker', async (t) => {
  const f = fixture(t)
  let calls = 0
  const editor = f.open('uncertain', {
    start: () => {
      calls++
      throw Object.assign(new Error('Remote cleanup unconfirmed'), {
        status: 503,
        workerCleanup: true,
      })
    },
  })
  await assert.rejects(editor.ready, /cleanup unconfirmed/)
  assert.equal(calls, 1)
  assert.equal(f.admission.info().queued, 0)
})
