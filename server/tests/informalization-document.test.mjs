import test from 'node:test'
import assert from 'node:assert/strict'
import {
  informalizationDocumentPath,
  addedInformalizationReferences,
  followupInformalizationOutput,
  validateInformalizationOutputPath,
  verifyInformalizationDocument,
} from '../informalization-document.mjs'

const job = {
  id: 'run',
  owner: 'actor',
  projectId: 'project',
  currentFile: 'Main.lean',
}
const snapshot = {
  root: '/managed/copy',
  files: ['Main.lean', 'paper/main.tex', 'paper/notes.md'].map((path) => ({
    path,
  })),
}
const entries = [
  { path: 'Main.lean', name: 'add_zero' },
  { path: 'Main.lean', name: 'zero_add' },
]
const md = `Existing introduction.

<!-- Lean: Main.lean#add_zero -->
Adding zero on the right leaves a number unchanged.

**Proof.** The defining equation adds zero by returning that number.

<!-- Lean: Main.lean#zero_add -->
Adding zero on the left leaves a number unchanged.

<!-- Lean proof -->
Use induction on the other number.
`
const chapter = String.raw`% Lean: Main.lean#add_zero
Adding zero on the right leaves a number unchanged.
\begin{proof}
The defining equation returns that number.
\end{proof}
% Lean: Main.lean#zero_add
Adding zero on the left leaves a number unchanged.
% Lean proof
Use induction on the other number.
`
const tex = String.raw`\documentclass{article}
\begin{document}
${chapter}
\end{document}
`
const verify = (changes, options = {}) =>
  verifyInformalizationDocument({
    job: {
      ...job,
      prompt: changes[0]?.path.endsWith('.md') ? 'Write in Markdown' : '',
    },
    snapshot,
    entries,
    changes,
    ...options,
  })

test('suggests the requested or contextual destination and avoids overwriting a default document', () => {
  const occupied = {
    ...snapshot,
    files: [
      ...snapshot.files,
      { path: 'Informalization.tex' },
      { path: 'Informalization-2.tex/child.md' },
    ],
    links: [{ path: 'Informalization-3.tex' }],
  }
  assert.equal(
    informalizationDocumentPath(job, occupied),
    'Informalization-4.tex',
  )
  assert.equal(
    informalizationDocumentPath(
      { ...job, prompt: 'Write this in Markdown' },
      snapshot,
    ),
    'Informalization.md',
  )
  assert.equal(
    informalizationDocumentPath(
      { ...job, prompt: 'Update notes.md.', currentFile: 'paper/main.tex' },
      snapshot,
    ),
    'paper/notes.md',
  )
  assert.equal(
    informalizationDocumentPath(
      { ...job, prompt: 'Update paper/main.tex', files: ['paper/notes.md'] },
      snapshot,
    ),
    'paper/main.tex',
  )
  assert.equal(
    informalizationDocumentPath(
      { ...job, files: ['paper/notes.md'] },
      snapshot,
    ),
    'paper/notes.md',
  )
  assert.equal(
    informalizationDocumentPath(
      { ...job, outputFile: 'new.tex', prompt: 'Review paper/main.tex' },
      snapshot,
    ),
    'new.tex',
  )
  const previous = { ...job, previousDocument: 'paper/notes.md' }
  assert.equal(
    informalizationDocumentPath(
      { ...previous, prompt: 'Fix the draft' },
      snapshot,
    ),
    'paper/notes.md',
  )
  assert.equal(
    informalizationDocumentPath(
      { ...previous, prompt: 'Write a fresh paper.' },
      snapshot,
    ),
    'Informalization.tex',
  )
  assert.equal(
    informalizationDocumentPath(
      { ...previous, prompt: 'Write in LaTeX.' },
      snapshot,
    ),
    'Informalization.tex',
  )
  for (const invalid of [
    null,
    '../notes.md',
    '.hidden.md',
    'x/.hidden.md',
    'Main.lean',
    '.lake/packages/p/readme.md',
  ])
    assert.throws(() => validateInformalizationOutputPath(invalid), {
      status: 400,
    })
})

test('applies explicit followup redirects and preserves the prior destination for ambiguous or incidental mentions', () => {
  for (const [text, expected] of [
    ['Actually put it in Draft.md.', 'Draft.md'],
    ['Write the translation into notes.md instead.', 'paper/notes.md'],
    ['Update `paper/main.tex`.', 'paper/main.tex'],
    ['Save it as "My Paper.tex".', 'My Paper.tex'],
    ['Use the definition from Draft.md.', undefined],
    ['Use Draft.md as the source.', undefined],
    ['Use the notation in notes.md.', undefined],
    ['Use Draft.md or Other.md.', undefined],
    ["Don't write to Wrong.md, put it in Right.tex.", 'Right.tex'],
    ['Do not update notes.md.', undefined],
    ['Update notes.md and save it as Other.md.', undefined],
  ])
    assert.equal(followupInformalizationOutput(text, snapshot), expected, text)
  assert.equal(
    followupInformalizationOutput('Update notes.md', {
      files: [{ path: 'a/notes.md' }, { path: 'b/notes.md' }],
    }),
    undefined,
  )
  assert.throws(
    () => followupInformalizationOutput('Save it as ../other.md', snapshot),
    { status: 400 },
  )
})

test('extracts only added or revised document references for independent Lean resolution', () => {
  const before =
    md + '\n<!-- Lean: Other.lean#unrelated -->\nExisting unrelated prose.'
  assert.deepEqual(
    addedInformalizationReferences({
      path: 'a.md',
      before,
      after: before.replace('on the left', 'as the left summand'),
    }),
    [entries[1]],
  )
  assert.deepEqual(
    addedInformalizationReferences({ path: 'a.tex', after: tex }),
    entries,
  )
  assert.throws(
    () =>
      addedInformalizationReferences({
        path: 'a.md',
        after: md + '\n<!-- Lean: Main#missing -->\nProse',
      }),
    /path.lean#name/,
  )
  assert.throws(
    () =>
      addedInformalizationReferences({
        path: 'a.md',
        after: md + '\n<!-- Lean: Main.lean#missing -->',
      }),
    /its translation/,
  )
})

test('accepts a requested document, ignores suggestions as a restriction, and skips compilation for Markdown', async () => {
  const existing = {
    path: 'chapter-notes.md',
    before: 'Existing introduction.',
    after: md,
  }
  assert.deepEqual(
    await verify([existing], {
      job: {
        ...job,
        currentFile: 'paper/main.tex',
        prompt: 'Write in Markdown',
      },
    }),
    { path: existing.path },
  )
  await assert.rejects(
    verify([existing], { job: { ...job, outputFile: 'summary.md' } }),
    /requested document is summary.md/,
  )
  for (const changes of [
    [],
    [existing, { path: 'Main.lean', after: 'changed' }],
    [{ path: 'Main.lean', after: 'changed' }],
    [{ path: 'notes.md', after: null }],
    [{ path: 'notes.md', after: '  ' }],
  ])
    await assert.rejects(verify(changes), { status: 409 })
})

test('enforces the requested document and format at review including accepted redirects', async () => {
  const change = { path: 'custom.md', after: md }
  await assert.rejects(verify([change], { job }), /requires a TeX document/)
  await assert.rejects(
    verify([{ path: 'notes.tex', after: tex }], {
      job: { ...job, prompt: 'Write a Markdown document.' },
    }),
    /requires a Markdown document/,
  )
  await assert.rejects(
    verify([change], {
      job: { ...job, prompt: 'Read notes.md for a style example.' },
    }),
    /requires a TeX document/,
  )
  for (const prompt of [
    'Output file: output.md',
    'Insert the selected proof in output.md.',
    'Update output.md',
    'Add the statements and proofs from this file to the Results section of output.md.',
    'Translate these theorems into output.md.',
    'Create a paper named output.md.',
  ])
    await assert.rejects(
      verify([change], { job: { ...job, prompt } }),
      /requested document is output.md/,
    )
  for (const prompt of [
    'Add the statements and proofs from this file to the Results section of notes/My Paper.md.',
    'Merci de placer les preuves dans notes/My Paper.md.',
  ]) {
    assert.equal(
      informalizationDocumentPath({ ...job, prompt }, snapshot),
      'notes/My Paper.md',
    )
    await assert.rejects(
      verify([change], { job: { ...job, prompt } }),
      /requested document is notes\/My Paper.md/,
    )
  }
  await assert.rejects(
    verify([change], {
      job: { ...job, prompt: 'Place the summary inside notes.md' },
    }),
    /requested document is paper\/notes.md/,
  )
  assert.deepEqual(
    await verify([change], {
      job: { ...job, outputFile: 'old.tex' },
      followups: [
        { status: 'accepted', text: 'Actually put it in custom.md.' },
      ],
    }),
    { path: 'custom.md' },
  )
  await assert.rejects(
    verify([change], {
      job: { ...job, outputFile: 'old.tex' },
      followups: [
        { status: 'rejected', text: 'Actually put it in custom.md.' },
      ],
    }),
    /requested document is old.tex/,
  )
  assert.deepEqual(
    await verify([change], {
      job: { ...job, outputFile: 'old.tex' },
      followups: [
        { status: 'accepted', text: 'Actually make it Markdown instead.' },
      ],
    }),
    { path: 'custom.md' },
  )
  assert.deepEqual(
    await verify([change], {
      job: { ...job, prompt: 'Please produce a new Markdown document' },
    }),
    { path: 'custom.md' },
  )
})

test('requires visible text for every declaration at its own source reference and rejects empty updates to old translations', async () => {
  for (const after of [
    md.replace(
      '<!-- Lean: Main.lean#add_zero -->',
      'Inline <!-- Lean: Main.lean#add_zero -->',
    ),
    md.replace('Main.lean#add_zero', 'Other.lean#add_zero'),
    md.replace(
      'Adding zero on the right leaves a number unchanged.',
      '<!-- skipped -->',
    ),
    md.replace(
      'Adding zero on the right leaves a number unchanged.',
      '# To do',
    ),
    md.replace(
      'Adding zero on the right leaves a number unchanged.',
      '<!--\nInvisible.\n-->',
    ),
    md.replace('Adding zero on the left leaves a number unchanged.', ''),
  ])
    await assert.rejects(
      verify([{ path: 'notes.md', after }]),
      /source reference/,
    )
  for (const after of [
    md + '\n## Empty section',
    md + '\n<!-- New section -->',
    '# New heading\n' + md,
  ])
    await assert.rejects(
      verify([{ path: 'notes.md', before: md, after }]),
      /Revise or add/,
    )
  assert.deepEqual(
    await verify([
      {
        path: 'notes.md',
        before: md,
        after: md.replace('on the left', 'as the first summand'),
      },
    ]),
    { path: 'notes.md' },
  )
  for (const after of [
    String.raw`\begin{document}
\end{document}
${chapter}`,
    String.raw`${chapter}
\begin{document}Actual body.\end{document}`,
    String.raw`${chapter.replace('Adding zero on the right leaves a number unchanged.', '\\begin{theorem}[Theorem]\n\\end{theorem}')}
`,
  ])
    await assert.rejects(
      verify([{ path: 'paper.tex', after }]),
      /source reference/,
    )
})

test('requires statement and proof bodies for every theorem and honors an explicit statements-only request', async () => {
  const statement =
    '<!-- Lean: Main.lean#add_zero -->\nAdding zero returns the same number.'
  const candidate = (after) => [{ path: 'notes.md', after }]
  const options = { entries: [entries[0]] }
  for (const after of [
    statement,
    statement + '\n## Proof',
    statement + '\n**Proof.** TODO.',
    statement + '\n<!-- Lean proof -->\n[TODO]',
    statement.replace('Adding zero returns the same number.', 'Theorem.') +
      '\nProof. The defining equation gives the result.',
  ])
    await assert.rejects(
      verify(candidate(after), options),
      /statement and proof/,
    )
  for (const label of [
    '## Proof',
    '**Proof.**',
    'Proof.',
    '<!-- Lean proof -->',
  ])
    assert.deepEqual(
      await verify(
        candidate(
          statement +
            '\n' +
            label +
            '\nThe defining equation gives the result.',
        ),
        options,
      ),
      { path: 'notes.md' },
    )
  assert.deepEqual(
    await verify(candidate(statement), {
      ...options,
      job: {
        ...job,
        outputFile: 'notes.md',
        prompt: 'Write a document of statements only.',
      },
    }),
    { path: 'notes.md' },
  )
  await assert.rejects(
    verify(candidate(statement), {
      ...options,
      job: { ...job, outputFile: 'notes.md', prompt: 'Write statements only' },
      followups: [{ status: 'accepted', text: 'Actually add proofs.' }],
    }),
    /statement and proof/,
  )
  const chapterWithHeading = chapter
    .replace('\\begin{proof}', '\\paragraph{Proof.}')
    .replace('\\end{proof}', '')
  assert.deepEqual(
    addedInformalizationReferences({
      path: 'a.tex',
      after: chapterWithHeading,
    }),
    entries,
  )
})

test('compiles the final clean snapshot once, associates the PDF with the original run, and propagates diagnostics and cancellation', async () => {
  const signal = new AbortController().signal
  const record = {
    status: 'completed',
    id: 'pdf-id',
    pdf: { url: 'authenticated' },
  }
  const calls = []
  const texBuilds = {
    async start(...args) {
      calls.push(args)
      return { id: 'pdf-id' }
    },
    async wait(...args) {
      calls.push(args)
      return record
    },
  }
  const options = {
    texBuilds,
    signal,
    snapshot: { ...snapshot, purpose: 'verification', runId: 'clean-id' },
  }
  assert.deepEqual(await verify([{ path: 'draft.tex', after: tex }], options), {
    path: 'draft.tex',
    buildId: 'pdf-id',
  })
  assert.deepEqual(calls, [
    [
      'actor',
      'project',
      { rootFile: 'draft.tex' },
      {
        origin: 'agent',
        waitForProject: true,
        runId: 'run',
        verificationRunId: 'clean-id',
        requiredTexSources: [],
        sourceRoot: snapshot.root,
        signal,
      },
    ],
    ['actor', 'pdf-id'],
  ])
  Object.assign(record, {
    status: 'failed',
    diagnostics: [
      {
        severity: 'error',
        message: 'Undefined control sequence',
        path: 'draft.tex',
        line: 8,
      },
    ],
  })
  await assert.rejects(
    verify([{ path: 'draft.tex', after: tex }], options),
    /Undefined control sequence \(draft\.tex:8\)/,
  )
  await assert.rejects(verify([{ path: 'draft.tex', after: tex }]), {
    status: 503,
  })
  const abort = new AbortController()
  abort.abort(new Error('Cancelled by user'))
  await assert.rejects(
    verify([{ path: 'draft.tex', after: tex }], {
      ...options,
      signal: abort.signal,
    }),
    /Cancelled by user/,
  )
})

test('resolves fragment roots and requires confirmation that the chosen fragment contributed to the PDF', async () => {
  const calls = []
  const texBuilds = {
    async start(...args) {
      calls.push(args)
      return { id: 'pdf-id' }
    },
    async wait() {
      return { id: 'pdf-id', status: 'completed', pdf: {} }
    },
  }
  const edited = 'paper/sections/intro.tex'
  const verifyFragment = (after, opts = {}) =>
    verify([{ path: edited, after }], { texBuilds, ...opts })
  await verifyFragment(chapter)
  assert.deepEqual(calls[0][2], { rootFile: 'paper/main.tex' })
  assert.deepEqual(calls[0][3].requiredTexSources, [edited])
  const ambiguous = {
    ...snapshot,
    files: ['paper/book.tex', 'paper/paper.tex', edited].map((path) => ({
      path,
    })),
  }
  await assert.rejects(
    verifyFragment(chapter, { snapshot: ambiguous }),
    /Choose the root/,
  )
  await verifyFragment('% !TeX root = ../book.tex\n' + chapter, {
    snapshot: ambiguous,
  })
  assert.deepEqual(calls[1][2], { rootFile: 'paper/book.tex' })
  await assert.rejects(
    verifyFragment('% !TeX root = ../missing.tex\n' + chapter, {
      snapshot: ambiguous,
    }),
    /root.*unavailable/,
  )
  await verifyFragment(chapter, {
    snapshot: ambiguous,
    job: { ...job, files: ['paper/paper.tex'] },
  })
  assert.deepEqual(calls[2][2], { rootFile: 'paper/paper.tex' })
})

test('finds a document root among macros and unrelated compilable documents using guarded snapshot reads', async () => {
  const sources = new Map([
    [
      'paper/article.tex',
      String.raw`\documentclass{article}
\input{sections/intro}`,
    ],
    ['paper/cover.tex', String.raw`\documentclass{letter}`],
    ['paper/macros.tex', String.raw`\newcommand{\mycommand}{X}`],
  ])
  const clean = {
    ...snapshot,
    files: [...sources.keys()].map((path) => ({ path })),
  }
  const reads = []
  const workspaces = {
    async readSnapshotFile(s, path) {
      assert.equal(s, clean)
      reads.push(path)
      return { content: sources.get(path) }
    },
  }
  const texBuilds = {
    async start(_owner, _project, args, options) {
      assert.equal(args.rootFile, 'paper/article.tex')
      assert.deepEqual(options.requiredTexSources, ['paper/sections/intro.tex'])
      return { id: 'pdf' }
    },
    async wait() {
      return { id: 'pdf', pdf: {}, status: 'completed' }
    },
  }
  assert.deepEqual(
    await verify([{ path: 'paper/sections/intro.tex', after: chapter }], {
      snapshot: clean,
      workspaces,
      texBuilds,
    }),
    { path: 'paper/sections/intro.tex', buildId: 'pdf' },
  )
  assert.deepEqual(reads, [...sources.keys()])
})

test('one paper covers the checked proofs across linked Markdown files', async () => {
  const [right, left] = md
    .slice(md.indexOf('<!-- Lean:'))
    .split(/(?=<!-- Lean: Main\.lean#zero_add)/)
  const changes = [
    { path: 'notes/left.md', after: left },
    { path: 'notes/right.md', after: right },
    {
      path: 'notes/index.md',
      after: '# Results\n[First](right.md#proof) · [Second](left.md)',
    },
  ]
  const options = { job: { ...job, outputFile: 'notes/index.md' } }
  const paths = changes.map((change) => change.path)
  assert.deepEqual(await verify(changes, options), {
    path: 'notes/index.md',
    paths,
  })
  await assert.rejects(
    verify(
      changes.map((change) =>
        change.path.endsWith('index.md')
          ? {
              ...change,
              after: '[First](right.md)\n<!-- [Second](left.md) -->',
            }
          : change,
      ),
      options,
    ),
    /must link.*left\.md/,
  )
  await assert.rejects(
    verify(
      changes.map((change) =>
        change.path.endsWith('left.md')
          ? { ...change, after: '# Left' }
          : change,
      ),
      options,
    ),
    /statement and proof for Main\.lean#zero_add/,
  )
  for (const mention of ['![figure](left.md)', '[unused]: left.md']) {
    const suggested = changes.map((change) =>
      change.path.endsWith('index.md')
        ? { ...change, after: '[First](right.md)\n\n' + mention }
        : change,
    )
    await assert.rejects(verify(suggested, options), /must link.*left\.md/)
  }
  const referenced = changes.map((change) =>
    change.path.endsWith('index.md')
      ? {
          ...change,
          after:
            '[First](right.md) and [the left proof][second].\n\n[second]: left.md',
        }
      : change,
  )
  assert.equal((await verify(referenced, options)).path, 'notes/index.md')
  const saved = new Map([
    ['index.md', '[Chapters](chapters/list.md)'],
    ['chapters/list.md', '[Results](../notes/left.md)'],
  ])
  assert.deepEqual(
    await verify([{ path: 'notes/left.md', after: md }], {
      job: { ...job, outputFile: 'index.md' },
      snapshot: { files: [...saved.keys()].map((path) => ({ path })) },
      workspaces: {
        readSnapshotFile: async (_snapshot, name) => ({
          content: saved.get(name),
        }),
      },
    }),
    { path: 'index.md', paths: ['notes/left.md'] },
  )
})

test('counts an existing translation only when the unchanged chapter belongs to the paper', async () => {
  const [right, left] = md
    .slice(md.indexOf('<!-- Lean:'))
    .split(/(?=<!-- Lean: Main\.lean#zero_add)/)
  const changed = [{ path: 'notes/left.md', after: left }]
  const saved = new Map([
    ['notes/index.md', '[Left](left.md) and [Right](right.md)'],
    ['notes/right.md', right],
  ])
  const options = {
    job: { ...job, outputFile: 'notes/index.md' },
    snapshot: { files: [...saved.keys()].map((path) => ({ path })) },
    workspaces: {
      readSnapshotFile: async (_snapshot, name) => ({
        content: saved.get(name),
      }),
    },
  }
  assert.equal((await verify(changed, options)).path, 'notes/index.md')
  saved.set('notes/index.md', '[Left](left.md)')
  await assert.rejects(
    verify(changed, options),
    /statement and proof for Main\.lean#add_zero/,
  )
})

test('compiles a new TeX master and confirms all translated chapters in the same PDF', async () => {
  const [one, two] = chapter.split(/(?=% Lean: Main\.lean#zero_add)/)
  const changes = [
    { path: 'paper/first.tex', after: one },
    { path: 'paper/second.tex', after: two },
    { path: 'paper/setup.tex', after: '\\newcommand{\\Z}{Z}' },
    {
      path: 'paper/main.tex',
      after:
        '\\documentclass{article}\n\\input{setup}\n\\begin{document}\n\\input{first}\n\\input{second}\n\\end{document}',
    },
  ]
  const texBuilds = {
    async start(_owner, _project, input, options) {
      assert.deepEqual(input, { rootFile: 'paper/main.tex' })
      assert.deepEqual(options.requiredTexSources, [
        'paper/first.tex',
        'paper/second.tex',
      ])
      return { id: 'pdf' }
    },
    async wait() {
      return { status: 'completed', id: 'pdf', pdf: {} }
    },
  }
  assert.deepEqual(await verify(changes, { texBuilds }), {
    path: 'paper/main.tex',
    paths: changes.map((change) => change.path),
    buildId: 'pdf',
  })
  await assert.rejects(
    verify([...changes, { path: 'unrelated.tex', after: 'Unrelated prose' }], {
      texBuilds,
    }),
    /must link or include.*unrelated/,
  )
})
