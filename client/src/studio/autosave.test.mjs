import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

function load(name, imports = {}) {
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL(name, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  )
  const module = { exports: {} }
  new Function('exports', 'module', 'require', outputText)(
    module.exports,
    module,
    (specifier) => {
      if (specifier in imports) return imports[specifier]
      throw new Error(`Unexpected module ${specifier}`)
    },
  )
  return module.exports
}
const { ApiError, errorText } = load('./api.ts')
const { WorkspaceBuffers } = load('./workspaceBuffers.ts')
const source = (path) => ({
  path,
  content: 'saved',
  savedContent: 'saved',
  hash: 'a'.repeat(64),
  generation: 1,
})
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function fixture(t, save) {
  const originals = Object.fromEntries(
    ['window', 'document', 'navigator'].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  )
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: new EventTarget(),
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true },
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let cleanup
  const { useAutosave } = load('./useAutosave.ts', {
    react: {
      useCallback: (fn) => fn,
      useRef: (current) => ({ current }),
      useState: (initial) => [initial, () => {}],
      useEffect: (fn) => {
        cleanup = fn()
      },
    },
    './api': { ApiError, errorText },
    './workspaceBuffers': { WorkspaceBuffers },
  })
  const store = new WorkspaceBuffers()
  store.selectProject('shared')
  const controls = useAutosave({
    store,
    scope: store.getSnapshot().scope,
    enabled: true,
    save: () => save(store),
  })
  t.after(() => {
    cleanup?.()
    t.mock.timers.reset()
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  return { store, controls }
}

test('removing a failed batch member resumes autosaving the healthy files without losing its draft', async (t) => {
  const calls = []
  const { store } = fixture(t, async (store) => {
    const snapshots = store.dirty()
    calls.push(snapshots.map(({ path }) => path))
    if (calls.length === 1) {
      store.detach('Gone.lean')
      throw new ApiError('Gone.lean was removed before the batch saved.', 409)
    }
    store.saved(
      snapshots,
      snapshots.map(({ path }) => ({ path, hash: 'b'.repeat(64) })),
    )
  })
  store.setFile(source('Gone.lean'))
  store.change('Gone.lean', 'preserved draft')
  store.setFile(source('Healthy.lean'))
  store.change('Healthy.lean', 'healthy draft')
  t.mock.timers.tick(1500)
  await settle()
  t.mock.timers.tick(1500)
  await settle()
  assert.deepEqual(calls, [['Gone.lean', 'Healthy.lean'], ['Healthy.lean']])
  assert.equal(
    store.getSnapshot().buffers.get('Healthy.lean').savedContent,
    'healthy draft',
  )
  assert.equal(store.drafts()[0].content, 'preserved draft')
  assert.equal(store.drafts()[0].unavailable, true)
})

test('typing against the same conflicting saved version does not silently retry an overwrite', async (t) => {
  let calls = 0
  const { store } = fixture(t, async () => {
    calls++
    throw new ApiError('Version conflict', 409)
  })
  store.setFile(source('Main.lean'))
  store.change('Main.lean', 'local draft')
  t.mock.timers.tick(1500)
  await settle()
  store.change('Main.lean', 'more local typing')
  t.mock.timers.tick(30_000)
  await settle()
  assert.equal(calls, 1)
  assert.equal(store.drafts()[0].content, 'more local typing')
})
