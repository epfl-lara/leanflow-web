import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Exercise the actual frontend functions and renderer without a browser build.
// Their extensionless imports target Vite, so transpile only in this test loader.
const require = createRequire(import.meta.url)
const modules = new Map([
  ['react-markdown', { __esModule: true, default: ReactMarkdown }],
  ['remark-gfm', { __esModule: true, default: remarkGfm }],
])
function load(name) {
  if (modules.has(name)) return modules.get(name)
  const path = new URL(name, import.meta.url)
  const source = readFileSync(path, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: fileURLToPath(path),
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  })
  const module = { exports: {} }
  modules.set(name, module.exports)
  const imports = (id) => {
    if (id.startsWith('.')) {
      const suffix = id === './Icons' ? '.tsx' : '.ts'
      return load(`${id}${suffix}`)
    }
    return modules.has(id) ? modules.get(id) : require(id)
  }
  new Function('require', 'module', 'exports', outputText)(
    imports,
    module,
    module.exports,
  )
  modules.set(name, module.exports)
  return module.exports
}

const { mergeRunSnapshot, appendRunEvents } = load('./runStream.ts')
const { runChangeCount, runStatusLabel } = load('./chatTimeline.ts')
const { clearDraftSubmission, restoreDraftSubmission } = load('./chatDrafts.ts')
const { OutputText } = load('./AssistantText.tsx')
const run = (fields = {}) => ({ id: 'run-1', status: 'completed', ...fields })
const draft = {
  text: 'Use the attached lemma',
  files: ['Main/Useful.lean'],
  revision: 7,
  mode: 'proofs',
}
const submission = { ...draft, key: 'chat-a' }

test('compact history preserves full verification details and search kind', () => {
  const full = run({
    eventCursor: 12,
    mode: 'search',
    verification: {
      compiled: true,
      complete: true,
      kind: 'search',
      files: ['Main.lean'],
      errors: ['diagnostic detail'],
      axioms: { lemma: ['propext'] },
    },
  })
  const merged = mergeRunSnapshot(
    full,
    run({ eventCursor: 13, verification: { compiled: true, complete: true } }),
  )
  assert.deepEqual(merged.verification, full.verification)
  assert.equal(runStatusLabel(merged), 'Search finished')
  assert.equal(
    runStatusLabel(run({ mode: 'search', verification: { complete: true } })),
    'Search finished',
  )
})

test('partial verification events retain details but explicit results replace fields', () => {
  const original = run({
    eventCursor: 2,
    verification: { complete: true, files: ['Main.lean'], errors: ['old'] },
  })
  const merged = appendRunEvents(original, [
    { seq: 3, type: 'verification', data: { complete: false, errors: [] } },
  ])
  assert.deepEqual(merged.verification, {
    complete: false,
    files: ['Main.lean'],
    errors: [],
  })
  assert.deepEqual(original.verification.errors, ['old'])
  assert.equal(
    mergeRunSnapshot(merged, run({ eventCursor: 4, verification: null }))
      .verification,
    null,
  )
})

test('stale polls cannot drop details or revive a terminal run', () => {
  const original = run({ eventCursor: 8, verification: { complete: true } })
  assert.equal(
    mergeRunSnapshot(original, run({ eventCursor: 7, verification: {} })),
    original,
  )
  assert.equal(
    mergeRunSnapshot(original, run({ eventCursor: 9, status: 'running' })),
    original,
  )
})

test('actual empty and nonempty change arrays supersede stale compact counts', () => {
  assert.equal(runChangeCount(run({ changeCount: 5, changes: [] })), 0)
  assert.equal(
    runChangeCount(run({ changeCount: 0, changes: [{ path: 'Main.lean' }] })),
    1,
  )
  assert.equal(
    runChangeCount(run({ liveChangeCount: 5, liveChanges: [] }), true),
    0,
  )
  assert.equal(
    runChangeCount(
      run({ liveChangeCount: 0, liveChanges: [{ path: 'Main.lean' }] }),
      true,
    ),
    1,
  )
  assert.equal(runChangeCount(run({ changeCount: 3 })), 3)
})

test('successful steering consumes its captured attachments and failed delivery restores both', () => {
  const cleared = clearDraftSubmission(draft, submission, true)
  assert.deepEqual(cleared, { ...draft, text: '', files: [], revision: 8 })
  assert.deepEqual(restoreDraftSubmission(cleared, submission), {
    ...draft,
    revision: 9,
  })
  assert.deepEqual(clearDraftSubmission(draft, submission).files, draft.files)
  assert.deepEqual(draft.files, ['Main/Useful.lean'])
})

test('new typing, files, or revision prevent delayed receipts from changing a draft', () => {
  assert.equal(
    clearDraftSubmission(
      { ...draft, text: 'New request', revision: 8 },
      submission,
      true,
    ),
    null,
  )
  assert.equal(
    clearDraftSubmission(
      { ...draft, files: ['Main/New.lean'] },
      submission,
      true,
    ),
    null,
  )
  assert.equal(
    restoreDraftSubmission(
      { ...draft, text: 'New request', files: [], revision: 9 },
      submission,
    ),
    null,
  )
  assert.equal(
    restoreDraftSubmission(
      { ...draft, text: '', files: ['Main/New.lean'], revision: 8 },
      submission,
    ),
    null,
  )
})

test('completed replies render GFM tables, Lean code, lists and safe external links', () => {
  const text = String.raw`| Theorem | New body | Main idea |
| --- | --- | --- |
| useful | \`by exact h <;> simp\` | \`a \| b\` |

- Reuse the lemma
- [Lean reference](https://lean-lang.org/)

\`\`\`lean
theorem useful : True := by trivial
\`\`\`

![diagram](https://example.com/image.png)
<script>alert('unsafe')</script>`.replaceAll('\\`', '`')
  const html = renderToStaticMarkup(React.createElement(OutputText, { text }))
  assert.match(html, /class="markdown-table"><table>/)
  assert.match(
    html,
    /<thead><tr><th>Theorem<\/th><th>New body<\/th><th>Main idea<\/th>/,
  )
  assert.match(html, /<code>by exact h &lt;;&gt; simp<\/code>/)
  assert.match(html, /<code>a \| b<\/code>/)
  assert.match(html, /<ul>/)
  assert.match(html, /target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /<pre><code class="language-lean">/)
  assert.doesNotMatch(html, /<img|<script/)
})

test('live output stays plain text until the response finishes', () => {
  const html = renderToStaticMarkup(
    React.createElement(OutputText, {
      text: '| a | b |\n|---|---|',
      streaming: true,
    }),
  )
  assert.match(html, /class="streaming-text"/)
  assert.doesNotMatch(html, /<table>/)
})
