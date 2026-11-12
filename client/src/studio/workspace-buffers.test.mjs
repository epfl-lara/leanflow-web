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

test('read-only permission changes preserve draft discovery while excluding those files from saving', () => {
  const store = new WorkspaceBuffers()
  store.selectProject('shared')
  store.setFile(file('Main.lean', 'saved'))
  store.change('Main.lean', 'unsaved local work')
  store.permissions(true)
  assert.deepEqual(store.dirty(), [])
  assert.equal(store.drafts()[0].content, 'unsaved local work')
  assert.equal(store.drafts()[0].readOnly, true)
  store.permissions(false)
  assert.equal(store.dirty().length, 1)
  store.permissions(true)
  store.discard(2)
  assert.deepEqual(store.drafts(), [])
})

test('removed paths retain drafts without recreating files or accepting late save results', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file('Main.lean', 'saved'))
  store.change('Main.lean', 'draft to recover')
  const pending = store.dirty()
  store.detach('Main.lean')
  store.permissions(false)
  store.saved(pending, [{ path: 'Main.lean', hash: hashB }])
  store.collaborated('Main.lean', 'late source', 'late source', hashC)
  store.change('Main.lean', 'late editor callback')
  assert.deepEqual(store.dirty(), [])
  assert.equal(store.drafts()[0].content, 'draft to recover')
  assert.equal(store.drafts()[0].savedContent, 'saved')
  assert.equal(store.drafts()[0].unavailable, true)
  assert.equal(store.drafts()[0].readOnly, true)
  const detached = store.getSnapshot()
  assert.throws(
    () =>
      store.register([
        source('Other.lean', 'safe source'),
        source('Main.lean', 'draft to recover'),
      ]),
    /deleted or moved/,
  )
  assert.equal(
    store.getSnapshot(),
    detached,
    'a delayed Lean rename cannot attach or edit unavailable sources',
  )
  store.setFile(file('Other.lean', 'other saved'))
  store.change('Other.lean', 'other draft')
  assert.deepEqual(
    store.dirty().map(({ path }) => path),
    ['Other.lean'],
  )
  assert.deepEqual(
    store.drafts().map(({ path }) => path),
    ['Main.lean', 'Other.lean'],
  )
})

test('moving a restored file cannot revive the draft of its removed predecessor', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file('Main.lean', 'saved source'))
  store.change('Main.lean', 'old draft to recover')
  store.detach('Main.lean')
  const before = store.getSnapshot()
  // Another member restores the same saved bytes and then renames that file.
  store.move('Main.lean', 'Restored.lean')
  store.permissions(false)
  assert.equal(store.getSnapshot(), before)
  assert.equal(store.getSnapshot().file.path, 'Main.lean')
  assert.equal(store.drafts()[0].content, 'old draft to recover')
  assert.equal(store.drafts()[0].unavailable, true)
  assert.equal(store.drafts()[0].readOnly, true)
  assert.equal(store.getSnapshot().buffers.has('Restored.lean'), false)
  assert.deepEqual(store.dirty(), [])
})

test('folder moves retain removed drafts at their original paths while attached files follow', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file('Old/Attached.lean', 'attached saved source'))
  store.change('Old/Attached.lean', 'attached unsaved work')
  store.setFile(file('Old/Removed.lean', 'removed saved source'))
  store.change('Old/Removed.lean', 'removed draft to recover')
  store.detach('Old/Removed.lean')
  const detached = store.getSnapshot().file
  store.move('Old', 'New')
  store.permissions(false)
  assert.equal(store.getSnapshot().file, detached)
  assert.equal(store.getSnapshot().buffers.get('Old/Removed.lean'), detached)
  assert.equal(store.getSnapshot().buffers.has('Old/Attached.lean'), false)
  assert.equal(store.getSnapshot().buffers.has('New/Removed.lean'), false)
  assert.equal(
    store.getSnapshot().buffers.get('New/Attached.lean').content,
    'attached unsaved work',
  )
  assert.deepEqual(
    store.dirty().map(({ path }) => path),
    ['New/Attached.lean'],
  )
  assert.equal(detached.unavailable, true)
  assert.equal(detached.readOnly, true)
})

test('a move cannot replace an unavailable destination draft', () => {
  const store = new WorkspaceBuffers()
  store.setFile(file('Destination.lean', 'destination saved source'))
  store.change('Destination.lean', 'destination draft to recover')
  store.detach('Destination.lean')
  store.setFile(file('Source.lean', 'source saved content'))
  const before = store.getSnapshot()
  assert.throws(
    () => store.move('Source.lean', 'Destination.lean'),
    /draft already uses/,
  )
  assert.equal(store.getSnapshot(), before)
  assert.equal(store.drafts()[0].content, 'destination draft to recover')
  assert.equal(store.drafts()[0].unavailable, true)
})

test('project selection clears visible and retained files before notifying subscribers', () => {
  const store = new WorkspaceBuffers()
  store.selectProject('alpha')
  store.setFile(file('main.tex', 'alpha source'))
  store.register([source('Use.lean', '#check alpha')])
  store.change('main.tex', 'unsaved alpha')
  const observed = []
  store.subscribe(() => observed.push(store.getSnapshot()))
  store.selectProject('scratch')
  assert.equal(observed.length, 1)
  assert.equal(observed[0].scope.projectId, 'scratch')
  assert.equal(observed[0].file, null)
  assert.equal(observed[0].buffers.size, 0)
  assert.deepEqual(store.dirty(), [])
})

test('returning to a project invalidates requests from its previous visit', async () => {
  const store = new WorkspaceBuffers()
  store.selectProject('alpha')
  const firstVisit = store.getSnapshot().scope
  let resolve
  const response = new Promise((done) => {
    resolve = done
  })
  const pending = response.then(() => {
    if (store.isCurrent(firstVisit)) store.setFile(file('main.tex', 'stale'))
  })
  store.selectProject('beta')
  store.selectProject('alpha')
  store.setFile(file('main.tex', 'fresh'))
  resolve()
  await pending
  assert.equal(store.getSnapshot().file.content, 'fresh')
  assert.equal(store.isCurrent(firstVisit), false)
  const currentVisit = store.getSnapshot().scope
  store.selectProject('alpha')
  assert.equal(store.isCurrent(currentVisit), true)
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
