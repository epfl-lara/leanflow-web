import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = fs.readFileSync(
  new URL('./proofTarget.ts', import.meta.url),
  'utf8',
)
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS,
  },
})
const module = { exports: {} }
new Function('exports', 'module', outputText)(module.exports, module)
const { proofDeclarations, proofTargetForSelection, MAX_PROOF_SOURCE_LENGTH } =
  module.exports
const uri = 'file:///workspace/Main.lean'
const content =
  'namespace Demo\n/-- Doc --/\ntheorem one : True := by\n  trivial\n\nexample : True := by trivial\nend Demo\n'
const symbols = [
  {
    name: 'Demo',
    kind: 3,
    range: { start: { line: 0, character: 0 }, end: { line: 6, character: 8 } },
    children: [
      {
        name: 'one',
        kind: 6,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 3, character: 9 },
        },
      },
      {
        name: 'example',
        kind: 6,
        range: {
          start: { line: 5, character: 0 },
          end: { line: 5, character: 33 },
        },
      },
    ],
  },
]
const declarations = proofDeclarations(symbols, uri, 8)
const cursor = (line, column = 1) => ({
  startLineNumber: line,
  endLineNumber: line,
  startColumn: column,
  endColumn: column,
})

test('Lean hierarchical symbols become qualified declarations, never namespace ranges', () => {
  assert.deepEqual(
    declarations.map((item) => item.name),
    ['Demo.one', 'Demo.example'],
  )
  assert.equal(declarations[0].startLine, 2)
  assert.equal(declarations[0].endLine, 4)
  assert.deepEqual(proofDeclarations(null, uri, 8), [])
})

test('cursor inside proof and at its final column captures complete declaration including docs', () => {
  for (const column of [3, 10]) {
    const { target } = proofTargetForSelection(
      'Main.lean',
      content,
      cursor(4, column),
      declarations,
    )
    assert.equal(target.name, 'Demo.one')
    assert.equal(target.startLine, 2)
    assert.equal(target.endLine, 4)
    assert.equal(
      target.source,
      '/-- Doc --/\ntheorem one : True := by\n  trivial',
    )
  }
})

test('explicit selected lines work without Lean and normalize CRLF snapshots', () => {
  const selection = {
    startLineNumber: 3,
    startColumn: 4,
    endLineNumber: 5,
    endColumn: 1,
  }
  const { target } = proofTargetForSelection(
    'Main.lean',
    content.replaceAll('\n', '\r\n'),
    selection,
    [],
  )
  assert.deepEqual(target, {
    path: 'Main.lean',
    startLine: 3,
    endLine: 4,
    source: 'theorem one : True := by\n  trivial',
  })
})

test('no implicit whole-file focus outside a declaration, including broken syntax', () => {
  assert.equal(
    proofTargetForSelection('Main.lean', content, cursor(5), declarations)
      .target,
    null,
  )
  assert.equal(
    proofTargetForSelection(
      'Main.lean',
      'theorem broken := by\n  ',
      cursor(1),
      [],
    ).target,
    null,
  )
  assert.equal(
    proofTargetForSelection('Main.lean', content, null, declarations).target,
    null,
  )
})

test('multiple-declaration selection does not claim the first declaration name', () => {
  const { target } = proofTargetForSelection(
    'Main.lean',
    content,
    { startLineNumber: 2, startColumn: 1, endLineNumber: 6, endColumn: 10 },
    declarations,
  )
  assert.equal(target.name, undefined)
  assert.equal(target.endLine, 6)
})

test('oversized focus reports an actionable error instead of silently truncating code', () => {
  const result = proofTargetForSelection(
    'Main.lean',
    'a'.repeat(MAX_PROOF_SOURCE_LENGTH + 1),
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
    [],
  )
  assert.equal(result.target, null)
  assert.match(result.error, /Select fewer lines/)
})

test('foreign, invalid and out-of-buffer symbols cannot select source', () => {
  const location = {
    uri: 'file:///another/File.lean',
    range: symbols[0].children[0].range,
  }
  assert.deepEqual(
    proofDeclarations(
      [
        { name: 'foreign', kind: 6, location },
        {
          name: 'outside',
          kind: 6,
          range: {
            start: { line: 100, character: 0 },
            end: { line: 101, character: 2 },
          },
        },
        {
          name: 'negative',
          kind: 6,
          range: {
            start: { line: -1, character: 0 },
            end: { line: 1, character: 2 },
          },
        },
      ],
      uri,
      8,
    ),
    [],
  )
})

test('outline labels Lean command kinds without guessing declaration boundaries', () => {
  const source = [
    'import Mathlib.Data.Nat.Basic',
    '/-- theorem fake : False --/',
    '@[simp] private theorem actual : True := by trivial',
    'protected def evaluate := "lemma fake := by"',
    'lemma useful : True := by trivial',
    'example : True := by trivial',
    'structure Point where x : Nat',
    'inductive Color | red',
    'abbrev Number := Nat',
    'instance : Inhabited Number := ⟨0⟩',
    'axiom assumed : True',
  ].join('\n')
  const commands = [
    ['actual', 1, 2],
    ['evaluate', 3, 3],
    ['useful', 4, 4],
    ['example', 5, 5],
    ['Point', 6, 6],
    ['Color', 7, 7],
    ['Number', 8, 8],
    ['instInhabitedNumber', 9, 9],
    ['assumed', 10, 10],
  ].map(([name, start, end]) => ({
    name,
    kind: 6,
    range: {
      start: { line: start, character: 0 },
      end: { line: end, character: source.split('\n')[end].length },
    },
  }))
  const result = proofDeclarations(commands, uri, 11, source)
  assert.deepEqual(
    result.map(({ name, kind }) => [name, kind]),
    [
      ['Mathlib.Data.Nat.Basic', 'import'],
      ['actual', 'theorem'],
      ['evaluate', 'def'],
      ['useful', 'lemma'],
      ['example', 'example'],
      ['Point', 'structure'],
      ['Color', 'inductive'],
      ['Number', 'abbrev'],
      ['instInhabitedNumber', 'instance'],
      ['assumed', 'other'],
    ],
  )
  assert.deepEqual(result[1], {
    name: 'actual',
    kind: 'theorem',
    startLine: 2,
    startColumn: 1,
    endLine: 3,
    endColumn: source.split('\n')[2].length + 1,
  })
})

test('import header retains exact locations and ignores nested comments', () => {
  const source = [
    '/- import Fake',
    '  /- import Nested -/',
    '-/',
    'prelude',
    '  import Mathlib -- import AlsoFake',
    'public import CSLib',
    'namespace Demo',
    'import NotInTheHeader',
  ].join('\r\n')
  assert.deepEqual(proofDeclarations([], uri, 8, source), [
    {
      name: 'Mathlib',
      kind: 'import',
      startLine: 5,
      startColumn: 3,
      endLine: 5,
      endColumn: 17,
    },
    {
      name: 'CSLib',
      kind: 'import',
      startLine: 6,
      startColumn: 1,
      endLine: 6,
      endColumn: 20,
    },
  ])
})

test('imports and command kinds are never taken from strings or syntax quotations', () => {
  const source = [
    'import Mathlib',
    'def text := "',
    'import InAString',
    'theorem InAString : True := by trivial"',
    'def quoted := `(command|',
    '  /- nested /- theorem Fake -/ -/',
    '  import InAQuotation',
    "  def nested := ')'",
    ')',
    'import AfterACommand',
  ].join('\n')
  const symbols = [
    {
      name: 'quoted',
      kind: 6,
      range: {
        start: { line: 4, character: 0 },
        end: { line: 8, character: 1 },
      },
    },
  ]
  const result = proofDeclarations(symbols, uri, 10, source)
  assert.deepEqual(
    result.map(({ name, kind }) => [name, kind]),
    [
      ['Mathlib', 'import'],
      ['quoted', 'def'],
    ],
  )
  // A range beginning at a term quotation is still not a declaration keyword.
  assert.equal(
    proofDeclarations(
      [
        {
          name: 'term',
          kind: 6,
          range: {
            start: { line: 4, character: 14 },
            end: { line: 8, character: 1 },
          },
        },
      ],
      uri,
      10,
      source,
    ).find(({ name }) => name === 'term').kind,
    'other',
  )
})

test('cursor on an import navigates without implicitly setting a proof target', () => {
  const source = 'import Mathlib\ntheorem actual : True := by trivial'
  const items = proofDeclarations([], uri, 2, source)
  assert.equal(
    proofTargetForSelection('Main.lean', source, cursor(1), items).target,
    null,
  )
  // An explicit line selection remains available when the user asks about an import.
  assert.equal(
    proofTargetForSelection(
      'Main.lean',
      source,
      {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 1,
        endColumn: 8,
      },
      items,
    ).target.source,
    'import Mathlib',
  )
})
