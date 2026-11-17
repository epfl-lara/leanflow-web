import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorAdmission } from '../editor-admission.mjs'

const POLL = 500
const STARTING = { state: 'starting' }
const waiting = (position, total) => ({ state: 'waiting', position, total })
const started = (session) =>
  session.notices.some((notice) => notice.state === 'starting')

function editors(t, options = {}) {
  const pool = { capacity: options.capacity ?? 1 }
  const admission = new EditorAdmission({
    maxPerUser: 8,
    maxPerProject: 8,
    pollMs: POLL,
    ...options,
    capacity: () => {
      if (pool.capacity instanceof Error) throw pool.capacity
      return pool.capacity
    },
  })
  t.after(() => admission.close())
  // Each tab records only the notices sent to its own connection.
  const open = (actor, projectId, { canStart = () => true, onStatus } = {}) => {
    const controller = new AbortController()
    const session = { controller, notices: [], release: null, error: null }
    session.settled = admission
      .acquire({
        actor,
        projectId,
        signal: controller.signal,
        canStart,
        onStatus: (notice) => {
          session.notices.push(notice)
          onStatus?.(notice)
        },
      })
      .then(
        (release) => {
          session.release = release
        },
        (error) => {
          session.error = error
        },
      )
    return session
  }
  return { admission, pool, open }
}

test('a startup retry keeps its original place even when both waiting limits are full', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let capacity = 0,
    available = true
  const admission = new EditorAdmission({
    capacity: () => capacity,
    maxPerUser: 2,
    maxPerProject: 2,
    maxQueued: 2,
    maxQueuedPerUser: 2,
  })
  t.after(() => admission.close())
  const notices = [[], []]
  const first = admission.acquire({
    actor: 'alice',
    projectId: 'first',
    reserveStart: true,
    canStart: () => available,
    onStatus: (notice) => notices[0].push(notice),
  })
  const second = admission.acquire({
    actor: 'alice',
    projectId: 'second',
    reserveStart: true,
    onStatus: (notice) => notices[1].push(notice),
  })
  capacity = 1
  t.mock.timers.tick(POLL)
  const lease = await first
  assert.throws(() => admission.assertCanQueue('alice'), { status: 429 })
  await assert.rejects(
    admission.acquire({
      actor: 'alice',
      projectId: 'overflow',
      reserveStart: true,
    }),
    { status: 429 },
  )
  available = false
  const retry = lease.retry()
  assert.deepEqual(notices[0].at(-1), waiting(1, 2))
  assert.deepEqual(notices[1].at(-1), waiting(2, 2))
  available = true
  t.mock.timers.tick(POLL)
  const retried = await retry
  retried.started()
  retried()
  const next = await second
  next.started()
  next()
  assert.equal(admission.info().active, 0)
})

test('the 33rd editor waits without a worker and starts in arrival order as sessions close', async (t) => {
  const { admission, open } = editors(t, { capacity: 32 })
  const sessions = Array.from({ length: 36 }, (_, index) =>
    open(`user-${index}`, `project-${index}`),
  )
  await Promise.all(sessions.slice(0, 32).map((session) => session.settled))
  assert.ok(
    sessions
      .slice(0, 32)
      .every((session) => typeof session.release === 'function'),
  )
  assert.deepEqual(sessions[0].notices, [STARTING])
  assert.deepEqual(
    sessions.slice(32).map((session) => session.notices.at(-1)),
    [waiting(1, 4), waiting(2, 4), waiting(3, 4), waiting(4, 4)],
  )
  assert.deepEqual(admission.info(), { active: 32, queued: 4, maxQueued: 128 })
  for (const [index, closed] of [7, 0, 31, 12].entries()) {
    sessions[closed].release()
    const next = sessions[32 + index]
    await next.settled
    assert.deepEqual(next.notices.at(-1), STARTING)
    assert.equal(typeof next.release, 'function')
    assert.deepEqual(admission.info(), {
      active: 32,
      queued: 3 - index,
      maxQueued: 128,
    })
    for (const [offset, later] of sessions.slice(33 + index).entries())
      assert.deepEqual(later.notices.at(-1), waiting(offset + 1, 3 - index))
  }
})

test('releasing a session twice frees only its own slot', async (t) => {
  const { admission, open } = editors(t)
  const first = open('alice', 'one')
  const second = open('bob', 'two')
  const third = open('carol', 'three')
  await first.settled
  first.release()
  await second.settled
  first.release()
  assert.equal(started(third), false)
  assert.deepEqual(admission.info(), { active: 1, queued: 1, maxQueued: 128 })
  second.release()
  second.release()
  await third.settled
  assert.deepEqual(admission.info(), { active: 1, queued: 0, maxQueued: 128 })
  third.release()
  third.release()
  assert.deepEqual(admission.info(), { active: 0, queued: 0, maxQueued: 128 })
  const fresh = [open('dave', 'four'), open('erin', 'five')]
  await fresh[0].settled
  assert.equal(started(fresh[1]), false)
  assert.deepEqual(admission.info(), { active: 1, queued: 1, maxQueued: 128 })
})

test('each waiting tab sees its own global position, resent only when it changes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const { admission, open } = editors(t)
  const owner = open('alice', 'one')
  const bob = open('bob', 'two')
  const carol = open('carol', 'three')
  const dave = open('dave', 'four')
  assert.deepEqual(owner.notices, [STARTING])
  assert.deepEqual(bob.notices, [waiting(1, 1), waiting(1, 2), waiting(1, 3)])
  assert.deepEqual(carol.notices, [waiting(2, 2), waiting(2, 3)])
  assert.deepEqual(dave.notices, [waiting(3, 3)])
  t.mock.timers.tick(POLL * 4)
  assert.equal(bob.notices.length, 3)
  assert.equal(carol.notices.length, 2)
  assert.equal(dave.notices.length, 1)
  const reason = new Error('Fixture tab closed')
  carol.controller.abort(reason)
  assert.deepEqual(admission.info(), { active: 1, queued: 2, maxQueued: 128 })
  assert.deepEqual(bob.notices.at(-1), waiting(1, 2))
  assert.deepEqual(dave.notices, [waiting(3, 3), waiting(2, 2)])
  assert.deepEqual(carol.notices, [waiting(2, 2), waiting(2, 3)])
  await Promise.all([owner.settled, carol.settled])
  assert.equal(carol.error, reason)
  owner.release()
  assert.deepEqual(bob.notices.at(-1), STARTING)
  assert.deepEqual(dave.notices.at(-1), waiting(1, 1))
  assert.equal(started(carol), false)
})

test('an unrelated tab bypasses blocked ones while a shared project or account keeps arrival order', async (t) => {
  const { admission, open } = editors(t, {
    capacity: 6,
    maxPerUser: 2,
    maxPerProject: 1,
  })
  const bob = open('bob', 'shared')
  const aliceShared = open('alice', 'shared')
  const aliceOwn = open('alice', 'alice-own')
  const carolShared = open('carol', 'shared')
  const dave = open('dave', 'unrelated')
  await Promise.all([bob.settled, dave.settled])
  assert.deepEqual(dave.notices, [STARTING])
  assert.deepEqual(aliceShared.notices.at(-1), waiting(1, 3))
  assert.deepEqual(aliceOwn.notices.at(-1), waiting(2, 3))
  assert.deepEqual(carolShared.notices.at(-1), waiting(3, 3))
  assert.deepEqual(admission.info(), { active: 2, queued: 3, maxQueued: 128 })
  bob.release()
  await Promise.all([aliceShared.settled, aliceOwn.settled])
  assert.equal(typeof aliceShared.release, 'function')
  assert.equal(typeof aliceOwn.release, 'function')
  assert.deepEqual(carolShared.notices.at(-1), waiting(1, 1))
  assert.deepEqual(admission.info(), { active: 3, queued: 1, maxQueued: 128 })
  aliceShared.release()
  await carolShared.settled
  assert.equal(typeof carolShared.release, 'function')
  assert.deepEqual(admission.info(), { active: 3, queued: 0, maxQueued: 128 })
})

test('a tab that cannot be placed yet holds back only its account and starts when the poll sees room', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const { admission, open } = editors(t, { capacity: 4 })
  let localRoom = false
  const localOnly = open('alice', 'local-only', { canStart: () => localRoom })
  const unrelated = open('bob', 'remote')
  const laterOwn = open('alice', 'remote-alice')
  await unrelated.settled
  assert.deepEqual(unrelated.notices, [STARTING])
  assert.deepEqual(localOnly.notices.at(-1), waiting(1, 2))
  assert.deepEqual(laterOwn.notices, [waiting(2, 2)])
  t.mock.timers.tick(POLL * 2)
  assert.equal(started(localOnly), false)
  localRoom = true
  assert.equal(started(localOnly), false)
  t.mock.timers.tick(POLL)
  await Promise.all([localOnly.settled, laterOwn.settled])
  assert.equal(typeof localOnly.release, 'function')
  assert.equal(typeof laterOwn.release, 'function')
  assert.deepEqual(admission.info(), { active: 3, queued: 0, maxQueued: 128 })
})

test('an account with every allowed editor open may queue three more tabs but no more', async (t) => {
  const { admission, open } = editors(t, { capacity: 3, maxPerUser: 3 })
  const active = ['a', 'b', 'c'].map((project) => open('alice', project))
  await Promise.all(active.map((session) => session.settled))
  const queued = ['d', 'e', 'f'].map((project) => open('alice', project))
  assert.deepEqual(
    queued.map((session) => session.notices.at(-1)),
    [waiting(1, 3), waiting(2, 3), waiting(3, 3)],
  )
  assert.throws(() => admission.assertCanQueue('alice'), {
    status: 429,
    message: /Close one or wait for an editor to start/,
  })
  const extra = open('alice', 'g')
  await extra.settled
  assert.equal(extra.error.status, 429)
  assert.deepEqual(extra.notices, [])
  admission.assertCanQueue('bob')
  const bob = open('bob', 'h')
  assert.deepEqual(bob.notices, [waiting(4, 4)])
  assert.deepEqual(admission.info(), { active: 3, queued: 4, maxQueued: 128 })
  active[0].release()
  assert.deepEqual(queued[0].notices.at(-1), STARTING)
  assert.deepEqual(bob.notices.at(-1), waiting(3, 3))
  admission.assertCanQueue('alice')
})

test('a full waiting list refuses only tabs that would wait and keeps existing positions', async (t) => {
  const { admission, open } = editors(t, {
    capacity: 2,
    maxPerProject: 1,
    maxQueued: 2,
  })
  const owner = open('alice', 'shared')
  const first = open('bob', 'shared')
  const second = open('carol', 'shared')
  assert.deepEqual(admission.info(), { active: 1, queued: 2, maxQueued: 2 })
  // A free slot may still serve this account, so the pre-check lets it through.
  admission.assertCanQueue('dave')
  const refused = open('dave', 'shared')
  const unrelated = open('dave', 'other')
  await Promise.all([owner.settled, refused.settled, unrelated.settled])
  assert.equal(refused.error.status, 429)
  assert.match(refused.error.message, /waiting list is full/)
  assert.deepEqual(refused.notices, [])
  assert.deepEqual(unrelated.notices, [STARTING])
  assert.deepEqual(first.notices, [waiting(1, 1), waiting(1, 2)])
  assert.deepEqual(second.notices, [waiting(2, 2)])
  assert.throws(() => admission.assertCanQueue('erin'), {
    status: 429,
    message: /waiting list is full/,
  })
  const late = open('erin', 'elsewhere')
  await late.settled
  assert.equal(late.error.status, 429)
  owner.release()
  await first.settled
  assert.deepEqual(admission.info(), { active: 2, queued: 1, maxQueued: 2 })
  admission.assertCanQueue('erin')
})

test('zero waiting room still admits a free editor and refuses one that would wait', async (t) => {
  const { admission, open } = editors(t, { maxQueued: 0 })
  admission.assertCanQueue('alice')
  const first = open('alice', 'one')
  await first.settled
  assert.deepEqual(first.notices, [STARTING])
  assert.throws(() => admission.assertCanQueue('bob'), { status: 429 })
  const refused = open('bob', 'two')
  await refused.settled
  assert.equal(refused.error.status, 429)
  assert.deepEqual(refused.notices, [])
  first.release()
  const retry = open('bob', 'two')
  await retry.settled
  assert.deepEqual(retry.notices, [STARTING])
})

test('a cancelled or expired tab leaves the queue at once and never starts later', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const { admission, open } = editors(t, { maxWaitMs: 2000 })
  const owner = open('alice', 'one')
  const cancelled = open('bob', 'two')
  t.mock.timers.tick(1000)
  const expiring = open('carol', 'three')
  const reason = new Error('Fixture tab closed')
  cancelled.controller.abort(reason)
  assert.deepEqual(expiring.notices, [waiting(2, 2), waiting(1, 1)])
  t.mock.timers.tick(1000)
  assert.deepEqual(admission.info(), { active: 1, queued: 1, maxQueued: 128 })
  t.mock.timers.tick(1000)
  assert.deepEqual(admission.info(), { active: 1, queued: 0, maxQueued: 128 })
  await Promise.all([owner.settled, cancelled.settled, expiring.settled])
  assert.equal(cancelled.error, reason)
  assert.equal(expiring.error.status, 429)
  assert.match(expiring.error.message, /Reopen the file/)
  owner.release()
  assert.equal(started(cancelled), false)
  assert.equal(started(expiring), false)
  assert.deepEqual(admission.info(), { active: 0, queued: 0, maxQueued: 128 })
  const aborted = new AbortController()
  aborted.abort(reason)
  await assert.rejects(
    admission.acquire({
      actor: 'dave',
      projectId: 'four',
      signal: aborted.signal,
      onStatus: () => assert.fail('An aborted tab received a notice'),
    }),
    reason,
  )
  const retry = open('carol', 'three')
  await retry.settled
  assert.deepEqual(retry.notices, [STARTING])
})

test('an overdue tab cannot start when a release arrives before the next poll', async (t) => {
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const { admission, open } = editors(t, { maxWaitMs: 1000 })
  const owner = open('alice', 'one')
  const overdue = open('bob', 'two')
  await owner.settled
  now += 1000
  owner.release()
  await overdue.settled
  assert.equal(overdue.error.status, 429)
  assert.equal(started(overdue), false)
  assert.deepEqual(admission.info(), { active: 0, queued: 0, maxQueued: 128 })
})

test('capacity probes hold new starts after a worker loss and resume on recovery without oversubscribing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const { admission, pool, open } = editors(t, { capacity: 2 })
  const first = open('alice', 'one')
  const second = open('bob', 'two')
  const third = open('carol', 'three')
  const fourth = open('dave', 'four')
  await Promise.all([first.settled, second.settled])
  pool.capacity = 1
  t.mock.timers.tick(POLL)
  assert.deepEqual(admission.info(), { active: 2, queued: 2, maxQueued: 128 })
  first.release()
  t.mock.timers.tick(POLL * 2)
  assert.equal(started(third), false)
  assert.deepEqual(admission.info(), { active: 1, queued: 2, maxQueued: 128 })
  pool.capacity = new Error('Fixture controller unavailable')
  second.release()
  t.mock.timers.tick(POLL * 2)
  assert.equal(started(third), false)
  assert.deepEqual(admission.info(), { active: 0, queued: 2, maxQueued: 128 })
  pool.capacity = 3
  t.mock.timers.tick(POLL)
  await Promise.all([third.settled, fourth.settled])
  assert.equal(typeof third.release, 'function')
  assert.equal(typeof fourth.release, 'function')
  assert.deepEqual(admission.info(), { active: 2, queued: 0, maxQueued: 128 })
})

test('a revoked start check or failed status delivery refuses only that tab without keeping its slot', async (t) => {
  const { admission, open } = editors(t)
  const owner = open('alice', 'one')
  const revoked = Object.assign(new Error('Project access was removed.'), {
    status: 403,
  })
  const removed = open('bob', 'two', {
    canStart: () => {
      throw revoked
    },
  })
  const startFailure = new Error('Fixture start notice failed')
  const unsent = open('carol', 'three', {
    onStatus: (notice) => {
      if (notice.state === 'starting') throw startFailure
    },
  })
  const waitFailure = new Error('Fixture waiting notice failed')
  const silent = open('dave', 'four', {
    onStatus: (notice) => {
      if (notice.state === 'waiting') throw waitFailure
    },
  })
  const next = open('erin', 'five')
  await Promise.all([owner.settled, silent.settled])
  assert.equal(silent.error, waitFailure)
  assert.deepEqual(next.notices.at(-1), waiting(3, 3))
  assert.deepEqual(admission.info(), { active: 1, queued: 3, maxQueued: 128 })
  owner.release()
  await Promise.all([removed.settled, unsent.settled, next.settled])
  assert.equal(removed.error, revoked)
  assert.equal(removed.release, null)
  assert.equal(unsent.error, startFailure)
  assert.equal(unsent.release, null)
  assert.equal(typeof next.release, 'function')
  assert.deepEqual(admission.info(), { active: 1, queued: 0, maxQueued: 128 })
  next.release()
  assert.deepEqual(admission.info(), { active: 0, queued: 0, maxQueued: 128 })
})

test('an abort before the grant frees the slot while an abort after it leaves the caller holding release', async (t) => {
  const { admission, open } = editors(t)
  const owner = open('alice', 'one')
  const duringStart = new Error('Fixture tab closed while starting')
  const racing = open('bob', 'two', {
    onStatus: (notice) => {
      if (notice.state === 'starting') racing.controller.abort(duringStart)
    },
  })
  const granted = open('carol', 'three')
  const duringCheck = new Error('Fixture tab closed during the start check')
  const checking = open('dave', 'four', {
    canStart: () => {
      checking.controller.abort(duringCheck)
      return true
    },
  })
  await owner.settled
  owner.release()
  assert.ok(started(granted))
  granted.controller.abort(new Error('Fixture tab closed after the grant'))
  await Promise.all([racing.settled, granted.settled])
  assert.equal(racing.error, duringStart)
  assert.equal(racing.release, null)
  assert.equal(granted.error, null)
  assert.equal(typeof granted.release, 'function')
  assert.deepEqual(admission.info(), { active: 1, queued: 1, maxQueued: 128 })
  granted.release()
  await checking.settled
  assert.equal(checking.error, duringCheck)
  assert.equal(started(checking), false)
  assert.deepEqual(admission.info(), { active: 0, queued: 0, maxQueued: 128 })
})

test('close refuses waiting and new tabs while running editors keep their slots until released', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const { admission, open } = editors(t, { capacity: 2 })
  const running = open('alice', 'one')
  let checks = 0
  const queued = open('bob', 'two', {
    canStart: () => {
      checks++
      return false
    },
  })
  t.mock.timers.tick(POLL)
  assert.ok(checks >= 2)
  admission.close()
  const seen = checks
  t.mock.timers.tick(POLL * 4)
  assert.equal(checks, seen)
  await Promise.all([running.settled, queued.settled])
  assert.equal(queued.error.status, 503)
  assert.equal(started(queued), false)
  assert.deepEqual(admission.info(), { active: 1, queued: 0, maxQueued: 128 })
  assert.throws(() => admission.assertCanQueue('carol'), { status: 503 })
  const late = open('carol', 'three')
  await late.settled
  assert.equal(late.error.status, 503)
  running.release()
  running.release()
  assert.deepEqual(admission.info(), { active: 0, queued: 0, maxQueued: 128 })
  admission.close()
})

test('invalid limits, probes or tab identities are rejected before admitting editors', async () => {
  const valid = { capacity: () => 1, maxPerUser: 1, maxPerProject: 1 }
  assert.throws(() => new EditorAdmission({ ...valid, capacity: 1 }))
  assert.throws(() => new EditorAdmission({ ...valid, maxPerUser: undefined }))
  for (const key of ['maxPerUser', 'maxPerProject', 'maxWaitMs', 'pollMs'])
    for (const value of [0, -1, 1.5, NaN, Infinity, '2'])
      assert.throws(() => new EditorAdmission({ ...valid, [key]: value }))
  for (const key of ['maxQueued', 'maxQueuedPerUser'])
    for (const value of [-1, 1.5, NaN, Infinity, '2'])
      assert.throws(() => new EditorAdmission({ ...valid, [key]: value }))
  const admission = new EditorAdmission({
    ...valid,
    maxQueued: 0,
    maxQueuedPerUser: 0,
  })
  await assert.rejects(admission.acquire({ actor: '', projectId: 'one' }), {
    name: 'TypeError',
  })
  await assert.rejects(admission.acquire({ actor: 'alice' }), {
    name: 'TypeError',
  })
  assert.deepEqual(admission.info(), { active: 0, queued: 0, maxQueued: 0 })
  admission.close()
})
