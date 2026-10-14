import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
const { outputText } = ts.transpileModule(
  fs.readFileSync(new URL('./workspaceBuffers.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
)
const module = { exports: {} }
new Function('exports', 'module', outputText)(module.exports, module)
const { WorkspaceBuffers, renameSources } = module.exports
const hashA = 'a'.repeat(64),
  hashB = 'b'.repeat(64),
  hashC = 'c'.repeat(64)
const file = (
  path = 'Main.lean',
  content = 'def blank := 0',
  hash = hashA,
) => ({ path, content, savedContent: content, hash, generation: 1 })
const source = (path, content, hash = hashA, unsaved = false) => ({
  uri: `file:///workspace/${path}`,
  path,
  content,
  hash,
  unsaved,
})

test('workspace rename keeps every changed buffer and a save response preserves later typing', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file())
  store.change('Main.lean', 'def blank := 0\n-- user edit')
  store.register([
    source('Main.lean', 'def blank := 0\n-- user edit', hashA, true),
    source('Use.lean', '#check blank', hashB),
  ])
  store.change('Main.lean', 'def blankC := 0\n-- user edit')
  store.change('Use.lean', '#check blankC')
  const saving = store.dirty()
  assert.equal(saving.length, 2)
  store.change('Main.lean', 'def blankC := 0\n-- user edit\n-- later typing')
  store.saved(saving, [
    { path: 'Main.lean', hash: hashC },
    { path: 'Use.lean', hash: hashC },
  ])
  const current = store.getSnapshot().file
  assert.equal(
    current.content,
    'def blankC := 0\n-- user edit\n-- later typing',
  )
  assert.equal(current.savedContent, 'def blankC := 0\n-- user edit')
  assert.equal(current.hash, hashC)
  assert.equal(store.dirty().length, 1)
})

test('registering stale or unknown unsaved sources fails without changing any buffers', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file())
  const previous = store.getSnapshot()
  for (const sources of [
    [source('New.lean', 'new'), source('Main.lean', 'different')],
    [source('Main.lean', 'def blank := 0', hashB)],
    [source('New.lean', 'unsaved', hashA, true)],
  ]) {
    assert.throws(() => store.register(sources), /changed/)
    assert.equal(store.getSnapshot(), previous)
  }
})

test('discard and project reset cover hidden files as well as the current file', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file())
  store.register([
    source('Main.lean', 'def blank := 0'),
    source('Use.lean', '#check blank'),
  ])
  store.change('Main.lean', 'def new := 0')
  store.change('Use.lean', '#check new')
  store.discard(10)
  assert.equal(store.dirty().length, 0)
  assert.equal(
    store.getSnapshot().buffers.get('Use.lean').content,
    '#check blank',
  )
  assert.equal(store.getSnapshot().file.generation, 10)
  assert.equal(store.getSnapshot().discardVersion, 1)
  store.setFile(null)
  assert.equal(store.getSnapshot().buffers.size, 0)
})

test('workspace undo can restore all references without discarding preceding user edits', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file())
  store.change('Main.lean', 'def blank := 0\n-- unsaved')
  store.register([
    source('Main.lean', 'def blank := 0\n-- unsaved', hashA, true),
    source('Use.lean', '#check blank'),
  ])
  store.change('Main.lean', 'def renamed := 0\n-- unsaved')
  store.change('Use.lean', '#check renamed')
  store.change('Main.lean', 'def blank := 0\n-- unsaved')
  store.change('Use.lean', '#check blank')
  assert.equal(store.dirty().length, 1)
  assert.equal(store.getSnapshot().file.content, 'def blank := 0\n-- unsaved')
})

test('late save responses cannot rebase buffers that have been reloaded from another revision', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file())
  store.change('Main.lean', 'candidate')
  const snapshots = store.dirty()
  store.setFile(file('Main.lean', 'external version', hashB))
  store.saved(snapshots, [{ path: 'Main.lean', hash: hashC }])
  assert.equal(store.getSnapshot().file.hash, hashB)
  assert.equal(store.getSnapshot().file.content, 'external version')
})

test('rename source metadata rejects duplicate paths, foreign URIs, and malformed data', () => {
  const valid = source('Main.lean', 'def blank := 0')
  assert.deepEqual(renameSources([valid]), [valid])
  for (const input of [
    null,
    [],
    [valid, valid],
    [{ ...valid, uri: 'file:///other/Main.lean' }],
    [{ ...valid, path: '../Main.lean' }],
    [{ ...valid, hash: null }],
    [{ ...valid, unsaved: 'true' }],
    [{ ...valid, path: '.lake/Dep.lean' }],
  ])
    assert.throws(() => renameSources(input))
})

test('removing a file or folder keeps unrelated staged buffers and their dirty warnings', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file())
  store.register([
    source('Main.lean', 'def blank := 0'),
    source('Use/Extra.lean', '#check blank'),
  ])
  store.change('Use/Extra.lean', '#check blankC')
  store.remove('Main.lean')
  assert.equal(store.getSnapshot().file, null)
  assert.equal(store.dirty().length, 1)
  assert.equal(store.dirty()[0].path, 'Use/Extra.lean')
  store.remove('Use')
  assert.equal(store.dirty().length, 0)
  assert.equal(store.getSnapshot().buffers.size, 0)
})
