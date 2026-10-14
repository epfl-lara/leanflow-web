import assert from 'node:assert/strict'
import test from 'node:test'
import { LeanRenames } from '../lean-renames.mjs'
import { LeanRequests } from '../lean-requests.mjs'

const uri = 'file:///workspace/Screen.lean'
const range = (line, start, end) => ({
  start: { line, character: start },
  end: { line, character: end },
})
const edit = (line, start, end, newText = 'blankC') => ({
  range: range(line, start, end),
  newText,
})
function fixture({
  readFile = async () => assert.fail('Open buffers must win over saved files'),
} = {}) {
  const sent = []
  const requests = new LeanRequests({
    sendToClient: (value) => sent.push(value),
  })
  const renames = new LeanRenames({
    readFile,
    sendToClient: (value) => {
      if (requests.receive(value)) sent.push(value)
    },
  })
  const client = (message) => {
    requests.track(message)
    renames.track(message)
  }
  const open = (text, filename = uri) =>
    client({
      method: 'textDocument/didOpen',
      params: { textDocument: { uri: filename, version: 1, text } },
    })
  const rename = (newName = 'blankC', id = 1, filename = uri) =>
    client({
      id,
      method: 'textDocument/rename',
      params: {
        textDocument: { uri: filename },
        position: { line: 0, character: 5 },
        newName,
      },
    })
  const prepare = () =>
    client({
      id: 1,
      method: 'textDocument/prepareRename',
      params: { textDocument: { uri }, position: { line: 0, character: 14 } },
    })
  const reply = async (result) => {
    assert.equal(renames.receive({ jsonrpc: '2.0', id: 1, result }), false)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { sent, renames, client, open, rename, prepare, reply }
}

test('rename boxes offer only the final identifier when invoked on qualified or dotted references', async () => {
  for (const [text, start, leaf] of [
    ['#check Cell.blank', 7, 'blank'],
    ['#check .empty', 7, 'empty'],
    ['#check «🙂.namespace».«a.b»', 7, '«a.b»'],
  ]) {
    const f = fixture()
    f.open(text)
    f.prepare()
    await f.reply(range(0, start, text.length))
    const prepared = f.sent[0].result
    assert.equal(prepared.placeholder, leaf)
    assert.equal(
      text.slice(prepared.range.start.character, prepared.range.end.character),
      leaf,
    )
  }
})

test('preserves null/default prepare replies and already-short placeholders', async () => {
  for (const prepared of [
    null,
    { defaultBehavior: true },
    { range: range(0, 12, 17), placeholder: 'blank' },
  ]) {
    const f = fixture()
    f.open('#check Cell.blank')
    f.prepare()
    await f.reply(structuredClone(prepared))
    assert.deepEqual(f.sent[0].result, prepared)
  }
})

test('a declaration rename preserves qualifiers on references and does not change edit ranges', async () => {
  const f = fixture()
  f.open(
    'def blank := 0\n#check Cell.blank\n#check _root_.LeanTui.Cell.blank\n',
  )
  f.rename()
  const edits = [edit(0, 4, 9), edit(1, 7, 17), edit(2, 7, 32)]
  const before = structuredClone(edits.map((e) => e.range))
  await f.reply({ changes: { [uri]: edits } })
  assert.deepEqual(
    f.sent[0].result.changes[uri].map((e) => e.newText),
    ['blankC', 'Cell.blankC', '_root_.LeanTui.Cell.blankC'],
  )
  assert.deepEqual(
    edits.map((e) => e.range),
    before,
  )
})

test('uses current incremental UTF-16 buffers with CRLF, escaped names and documentChanges', async () => {
  const f = fixture()
  f.open('-- 🙂\r\n#check Cell.blank\r\n')
  f.client({
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: range(1, 7, 17), text: '«Cell.part».blank' }],
    },
  })
  f.rename('«blank.new»')
  await f.reply({
    documentChanges: [
      {
        textDocument: { uri, version: 2 },
        edits: [edit(1, 7, 24, '«blank.new»')],
      },
    ],
  })
  assert.equal(
    f.sent[0].result.documentChanges[0].edits[0].newText,
    '«Cell.part».«blank.new»',
  )
})

test('constructor renames retain the leading dot in expressions and match patterns', async () => {
  const f = fixture()
  f.open(
    '  | empty\ndef k : Kind := .empty\n  | .empty => 0\n#check Kind.empty\n',
  )
  f.rename('vacant')
  await f.reply({
    changes: {
      [uri]: [
        edit(0, 4, 9, 'vacant'),
        edit(1, 16, 22, 'vacant'),
        edit(2, 4, 10, 'vacant'),
        edit(3, 7, 17, 'vacant'),
      ],
    },
  })
  assert.deepEqual(
    f.sent[0].result.changes[uri].map((item) => item.newText),
    ['vacant', '.vacant', '.vacant', 'Kind.vacant'],
  )
})

test('retains already-correct newer Lean replies and qualified definitions', async () => {
  for (const [newName, replacement, expected] of [
    ['Cell.blankC', 'Cell.blankC', 'Cell.blankC'],
    ['blankC', 'Cell.blankC', 'Cell.blankC'],
    ['blankC', 'blankC', 'blankC'],
  ]) {
    const f = fixture()
    f.open('#check Cell.blank')
    f.rename(newName)
    const start = newName === 'blankC' && replacement === 'blankC' ? 12 : 7
    await f.reply({ changes: { [uri]: [edit(0, start, 17, replacement)] } })
    assert.equal(f.sent[0].result.changes[uri][0].newText, expected)
  }
})

test('qualified input copied from a use changes only the declaration’s final name', async () => {
  for (const [text, edits, input, expected] of [
    [
      'def blank := 0\n#check Cell.blank',
      [edit(0, 4, 9, 'Cell.blankC'), edit(1, 7, 17, 'Cell.blankC')],
      'Cell.blankC',
      ['blankC', 'Cell.blankC'],
    ],
    [
      '  | empty\ndef k : Kind := .empty',
      [edit(0, 4, 9, '.vacant'), edit(1, 16, 22, '.vacant')],
      '.vacant',
      ['vacant', '.vacant'],
    ],
  ]) {
    const f = fixture()
    f.open(text)
    f.rename(input)
    await f.reply({ changes: { [uri]: edits } })
    assert.deepEqual(
      f.sent[0].result.changes[uri].map((e) => e.newText),
      expected,
    )
  }
})

test('namespace moves and malformed names fail before any edits are returned', async () => {
  for (const newName of ['Other.blankC', 'bad name', '']) {
    const f = fixture()
    f.open('def blank := 0\n#check Cell.blank')
    f.rename(newName)
    await f.reply({
      changes: { [uri]: [edit(0, 4, 9, newName), edit(1, 7, 17, newName)] },
    })
    assert.equal(f.sent[0].error.code, -32602)
    assert.equal(f.sent[0].result, undefined)
  }
})

test('reads unopened project sources through the guarded workspace reader', async () => {
  const f = fixture({
    readFile: async (filename) => {
      assert.equal(filename, 'Nested/Use.lean')
      return '#check Cell.blank'
    },
  })
  const other = 'file:///workspace/Nested/Use.lean'
  f.rename('blankC', 1, other)
  await f.reply({ changes: { [other]: [edit(0, 7, 17)] } })
  assert.equal(f.sent[0].result.changes[other][0].newText, 'Cell.blankC')
})

test('multi-file renames fail as a whole before the editor can apply or save a partial rename', async () => {
  const f = fixture()
  f.open('def blank := 0')
  f.rename()
  await f.reply({
    changes: {
      [uri]: [edit(0, 4, 9)],
      'file:///workspace/Use.lean': [edit(0, 7, 17)],
    },
  })
  assert.equal(f.sent[0].error.code, -32803)
  assert.match(f.sent[0].error.message, /affects multiple files.*Use VS Code/)
  assert.equal(f.sent[0].result, undefined)
})

test('changed buffers and mismatched versions reject the entire rename', async () => {
  for (const mode of ['changed', 'version', 'range']) {
    const f = fixture()
    f.open('#check Cell.blank')
    f.rename()
    if (mode === 'changed')
      f.client({
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: '#check Other.blank' }],
        },
      })
    await f.reply({
      documentChanges: [
        {
          textDocument: { uri, version: mode === 'version' ? 2 : 1 },
          edits: [edit(mode === 'range' ? 3 : 0, 7, 17)],
        },
      ],
    })
    assert.equal(f.sent[0].error.code, -32803)
    assert.equal(f.sent[0].result, undefined)
  }
})

test('untracked incremental ranges leave Lean connected and block rename until a full update', async () => {
  const f = fixture()
  f.open('#check Cell.blank')
  assert.doesNotThrow(() =>
    f.client({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [{ range: range(0, 100, 100), text: ' ' }],
      },
    }),
  )
  f.rename()
  await f.reply({ changes: { [uri]: [edit(0, 7, 17)] } })
  assert.equal(f.sent[0].error.code, -32803)
  assert.match(f.sent[0].error.message, /Reopen the file/)
  f.open('#check Cell.blank')
  f.rename()
  await f.reply({ changes: { [uri]: [edit(0, 7, 17)] } })
  assert.equal(f.sent[1].result.changes[uri][0].newText, 'Cell.blankC')
})

test('a range that no longer contains an identifier fails without returning partial edits', async () => {
  const f = fixture()
  f.open('def blank := 0\n#check  blank')
  f.rename()
  await f.reply({ changes: { [uri]: [edit(0, 4, 9), edit(1, 6, 12)] } })
  assert.equal(f.sent[0].error.code, -32803)
  assert.equal(f.sent[0].result, undefined)
})

test('untrusted response URIs and dependency edits are never read or returned', async () => {
  for (const target of [
    'file:///etc/passwd',
    'file:///workspace/.env',
    'file:///workspace/.lake/packages/dep/A.lean',
    'file:///workspace/../Other.lean',
    'https://example.com/A.lean',
  ]) {
    for (const initiatingUri of [uri, target]) {
      const f = fixture()
      f.rename('blankC', 1, initiatingUri)
      await f.reply({ changes: { [target]: [edit(0, 0, 10)] } })
      assert.equal(f.sent[0].error.code, -32803, target)
      assert.equal(f.sent[0].result, undefined)
    }
  }
})

test('cancellation, buffer changes and socket disposal win while an unopened file is read', async () => {
  for (const mode of ['cancel', 'change', 'dispose']) {
    let release
    const f = fixture({
      readFile: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    })
    f.rename()
    f.renames.receive({
      jsonrpc: '2.0',
      id: 1,
      result: { changes: { [uri]: [edit(0, 7, 17)] } },
    })
    if (mode === 'cancel')
      f.client({ method: '$/cancelRequest', params: { id: 1 } })
    if (mode === 'change') f.open('#check Other.blank')
    if (mode === 'dispose') f.renames.dispose()
    release('#check Cell.blank')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.sent.length, mode === 'dispose' ? 0 : 1)
    if (mode !== 'dispose')
      assert.equal(f.sent[0].error.code, mode === 'cancel' ? -32800 : -32803)
  }
})

test('unrelated messages and original Lean errors pass through without file reads', async () => {
  const f = fixture()
  assert.equal(
    f.renames.receive({
      method: 'textDocument/publishDiagnostics',
      params: {},
    }),
    true,
  )
  f.rename()
  const error = {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32602, message: 'Invalid identifier' },
  }
  assert.equal(f.renames.receive(error), false)
  assert.deepEqual(f.sent, [error])
})
