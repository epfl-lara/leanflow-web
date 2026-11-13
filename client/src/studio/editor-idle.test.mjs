import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function load(name) {
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  )
  const module = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(
    module,
    module.exports,
    (name) => load(name.slice(2)),
  )
  return module.exports
}
const { editorIdle, EDITOR_IDLE_MS } = load('editorIdle')
const { listenForUserActivity } = load('userActivity')

test('an unattended editor sleeps once at the deadline and wakes only on activity', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  let sleeps = 0,
    wakes = 0
  const idle = editorIdle(
    () => sleeps++,
    () => wakes++,
  )
  t.mock.timers.tick(EDITOR_IDLE_MS - 1)
  assert.equal(sleeps, 0)
  t.mock.timers.tick(1)
  assert.equal(sleeps, 1)
  t.mock.timers.tick(10 * EDITOR_IDLE_MS)
  assert.equal(sleeps, 1)
  assert.equal(wakes, 0)
  idle.activity()
  idle.activity()
  assert.equal(wakes, 1)
  t.mock.timers.tick(EDITOR_IDLE_MS)
  assert.equal(sleeps, 2)
  idle.dispose()
})

test('reading and editing activity extends the idle deadline, and disposal prevents later sleep or wake', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  let sleeps = 0,
    wakes = 0
  const idle = editorIdle(
    () => sleeps++,
    () => wakes++,
  )
  t.mock.timers.tick(EDITOR_IDLE_MS / 2)
  idle.activity()
  t.mock.timers.tick(EDITOR_IDLE_MS / 2)
  assert.equal(sleeps, 0)
  t.mock.timers.tick(EDITOR_IDLE_MS / 2)
  assert.equal(sleeps, 1)
  idle.dispose()
  idle.activity()
  t.mock.timers.tick(EDITOR_IDLE_MS * 2)
  assert.equal(sleeps, 1)
  assert.equal(wakes, 0)
})

test('user activity ignores background keepalives, hidden pages and synthetic events; all listeners are removed', () => {
  const handlers = new Map()
  const target = {
    visibilityState: 'visible',
    addEventListener(name, listener, options) {
      assert.deepEqual(options, { capture: true, passive: true })
      handlers.set(name, listener)
    },
    removeEventListener(name, listener, capture) {
      assert.equal(capture, true)
      assert.equal(handlers.get(name), listener)
      handlers.delete(name)
    },
  }
  let activities = 0
  const stop = listenForUserActivity(target, () => activities++)
  assert.equal(handlers.has('message'), false)
  handlers.get('keydown')({ isTrusted: false })
  assert.equal(activities, 0)
  target.visibilityState = 'hidden'
  handlers.get('wheel')({ isTrusted: true })
  assert.equal(activities, 0)
  target.visibilityState = 'visible'
  for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart'])
    handlers.get(name)({ isTrusted: true })
  assert.equal(activities, 4)
  stop()
  assert.equal(handlers.size, 0)
})
