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
