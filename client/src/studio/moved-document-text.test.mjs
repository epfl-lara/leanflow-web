import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { documentTextEdits } from '../../../shared/document-text.mjs'

const { outputText } = ts.transpileModule(
  fs.readFileSync(new URL('./movedDocumentText.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
)
function load(diff = documentTextEdits) {
  const module = { exports: {} }
  new Function('exports', 'module', 'require', outputText)(
    module.exports,
    module,
    (specifier) => {
      assert.equal(specifier, '../../../shared/document-text.mjs')
      return { documentTextEdits: diff }
    },
  )
  return module.exports.mergeMovedDocumentText
}
const merge = load()

test('moved drafts keep typing before and after independently rewritten references', () => {
  const baseline = 'import Old.Helper\n\nexample : True := by trivial\n'
  const remote = 'import Archive.New.Helper\n\nexample : True := by trivial\n'
  const local = '-- local header\n' + baseline + '-- local footer\n'
  assert.equal(
    merge(baseline, local, remote),
    '-- local header\n' + remote + '-- local footer\n',
  )
})

test('scattered reference rewrites merge with independent source edits between them', () => {
  const baseline = [
    'import Old.Helper',
    '/-!',
    '![Figure](assets/Figure.svg)',
    '-/',
    'example : True := by trivial',
    '-- end',
  ].join('\n')
  const local = baseline.replace('True := by trivial', '1 = 1 := by rfl')
  const remote = baseline
    .replace('Old.Helper', 'New.Helper')
    .replace('assets/Figure.svg', '../assets/Figure.svg')
  assert.equal(
    merge(baseline, local, remote),
    remote.replace('True := by trivial', '1 = 1 := by rfl'),
  )
})

test('identical edits are included once alongside independent edits', () => {
  const baseline = 'import Old.Helper\n-- body\n-- end\n'
  const shared = baseline.replace('Old.Helper', 'New.Helper')
  assert.equal(
    merge(baseline, shared + '-- local\n', shared),
    shared + '-- local\n',
  )
})

test('overlapping reference edits preserve the draft by refusing to choose either version', () => {
  const baseline = '![Figure](assets/Figure.svg)\n'
  assert.equal(
    merge(
      baseline,
      baseline.replace('Figure.svg', 'Other.svg'),
      baseline.replace('assets/Figure.svg', '../images/Diagram.svg'),
    ),
    null,
  )
  assert.equal(merge('abc', 'axc', 'ayc'), null)
  assert.equal(merge('abc', 'ac', 'abXc'), null)
  assert.equal(merge('abc', 'ac', 'aXbc'), null)
  assert.equal(merge('abc', 'aXXbc', 'aYYbc'), null)
})

test('adjacent replacements can merge while insertion anchors on replaced boundaries cannot', () => {
  assert.equal(merge('abcd', 'aBcd', 'abCd'), 'aBCd')
  assert.equal(merge('abcd', 'abXcd', 'aBcd'), null)
  assert.equal(merge('abcd', 'aXbcd', 'aBcd'), null)
})

test('Unicode typing and reference rewrites preserve whole characters', () => {
  const baseline = '![图](images/图.svg)\n-- proof\n'
  const remote = baseline.replace('images/', '../images/')
  const local = baseline + '-- 👩🏽‍💻 proves α = α\n'
  assert.equal(merge(baseline, local, remote), remote + '-- 👩🏽‍💻 proves α = α\n')
})

test('unchanged and already identical contents need no merge', () => {
  assert.equal(merge('base', 'base', 'remote'), 'remote')
  assert.equal(merge('base', 'local', 'base'), 'local')
  assert.equal(merge('base', 'same', 'same'), 'same')
})

test('diff-budget errors propagate before exposing a partial merged result', () => {
  const error = Object.assign(new Error('The edit is too complex.'), {
    code: 'DOCUMENT_DIFF_LIMIT',
  })
  let calls = 0
  const limited = load((...args) => {
    if (++calls === 2) throw error
    return documentTextEdits(...args)
  })
  assert.throws(
    () => limited('abc\ndef\n', 'abc\ndef\nlocal\n', 'Abc\ndef\n'),
    error,
  )
})
