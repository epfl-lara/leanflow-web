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
