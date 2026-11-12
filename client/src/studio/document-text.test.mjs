import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import * as Y from 'yjs'
import {
  documentTextEdit,
  documentTextEdits,
  documentOffsetAfterEdit,
  replaceDocumentText,
} from '../../../shared/document-text.mjs'

function concurrent(initial, changed, humanChange, order = 'agent-first') {
  const baseline = new Y.Doc()
  baseline.getText('source').insert(0, initial)
  const agent = new Y.Doc(),
    human = new Y.Doc()
  const original = Y.encodeStateAsUpdate(baseline)
  Y.applyUpdate(agent, original)
  Y.applyUpdate(human, original)
  const vector = Y.encodeStateVector(baseline)
  replaceDocumentText(agent.getText('source'), changed, 'agent')
  humanChange(human.getText('source'))
  const agentUpdate = Y.encodeStateAsUpdate(agent, vector)
  const humanUpdate = Y.encodeStateAsUpdate(human, vector)
  if (order === 'agent-first') {
    Y.applyUpdate(human, agentUpdate)
    Y.applyUpdate(agent, humanUpdate)
  } else {
    Y.applyUpdate(agent, humanUpdate)
    Y.applyUpdate(human, agentUpdate)
  }
  const result = agent.getText('source').toString()
  assert.equal(human.getText('source').toString(), result)
  baseline.destroy()
  agent.destroy()
  human.destroy()
  return result
}

const fiveLines =
  'first old\nsecond unchanged\nmiddle target\nfourth unchanged\nlast old\n'
const outerEdits = fiveLines
  .replace('first old', 'first NEW')
  .replace('last old', 'last NEW')
for (const order of ['agent-first', 'human-first']) {
  test(`separate first/last-line edits retain an acknowledged middle deletion (${order})`, () => {
    const result = concurrent(
      fiveLines,
      outerEdits,
      (text) => {
        text.delete(
          fiveLines.indexOf('middle target'),
          'middle target\n'.length,
        )
      },
      order,
    )
    assert.equal(result, outerEdits.replace('middle target\n', ''))
  })
  test(`separate first/last-line edits retain a middle insertion in its original location (${order})`, () => {
    const result = concurrent(
      fiveLines,
      outerEdits,
      (text) => {
        text.insert(fiveLines.indexOf('target'), 'human ')
      },
      order,
    )
    assert.equal(
      result,
      outerEdits.replace('middle target', 'middle human target'),
    )
  })
}

test('multiple changes on one line preserve concurrent deletion and insertion between them', () => {
  const initial = 'first old | untouched middle | last old'
  const changed = 'first NEW | untouched middle | last NEW'
  assert.equal(
    concurrent(initial, changed, (text) => {
      const start = initial.indexOf('untouched ')
      text.delete(start, 'untouched '.length)
      text.insert(start, 'human ')
    }),
    'first NEW | human middle | last NEW',
  )
})

test('CRLF and supplementary Unicode characters remain exact without splitting code points', () => {
  const initial = '🙂 first old\r\nα middle 🧑‍💻 target\r\n𝒜 last old\r\n'
  const changed = '🙂 first new🙂\r\nα middle 🧑‍💻 target\r\n𝒜 last new🦉\r\n'
  const result = concurrent(initial, changed, (text) => {
    text.insert(initial.indexOf('target'), '人間 ')
  })
  assert.equal(result, changed.replace('target', '人間 target'))
  assert.equal(result.toWellFormed(), result)
  const edits = documentTextEdits(
    '🙂x🙂 unchanged 🧑‍💻 y🦉',
    '🙂A🙂 unchanged 🧑‍💻 B🦉',
  )
  for (const edit of edits)
    assert.equal(edit.insert.toWellFormed(), edit.insert)
})

test('origin groups local hunks for selective undo without removing remote edits', () => {
  const local = new Y.Doc(),
    remote = new Y.Doc()
  const source = local.getText('source')
  source.insert(0, fiveLines)
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local))
  const origin = { local: true }
  const manager = new Y.UndoManager(source, {
    trackedOrigins: new Set([origin]),
  })
  replaceDocumentText(source, outerEdits, origin)
  remote.getText('source').insert(fiveLines.indexOf('middle'), 'REMOTE ')
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote))
  manager.undo()
  assert.equal(source.toString(), fiveLines.replace('middle', 'REMOTE middle'))
  manager.redo()
  assert.equal(source.toString(), outerEdits.replace('middle', 'REMOTE middle'))
  manager.destroy()
  local.destroy()
  remote.destroy()
})

function assertPrivateUndoAfterExternal({
  base,
  local,
  external,
  undone,
  options,
}) {
  const alice = new Y.Doc(),
    peer = new Y.Doc()
  const source = alice.getText('source')
  source.insert(0, base)
  const origin = Symbol('Alice local edit')
  const undo = new Y.UndoManager(source, {
    trackedOrigins: new Set([origin]),
  })
  try {
    alice.transact(() => local(source), origin)
    undo.stopCapturing()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(alice))
    const replacement = external(source.toString())
    replaceDocumentText(
      peer.getText('source'),
      replacement,
      'external',
      options,
    )
    Y.applyUpdate(alice, Y.encodeStateAsUpdate(peer), 'external')
    assert.equal(source.toString(), replacement)
    assert(undo.undo())
    const afterUndo = source.toString()
    if (typeof undone === 'function') undone(afterUndo)
    else assert.equal(afterUndo, undone)
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(alice))
    assert.equal(peer.getText('source').toString(), afterUndo)
    assert(undo.redo())
    assert.equal(source.toString(), replacement)
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(alice))
    assert.equal(peer.getText('source').toString(), replacement)
  } finally {
    undo.destroy()
    alice.destroy()
    peer.destroy()
  }
}

test('private Undo preserves an external prepended comment sharing the local comment prefix', () => {
  const base = '-- original source\nbody\n'
  assertPrivateUndoAfterExternal({
    base,
    local: (text) => text.insert(0, '-- ALICE_LOCAL\n'),
    external: (value) => '-- EXTERNAL_PREFIX\n' + value,
    undone: '-- EXTERNAL_PREFIX\n' + base,
  })
})

test('private Undo preserves simultaneous external prefix and suffix insertions', () => {
  const base = '-- original source\nbody\n'
  assertPrivateUndoAfterExternal({
    base,
    local: (text) => text.insert(0, '-- ALICE_LOCAL\n'),
    external: (value) =>
      '-- EXTERNAL_PREFIX\n' + value + '-- EXTERNAL_SUFFIX\n',
    undone: '-- EXTERNAL_PREFIX\n' + base + '-- EXTERNAL_SUFFIX\n',
  })
})

test('private Undo preserves an external prefix on the same line as a local comment', () => {
  const base = 'body\n'
  assertPrivateUndoAfterExternal({
    base,
    local: (text) => text.insert(0, '-- ALICE_LOCAL\n'),
    external: (value) => '-- EXTERNAL: ' + value,
    undone: '-- EXTERNAL: ' + base,
  })
})

test('private Undo preserves external boundaries around a line too long for character allocation', () => {
  assertPrivateUndoAfterExternal({
    base: 'body',
    local: (text) => text.insert(0, '-- ALICE_LOCAL ' + 'x'.repeat(64)),
    external: (value) => '-- EXTERNAL: ' + value + ' :EXTERNAL_END',
    undone: '-- EXTERNAL: body :EXTERNAL_END',
    options: { maxTokens: 32 },
  })
})

test('private Undo preserves an external prefix and a distant changed line when the complete old source is not retained', () => {
  const base = '-- original source\nunchanged middle\nlast old\n'
  assertPrivateUndoAfterExternal({
    base,
    local: (text) => text.insert(0, '-- ALICE_LOCAL\n'),
    external: (value) =>
      '-- EXTERNAL_PREFIX\n' + value.replace('last old', 'last NEW'),
    undone: '-- EXTERNAL_PREFIX\n' + base.replace('last old', 'last NEW'),
  })
})

test('private Undo preserves an external prefix when the external edit also changes locally inserted text', () => {
  const prefix = '-- EXTERNAL_PREFIX\n',
    base = 'body\n'
  assertPrivateUndoAfterExternal({
    base,
    local: (text) => text.insert(0, '-- ALICE_LOCAL\n'),
    external: (value) => prefix + value.replace('ALICE_LOCAL', 'ALICE_CHANGED'),
    undone(value) {
      assert(
        value.startsWith(prefix),
        'Undo must preserve the entire external comment.',
      )
      assert(
        value.includes('CHANGED'),
        'Undo must preserve remotely inserted replacement text.',
      )
      assert(value.endsWith(base), 'Undo must preserve the original source.')
    },
  })
})

test('private Undo preserves an external appended comment sharing the local comment suffix', () => {
  const base = 'body\n-- original ending\n'
  assertPrivateUndoAfterExternal({
    base,
    local: (text) => text.insert(text.length, '-- ALICE_LOCAL\n'),
    external: (value) => value + '-- EXTERNAL_SUFFIX\n',
    undone: base + '-- EXTERNAL_SUFFIX\n',
  })
})

test('private Undo does not restore an externally deleted prefix before a retained local comment', () => {
  const prefix = '-- EXTERNAL_PREFIX\n',
    base = prefix + 'body\n'
  assertPrivateUndoAfterExternal({
    base,
    local: (text) => text.insert(prefix.length, '-- ALICE_LOCAL\n'),
    external: (value) => value.slice(prefix.length),
    undone: 'body\n',
  })
})

test('private Undo does not restore an externally deleted suffix after a retained local comment', () => {
  const suffix = '-- EXTERNAL_SUFFIX\n',
    base = 'body\n' + suffix
  assertPrivateUndoAfterExternal({
    base,
    local: (text) =>
      text.insert(base.length - suffix.length, '-- ALICE_LOCAL\n'),
    external: (value) => value.slice(0, -suffix.length),
    undone: 'body\n',
  })
})

test('private Undo preserves external CRLF comments and supplementary Unicode through a distant replacement', () => {
  const base = '-- original 🦉\r\nunchanged 𝒜\r\nlast old\r\n'
  assertPrivateUndoAfterExternal({
    base,
    local: (text) => text.insert(0, '-- ALICE_🙂\r\n'),
    external: (value) =>
      '-- EXTERNAL_🌍\r\n' + value.replace('last old', 'last NEW 🧑‍💻'),
    undone: '-- EXTERNAL_🌍\r\n' + base.replace('last old', 'last NEW 🧑‍💻'),
  })
})

test('complexity limits reject the entire operation before any Yjs mutation or update', () => {
  const doc = new Y.Doc(),
    source = doc.getText('source')
  source.insert(0, fiveLines)
  let updates = 0
  doc.on('update', () => updates++)
  const state = Y.encodeStateAsUpdate(doc)
  for (const options of [
    { maxOperations: 0 },
    { maxOperations: 4 },
    { maxTokens: 1 },
    { maxComputationTimeMs: 0 },
  ]) {
    assert.throws(
      () => replaceDocumentText(source, outerEdits, 'local', options),
      { code: 'DOCUMENT_DIFF_LIMIT' },
    )
    assert.equal(source.toString(), fiveLines)
    assert.deepEqual(Y.encodeStateAsUpdate(doc), state)
  }
  assert.equal(updates, 0)
  doc.destroy()
})

test('Monaco refinement preserves surrogate pairs in changed lines', () => {
  const before = 'a🙂\nunchanged\nlast old\n'
  const after = '-- external\nb🦉\nunchanged\nlast NEW\n'
  const edits = documentTextEdits(before, after)
  let applied = before
  for (const edit of edits.toReversed()) {
    assert.equal(edit.insert.toWellFormed(), edit.insert)
    assert.equal(
      before.slice(edit.start, edit.start + edit.deleteCount).toWellFormed(),
      before.slice(edit.start, edit.start + edit.deleteCount),
    )
    applied =
      applied.slice(0, edit.start) +
      edit.insert +
      applied.slice(edit.start + edit.deleteCount)
  }
  assert.equal(applied, after)
  // These emoji share a high surrogate; a UTF-16 diff can otherwise retain
  // half of the old character and transmit an unpaired replacement half.
  for (const edit of documentTextEdits('🙂\na\n', '🙃\nb\n'))
    assert.equal(edit.insert.toWellFormed(), edit.insert)
  assert.equal(
    concurrent('🙂\na\n', '🙃\nb\n', () => {}),
    '🙃\nb\n',
  )
})

test('Monaco refinement refuses token and operation limits before changing a shared document', () => {
  for (const options of [{ maxTokens: 8 }, { maxOperations: 1000 }]) {
    const doc = new Y.Doc(),
      source = doc.getText('source')
    const before = '-- ALICE_LOCAL ' + 'word '.repeat(20) + '\nbody\n'
    source.insert(0, before)
    const state = Y.encodeStateAsUpdate(doc)
    try {
      assert.throws(
        () =>
          replaceDocumentText(
            source,
            '-- EXTERNAL_PREFIX\n' + before.replace('LOCAL', 'CHANGED'),
            'external',
            options,
          ),
        { code: 'DOCUMENT_DIFF_LIMIT' },
      )
      assert.equal(source.toString(), before)
      assert.deepEqual(Y.encodeStateAsUpdate(doc), state)
    } finally {
      doc.destroy()
    }
  }
})

test('an oversized line refuses an ambiguous external prefix and replacement before changing shared identities', () => {
  const doc = new Y.Doc(),
    source = doc.getText('source')
  const before = '-- ALICE_LOCAL ' + 'x'.repeat(64) + ' body'
  source.insert(0, before)
  const state = Y.encodeStateAsUpdate(doc)
  try {
    assert.throws(
      () =>
        replaceDocumentText(
          source,
          '-- EXTERNAL: ' + before.replace('LOCAL', 'CHANGED'),
          'external',
          { maxTokens: 32 },
        ),
      { code: 'DOCUMENT_DIFF_LIMIT' },
    )
    assert.equal(source.toString(), before)
    assert.deepEqual(Y.encodeStateAsUpdate(doc), state)
  } finally {
    doc.destroy()
  }
})

test('a very long changed line fails safely instead of replacing an unchanged middle', () => {
  const original = `first old ${'x'.repeat(700_000)} last old`
  const changed = `first NEW ${'x'.repeat(700_000)} last NEW`
  const doc = new Y.Doc(),
    source = doc.getText('source')
  source.insert(0, original)
  assert.throws(() => replaceDocumentText(source, changed), {
    code: 'DOCUMENT_DIFF_LIMIT',
  })
  assert.equal(source.toString(), original)
  doc.destroy()
})

test('first/last edits to an eight MiB multiline source remain small and bounded', () => {
  const line = '-- unchanged middle context: alpha beta gamma delta epsilon\n'
  const original = `first old\n${line.repeat(Math.floor((8 * 1024 * 1024 - 100) / line.length))}last old\n`
  const changed = original
    .replace('first old', 'first NEW')
    .replace('last old', 'last NEW')
  const started = performance.now()
  const edits = documentTextEdits(original, changed, {
    maxComputationTimeMs: 2000,
  })
  assert.equal(edits.length, 2)
  assert.equal(
    edits.reduce((sum, edit) => sum + edit.deleteCount + edit.insert.length, 0),
    12,
  )
  assert(
    performance.now() - started < 2500,
    'Large source diff exceeded bounded computation time',
  )
})

test('small typing and replacement in an eight MiB single line trim context before tokenization', () => {
  const prefix = 'a'.repeat(4 * 1024 * 1024)
  const suffix = 'z'.repeat(4 * 1024 * 1024 - 16)
  const before = `${prefix}middle${suffix}`
  assert.deepEqual(documentTextEdits(before, `${prefix}midXdle${suffix}`), [
    { start: prefix.length + 3, deleteCount: 0, insert: 'X' },
  ])
  assert.deepEqual(documentTextEdits(before, `${prefix}midYle${suffix}`), [
    { start: prefix.length + 3, deleteCount: 1, insert: 'Y' },
  ])
})

test('seeded mixed Unicode and newline edits reproduce the requested source exactly', () => {
  let state = 0x517281
  const random = (max) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % max
  }
  const tokens = ['a', 'b', ' ', '\n', '\r\n', 'α', '🦉', '𝒜']
  for (let iteration = 0; iteration < 500; iteration++) {
    const before = Array.from(
      { length: random(50) },
      () => tokens[random(tokens.length)],
    ).join('')
    const after = Array.from(
      { length: random(50) },
      () => tokens[random(tokens.length)],
    ).join('')
    let applied = before
    const edits = documentTextEdits(before, after)
    for (const edit of edits.toReversed())
      applied =
        applied.slice(0, edit.start) +
        edit.insert +
        applied.slice(edit.start + edit.deleteCount)
    assert.equal(applied, after, `Seeded iteration ${iteration}`)
  }
})

test('existing editor selection helper keeps its single-range contract', () => {
  const edit = documentTextEdit('before middle after', 'before middle AFTER')
  assert.equal(documentOffsetAfterEdit(0, edit), 0)
  assert.equal(documentOffsetAfterEdit(19, edit), 19)
  assert.equal(documentTextEdit('same', 'same'), null)
  assert.deepEqual(documentTextEdits('same', 'same'), [])
})
