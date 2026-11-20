import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import * as texInputs from '../../../shared/tex.mjs'

const { outputText } = ts.transpileModule(
  fs.readFileSync(new URL('./texBuilds.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
)
const module = { exports: {} }
new Function('exports', 'module', 'require', outputText)(
  module.exports,
  module,
  (specifier) => {
    assert.equal(specifier, '../../../shared/tex.mjs')
    return texInputs
  },
)
const {
  defaultTexRoot,
  observeTexPdf,
  texBuildIsActive,
  texLanguage,
  texPdfIsStale,
  texInputInRoot,
} = module.exports

test('an already displayed published PDF covers a late editor save only after its saved inputs match', () => {
  const status = {
    workspaceRevision: 'checked-proof',
    lastSuccessful: {
      id: 'checked-pdf',
      origin: 'agent',
      rootFile: 'main.tex',
      workspaceRevision: 'checked-proof',
      pdf: { revision: 'checked-pdf' },
    },
  }
  const submitted = new Map()
  const current = (status, seen, saved) =>
    !texPdfIsStale(status, 'main.tex', false, saved !== seen.saveVersion)
  const first = observeTexPdf(status, 0, submitted, null)
  assert(current(status, first, 0))
  assert(
    !current(status, first, 1),
    'the newer editor receipt has not been checked yet',
  )
  const matched = observeTexPdf(status, 1, submitted, first)
  assert(current(status, matched, 1))
  assert(matched.published)
  const changed = { ...status, workspaceRevision: 'edited-proof' }
  const stale = observeTexPdf(changed, 2, submitted, matched)
  assert(!current(changed, stale, 2))
  assert.equal(stale.saveVersion, 1)
  assert.equal(stale.published, false)
  assert.equal(
    observeTexPdf({ ...status, lastSuccessful: null }, 2, submitted, stale),
    null,
  )
})

test('TeX save and dirty tracking includes eligible input descendants of the selected root folder', () => {
  assert.equal(texInputInRoot('paper/main.tex', 'paper/main.tex'), true)
  assert.equal(
    texInputInRoot('paper/main.tex', 'paper/figures/figure.png'),
    true,
  )
  assert.equal(texInputInRoot('paper/main.tex', 'paper/refs.bib'), true)
  assert.equal(texInputInRoot('paper/main.tex', 'paper/Main.lean'), false)
  assert.equal(texInputInRoot('paper/main.tex', 'papers/reference.pdf'), false)
  assert.equal(texInputInRoot('paper/main.tex', 'Main.lean'), false)
})

test('TeX language families match the reused VS Code grammar IDs', () => {
  assert.equal(texLanguage('paper.TEX'), 'latex')
  assert.equal(texLanguage('style.sty'), 'tex')
  assert.equal(texLanguage('article.cls'), 'tex')
  assert.equal(texLanguage('refs.bib'), 'bibtex')
  assert.equal(texLanguage('Main.lean'), null)
})
test('root selection prefers main, then current TeX, and asks when several roots are ambiguous', () => {
  assert.equal(
    defaultTexRoot(['child.tex', 'main.tex'], 'child.tex'),
    'main.tex',
  )
  assert.equal(
    defaultTexRoot(['child.tex', 'paper.tex'], 'paper.tex'),
    'paper.tex',
  )
  assert.equal(defaultTexRoot(['child.tex', 'paper.tex'], 'refs.bib'), '')
  assert.equal(defaultTexRoot(['paper.tex'], 'refs.bib'), 'paper.tex')
})
test('PDF freshness distinguishes saved snapshots, drafts, edited inputs, and root changes', () => {
  assert.equal(
    texBuildIsActive({ status: 'failed', cleanupFailed: true }),
    true,
  )
  const status = {
    workspaceRevision: 'abc',
    lastSuccessful: {
      rootFile: 'main.tex',
      sourceRevision: 'abc',
      workspaceRevision: 'abc',
      pdf: { revision: 'abc' },
    },
  }
  assert.equal(texPdfIsStale(status, 'main.tex', false, false), false)
  assert.equal(texPdfIsStale(status, 'main.tex', true, false), true)
  assert.equal(texPdfIsStale(status, 'main.tex', false, true), true)
  assert.equal(texPdfIsStale(status, 'other.tex', false, false), true)
  assert.equal(
    texPdfIsStale(
      { ...status, workspaceRevision: 'xyz' },
      'main.tex',
      false,
      false,
    ),
    true,
  )
  for (const workspaceRevision of [null, undefined])
    assert.equal(
      texPdfIsStale(
        {
          workspaceRevision,
          lastSuccessful: {
            ...status.lastSuccessful,
            workspaceRevision: 'original',
          },
        },
        'main.tex',
        false,
        false,
      ),
      true,
    )
  assert.equal(texPdfIsStale(null, 'main.tex', true, true), false)
  assert.equal(
    texPdfIsStale(
      {
        workspaceRevision: 'changed',
        lastSuccessful: {
          ...status.lastSuccessful,
          workspaceRevision: 'original',
        },
      },
      'main.tex',
      false,
      false,
    ),
    true,
  )
  for (const value of ['queued', 'starting', 'running', 'stopping'])
    assert.equal(texBuildIsActive({ status: value }), true)
  for (const value of ['completed', 'cancelled', 'failed'])
    assert.equal(texBuildIsActive({ status: value }), false)
})
