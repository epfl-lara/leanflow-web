import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

// Exercise the actual frontend functions and renderer without a browser build.
// Their extensionless imports target Vite, so transpile only in this test loader.
const require = createRequire(import.meta.url)
const modules = new Map([
  ['react-markdown', { __esModule: true, default: ReactMarkdown }],
  ['remark-gfm', { __esModule: true, default: remarkGfm }],
  ['remark-math', { __esModule: true, default: remarkMath }],
  ['rehype-katex', { __esModule: true, default: rehypeKatex }],
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
    if (id.endsWith('.css')) return {}
    if (id.endsWith('.mjs')) return require(id)
    if (id.startsWith('.')) {
      const suffix = existsSync(new URL(`${id}.ts`, import.meta.url))
        ? '.ts'
        : '.tsx'
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
const {
  runChangeCount,
  runChangePaths,
  runStatusLabel,
  conversationSegments,
  liveEditStatus,
  finalVerificationIssue,
} = load('./chatTimeline.ts')
const {
  clearDraftSubmission,
  restoreDraftSubmission,
  focusDraft,
  proofFocusPrompts,
} = load('./chatDrafts.ts')
const { OutputText } = load('./AssistantText.tsx')
const { hydrateReasoningHistory } = load('./reasoningHistory.ts')
const {
  retainedReasoningBlocks,
  reasoningBlocksFromEvents,
} = require('../../../shared/reasoning-timeline.mjs')
const { UsageSummary } = load('./UsageSummary.tsx')
const { Verification } = load('./RunReview.tsx')

test('Ask & Search reports conversation and file review separately from Lean verification', () => {
  for (const kind of ['chat', 'workspace']) {
    const value = {
      kind,
      complete: true,
      reason: 'No Lean source changes to check.',
    }
    const html = renderToStaticMarkup(
      React.createElement(Verification, { value }),
    )
    assert.doesNotMatch(html, /Lean verification passed|Axiom audit/)
    assert.match(html, /No Lean source changes to check/)
    assert.equal(
      runStatusLabel(run({ mode: 'search', verification: value })),
      kind === 'chat' ? 'Finished' : 'Ready to review',
    )
  }
  const failed = run({
    mode: 'search',
    verification: {
      complete: false,
      errors: ['The candidate project does not build.'],
    },
  })
  assert.equal(runStatusLabel(failed), 'Finished · checks need attention')
  assert.equal(
    finalVerificationIssue(failed),
    'The candidate project does not build.',
  )
  assert.equal(
    runStatusLabel(
      run({
        mode: 'search',
        verification: { complete: true, kernelChecked: true },
      }),
    ),
    'Verified',
  )
})

test('usage shows current context first and keeps cumulative request totals collapsed', () => {
  const html = renderToStaticMarkup(
    React.createElement(UsageSummary, {
      value: {
        total: {
          inputTokens: 3477092,
          cachedInputTokens: 3350016,
          outputTokens: 5603,
          totalTokens: 3482695,
        },
        last: { inputTokens: 26556 },
        modelContextWindow: 190000,
      },
    }),
  )
  assert.match(html, /Current context: 26,556 \/ 190,000 tokens \(14\.0%\)/)
  assert(
    html.indexOf('Current context') < html.indexOf('Totals for this request'),
  )
  assert.match(
    html,
    /<details class="usage-request"><summary>Totals for this request<\/summary>/,
  )
  assert.match(html, /Input \(including cached\)/)
  assert.match(html, /3,477,092/)
  assert.match(html, /Repeated context counts each time/)
})

test('missing context stays unknown instead of using request totals as context', () => {
  for (const last of [
    undefined,
    { inputTokens: -1 },
    { inputTokens: '26556' },
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(UsageSummary, {
        value: {
          total: { inputTokens: 3477092 },
          last,
          modelContextWindow: 190000,
        },
      }),
    )
    assert.match(html, /Current context was not reported/)
    assert(!html.includes('Current context: 3,477,092'))
  }
})

test('usage can show a reported context without a window or totals, including zero', () => {
  for (const input of [0, 26556]) {
    const html = renderToStaticMarkup(
      React.createElement(UsageSummary, {
        value: { last: { inputTokens: input } },
      }),
    )
    assert(html.includes(`Current context: ${input.toLocaleString()} tokens`))
    assert.match(html, /Token totals were not reported/)
    assert(!html.includes('%'))
  }
  assert.equal(
    renderToStaticMarkup(React.createElement(UsageSummary, { value: null })),
    '',
  )
})
const run = (fields = {}) => ({ id: 'run-1', status: 'completed', ...fields })
const draft = {
  text: 'Use the attached lemma',
  files: ['Main/Useful.lean'],
  revision: 7,
  mode: 'proofs',
}
const submission = { ...draft, key: 'chat-a' }

test('final verification rejection is reported independently of saved files and model claims', () => {
  const completed = run({
    message: 'The proof was checked.',
    liveEdits: true,
    liveRevision: 1,
    verification: {
      complete: false,
      compiled: false,
      errors: ['Main.lean changes code outside existing theorem proof bodies.'],
    },
  })
  assert.equal(runStatusLabel(completed), 'Finished · checks need attention')
  assert.equal(
    finalVerificationIssue(completed),
    completed.verification.errors[0],
  )
  assert.equal(
    finalVerificationIssue(run({ verification: { complete: true } })),
    '',
  )
  assert.equal(
    finalVerificationIssue(
      run({ verification: { kind: 'search', complete: false } }),
    ),
    '',
  )
  assert.equal(finalVerificationIssue(run()), '')
})

test('live edit status distinguishes work without writes, saved edits, review mode, and paused mirroring', () => {
  assert.equal(
    liveEditStatus(run({ liveEdits: true, liveRevision: 0 })),
    'Live edits on · No saved edits yet',
  )
  assert.equal(
    liveEditStatus(
      run({
        liveEdits: true,
        liveRevision: 2,
        liveChanges: [{ path: 'Main.lean' }],
      }),
    ),
    'Live edits on · 1 file updated',
  )
  assert.equal(
    liveEditStatus(
      run({
        liveEdits: true,
        liveRevision: 2,
        liveChangeCount: 5,
        liveChanges: [],
      }),
    ),
    'Live edits on · No current file changes',
  )
  assert.equal(
    liveEditStatus(run({ liveEdits: true, liveRevision: 2 })),
    'Live edits on · Edits saved',
  )
  assert.equal(
    liveEditStatus(run({ liveEdits: false })),
    'Review first · Files update after you accept changes',
  )
  assert.equal(
    liveEditStatus(run({ mode: 'search' })),
    'Review first · Requested edits need your approval',
  )
  assert.equal(
    liveEditStatus(
      run({
        mode: 'search',
        liveEdits: true,
        liveRevision: 1,
        liveChanges: [{ path: 'Notes.md', before: '', after: 'Notes' }],
      }),
    ),
    'Live edits on · 1 file updated',
  )
  assert.equal(
    liveEditStatus(
      run({ liveEdits: true, liveEditConflict: 'Saved file differs.' }),
    ),
    'Live edits paused · Saved files changed',
  )
})

test('reasoning is interleaved between replies, coalesces deltas, and survives duplicate replay and snapshots', () => {
  const initial = run({ status: 'running', eventCursor: 0 })
  const events = [
    { seq: 1, type: 'message', data: { text: 'First reply.' } },
    { seq: 2, type: 'reasoning', data: { text: 'Check ' } },
    { seq: 3, type: 'reasoning', data: { text: 'the lemma.' } },
    { seq: 4, type: 'reasoning-summary', data: { text: 'Checking.' } },
    { seq: 5, type: 'activity', data: { text: 'Tool activity.' } },
    { seq: 6, type: 'message', data: { text: 'Second reply.' } },
    { seq: 7, type: 'reasoning', data: { text: 'Try induction.' } },
  ]
  const current = appendRunEvents(initial, events)
  const segments = conversationSegments(current)
  assert.deepEqual(
    segments.map((entry) => entry.kind),
    ['assistant', 'reasoning', 'assistant', 'reasoning'],
  )
  assert.deepEqual(
    segments
      .filter((entry) => entry.kind === 'assistant')
      .map((entry) => entry.text),
    ['First reply.', 'Second reply.'],
  )
  const blocks = segments.filter((entry) => entry.kind === 'reasoning')
  assert.equal(blocks[0].active, false)
  assert.equal(blocks[1].active, true)
  assert.equal(blocks[0].block.reasoningLength, 'Check the lemma.'.length)
  assert.equal(blocks[0].block.summaryLength, 'Checking.'.length)
  assert.equal(current.reasoning, 'Check the lemma.Try induction.')
  assert.equal(initial.reasoning, undefined)
  assert.equal(appendRunEvents(current, events), current)
  const polled = mergeRunSnapshot(current, { ...current, status: 'completed' })
  assert.deepEqual(
    conversationSegments(polled).map((entry) => entry.key),
    segments.map((entry) => entry.key),
  )
})

test('trimmed message and reasoning tails keep absolute step and user-update positions', () => {
  const original = run({ status: 'running', eventCursor: 0 })
  const current = appendRunEvents(original, [
    { seq: 1, type: 'message', data: { text: 'a'.repeat(250010) } },
    { seq: 2, type: 'reasoning', data: { text: 'x'.repeat(250020) } },
    {
      seq: 3,
      type: 'followup',
      data: {
        id: 'u',
        text: 'Use induction.',
        status: 'accepted',
        createdAt: '2026-10-13T10:00:00Z',
        messageOffset: 250010,
      },
    },
    { seq: 4, type: 'message', data: { text: 'Final reply.' } },
  ])
  assert.equal(current.message.length, 250000)
  assert.equal(current.reasoning.length, 250000)
  assert.equal(current.reasoningBaseOffset, 20)
  const segments = conversationSegments(current)
  assert.deepEqual(
    segments.map((entry) => entry.kind),
    ['assistant', 'reasoning', 'followup', 'assistant'],
  )
  assert.equal(segments.at(-1).text, 'Final reply.')
  assert.equal(segments[1].block.messageOffset, 250010)
  assert.equal(segments[1].block.reasoningLength, 250020)
})

test('inline reply boundaries remove blank spacer lines without changing code indentation', () => {
  const message = '\n\nFirst reply.\n\n\n\n    example : True := by trivial\n\n'
  const position = message.indexOf('    example')
  const blocks = [
    {
      id: 'r',
      messageOffset: position,
      reasoningOffset: 0,
      reasoningLength: 1,
      summaryOffset: 0,
      summaryLength: 0,
    },
  ]
  const parts = conversationSegments(
    run({ message, reasoningBlocks: blocks }),
  ).filter((part) => part.kind === 'assistant')
  assert.deepEqual(
    parts.map((part) => part.text),
    ['First reply.', '    example : True := by trivial'],
  )
})

test('reasoning before and after a user update stays on its own side even without a reply', () => {
  const entry = {
    id: 'update-1',
    text: 'Try induction.',
    status: 'pending',
    createdAt: '2026-10-13T10:00:00Z',
    messageOffset: 0,
  }
  const events = [
    { seq: 1, type: 'reasoning', data: { text: 'Before update.' } },
    { seq: 2, type: 'followup', data: entry },
    { seq: 3, type: 'reasoning', data: { text: 'After update.' } },
    { seq: 4, type: 'followup', data: { ...entry, status: 'accepted' } },
    { seq: 5, type: 'reasoning', data: { text: ' Still after.' } },
  ]
  const current = appendRunEvents(
    run({ status: 'running', eventCursor: 0 }),
    events,
  )
  const parts = conversationSegments(current)
  assert.deepEqual(
    parts.map((part) => part.kind),
    ['reasoning', 'followup', 'reasoning'],
  )
  assert.equal(parts[0].block.reasoningLength, 'Before update.'.length)
  assert.equal(
    parts[2].block.reasoningLength,
    'After update. Still after.'.length,
  )
  assert.deepEqual(current.reasoningBlocks, reasoningBlocksFromEvents(events))
})

test('fully trimmed reasoning sections do not survive because of empty summary ranges', () => {
  const first = {
    id: 'old',
    messageOffset: 0,
    reasoningOffset: 0,
    reasoningLength: 10,
    summaryOffset: 100,
    summaryLength: 0,
  }
  const second = {
    ...first,
    id: 'new',
    reasoningOffset: 10,
    reasoningLength: 20,
  }
  assert.deepEqual(
    retainedReasoningBlocks([first, second], {
      reasoning: 10,
      reasoningSummary: 0,
    }),
    [second],
  )
})

test('a server without timeline metadata retains its earlier reasoning while new steps arrive', () => {
  const old = run({
    status: 'running',
    eventCursor: 3,
    message: 'Earlier reply.',
    reasoning: 'Earlier reasoning.',
  })
  const key = conversationSegments(old)[0].key
  const current = appendRunEvents(old, [
    { seq: 4, type: 'reasoning', data: { text: 'New step.' } },
  ])
  assert.deepEqual(
    conversationSegments(current).map((entry) => entry.kind),
    ['reasoning', 'assistant', 'reasoning'],
  )
  assert.equal(conversationSegments(current)[0].key, key)
  assert.equal(
    current.reasoningBlocks[1].reasoningOffset,
    'Earlier reasoning.'.length,
  )
})

test('older running servers recover positions through owned replay and only replay subsequent gaps', async (t) => {
  const events = [
    { seq: 1, type: 'message', data: { text: 'First.' } },
    { seq: 2, type: 'reasoning', data: { text: 'Step one.' } },
    { seq: 3, type: 'message', data: { text: 'Second.' } },
    { seq: 4, type: 'reasoning', data: { text: 'Step two.' } },
    { seq: 5, type: 'status', data: { status: 'running' } },
  ]
  const streams = [],
    saved = globalThis.EventSource
  t.after(() => {
    globalThis.EventSource = saved
  })
  globalThis.EventSource = class extends EventTarget {
    constructor(url) {
      super()
      this.url = url
      streams.push(this)
      queueMicrotask(() => {
        for (const event of events)
          this.dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify(event) }),
          )
      })
    }
    close() {
      this.closed = true
    }
  }
  const snapshot = run({
    status: 'running',
    eventCursor: 5,
    message: 'First.Second.',
    reasoning: 'Step one.Step two.',
  })
  const hydrated = await hydrateReasoningHistory(snapshot)
  assert.equal(streams[0].url, '/api/runs/run-1/events?after=0')
  assert.equal(streams[0].closed, true)
  assert.deepEqual(
    hydrated.reasoningBlocks.map((block) => block.messageOffset),
    [6, 13],
  )
  assert.equal(hydrated.reasoningBlocks[0].id, 'reasoning-legacy')
  assert.equal(hydrated.message, snapshot.message)
  assert.equal(hydrated.reasoning, snapshot.reasoning)
  events.push(
    { seq: 6, type: 'message', data: { text: 'Third.' } },
    { seq: 6, type: 'message', data: { text: 'Third.' } },
    { seq: 7, type: 'reasoning', data: { text: 'Step three.' } },
  )
  const next = await hydrateReasoningHistory(
    {
      ...snapshot,
      eventCursor: 7,
      message: snapshot.message + 'Third.',
      reasoning: snapshot.reasoning + 'Step three.',
    },
    hydrated,
  )
  assert.equal(streams[1].url, '/api/runs/run-1/events?after=5')
  assert.deepEqual(
    next.reasoningBlocks.map((block) => block.messageOffset),
    [6, 13, 19],
  )
  assert.equal(next.reasoningBlocks[0].id, hydrated.reasoningBlocks[0].id)
  assert.equal(await hydrateReasoningHistory(next), next)
  assert.equal(streams.length, 2)
})

test('reasoning replay closes promptly on cancellation and reports connection failures', async (t) => {
  const streams = [],
    saved = globalThis.EventSource
  t.after(() => {
    globalThis.EventSource = saved
  })
  globalThis.EventSource = class extends EventTarget {
    constructor() {
      super()
      streams.push(this)
    }
    close() {
      this.closed = true
    }
  }
  const snapshot = run({ eventCursor: 3, reasoning: 'Reasoning.' })
  const controller = new AbortController()
  const pending = hydrateReasoningHistory(snapshot, null, controller.signal)
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  assert.equal(streams[0].closed, true)
  const failed = hydrateReasoningHistory(snapshot)
  streams[1].dispatchEvent(new Event('error'))
  await assert.rejects(failed, /Try opening the trace again/)
  assert.equal(streams[1].closed, true)
})

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
  assert.equal(runStatusLabel(merged), 'Finished')
  assert.equal(
    runStatusLabel(run({ mode: 'search', verification: { complete: true } })),
    'Verified',
  )
})

test('lightweight steering receipts retain full previews and apply their durable acknowledgement', () => {
  const change = { path: 'Main.lean', before: 'old proof', after: 'new proof' }
  const previous = run({
    status: 'running',
    eventCursor: 5,
    changes: [change],
    liveChanges: [change],
    verification: { compiled: true, files: ['Main.lean'] },
  })
  const receipt = run({
    status: 'running',
    eventCursor: 6,
    changeCount: 1,
    liveChangeCount: 1,
    followups: [{ id: 'receipt', text: 'Keep this proof.', status: 'pending' }],
  })
  const merged = mergeRunSnapshot(previous, receipt)
  assert.deepEqual(merged.changes, [change])
  assert.deepEqual(merged.liveChanges, [change])
  assert.deepEqual(merged.verification, previous.verification)
  assert.deepEqual(merged.followups, receipt.followups)
  assert.deepEqual(mergeRunSnapshot(merged, receipt), merged)
})

test('project summaries without a live revision retain a loaded nonlive proof preview', () => {
  const change = {
    path: 'Main.lean',
    before: 'before',
    after: 'reviewed proof',
  }
  const previous = run({
    status: 'completed',
    eventCursor: 5,
    liveEdits: false,
    changes: [change],
  })
  const summary = run({ status: 'completed', eventCursor: 5, liveEdits: false })
  assert.equal(summary.liveRevision, undefined)
  assert.deepEqual(mergeRunSnapshot(previous, summary).changes, [change])
})

test('new metadata revisions invalidate older proof previews and retain current file links until explicit review', () => {
  const change = { path: 'Old.lean', before: 'before', after: 'old revision' }
  const previous = run({
    status: 'running',
    eventCursor: 4,
    liveEdits: true,
    liveRevision: 1,
    changes: [change],
    liveChanges: [change],
  })
  const metadata = run({
    status: 'running',
    eventCursor: 5,
    liveEdits: true,
    liveRevision: 2,
    changeCount: 1,
    liveChangeCount: 1,
    changePaths: ['Current.lean'],
    liveChangePaths: ['Current.lean'],
  })
  const value = mergeRunSnapshot(previous, metadata)
  assert.equal(value.changes, undefined)
  assert.equal(value.liveChanges, undefined)
  assert.deepEqual(runChangePaths(value, true), ['Current.lean'])
  assert.equal(runChangeCount(value, true), 1)
  assert.equal(liveEditStatus(value), 'Live edits on · 1 file updated')
  const { ConversationTurn } = load('./ConversationTurn.tsx')
  const html = renderToStaticMarkup(
    React.createElement(ConversationTurn, {
      run: value,
      onReview: () => {},
      onUndo: () => {},
      onInspect: async () => {},
      canUndo: false,
      undoing: false,
      onOpenTarget: () => {},
    }),
  )
  assert.match(html, /Saved to project:/)
  assert.match(html, /Current\.lean/)
  assert(!html.includes('Old.lean'))
  const currentChange = {
    path: 'Current.lean',
    before: 'before',
    after: 'current revision',
  }
  const reviewed = mergeRunSnapshot(value, {
    ...metadata,
    liveChanges: [currentChange],
    changes: [currentChange],
  })
  assert.deepEqual(reviewed.liveChanges, [currentChange])
  assert.deepEqual(runChangePaths(reviewed, true), ['Current.lean'])
  const undone = mergeRunSnapshot(reviewed, {
    ...metadata,
    eventCursor: 6,
    liveUndone: true,
    liveChangeCount: 0,
    liveChangePaths: [],
  })
  assert.equal(undone.liveChanges, undefined)
  assert.equal(runChangeCount(undone, true), 0)
})

test('saved-file events clear stale previews before metadata refresh and preserve replayed output', () => {
  const change = { path: 'Main.lean', before: 'before', after: 'old revision' }
  const previous = run({
    status: 'running',
    eventCursor: 2,
    changes: [change],
    liveChanges: [change],
    message: 'Saved proof.',
  })
  const value = appendRunEvents(previous, [
    {
      seq: 3,
      type: 'files-updated',
      data: { paths: ['Main.lean'], live: true },
    },
    { seq: 4, type: 'message', data: { text: ' Checking it.' } },
  ])
  assert.equal(value.liveChanges, undefined)
  assert.equal(value.changes, undefined)
  assert.equal(value.message, 'Saved proof. Checking it.')
  assert.equal(value.eventCursor, 4)
  assert.equal(
    appendRunEvents(value, [{ seq: 3, type: 'files-updated', data: {} }]),
    value,
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

test('proof targets are consumed and restored with their exact draft revision', () => {
  const proofTarget = {
    path: 'Main.lean',
    startLine: 3,
    endLine: 4,
    name: 'useful',
    source: 'theorem useful : True := by\n  trivial',
  }
  const focused = { ...draft, proofTarget }
  const sent = { ...submission, proofTarget }
  const cleared = clearDraftSubmission(focused, sent, true)
  assert.equal(cleared.proofTarget, undefined)
  assert.deepEqual(
    restoreDraftSubmission(cleared, sent).proofTarget,
    proofTarget,
  )
  assert.equal(
    clearDraftSubmission(
      { ...focused, proofTarget: { ...proofTarget, source: 'edited source' } },
      sent,
      true,
    ),
    null,
  )
  assert.equal(
    restoreDraftSubmission(
      { ...cleared, proofTarget: { ...proofTarget, name: 'other' } },
      sent,
    ),
    null,
  )
})

test('changing proof focus mode updates only generated prompts and preserves custom requests', () => {
  const target = {
    path: 'Main.lean',
    startLine: 1,
    endLine: 2,
    source: 'example : True := by\n  trivial',
  }
  const fresh = focusDraft({ ...draft, text: '' }, target, 'proofs')
  assert.equal(fresh.text, proofFocusPrompts.proofs)
  assert.equal(
    focusDraft(fresh, target, 'optimize').text,
    proofFocusPrompts.optimize,
  )
  assert.equal(
    focusDraft(
      { ...fresh, text: 'Please use my specific lemma.' },
      target,
      'optimize',
    ).text,
    'Please use my specific lemma.',
  )
  assert.equal(
    focusDraft({ ...fresh, text: proofFocusPrompts.optimize }, target, 'proofs')
      .text,
    proofFocusPrompts.proofs,
  )
})

test('Ask & Search focuses declarations with a read-only prompt and preserves custom drafts', () => {
  const target = {
    path: 'Main.lean',
    startLine: 3,
    endLine: 3,
    name: 'negate',
    source: 'def negate (b : Bool) := !b',
  }
  for (const text of ['', '  ', ...Object.values(proofFocusPrompts)]) {
    const focused = focusDraft({ ...draft, text }, target, 'search')
    assert.equal(focused.mode, 'search')
    assert.equal(
      focused.text,
      'Explain this proof or definition and find relevant lemmas. Do not edit files.',
    )
    assert.deepEqual(focused.proofTarget, target)
    assert.deepEqual(focused.files, draft.files)
    assert.equal(focused.revision, draft.revision + 1)
    assert.equal(
      focusDraft(focused, target, 'optimize').text,
      proofFocusPrompts.optimize,
    )
    assert.equal(
      focusDraft(focused, target, 'proofs').text,
      proofFocusPrompts.proofs,
    )
  }
  const custom = focusDraft(draft, target, 'search')
  assert.equal(custom.mode, 'search')
  assert.equal(custom.text, draft.text)
  assert.deepEqual(custom.proofTarget, target)
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

test('live output renders Markdown and completed formulas while incomplete math stays readable', () => {
  const html = renderToStaticMarkup(
    React.createElement(OutputText, {
      text: '| a | b |\n|---|---|\n\n$C^\\infty$ and $\\frac{1}',
      streaming: true,
    }),
  )
  assert.match(html, /class="streaming-text markdown-body"/)
  assert.match(html, /<table>/)
  assert.match(html, /class="katex"/)
  assert.match(html, /\$\\frac\{1\}/)
})

test('math renders dollar and LaTeX delimiters inline and in display mode', () => {
  const text = String.raw`The force $f(x,t)$ is smooth ($C^\infty$) for $t \ge 0$.

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

Also \(a^2 + b^2 = c^2\).

\[
\sum_{n=1}^\infty \frac{1}{n^2} = \frac{\pi^2}{6}
\]`
  for (const streaming of [false, true]) {
    const html = renderToStaticMarkup(
      React.createElement(OutputText, { text, streaming }),
    )
    assert.equal((html.match(/class="katex"/g) || []).length, 6)
    assert.equal((html.match(/class="katex-display"/g) || []).length, 2)
    assert.equal((html.match(/<math /g) || []).length, 6)
    assert.doesNotMatch(html, /katex-error/)
  }
})

test('math parsing preserves code, escaped delimiters and link destinations', () => {
  const text = [
    String.raw`Literal \`$x$\` and \`\(x\)\`. Escaped \\(x\\) and \$5.`,
    '',
    '[Reference](https://example.com/$x$)',
    '',
    '```lean',
    String.raw`-- $x$ and \(x\) are literal Lean comments`,
    'example : True := by trivial',
    '```',
    '',
    '    -- $x$ and \\(x\\) are literal indented code',
  ]
    .join('\n')
    .replaceAll('\\`', '`')
  const html = renderToStaticMarkup(React.createElement(OutputText, { text }))
  assert.doesNotMatch(html, /class="katex"/)
  assert.match(html, /<code>\$x\$<\/code>/)
  assert.match(html, /<code>\\\(x\\\)<\/code>/)
  assert.match(html, /Escaped \\\(x\\\) and \$5/)
  assert.match(html, /href="https:\/\/example.com\/\$x\$"/)
  assert.match(html, /<pre><code class="language-lean">-- \$x\$/)
})

test('every streamed LaTeX prefix renders safely, including multiline and CRLF formulas', () => {
  for (const formula of [
    String.raw`\(\frac{1}{2} + x^2\)`,
    '\\[\r\n\\sum_{n=1}^3 n = 6\r\n\\]',
    '\\[\n\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}\n\\]',
  ]) {
    for (let length = 0; length <= formula.length; length++) {
      assert.doesNotThrow(() =>
        renderToStaticMarkup(
          React.createElement(OutputText, {
            text: formula.slice(0, length),
            streaming: true,
          }),
        ),
      )
    }
    const html = renderToStaticMarkup(
      React.createElement(OutputText, { text: formula, streaming: true }),
    )
    assert.match(html, /class="katex"/)
    assert.doesNotMatch(html, /katex-error/)
  }
})

test('unsupported and untrusted math stays readable without creating unsafe elements', () => {
  for (const streaming of [false, true]) {
    const text = String.raw`$\unknownMacro{x}$ $\href{javascript:alert(1)}{click}$ $\includegraphics{https://example.com/image.png}$ <script>alert(1)</script>`
    const html = renderToStaticMarkup(
      React.createElement(OutputText, { text, streaming }),
    )
    assert.match(html, /\\unknownMacro/)
    assert.doesNotMatch(
      html,
      /<a[\s>]|<img[\s>]|<script[\s>]|href="javascript:/,
    )
  }
})
