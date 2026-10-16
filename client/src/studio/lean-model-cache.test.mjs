import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const code = ts.transpileModule(
  fs.readFileSync(new URL('./leanModelCache.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText
const uri = (path) => 'file:///workspace/' + path
const a = uri('A.lean'),
  b = uri('B.lean'),
  c = uri('C.lean')

function fixture() {
  const models = new Map([a, b, c].map((key) => [key, { text: key }]))
  const requests = [],
    released = [],
    notices = [],
    timers = new Map()
  let now = 0,
    nextTimer = 0,
    load
  const module = { exports: {} }
  new Function(
    'exports',
    'module',
    'require',
    'setTimeout',
    'clearTimeout',
    code,
  )(
    module.exports,
    module,
    (name) => {
      if (name === 'monaco-editor')
        return {
          Uri: {
            parse: (value) => ({
              path: new URL(value).pathname,
              toString: () => value,
            }),
          },
          editor: {
            getModel: (resource) => {
              const model = models.get(resource.toString())
              return model && { getValueLength: () => model.text.length }
            },
          },
        }
      if (name === 'vscode/monaco')
        return {
          createModelReference: async (...args) => {
            requests.push(args)
            if (load) await load
            const key = args[0].toString()
            return {
              object: {
                textEditorModel: {
                  getValueLength: () => models.get(key).text.length,
                },
              },
              dispose: () => released.push(key),
            }
          },
        }
      throw new Error('Unexpected import: ' + name)
    },
    (callback, delay) => {
      const id = ++nextTimer
      timers.set(id, { callback, at: now + delay })
      return id
    },
    (id) => timers.delete(id),
  )
  const cache = new module.exports.LeanModelCache(() =>
    notices.push('released'),
  )
  return {
    cache,
    requests,
    released,
    notices,
    models,
    async visit(key) {
      cache.select(key)
      await cache.retain(key)
    },
    pending(promise) {
      load = promise
    },
    advance(delta) {
      now += delta
      for (const [id, timer] of timers)
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
    },
  }
}

test('a recent file retains the same model reference without writing or reopening it', async () => {
  const f = fixture()
  await f.visit(a)
  await f.visit(b)
  await f.visit(a)
  assert(f.cache.has(a) && f.cache.has(b))
  assert.equal(f.requests.length, 2)
  assert(f.requests.every((args) => args.length === 1))
  assert.deepEqual(f.released, [])
  f.cache.dispose()
  assert.deepEqual(new Set(f.released), new Set([a, b]))
  assert.equal(f.notices.length, 0)
})

test('only the visible model and one recent project file remain retained', async () => {
  const f = fixture()
  await f.visit(a)
  await f.visit(b)
  await f.visit(c)
  assert(!f.cache.has(a) && f.cache.has(b) && f.cache.has(c))
  assert.deepEqual(f.released, [a])
  f.cache.select(uri('Notes.md'))
  assert(!f.cache.has(b) && f.cache.has(c))
  f.cache.select(null)
  assert(!f.cache.has(c))
  assert.deepEqual(f.released, [a, b, c])
  f.cache.dispose()
})

test('inactive entries expire after a minute while the current file remains retained', async () => {
  const f = fixture()
  await f.visit(a)
  f.advance(120_000)
  assert(f.cache.has(a))
  await f.visit(b)
  f.advance(59_000)
  assert(f.cache.has(a))
  await f.visit(a)
  f.advance(60_000)
  assert(f.cache.has(a) && !f.cache.has(b))
  assert.deepEqual(f.released, [b])
  f.cache.dispose()
})

test('hidden edits, saved revisions, deletions and setup changes invalidate cached imports', async () => {
  for (const change of ['hidden edit', 'save', 'remove', 'configuration']) {
    const f = fixture()
    const initial = new Map([
      ['A.lean', { content: 'old', hash: 'old' }],
      ['B.lean', { content: 'import A', hash: 'b' }],
      ['lakefile.toml', { content: 'name="fixture"', hash: 'config' }],
    ])
    f.cache.reconcile(initial)
    await f.visit(a)
    await f.visit(b)
    await f.visit(a)
    // Merely selecting/refetching a file does not change its source revision.
    f.cache.reconcile(
      new Map(
        [...initial].map(([key, value]) => [key, { ...value, generation: 2 }]),
      ),
    )
    assert(f.cache.has(b))
    const changed = new Map(initial)
    if (change === 'hidden edit')
      changed.set('B.lean', { content: 'changed by rename', hash: 'b' })
    if (change === 'save')
      changed.set('A.lean', { content: 'old', hash: 'new' })
    if (change === 'remove') {
      changed.delete('B.lean')
      f.cache.removePaths(['B.lean'])
    }
    if (change === 'configuration')
      changed.set('lakefile.toml', { content: 'changed', hash: 'config' })
    f.cache.reconcile(changed)
    assert(f.cache.has(a) && !f.cache.has(b), change)
    f.cache.dispose()
  }
})

test('typing in the visible file keeps cached importers until the source is saved', async () => {
  const f = fixture()
  const initial = new Map([
    ['A.lean', { content: 'old', hash: 'old' }],
    ['B.lean', { content: 'import A', hash: 'b' }],
  ])
  f.cache.reconcile(initial, 'A.lean')
  await f.visit(a)
  await f.visit(b)
  await f.visit(a)
  const changed = new Map(initial)
  changed.set('A.lean', { content: 'unsaved', hash: 'old' })
  f.cache.reconcile(changed, 'A.lean')
  assert(f.cache.has(a) && f.cache.has(b))
  const saved = new Map(changed)
  saved.set('A.lean', { content: 'unsaved', hash: 'saved' })
  f.cache.reconcile(saved, 'A.lean')
  assert(f.cache.has(a) && !f.cache.has(b))
  f.cache.dispose()
})

test('document edits do not invalidate Lean, and large/library sources are not retained', async () => {
  const f = fixture()
  const initial = new Map([['Notes.md', { content: 'old', hash: 'old' }]])
  f.cache.reconcile(initial)
  await f.visit(a)
  await f.visit(b)
  f.cache.reconcile(new Map([['Notes.md', { content: 'new', hash: 'new' }]]))
  assert(f.cache.has(a))
  f.models.get(b).text = 'x'.repeat(256 * 1024 + 1)
  await f.visit(c)
  assert(!f.cache.has(b))
  for (const key of [uri('.lake/packages/lib/Main.lean'), uri('Notes.md')]) {
    await f.visit(key)
    assert(!f.cache.has(key))
  }
  f.cache.dispose()
})

test('project disposal releases a model acquired while the project was closing', async () => {
  const f = fixture()
  let release
  f.pending(
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const retaining = f.visit(a)
  f.cache.dispose()
  release()
  await retaining
  assert(!f.cache.has(a))
  assert.deepEqual(f.released, [a])
  f.advance(120_000)
  assert.equal(f.notices.length, 0)
})

test('dropping clean UI buffers preserves warm files but a refetched revision invalidates importers', async () => {
  const f = fixture()
  const main = { content: 'main', hash: 'a' },
    other = { content: 'other', hash: 'b' }
  f.cache.reconcile(new Map([['A.lean', main]]), 'A.lean')
  await f.visit(a)
  f.cache.reconcile(new Map([['B.lean', other]]), 'B.lean')
  await f.visit(b)
  f.cache.reconcile(new Map([['A.lean', { ...main, generation: 2 }]]), 'A.lean')
  await f.visit(a)
  assert(f.cache.has(a) && f.cache.has(b))
  f.cache.reconcile(
    new Map([['B.lean', { content: 'changed on disk', hash: 'new' }]]),
    'B.lean',
  )
  assert(f.cache.has(b) && !f.cache.has(a))
  f.cache.dispose()
})

test('opening a large file releases cached workers before its elaboration starts', async () => {
  const f = fixture()
  await f.visit(a)
  f.cache.reconcile(
    new Map([
      ['B.lean', { content: 'x'.repeat(256 * 1024 + 1), hash: 'large' }],
    ]),
    'B.lean',
  )
  assert(!f.cache.has(a))
  f.cache.dispose()
})
