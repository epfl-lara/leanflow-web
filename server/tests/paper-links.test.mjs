import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { fixturePdf } from '../../scripts/lib/pdf-fixture.mjs'
import {
  changedPaperDeclarations,
  listPaperLinks,
  makePaperLink,
  PAPER_LINKS_FILE,
  projectPaperLinks,
  projectTexPaperLinks,
  upsertPaperLink,
} from '../paper-links.mjs'

test('automatic linking identifies named declarations changed by formalization', () => {
  const before =
    'namespace Trace\ntheorem traceExists : True := by sorry\ntheorem unchanged : True := by trivial\nend Trace\n'
  const after =
    before.replace('sorry', 'trivial') + '\nexample : True := by trivial\n'
  assert.deepEqual(
    changedPaperDeclarations([{ path: 'Trace.lean', before, after }]),
    [{ path: 'Trace.lean', line: 2, declaration: 'Trace.traceExists' }],
  )
  const unnamedOnly = 'theorem unaffected : True := by trivial\n'
  assert.deepEqual(
    changedPaperDeclarations([
      {
        path: 'Trace.lean',
        before: unnamedOnly,
        after: unnamedOnly + 'example : True := by trivial\n',
      },
    ]),
    [],
  )
})

const pdfPath = 'papers/Trace.pdf'
const texPath = 'papers/Main.tex'
const leanPath = 'Trace/Main.lean'

function fixture() {
  const files = new Map([
    [pdfPath, fixturePdf()],
    [
      texPath,
      String.raw`% \label{thm:trace}
\begin{theorem}\label{thm:trace}
The trace exists.
\end{theorem}
`,
    ],
    [
      leanPath,
      'namespace Trace\n@[simp] theorem\n existsTrace : True := by trivial\nend Trace\n',
    ],
  ])
  const read = (path) => {
    if (!files.has(path))
      throw Object.assign(new Error('Missing file'), { status: 404 })
    return files.get(path)
  }
  const readers = {
    readText: (path) => ({ content: read(path) }),
    readPdf: (path) => ({ content: read(path), pageCount: 1 }),
  }
  const target = { path: leanPath, line: 3, declaration: 'Trace.existsTrace' }
  const pdfSource = { path: pdfPath, page: 1, quote: 'The trace exists.' }
  const texSource = { path: texPath, line: 2, label: 'thm:trace' }
  return {
    files,
    target,
    pdfSource,
    texSource,
    make: (source, destination = target, difference) =>
      makePaperLink({ source, target: destination, difference }, readers),
    list: (content, path) => listPaperLinks(content, { path, ...readers }),
    readers,
  }
}

test('PDF links are retry-safe, resolve a moved Lean header and go stale when PDF bytes change', async () => {
  const f = fixture()
  const link = await f.make(f.pdfSource)
  assert.equal(link.target.line, 2)
  const initial = upsertPaperLink(null, link)
  assert.equal(upsertPaperLink(initial, link), initial)
  const updated = await f.make({ ...f.pdfSource, quote: 'The new excerpt.' })
  assert.equal(updated.id, link.id)
  const manifest = upsertPaperLink(initial, updated)
  assert.deepEqual(await f.list(manifest, 'Another.lean'), [])

  f.files.set(leanPath, '\n' + f.files.get(leanPath))
  const [moved] = await f.list(manifest, leanPath)
  assert.deepEqual(moved, {
    id: link.id,
    source: { ...f.pdfSource, quote: 'The new excerpt.' },
    target: { ...f.target, line: 3 },
    status: 'current',
  })
  f.files.set(
    pdfPath,
    Buffer.concat([Buffer.from(f.files.get(pdfPath)), Buffer.from('\n')]),
  )
  assert.equal((await f.list(manifest, pdfPath))[0].status, 'stale')
})

test('TeX label moves are resolved and duplicate live labels or Lean declarations go stale', async () => {
  const f = fixture()
  const unqualified = { ...f.target, declaration: 'existsTrace' }
  const link = await f.make(f.texSource, unqualified)
  assert.equal(link.target.declaration, 'Trace.existsTrace')
  const plain = await f.make({ path: texPath, line: 3 })
  const manifest = upsertPaperLink(upsertPaperLink(null, link), plain)
  assert.deepEqual(
    (await f.list(manifest, texPath)).map(({ status }) => status),
    ['current', 'current'],
  )

  f.files.set(texPath, 'Preface\n' + f.files.get(texPath))
  const [labelled, bare] = await f.list(manifest, texPath)
  assert.deepEqual(
    [labelled.status, labelled.source.line, bare.status, bare.source.line],
    ['current', 3, 'current', 4],
  )
  f.files.set(texPath, f.files.get(texPath) + 'The trace exists.\n')
  assert.equal((await f.list(manifest, texPath))[1].status, 'stale')

  f.files.set(
    leanPath,
    f.files
      .get(leanPath)
      .replace(
        'end Trace',
        'theorem existsTrace : False := by sorry\nend Trace',
      ),
  )
  assert.equal((await f.list(manifest, texPath))[0].status, 'stale')
  f.files.set(
    leanPath,
    'namespace Trace\n@[simp] theorem\n existsTrace : True := by trivial\nend Trace\n',
  )
  f.files.set(texPath, f.files.get(texPath) + '\\label{thm:trace}\n')
  assert.equal((await f.list(manifest, texPath))[0].status, 'stale')
})

test('a definition correction is visible from both ends until its source or Lean definition changes', async () => {
  const f = fixture()
  const definition = 'def traceSize (n : Nat) : Nat :=\n  n + 1\n'
  const target = { path: leanPath, line: 1, declaration: 'traceSize' }
  const difference =
    'The paper uses n. Lean uses n + 1 to count the initial state, so an empty trace has size one.'
  f.files.set(leanPath, definition)
  const link = await f.make(f.pdfSource, target, ' ' + difference + ' ')
  const manifest = upsertPaperLink(null, link)
  assert.equal(
    upsertPaperLink(manifest, await f.make(f.pdfSource, target)),
    manifest,
  )
  for (const path of [pdfPath, leanPath]) {
    const [saved] = await f.list(manifest, path)
    assert.equal(saved.difference, difference)
    assert.equal(saved.status, 'current')
  }

  f.files.set(leanPath, '\n' + definition)
  const [moved] = await f.list(manifest, pdfPath)
  assert.equal(moved.status, 'current')
  assert.equal(moved.target.line, 2)
  f.files.set(leanPath, definition.replace('n + 1', 'n + 2'))
  const [stale] = await f.list(manifest, pdfPath)
  assert.equal(stale.status, 'stale')
  assert.equal(stale.difference, difference)
  const relink = await f.make(f.pdfSource, target)
  assert.throws(() => upsertPaperLink(manifest, relink), {
    status: 409,
    message: /Review the difference again/u,
  })
  const resolved = upsertPaperLink(manifest, { ...relink, difference: null })
  const [updated] = await f.list(resolved, leanPath)
  assert.equal(updated.id, link.id)
  assert.equal(updated.status, 'current')
  assert.equal('difference' in updated, false)
})

test('a note on a labeled TeX passage follows a move and flags changed prose', async () => {
  const f = fixture()
  const link = await f.make(
    f.texSource,
    f.target,
    'Lean assumes the trace is nonempty to select its first state.',
  )
  const manifest = upsertPaperLink(null, link)
  const paper = 'Preface\n' + f.files.get(texPath)
  f.files.set(texPath, paper)
  const [moved] = await f.list(manifest, leanPath)
  assert.equal(moved.status, 'current')
  assert.equal(moved.source.line, 3)
  f.files.set(
    texPath,
    paper.replace('The trace exists.', 'The trace is nonempty.'),
  )
  assert.equal((await f.list(manifest, texPath))[0].status, 'stale')
})

test('an informalized theorem links between Lean and the TeX statement and appears on printed PDF lines without a manifest', async () => {
  const f = fixture()
  const chapter = 'chapters/results.tex'
  const theorem = '% Lean: ' + leanPath + '#Trace.existsTrace'
  const paper = [
    '% Lean: Forbidden.lean#beforeDocument',
    'not printed',
    '\\begin{document}',
    '\\begin{verbatim}',
    '% Lean: Forbidden.lean#inExample',
    'not a statement',
    '\\end{verbatim}',
    theorem,
    '\\theorembox{%',
    'The trace exists.',
    '}',
    '\\heading{Proof}',
    'By induction.',
    '% Lean: ../Forbidden.lean#outside',
    'Outside the project.',
    '% Lean: .lake/packages/Foo/Forbidden.lean#dependency',
    'Dependency.',
    '% Lean: ' + leanPath + '#Trace.missing',
    'A missing declaration.',
    '\\end{document}',
    '% Lean: Forbidden.lean#afterDocument',
    'not printed',
  ].join('\n')
  f.files.set(chapter, paper)
  const reads = []
  const store = {
    accessibleProject() {},
    texSourcePaths: () => [chapter],
    readFile(_project, _actor, path) {
      reads.push(path)
      assert([PAPER_LINKS_FILE, chapter, leanPath].includes(path), path)
      return f.readers.readText(path)
    },
  }
  const { links } = await projectPaperLinks(store, 'project', 'reader', chapter)
  assert.equal(links.length, 1)
  const link = links[0]
  assert.equal(link.status, 'current')
  assert.deepEqual(link.source, { path: chapter, line: 10 })
  assert.deepEqual(link.renderRange, { startLine: 9, endLine: 11 })
  assert.deepEqual(link.target, {
    path: leanPath,
    line: 2,
    declaration: 'Trace.existsTrace',
  })
  assert.deepEqual(reads, [PAPER_LINKS_FILE, chapter, leanPath])
  reads.length = 0
  assert.deepEqual(
    await projectPaperLinks(store, 'project', 'reader', leanPath),
    { links },
  )
  assert.deepEqual(reads, [PAPER_LINKS_FILE, chapter, leanPath])
  assert.deepEqual(
    await projectTexPaperLinks(store, 'project', 'reader', [chapter]),
    links,
  )

  // Formalize and Informalize can both identify the same printed statement.
  const stored = await f.make({ path: chapter, line: 10 })
  f.files.set(PAPER_LINKS_FILE, upsertPaperLink(null, stored))
  assert.deepEqual(
    await projectTexPaperLinks(store, 'project', 'reader', [chapter]),
    links,
  )

  f.files.delete(PAPER_LINKS_FILE)
  f.files.set(leanPath, '\n' + f.files.get(leanPath))
  const [moved] = await projectTexPaperLinks(store, 'project', 'reader', [
    chapter,
  ])
  assert.equal(moved.target.line, 3)
  f.files.set(leanPath, f.files.get(leanPath) + f.files.get(leanPath))
  assert.deepEqual(
    await projectTexPaperLinks(store, 'project', 'reader', [chapter]),
    [],
  )
})

test('editing an inline Lean proof keeps the link while changing its statement makes it stale', async () => {
  const f = fixture()
  const original = 'theorem existsTrace (n : Nat := 1) : True := by sorry'
  f.files.set(leanPath, original + '\n')
  const link = await f.make(f.texSource, {
    path: leanPath,
    line: 1,
    declaration: 'existsTrace',
  })
  const manifest = upsertPaperLink(null, link)
  const olderManifest = upsertPaperLink(null, {
    ...link,
    targetRevision: createHash('sha256').update(original).digest('hex'),
  })
  assert.equal((await f.list(olderManifest, texPath))[0].status, 'current')
  f.files.set(
    leanPath,
    'theorem existsTrace (n : Nat := 1) : True := trivial\n',
  )
  assert.equal((await f.list(manifest, texPath))[0].status, 'current')
  f.files.set(
    leanPath,
    'theorem existsTrace (n : Nat := 1) : False := by sorry\n',
  )
  assert.equal((await f.list(manifest, texPath))[0].status, 'stale')
})

test('a theorem note follows proof edits but flags a changed hypothesis on a later line', async () => {
  const f = fixture()
  const lean = 'theorem traceExists\n    (h : n > 0) : n > 0 := by\n  exact h\n'
  f.files.set(leanPath, lean)
  const link = await f.make(
    f.pdfSource,
    { path: leanPath, line: 1, declaration: 'traceExists' },
    'Lean requires n to be positive to use the original argument.',
  )
  const manifest = upsertPaperLink(null, link)
  f.files.set(leanPath, lean.replace('by\n  exact h', 'h'))
  assert.equal((await f.list(manifest, pdfPath))[0].status, 'current')
  f.files.set(leanPath, lean.replace('h : n > 0', 'h : n ≥ 0'))
  assert.equal((await f.list(manifest, pdfPath))[0].status, 'stale')
})

test('a compiled page only gets links for its mapped TeX files, including a standalone theorem label', async () => {
  const f = fixture()
  const included = 'papers/chapters/trace.tex'
  f.files.set(
    included,
    String.raw`\begin{theorem}
\label{trace}
The trace exists.
\end{theorem}
% \begin{theorem}
\label{plain}
`,
  )
  const theorem = await f.make({ path: included, line: 2, label: 'trace' })
  const plain = await f.make({ path: included, line: 6, label: 'plain' })
  let manifest = upsertPaperLink(null, theorem)
  for (const link of [
    plain,
    await f.make(f.texSource),
    await f.make(f.pdfSource),
  ])
    manifest = upsertPaperLink(manifest, link)
  f.files.set(PAPER_LINKS_FILE, manifest)
  const store = {
    accessibleProject(projectId, actor) {
      assert.equal(projectId, 'p')
      assert.equal(actor, 'viewer')
    },
    readFile(_id, _actor, path) {
      assert([PAPER_LINKS_FILE, included, leanPath].includes(path))
      return f.readers.readText(path)
    },
  }
  const result = await projectTexPaperLinks(store, 'p', 'viewer', [
    included,
    pdfPath,
    included,
  ])
  assert.deepEqual(
    result.map(({ source, renderRange }) => [source.line, renderRange]),
    [
      [2, { startLine: 1, endLine: 4 }],
      [6, undefined],
    ],
  )
  f.files.set(leanPath, 'theorem different : True := by trivial\n')
  assert.deepEqual(
    await projectTexPaperLinks(store, 'p', 'viewer', [included]),
    [],
  )
})

test('tool input checks path containment, declaration spelling, TeX comments and PDF bounds', async () => {
  const f = fixture()
  for (const source of [
    { ...f.pdfSource, path: '../Trace.pdf' },
    { ...f.pdfSource, page: 2 },
    { ...f.pdfSource, expectedPath: pdfPath },
    { ...f.texSource, line: 1 },
  ])
    await assert.rejects(f.make(source), { status: 400 })
  for (const target of [
    { ...f.target, path: '.lake/packages/mathlib/Mathlib/Main.lean' },
    { ...f.target, declaration: 'Other.existsTrace' },
    { ...f.target, line: 1 },
  ])
    await assert.rejects(f.make(f.texSource, target), { status: 400 })
  for (const difference of ['   ', 'x'.repeat(1001), { note: 'wrong shape' }])
    await assert.rejects(f.make(f.texSource, f.target, difference), {
      status: 400,
    })
  await assert.rejects(
    makePaperLink(
      { source: f.texSource, target: f.target, projectId: 'another' },
      f.readers,
    ),
    { status: 400 },
  )

  f.files.set(leanPath, '/- theorem ghost : True := by trivial -/\n')
  await assert.rejects(
    f.make(f.texSource, { path: leanPath, line: 1, declaration: 'ghost' }),
    { status: 400 },
  )
  f.files.set(leanPath, 'theorem «trace.special» : True := by trivial')
  assert.equal(
    (
      await f.make(f.texSource, {
        path: leanPath,
        line: 1,
        declaration: '«trace.special»',
      })
    ).target.line,
    1,
  )
  await assert.rejects(f.list('{', pdfPath), { status: 400 })
})
