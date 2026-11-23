import assert from 'node:assert/strict'
import test from 'node:test'
import { changedLeanFiles } from './leanFileRevisions.ts'

const entry = (path, revision = 'unchanged') => ({ path, revision, size: 42 })
const legacy = (path, size = 42) => ({ path, size })
const compare = (before, files, reportedChanges) =>
  changedLeanFiles(before, { files, reportedChanges })
test('unchanged listings and documentation edits preserve Lean work', () => {
  const before = [entry('Main.lean'), entry('Notes.md'), entry('lakefile.toml')]
  const unchanged = {
    changed: new Set(),
    uncertain: false,
    unknownChange: false,
  }
  assert.deepEqual(compare(before, [...before].reverse()), unchanged)
  assert.deepEqual(
    compare(
      before,
      [before[0], entry('Notes.md', 'new'), before[2]],
      ['Notes.md'],
    ),
    unchanged,
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
    compare(before, after).changed,
    new Set(['Main.lean', 'Other.lean', 'New.lean', 'lakefile.toml']),
  )
})
test('incomplete listings invalidate caches while only evidence of a change flags running proofs', () => {
  const before = [legacy('Main.lean'), legacy('Dep.lean'), entry('Known.lean')]
  const idle = { changed: new Set(), uncertain: true, unknownChange: false }
  assert.deepEqual(compare(before, [...before]), idle)
  assert.deepEqual(
    compare(before, [...before], ['Notes.md', 'Known.lean']),
    idle,
  )
  assert.deepEqual(
    compare(before, [...before], ['Dep.lean']).changed,
    new Set(['Dep.lean']),
  )
  assert.deepEqual(
    compare(before, [before[0], legacy('Dep.lean', 45), before[2]]).changed,
    new Set(['Dep.lean']),
  )
  assert.deepEqual(compare(before, before, null), {
    ...idle,
    unknownChange: true,
  })
  assert.deepEqual(
    compare(before, [entry('Main.lean'), ...before.slice(1)]),
    idle,
  )
})
