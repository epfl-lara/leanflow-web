import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { streamRunEvents } from '../event-stream.mjs'

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
