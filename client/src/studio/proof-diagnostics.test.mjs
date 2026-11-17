import assert from 'node:assert/strict'
import test from 'node:test'
import { ProofDiagnostics, proofCheckStatuses } from './proofDiagnostics.ts'

const uri = 'file:///workspace/Main.lean'
const others = 'file:///workspace/Other.lean'
const full = 'textDocument/publishDiagnostics'
const progress = '$/lean/fileProgress'
const range = (line, character, endLine, endCharacter) => ({
  start: { line, character },
  end: { line: endLine, character: endCharacter },
})
const declarations = [
  {
    kind: 'def',
    name: 'intro',
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 20,
  },
  {
    kind: 'theorem',
    name: 'one',
    startLine: 2,
    startColumn: 1,
    endLine: 3,
    endColumn: 9,
  },
  {
    kind: 'lemma',
    name: 'two',
    startLine: 5,
    startColumn: 1,
    endLine: 5,
    endColumn: 35,
  },
  {
    kind: 'example',
    name: 'example',
    startLine: 5,
    startColumn: 36,
    endLine: 5,
    endColumn: 60,
  },
]

function fixture() {
  const diagnostics = new ProofDiagnostics()
  const stream = diagnostics.openConnection()
  stream.sent('textDocument/didOpen', { textDocument: { uri, version: 1 } })
  return {
    diagnostics,
    stream,
    doc: () => diagnostics.document(uri, 1),
    publish: (values, incremental = false) =>
      stream.received(full, {
        uri,
        version: 1,
        diagnostics: values,
        isIncremental: incremental,
      }),
    done: () =>
      stream.received(progress, {
        textDocument: { uri, version: 1 },
        processing: [],
      }),
    status: (version = 1) =>
      proofCheckStatuses(declarations, diagnostics.document(uri, version)).map(
        (entry) => entry.checkStatus,
      ),
  }
}

test('checks require a full diagnostics baseline, a finished file and acknowledgement for this exact document', () => {
  const f = fixture()
  const pending = [undefined, 'pending', 'pending', 'pending']
  f.done()
  f.publish([], true)
  f.diagnostics.confirm(uri, f.doc())
  assert.deepEqual(f.status(), pending)
  f.stream.received(full, { uri, diagnostics: [] })
  f.stream.received(full, { uri: others, version: 1, diagnostics: [] })
  f.stream.received(full, { uri, version: 2, diagnostics: [] })
  assert.deepEqual(f.status(), pending)
  f.publish([])
  assert.deepEqual(f.status(), pending)
  f.diagnostics.confirm(uri, f.doc())
  assert.deepEqual(f.status(), [undefined, 'checked', 'checked', 'checked'])
  const before = f.doc()
  f.stream.sent('textDocument/didChange', { textDocument: { uri, version: 2 } })
  f.done()
  f.publish([])
  f.diagnostics.confirm(uri, before)
  assert.deepEqual(f.status(2), pending)
  f.stream.received(full, { uri, version: 2, diagnostics: [] })
  f.stream.received(progress, {
    textDocument: { uri, version: 2 },
    processing: [],
  })
  assert.deepEqual(f.status(2), pending)
})

test('diagnostics map by UTF-16 columns, handle empty end ranges and prioritize errors across incremental updates', () => {
  const f = fixture()
  const warning = { severity: 2, range: range(4, 6, 4, 9) }
  const endError = { severity: 1, range: range(2, 8, 2, 8) }
  const error = { severity: 1, range: range(4, 37, 4, 40) }
  f.publish([warning])
  f.publish([endError, error], true)
  f.publish(
    [
      { severity: 2, range: range(2, 1, 2, 6) },
      { severity: 3, range: range(4, 36, 4, 38) },
    ],
    true,
  )
  assert.deepEqual(f.status(), [undefined, 'error', 'warning', 'error'])
  f.done()
  f.diagnostics.confirm(uri, f.doc())
  assert.deepEqual(f.status(), [undefined, 'error', 'warning', 'error'])
  f.publish([warning])
  assert.deepEqual(f.status(), [undefined, 'checked', 'warning', 'checked'])
})

test('fatal processing, broken imports and malformed snapshots cannot certify untouched proofs', () => {
  const f = fixture()
  f.done()
  f.publish([{ severity: 1, range: range(0, 0, 0, 4) }])
  f.diagnostics.confirm(uri, f.doc())
  assert.deepEqual(f.status(), [undefined, 'pending', 'pending', 'pending'])
  f.publish([])
  f.stream.received(progress, {
    textDocument: { uri, version: 1 },
    processing: [{ kind: 2, range: range(0, 0, 4, 60) }],
  })
  assert.deepEqual(f.status(), [undefined, 'pending', 'pending', 'pending'])
  f.publish([{ severity: 1, range: range(4, 10, 4, 0) }])
  f.done()
  assert.deepEqual(f.status(), [undefined, 'pending', 'pending', 'pending'])
})

test('a same-version reopen or reconnect discards prior checks and late connection events', () => {
  const f = fixture()
  f.done()
  f.publish([])
  const original = f.doc()
  f.diagnostics.confirm(uri, original)
  f.stream.sent('textDocument/didClose', { textDocument: { uri } })
  f.stream.sent('textDocument/didOpen', { textDocument: { uri, version: 1 } })
  f.diagnostics.confirm(uri, original)
  assert.deepEqual(f.status(), [undefined, 'pending', 'pending', 'pending'])
  const replacement = f.diagnostics.openConnection()
  replacement.sent('textDocument/didOpen', {
    textDocument: { uri, version: 1 },
  })
  const current = f.doc()
  f.stream.closed()
  f.done()
  f.publish([])
  f.diagnostics.confirm(uri, current)
  assert.deepEqual(f.status(), [undefined, 'pending', 'pending', 'pending'])
  replacement.received(full, { uri, version: 1, diagnostics: [] })
  replacement.received(progress, {
    textDocument: { uri, version: 1 },
    processing: [],
  })
  assert.deepEqual(f.status(), [undefined, 'pending', 'pending', 'pending'])
  f.diagnostics.confirm(uri, current)
  assert.deepEqual(f.status(), [undefined, 'checked', 'checked', 'checked'])
  replacement.closed()
  assert.deepEqual(f.status(), [undefined, 'pending', 'pending', 'pending'])
})
