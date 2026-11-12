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
const { WorkspaceBuffers } = module.exports
const hash = 'a'.repeat(64)
const file = (path, content = 'saved') => ({
  path,
  content,
  savedContent: content,
  hash,
  generation: 1,
})

test('moving an open file keeps its unsaved text, hash and conflict baseline at the new path', () => {
  const store = new WorkspaceBuffers()
  store.selectProject('project')
  store.setFile(file('Old.lean'))
  store.change('Old.lean', 'typed while the move was running')
  store.move('Old.lean', 'Proofs/New.lean', 7)
  const state = store.getSnapshot()
  assert.equal(state.file.path, 'Proofs/New.lean')
  assert.equal(state.file.content, 'typed while the move was running')
  assert.equal(state.file.savedContent, 'saved')
  assert.equal(state.file.hash, hash)
  assert.equal(state.file.generation, 7)
  assert.equal(state.buffers.has('Old.lean'), false)
  assert.deepEqual(state.removedPaths, ['Old.lean'])
  // Autosave now targets only the new path.
  assert.deepEqual(
    store.dirty().map((entry) => entry.path),
    ['Proofs/New.lean'],
  )
})

test('moving a folder re-keys nested buffers and leaves lookalike siblings alone', () => {
  const store = new WorkspaceBuffers()
  store.selectProject('project')
  store.setFile(file('Dir/A.lean'))
  store.register([
    {
      uri: 'file:///workspace/Dir/B.lean',
      path: 'Dir/B.lean',
      content: 'b',
      hash,
      unsaved: false,
    },
    {
      uri: 'file:///workspace/Directory/C.lean',
      path: 'Directory/C.lean',
      content: 'c',
      hash,
      unsaved: false,
    },
  ])
  store.move('Dir', 'Moved', 3)
  const names = [...store.getSnapshot().buffers.keys()].sort()
  assert.deepEqual(names, ['Directory/C.lean', 'Moved/A.lean', 'Moved/B.lean'])
  assert.equal(store.getSnapshot().file.path, 'Moved/A.lean')
  assert.deepEqual([...store.getSnapshot().removedPaths].sort(), [
    'Dir/A.lean',
    'Dir/B.lean',
  ])
})

test('moving a path with no open buffers changes nothing', () => {
  const store = new WorkspaceBuffers()
  store.selectProject('project')
  store.setFile(file('Main.lean'))
  const before = store.getSnapshot()
  store.move('Other', 'Elsewhere', 2)
  assert.equal(store.getSnapshot(), before)
})

test('a move preserves both drafts when a stale destination buffer is dirty, regardless of insertion order', () => {
  for (const order of [
    ['Old.lean', 'Moved.lean'],
    ['Moved.lean', 'Old.lean'],
  ]) {
    const store = new WorkspaceBuffers()
    store.selectProject('project')
    store.register(
      order.map((name) => ({
        uri: `file:///workspace/${name}`,
        path: name,
        content: `saved ${name}`,
        hash,
        unsaved: false,
      })),
    )
    store.setFile(store.getSnapshot().buffers.get(order[0]))
    store.change('Old.lean', 'draft from the moved file')
    store.change('Moved.lean', 'draft from the deleted destination')
    const before = store.getSnapshot()
    assert.throws(
      () => store.move('Old.lean', 'Moved.lean'),
      /draft.*Moved\.lean/,
    )
    assert.equal(store.getSnapshot(), before)
    assert.deepEqual(
      store
        .drafts()
        .map(({ content }) => content)
        .sort(),
      ['draft from the deleted destination', 'draft from the moved file'],
    )
  }
})

test('a moved file replaces a clean stale destination and keeps an active editor at the destination', () => {
  const store = new WorkspaceBuffers()
  store.selectProject('project')
  store.register(
    ['Old.lean', 'Moved.lean'].map((name) => ({
      uri: `file:///workspace/${name}`,
      path: name,
      content: name === 'Old.lean' ? 'source on disk' : 'stale destination',
      hash,
      unsaved: false,
    })),
  )
  store.setFile({
    ...store.getSnapshot().buffers.get('Moved.lean'),
    generation: 10,
  })
  store.change('Old.lean', 'source with pending edits')
  store.move('Old.lean', 'Moved.lean', 3)
  const state = store.getSnapshot()
  assert.deepEqual([...state.buffers.keys()], ['Moved.lean'])
  assert.equal(state.file.path, 'Moved.lean')
  assert.equal(state.file.content, 'source with pending edits')
  assert.equal(state.file.savedContent, 'source on disk')
  assert.equal(state.file.generation, 11)
  assert.deepEqual(
    new Set(state.removedPaths),
    new Set(['Old.lean', 'Moved.lean']),
  )
})
