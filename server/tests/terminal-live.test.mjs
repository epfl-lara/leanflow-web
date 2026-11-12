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
