import assert from 'node:assert/strict'
import test from 'node:test'
import { MacroProofDeclarations } from './macroProofDeclarations.ts'
import { outlineCode, proofDeclarations } from './proofTarget.ts'

const uri = 'file:///workspace/Main.lean'
const range = (line, character, endLine, endCharacter) => ({
  start: { line, character },
  end: { line: endLine, character: endCharacter },
})
const source = [
  'import Mathlib.Tactic.Lemma',
  '',
  'theorem ready : True := by trivial',
  'lemma placeholder : True := by sorry',
  'example : True := by exact 3',
  'lemma broken : True := by',
  '  exact 3',
  'namespace Nested',
  '@[simp] private lemma valid : True := by trivial',
  'end Nested',
].join('\n')
// Captured command and keyword hover boundaries from Lean 4.35 and Mathlib.
// The macro lemmas are absent from documentSymbol, including the broken one.
const symbols = [
  { kind: 6, name: 'ready', range: range(2, 0, 2, 34) },
  { kind: 6, name: 'example', range: range(4, 0, 4, 28) },
  { kind: 3, name: 'Nested', range: range(7, 0, 9, 10), children: [] },
]
const parserRanges = new Map([
  [3, range(3, 0, 3, 36)],
  [5, range(5, 0, 6, 9)],
  [8, range(8, 0, 8, 48)],
])

test('Mathlib lemma keyword hovers recover namespaced, incomplete and multiline declarations on their true header', async () => {
  const lines = source.split('\n')
  // Match the physical end of the private attributed declaration.
  assert.equal(lines[8].length, 48)
  const known = proofDeclarations(symbols, uri, lines.length, source)
  assert.deepEqual(
    known.map((x) => x.kind),
    ['import', 'theorem', 'example'],
  )
  let result
  await new MacroProofDeclarations().collect(
    source,
    outlineCode(source),
    {},
    symbols,
    known,
    async (position) => {
      assert.equal(
        lines[position.line].slice(position.character, position.character + 5),
        'lemma',
      )
      return { range: parserRanges.get(position.line) }
    },
    () => false,
    (declarations) => {
      result = declarations
    },
  )
  assert.deepEqual(
    result
      .filter((x) => x.kind === 'lemma')
      .map((d) => [
        d.name,
        d.startLine,
        d.headerLine,
        d.endLine,
        d.endColumn,
        d.checkStatus,
      ]),
    [
      ['placeholder', 4, 4, 4, 37, 'warning'],
      ['broken', 6, 6, 7, 10, undefined],
      ['Nested.valid', 9, 9, 9, 49, undefined],
    ],
  )
})

test('only parser-confirmed complete command ranges are added; comments, strings and quoted syntax never prompt searches', async () => {
  const text = [
    '-- lemma comment',
    'def a := "lemma quoted : True := by trivial"',
    'macro "doc" : command => `(theorem ghost : True := by trivial)',
    'lemma keywordOnly : True := by trivial',
    'lemma badRange : True := by trivial',
    'lemma absent : True := by trivial',
  ].join('\n')
  const calls = []
  let result
  await new MacroProofDeclarations().collect(
    text,
    outlineCode(text),
    {},
    [],
    [],
    async (point) => {
      calls.push(point.line)
      return point.line === 3
        ? { range: range(3, 0, 3, 5) }
        : point.line === 4
          ? { range: range(4, 0, 4, 999) }
          : null
    },
    () => false,
    (declarations) => {
      result = declarations
    },
  )
  assert.deepEqual(calls.sort(), [3, 4, 5])
  assert.deepEqual(result, [])
})

test('up to four lookups reuse parser-confirmed ranges ahead of a safe boundary across ordinary edits; a new document session invalidates them', async () => {
  const macros = new MacroProofDeclarations()
  const lines = Array.from(
    { length: 120 },
    (_, i) => 'lemma item' + i + ' : True := by trivial',
  )
  let session = {}
  const run = async () => {
    const text = lines.join('\n')
    let count = 0,
      active = 0,
      peak = 0,
      all
    await macros.collect(
      text,
      outlineCode(text),
      session,
      [],
      [],
      async (point) => {
        count++
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setImmediate(resolve))
        active--
        return {
          range: range(point.line, 0, point.line, lines[point.line].length),
        }
      },
      () => false,
      (result) => {
        all = result
      },
    )
    assert.equal(all.length, 120)
    assert(peak <= 4)
    return count
  }
  assert.equal(await run(), 120)
  assert.equal(await run(), 0)
  lines[119] = lines[119].replace('trivial', 'exact True.intro')
  assert.equal(await run(), 2)
  lines[60] = lines[60].replace('trivial', 'exact True.intro')
  assert.equal(await run(), 61)
  session = {}
  assert.equal(await run(), 120)
})

test('canceled macro requests cannot reintroduce declarations from an older edit', async () => {
  const macros = new MacroProofDeclarations()
  let stopped = false
  const pending = Promise.withResolvers()
  const run = macros.collect(
    source,
    outlineCode(source),
    {},
    symbols,
    [],
    async () => pending.promise,
    () => stopped,
    () => assert.fail('stale ranges reached current editor'),
  )
  stopped = true
  pending.resolve({ range: range(3, 0, 3, 36) })
  await run
})

test('Lean namespaces qualify native theorems and macro lemmas across named sections', async () => {
  const lines = [
    'namespace Review',
    'section Family',
    'theorem default_eq : True := by trivial',
    'lemma sibling : True := by trivial',
    'end Family',
    'end Review',
  ]
  const text = lines.join('\n')
  // Lean 4.35 returns kind 3 for both commands, with each range starting at
  // its keyword. Its Mathlib macro lemma is present only on keyword hover.
  const tree = [
    {
      kind: 3,
      name: 'Review',
      range: range(0, 0, 5, 10),
      selectionRange: range(0, 10, 0, 16),
      children: [
        {
          kind: 3,
          name: 'Family',
          range: range(1, 0, 4, 10),
          selectionRange: range(1, 8, 1, 14),
          children: [
            {
              kind: 6,
              name: 'default_eq',
              range: range(2, 0, 2, lines[2].length),
            },
          ],
        },
      ],
    },
  ]
  const known = proofDeclarations(tree, uri, lines.length, text)
  assert.deepEqual(
    known.map(({ name }) => name),
    ['Review.default_eq'],
  )
  let result
  await new MacroProofDeclarations().collect(
    text,
    outlineCode(text),
    {},
    tree,
    known,
    async (point) => {
      assert.equal(point.line, 3)
      return { range: range(3, 0, 3, lines[3].length) }
    },
    () => false,
    (declarations) => {
      result = declarations
    },
  )
  assert.deepEqual(
    result.map(({ name }) => name),
    ['Review.default_eq', 'Review.sibling'],
  )
})
