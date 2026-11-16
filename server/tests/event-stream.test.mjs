import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { eventStreamAdmission, streamRunEvents } from '../event-stream.mjs'

const tick = () => new Promise((resolve) => setImmediate(resolve))
function fixture(t, count = 0) {
  const events = new EventEmitter(),
    request = new EventEmitter(),
    response = new EventEmitter()
  const stored = [],
    written = [],
    reads = []
  const add = (count) => {
    for (let index = 0; index < count; index++) {
      const event = {
        seq: stored.length + 1,
        type: 'message',
        data: { text: 'fixture' },
      }
      stored.push(event)
      events.emit('run', event)
    }
  }
  events.eventPage = (id, after) => {
    assert.equal(id, 'run')
    reads.push(after)
    return stored.filter((event) => event.seq > after).slice(0, 100)
  }
  response.write = (text) => {
    written.push(text)
    return true
  }
  response.destroy = () => response.emit('close')
  add(count)
  t.after(() => response.emit('close'))
  return { events, request, response, stored, written, reads, add }
}

test('replay yields between pages and delivers subsequent live events without gaps', async (t) => {
  const f = fixture(t, 350)
  streamRunEvents(f.request, f.response, f.events, 'run', 40)
  await tick()
  assert.equal(f.written.length, 100)
  f.add(25)
  for (let i = 0; i < 6; i++) await tick()
  const received = f.written.map((text) => Number(/^id: (\d+)/.exec(text)[1]))
  assert.deepEqual(
    received,
    f.stored.slice(40).map((event) => event.seq),
  )
  assert(f.reads.length <= 6)
})

test('slow readers pause replay and live writes until drain without queuing more events', async (t) => {
  const f = fixture(t, 250)
  let ready = false
  f.response.write = (text) => {
    f.written.push(text)
    return ready
  }
  streamRunEvents(f.request, f.response, f.events, 'run', 0)
  await tick()
  assert.equal(f.written.length, 1)
  f.add(5000)
  await tick()
  assert.equal(f.written.length, 1)
  assert.equal(f.reads.length, 1)
  assert.equal(f.response.listenerCount('drain'), 1)
  ready = true
  f.response.emit('drain')
  for (let i = 0; i < 55; i++) await tick()
  assert.equal(f.written.length, 5250)
  assert.deepEqual(
    f.written.map((text) => Number(/^id: (\d+)/.exec(text)[1])),
    f.stored.map((event) => event.seq),
  )
})

test('disconnect removes subscriptions and pending replay including a blocked drain', async (t) => {
  const f = fixture(t, 200)
  f.response.write = () => false
  streamRunEvents(f.request, f.response, f.events, 'run', 0)
  await tick()
  f.response.emit('close')
  f.add(10)
  f.response.emit('drain')
  await tick()
  assert.equal(f.reads.length, 1)
  assert.equal(f.events.listenerCount('run'), 0)
  assert.equal(f.response.listenerCount('drain'), 0)
  assert.equal(f.request.listenerCount('aborted'), 0)
})

test('storage failures close the stream instead of leaving a live subscription', async (t) => {
  const f = fixture(t)
  f.events.eventPage = () => {
    throw new Error('Fixture storage failure')
  }
  streamRunEvents(f.request, f.response, f.events, 'run', 0)
  await tick()
  assert.equal(f.events.listenerCount('run'), 0)
  assert.equal(f.request.listenerCount('aborted'), 0)
})

test('an open event stream stops before private output after its account credential is revoked', async (t) => {
  const f = fixture(t, 1)
  let authorized = true,
    ended = false
  f.response.end = () => {
    ended = true
    f.response.emit('close')
  }
  streamRunEvents(f.request, f.response, f.events, 'run', 0, {
    isAuthorized: () => authorized,
  })
  await tick()
  assert.equal(f.written.length, 1)
  authorized = false
  f.add(1)
  await tick()
  assert.equal(f.written.length, 1)
  assert.equal(ended, true)
  assert.equal(f.events.listenerCount('run'), 0)
})

test('live stream admission bounds accounts and total connections and releases each place once', () => {
  const admit = eventStreamAdmission({ maxConcurrent: 2, maxPerUser: 1 })
  const response = () => {
    const res = new EventEmitter()
    res.setHeader = (key, value) => {
      res[key] = value
    }
    res.status = (value) => {
      res.statusCode = value
      return res
    }
    res.json = (value) => {
      res.body = value
      return res
    }
    return res
  }
  const alice = { user: { id: 'alice' } },
    bob = { user: { id: 'bob' } },
    carol = { user: { id: 'carol' } }
  const first = response(),
    second = response(),
    rejected = response()
  assert.equal(admit(alice, first), true)
  assert.equal(admit(alice, rejected), false)
  assert.equal(rejected.statusCode, 429)
  assert.equal(rejected['Retry-After'], '2')
  assert.match(rejected.body.error, /Live updates are busy/)
  assert.equal(admit(bob, second), true)
  assert.equal(admit(carol, response()), false)
  first.emit('finish')
  first.emit('close')
  const third = response()
  assert.equal(admit(carol, third), true)
  assert.equal(
    admit(alice, response()),
    false,
    'finish and close must not release twice',
  )
  second.emit('close')
  assert.equal(admit(bob, response()), true)
  third.emit('close')
})

test('invalid live stream limits fail before accepting connections', () => {
  for (const key of ['maxConcurrent', 'maxPerUser'])
    for (const value of [0, -1, NaN, Infinity, 1.5])
      assert.throws(
        () => eventStreamAdmission({ [key]: value }),
        /positive integers/,
      )
})
