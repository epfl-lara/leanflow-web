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
const { reconcileMissingBuffers } = load('./workspaceFiles.ts', {
  './api': { ApiError },
})
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
