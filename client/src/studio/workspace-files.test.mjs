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
const { ApiError } = load('./api.ts')
const { WorkspaceBuffers } = load('./workspaceBuffers.ts')
const { reconcileMissingBuffers, refreshChangedBuffers } = load(
  './workspaceFiles.ts',
  {
    './api': { ApiError },
  },
)
const file = (
  path,
  content = 'saved',
  generation = 1,
  hash = 'a'.repeat(64),
) => ({ path, content, savedContent: content, generation, hash })
function fixture() {
  const store = new WorkspaceBuffers()
  store.selectProject('shared')
  return store
}

test('a stale or bounded listing cannot detach a source that still exists', async () => {
  const store = fixture()
  store.setFile(file('Existing.lean'))
  store.change('Existing.lean', 'new local draft')
  const before = store.getSnapshot()
  const reads = []
  await reconcileMissingBuffers(store, before.scope, [], async (path) => {
    reads.push(path)
    return { content: 'saved' }
  })
  assert.deepEqual(reads, ['Existing.lean'])
  assert.equal(store.getSnapshot(), before)
})

test('confirmed missing ordinary-save files keep their drafts without blocking a healthy dirty file', async () => {
  const store = fixture()
  store.setFile(file('lakefile.toml'))
  store.change('lakefile.toml', 'configuration draft')
  store.setFile(file('Fallback.lean'))
  store.change('Fallback.lean', 'fallback draft')
  store.setFile(file('Healthy.lean'))
  store.change('Healthy.lean', 'healthy draft')
  await reconcileMissingBuffers(
    store,
    store.getSnapshot().scope,
    ['Healthy.lean'],
    async () => {
      throw new ApiError('Missing', 404)
    },
  )
  assert.deepEqual(
    store.dirty().map(({ path }) => path),
    ['Healthy.lean'],
  )
  assert.equal(
    store.getSnapshot().buffers.get('lakefile.toml').content,
    'configuration draft',
  )
  assert.equal(
    store.getSnapshot().buffers.get('Fallback.lean').unavailable,
    true,
  )
})

for (const replacement of ['visit', 'reload', 'save'])
  test(`a delayed missing-file response cannot detach a newer ${replacement}`, async () => {
    const store = fixture()
    store.setFile(file('Main.lean'))
    const scope = store.getSnapshot().scope
    let reject
    const pending = new Promise((_, fail) => {
      reject = fail
    })
    const reconciling = reconcileMissingBuffers(store, scope, [], () => pending)
    if (replacement === 'visit') {
      store.selectProject('other')
      store.selectProject('shared')
    }
    store.setFile(
      file(
        'Main.lean',
        'new saved source',
        replacement === 'reload' ? 2 : 1,
        replacement === 'save' ? 'b'.repeat(64) : 'a'.repeat(64),
      ),
    )
    reject(new ApiError('Old missing result', 404))
    await reconciling
    assert.equal(store.getSnapshot().file.unavailable, undefined)
    assert.equal(store.getSnapshot().file.content, 'new saved source')
  })

test('storage and access errors never masquerade as a deleted file', async () => {
  for (const status of [401, 403, 429, 503]) {
    const store = fixture()
    store.setFile(file('Main.lean'))
    const before = store.getSnapshot()
    await reconcileMissingBuffers(store, before.scope, [], async () => {
      throw new ApiError('Unavailable', status)
    })
    assert.equal(store.getSnapshot(), before)
  }
})

test('reference updates refresh clean active and retained buffers without opening other files', async () => {
  const store = fixture()
  store.register(
    ['Main.lean', 'Notes.md', 'Unrelated.lean'].map((path) => ({
      uri: `file:///workspace/${path}`,
      path,
      content: 'saved',
      hash: 'a'.repeat(64),
      unsaved: false,
    })),
  )
  store.setFile(file('Main.lean'))
  const reads = []
  const result = await refreshChangedBuffers(
    store,
    store.getSnapshot().scope,
    ['Main.lean', 'Notes.md', 'Closed.md'],
    async (path) => {
      reads.push(path)
      return { content: 'updated ' + path, hash: 'b'.repeat(64) }
    },
  )
  assert.deepEqual(reads, ['Main.lean', 'Notes.md'])
  assert.deepEqual(result, { pendingPaths: [], failedPaths: [] })
  assert.equal(store.getSnapshot().file.path, 'Main.lean')
  for (const path of reads) {
    const current = store.getSnapshot().buffers.get(path)
    assert.equal(current.content, 'updated ' + path)
    assert.equal(current.savedContent, current.content)
    assert.equal(current.hash, 'b'.repeat(64))
  }
  assert.equal(
    store.getSnapshot().buffers.get('Unrelated.lean').content,
    'saved',
  )
})

test('reference refresh preserves existing drafts and typing that arrives during its read', async () => {
  const store = fixture()
  store.setFile(file('Main.lean'))
  store.change('Main.lean', 'draft before refresh')
  const baseline = store.getSnapshot().file
  const result = await refreshChangedBuffers(
    store,
    store.getSnapshot().scope,
    ['Main.lean'],
    async () => {
      assert.fail('Dirty files must not be replaced by a reference refresh')
    },
  )
  assert.deepEqual(result.pendingPaths, ['Main.lean'])
  assert.equal(store.getSnapshot().file, baseline)

  store.setFile(file('Main.lean'))
  let finish
  const reading = new Promise((resolve) => {
    finish = resolve
  })
  const refreshing = refreshChangedBuffers(
    store,
    store.getSnapshot().scope,
    ['Main.lean'],
    () => reading,
  )
  store.change('Main.lean', 'typed during refresh')
  finish({ content: 'updated references', hash: 'b'.repeat(64) })
  assert.deepEqual((await refreshing).pendingPaths, ['Main.lean'])
  assert.equal(store.getSnapshot().file.content, 'typed during refresh')
  assert.equal(store.getSnapshot().file.savedContent, 'saved')
  assert.equal(store.getSnapshot().file.hash, 'a'.repeat(64))
})

for (const replacement of ['visit', 'reload', 'save', 'move'])
  test(`a delayed reference refresh cannot replace a newer ${replacement}`, async () => {
    const store = fixture()
    store.setFile(file('Main.lean'))
    let finish
    const reading = new Promise((resolve) => {
      finish = resolve
    })
    const refreshing = refreshChangedBuffers(
      store,
      store.getSnapshot().scope,
      ['Main.lean'],
      () => reading,
    )
    if (replacement === 'visit') {
      store.selectProject('other')
      store.selectProject('shared')
    }
    if (replacement === 'move') store.move('Main.lean', 'Moved.lean')
    const path = replacement === 'move' ? 'Moved.lean' : 'Main.lean'
    store.setFile(
      file(
        path,
        'new saved source',
        replacement === 'reload' ? 2 : 1,
        replacement === 'save' ? 'c'.repeat(64) : 'a'.repeat(64),
      ),
    )
    finish({ content: 'older reference response', hash: 'b'.repeat(64) })
    await refreshing
    assert.equal(store.getSnapshot().file.path, path)
    assert.equal(store.getSnapshot().file.content, 'new saved source')
    assert.equal(store.getSnapshot().file.savedContent, 'new saved source')
  })

test('live-managed files stay with collaboration even when admission changes during a read', async () => {
  const store = fixture()
  store.setFile(file('Main.lean'))
  const before = store.getSnapshot()
  await refreshChangedBuffers(
    store,
    before.scope,
    ['Main.lean'],
    async () => assert.fail('The live document owns this refresh'),
    () => true,
  )
  assert.equal(store.getSnapshot(), before)
  let finish,
    managed = false
  const refreshing = refreshChangedBuffers(
    store,
    before.scope,
    ['Main.lean'],
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
    () => managed,
  )
  managed = true
  finish({ content: 'updated references', hash: 'b'.repeat(64) })
  await refreshing
  assert.equal(store.getSnapshot(), before)
})

test('a failed reference refresh reports the file and preserves its editor baseline', async () => {
  const store = fixture()
  store.setFile(file('Main.lean'))
  const before = store.getSnapshot()
  const result = await refreshChangedBuffers(
    store,
    before.scope,
    ['Main.lean'],
    async () => {
      throw new ApiError('Unavailable', 503)
    },
  )
  assert.deepEqual(result, { pendingPaths: [], failedPaths: ['Main.lean'] })
  assert.equal(store.getSnapshot(), before)
})

test('confirmed missing clean tabs close even after their source buffer was released', async () => {
  const store = fixture()
  store.setFile(file('Old.lean'))
  store.setFile(file('OtherOld.lean'))
  store.setFile(file('Main.lean'))
  await reconcileMissingBuffers(
    store,
    store.getSnapshot().scope,
    ['Main.lean'],
    async () => {
      throw new ApiError('Removed', 404)
    },
  )
  assert.deepEqual(store.getSnapshot().openPaths, ['Main.lean'])
  assert.equal(store.getSnapshot().file.path, 'Main.lean')
})

test('a delayed missing-file response cannot close a reopened tab', async () => {
  const store = fixture()
  store.setFile(file('Old.lean'))
  store.setFile(file('Main.lean'))
  let reject
  const pending = new Promise((_, fail) => {
    reject = fail
  })
  const checking = reconcileMissingBuffers(
    store,
    store.getSnapshot().scope,
    ['Main.lean'],
    () => pending,
  )
  store.closeFile('Old.lean')
  store.setFile(file('Old.lean', 'restored source', 2))
  store.setFile(file('Main.lean'))
  reject(new ApiError('Old missing result', 404))
  await checking
  assert.deepEqual(store.getSnapshot().openPaths, ['Main.lean', 'Old.lean'])
})
