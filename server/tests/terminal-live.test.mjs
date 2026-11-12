import assert from 'node:assert/strict'
import test from 'node:test'
import { TerminalSourceMirror } from '../terminal-live.mjs'

test('private terminal publication is serial and shutdown waits for its final checked write', async () => {
  let release,
    calls = 0
  const first = new Promise((resolve) => {
    release = resolve
  })
  const mirror = new TerminalSourceMirror({
    snapshot: { runId: 'terminal' },
    workspaces: {
      async syncTerminal(_snapshot, previous) {
        calls++
        if (calls === 1) {
          assert.deepEqual(previous, [])
          await first
        } else
          assert.deepEqual(previous, [{ path: 'Main.lean', after: 'first' }])
        return [{ path: 'Main.lean', after: calls === 1 ? 'first' : 'final' }]
      },
    },
  })
  const polling = mirror.poll()
  assert.equal(mirror.poll(), polling)
  let stopped = false
  const stop = mirror.stop({ flush: true }).then(() => {
    stopped = true
  })
  await Promise.resolve()
  assert.equal(stopped, false)
  release()
  await stop
  assert.equal(calls, 2)
  assert.deepEqual(mirror.changes, [{ path: 'Main.lean', after: 'final' }])
  await mirror.poll()
  assert.equal(calls, 2)
})

test('a terminal publication conflict pauses once and preserves the candidate for recovery', async () => {
  const conflicts = []
  let calls = 0
  const mirror = new TerminalSourceMirror({
    snapshot: { runId: 'terminal' },
    workspaces: {
      syncTerminal() {
        calls++
        throw Object.assign(new Error('Main.lean changed in another tab.'), {
          status: 409,
        })
      },
    },
    onConflict: (error) => conflicts.push(error.message),
  })
  await mirror.poll()
  await mirror.poll()
  await mirror.stop({ flush: true })
  assert.equal(calls, 1)
  assert.deepEqual(conflicts, ['Main.lean changed in another tab.'])
  assert.equal(mirror.paused, true)
})

test('a changing private file retries from the last publication, but a failed final scan retains recovery', async () => {
  const published = [{ path: 'Main.lean', after: 'published' }]
  const errors = []
  let calls = 0
  const mirror = new TerminalSourceMirror({
    workspaces: {
      async syncTerminal(_snapshot, previous) {
        if (++calls === 1) return published
        assert.deepEqual(previous, published)
        throw Object.assign(new Error('Private files are changing.'), {
          code: 'TERMINAL_SOURCE_CHANGED',
          status: 503,
        })
      },
    },
    onError: (error) => errors.push(error.message),
  })
  await mirror.poll()
  await mirror.poll()
  assert.equal(mirror.paused, false)
  assert.deepEqual(mirror.changes, published)
  assert.deepEqual(errors, [])
  await mirror.stop({ flush: true })
  assert.equal(mirror.paused, true)
  assert.deepEqual(errors, ['Private files are changing.'])
})

test('closing during a transient ordinary scan still performs its final checked publication', async () => {
  let finishScan, entered
  const scanning = new Promise((resolve) => {
    entered = resolve
  })
  const first = new Promise((_, reject) => {
    finishScan = reject
  })
  const errors = []
  let calls = 0
  const final = [{ path: 'Final.lean', after: '-- final\n' }]
  const mirror = new TerminalSourceMirror({
    workspaces: {
      async syncTerminal() {
        if (++calls === 1) {
          entered()
          return first
        }
        return final
      },
    },
    onError: (error) => errors.push(error),
  })
  const polling = mirror.poll()
  await scanning
  const stopping = mirror.stop({ flush: true })
  finishScan(
    Object.assign(new Error('Temporary private scan race.'), {
      code: 'TERMINAL_SOURCE_CHANGED',
      status: 503,
    }),
  )
  await Promise.all([polling, stopping])
  assert.equal(calls, 2)
  assert.equal(mirror.paused, false)
  assert.deepEqual(mirror.changes, final)
  assert.deepEqual(errors, [])
})
