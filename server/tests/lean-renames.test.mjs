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
        position: (() => {
          const text =
            renames.documents.get(filename)?.text ?? '#check Cell.blank'
          const i = Math.max(
            0,
            text.indexOf('blank') >= 0
              ? text.indexOf('blank')
              : text.indexOf('empty'),
          )
          const head = text.slice(0, i)
          return {
            line: head.split('\n').length - 1,
            character: i - (head.lastIndexOf('\n') + 1) + 1,
          }
        })(),
        newName,
      },
    })
  const prepare = () =>
    client({
      id: 1,
      method: 'textDocument/prepareRename',
      params: {
        textDocument: { uri },
        position: {
          line: 0,
          character: Math.min(
            14,
            (renames.documents.get(uri)?.text.split('\n')[0].length ?? 15) - 1,
          ),
        },
      },
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
  for (const newName of ['Other.blankC', 'bad name', '', 'λ', 'Π', 'Σ', ':=']) {
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

test('Greek identifier renames preserve qualifiers using Lean identifier character classes', async () => {
  const f = fixture()
  f.open('def α := 0\n#check Cell.α')
  f.client({
    id: 1,
    method: 'textDocument/rename',
    params: {
      textDocument: { uri },
      position: { line: 0, character: 4 },
      newName: 'β',
    },
  })
  await f.reply({
    changes: { [uri]: [edit(0, 4, 5, 'β'), edit(1, 7, 13, 'β')] },
  })
  assert.deepEqual(
    f.sent[0].result.changes[uri].map((change) => change.newText),
    ['β', 'Cell.β'],
  )
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

test('multi-file renames preserve qualifiers and return exact source buffers with saved hashes', async () => {
  const read = []
  const f = fixture({
    readFile: async (path) => {
      read.push(path)
      return {
        content:
          path === 'Screen.lean' ? 'def blank := 0' : '#check Cell.blank',
      }
    },
  })
  f.open('def blank := 0')
  f.rename()
  await f.reply({
    changes: {
      [uri]: [edit(0, 4, 9)],
      'file:///workspace/Use.lean': [edit(0, 7, 17)],
    },
  })
  assert.deepEqual(f.sent[0].result.changes['file:///workspace/Use.lean'], [
    edit(0, 7, 17, 'Cell.blankC'),
  ])
  assert.deepEqual(read, ['Screen.lean', 'Use.lean'])
  const sources = f.sent[0].result.leanflowSources
  assert.deepEqual(
    sources.map((source) => [source.path, source.content, source.unsaved]),
    [
      ['Screen.lean', 'def blank := 0', false],
      ['Use.lean', '#check Cell.blank', false],
    ],
  )
  assert(sources.every((source) => /^[a-f0-9]{64}$/.test(source.hash)))
})

test('cross-file rename retains unsaved editor text and still records the saved-file base', async () => {
  const f = fixture({
    readFile: async (path) => ({
      content: path === 'Screen.lean' ? 'def blank := 0' : '#check Cell.blank',
    }),
  })
  f.open('def blank := 0\n-- unsaved')
  f.rename()
  await f.reply({
    changes: {
      [uri]: [edit(0, 4, 9)],
      'file:///workspace/Use.lean': [edit(0, 7, 17)],
    },
  })
  assert.equal(
    f.sent[0].result.leanflowSources[0].content,
    'def blank := 0\n-- unsaved',
  )
  assert.equal(f.sent[0].result.leanflowSources[0].unsaved, true)
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

test('a stale reference index cannot rename only part of a newer identifier', async () => {
  for (const mode of ['prepare', 'rename']) {
    const f = fixture()
    f.open('#check Cell.blankC')
    if (mode === 'prepare') {
      f.prepare()
      await f.reply(range(0, 7, 17))
    } else {
      f.rename('blankD')
      await f.reply({ changes: { [uri]: [edit(0, 7, 17, 'blankD')] } })
    }
    assert.equal(f.sent[0].error.code, -32803)
    assert.equal(f.sent[0].result, undefined)
  }
})

test('stale indexes cannot replace another identifier, punctuation, or an adjacent expression', async () => {
  for (const replacement of ['other', 'blank)', ':=']) {
    const f = fixture({
      readFile: async () => ({ content: '#check ' + replacement }),
    })
    f.open('def blank := 0')
    f.rename()
    await f.reply({
      changes: {
        [uri]: [edit(0, 4, 9)],
        'file:///workspace/Use.lean': [edit(0, 7, 7 + replacement.length)],
      },
    })
    assert.equal(f.sent[0].error.code, -32803)
    assert.equal(f.sent[0].result, undefined)
  }
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

test('a late update to a closed file cannot make it appear open or replace saved source', async () => {
  const f = fixture({ readFile: async () => '#check Cell.blank' })
  f.client({
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: '#check Other.blank' }],
    },
  })
  assert.equal(f.renames.documents.has(uri), false)
  f.rename()
  await f.reply({ changes: { [uri]: [edit(0, 7, 17)] } })
  assert.equal(f.sent[0].result.changes[uri][0].newText, 'Cell.blankC')
})
