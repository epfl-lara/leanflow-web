import assert from 'node:assert/strict'
import test from 'node:test'
import { changedLeanFiles } from './leanFileRevisions.ts'

const entry = (path, revision = 'unchanged') => ({ path, revision, size: 42 })
test('unchanged listings and documentation edits preserve Lean work', () => {
  const before = [entry('Main.lean'), entry('Notes.md'), entry('lakefile.toml')]
  assert.deepEqual(changedLeanFiles(before, [...before].reverse()), [])
  assert.deepEqual(
    changedLeanFiles(before, [before[0], entry('Notes.md', 'new'), before[2]]),
    [],
  )
})
test('same-size changes, deletion, addition and configuration changes invalidate imports', () => {
  const before = [
    entry('Main.lean'),
    entry('Other.lean'),
    entry('lakefile.toml'),
  ]
  const after = [
    entry('Main.lean', 'same-size-new-revision'),
    entry('New.lean'),
    entry('lakefile.toml', 'new'),
  ]
  assert.deepEqual(
    new Set(changedLeanFiles(before, after)),
    new Set(['Main.lean', 'Other.lean', 'New.lean', 'lakefile.toml']),
  )
})
test('missing revisions require conservative invalidation instead of treating equal size as equal contents', () => {
  assert.equal(changedLeanFiles(undefined, [entry('Main.lean')]), null)
  assert.equal(
    changedLeanFiles([{ path: 'Main.lean', size: 42 }], [entry('Main.lean')]),
    null,
  )
  assert.equal(
    changedLeanFiles([entry('Main.lean')], [{ path: 'Main.lean', size: 42 }]),
    null,
  )
})
