#!/usr/bin/env node
// Interleaved reasoning, live updates and reloads, using mocked backends only.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { reasoningBlocksFromEvents } from '../shared/reasoning-timeline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(root, '.runtime/reasoning-timeline-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'timeline-fixture',
  chatId = 'timeline-chat'
const historicalEvents = [
  {
    seq: 1,
    type: 'message',
    data: { text: 'FIRST_REPLY: The baseline compiles.' },
  },
  {
    seq: 2,
    type: 'reasoning',
    data: { text: 'FIRST_STEP: Inspect the induction hypothesis.' },
  },
  { seq: 3, type: 'reasoning-summary', data: { text: 'First step summary.' } },
  {
    seq: 4,
    type: 'message',
    data: { text: '\n\nSECOND_REPLY: Try the local lemma.' },
  },
  {
    seq: 5,
    type: 'reasoning',
    data: { text: 'SECOND_STEP: Check the simplification.' },
  },
  {
    seq: 6,
    type: 'message',
    data: { text: '\n\nFINAL_REPLY: The proof checks.' },
  },
]
const historical = {
  id: 'historical-timeline',
  projectId,
  chatId,
  status: 'completed',
  mode: 'repair',
  createdAt: '2026-10-13T08:00:00Z',
  prompt: 'Check the earlier proof.',
  message: historicalEvents
    .filter((event) => event.type === 'message')
    .map((event) => event.data.text)
    .join(''),
  reasoning: historicalEvents
    .filter((event) => event.type === 'reasoning')
    .map((event) => event.data.text)
    .join(''),
  reasoningSummary: 'First step summary.',
  reasoningBlocks: reasoningBlocksFromEvents(historicalEvents),
  eventCursor: 6,
}
const active = {
  id: 'live-timeline',
  projectId,
  chatId,
  status: 'running',
  mode: 'repair',
  createdAt: '2026-10-13T09:00:00Z',
  prompt: 'Keep checking the proof.',
  message: 'LIVE_REPLY: Checking the next lemma.',
  reasoning: 'LIVE_STEP: Inspect the new target.',
  liveEdits: true,
  liveRevision: 0,
  reasoningBlocks: reasoningBlocksFromEvents([
    {
      seq: 7,
      type: 'message',
      data: { text: 'LIVE_REPLY: Checking the next lemma.' },
    },
    {
      seq: 8,
      type: 'reasoning',
      data: { text: 'LIVE_STEP: Inspect the new target.' },
    },
  ]),
  eventCursor: 8,
}
const setup = {
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Timeline fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: {
    [projectId]: {
      'Main.lean': 'import Lean\n\nexample : True := by trivial\n',
    },
  },
  chats: [{ id: chatId, projectId, title: 'Interleaved reasoning' }],
  runs: [historical, active],
}
const fixture = await chatBrowserFixture(setup)
const { page, browser, report, emit, state } = fixture
const oldTurn = page.locator(`[data-run-id="${historical.id}"]`)
const liveTurn = page.locator(`[data-run-id="${active.id}"]`)
const order = (turn) =>
  turn.evaluate((element) =>
    [...element.children]
      .filter(
        (child) =>
          child.classList.contains('assistant-message') ||
          child.classList.contains('reasoning-trace') ||
          child.classList.contains('followup-message'),
      )
      .map((child) =>
        child.classList.contains('reasoning-trace')
          ? 'reasoning'
          : child.classList.contains('followup-message')
            ? 'update'
            : 'reply',
      ),
  )
try {
  await fixture.ready()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'live timeline connection',
  )
  const work = page.locator('.chat-current-work')
  assert.match(await work.innerText(), /Live edits on · No saved edits yet/)
  const select = page.getByLabel('Select chat')
  const arrow = page.locator('.chat-picker-select > svg')
  const selectBox = await select.boundingBox(),
    arrowBox = await arrow.boundingBox()
  assert(
    selectBox &&
      arrowBox &&
      selectBox.x + selectBox.width - arrowBox.x - arrowBox.width >= 11,
    'Chat dropdown arrow needs space inside the right border',
  )
  report.checks.push(
    'The work status distinguishes live mode from actual saved edits, and the dropdown arrow is inset',
  )
  assert.deepEqual(await order(oldTurn), [
    'reply',
    'reasoning',
    'reply',
    'reasoning',
    'reply',
  ])
  assert.deepEqual(await order(liveTurn), ['reply', 'reasoning'])
  assert.equal(
    await page.locator('.reasoning-content').count(),
    0,
    'All reasoning bodies begin collapsed',
  )
  const oldTraces = oldTurn.locator('.reasoning-trace')
  await oldTraces.first().locator('summary').click()
  await oldTraces.first().locator('.reasoning-content').waitFor()
  assert.match(await oldTraces.first().textContent(), /FIRST_STEP/)
  assert(!(await oldTraces.first().textContent()).includes('SECOND_STEP'))
  assert.equal(await oldTraces.nth(1).locator('.reasoning-content').count(), 0)
  await oldTraces.nth(1).locator('summary').click()
  assert.match(
    await oldTraces.nth(1).locator('.reasoning-content').innerText(),
    /SECOND_STEP/,
  )
  assert(!(await oldTraces.nth(1).textContent()).includes('FIRST_STEP'))
  await oldTraces
    .first()
    .getByRole('button', { name: 'Hide reasoning trace' })
    .click()
  assert.equal(
    await oldTraces.nth(1).getAttribute('open'),
    '',
    'Each trace controls its own open state',
  )
  report.checks.push(
    'Saved replies and individually collapsible reasoning steps retain their order and load bodies lazily',
  )

  const firstLive = liveTurn.locator('.reasoning-trace').first()
  await firstLive.locator('summary').click()
  await firstLive.locator('.reasoning-content').waitFor()
  const composer = page.getByLabel('Message Lemex')
  await composer.fill('Keep this draft while I read the trace.')
  await emit(active, 'reasoning', ' LIVE_DELTA: The next check is ready.')
  await until(
    async () => (await firstLive.textContent()).includes('LIVE_DELTA'),
    'streamed current reasoning section',
  )
  await emit(active, 'message', '\n\nNEXT_REPLY: That lemma checks.')
  await emit(active, 'reasoning', 'NEXT_STEP: Check the remaining goal.')
  await until(
    async () => (await liveTurn.locator('.reasoning-trace').count()) === 2,
    'next inline reasoning section',
  )
  assert.deepEqual(await order(liveTurn), [
    'reply',
    'reasoning',
    'reply',
    'reasoning',
  ])
  assert.equal(
    await firstLive.getAttribute('open'),
    '',
    'An earlier open section must stay open',
  )
  assert.equal(
    await firstLive.locator('.reasoning-live').count(),
    0,
    'Earlier reasoning must no longer claim to be live',
  )
  const lastLive = liveTurn.locator('.reasoning-trace').last()
  assert.equal(
    await lastLive.getAttribute('open'),
    null,
    'New sections must begin collapsed',
  )
  assert.equal(await lastLive.locator('.reasoning-live').count(), 1)
  assert(!(await firstLive.textContent()).includes('NEXT_STEP'))
  assert.equal(
    await composer.inputValue(),
    'Keep this draft while I read the trace.',
  )
  await firstLive.getByRole('button', { name: 'Hide reasoning trace' }).click()
  await lastLive.locator('summary').click()
  assert.match(
    await lastLive.locator('.reasoning-content').innerText(),
    /NEXT_STEP/,
  )
  report.checks.push(
    'Streaming grows the current section and adds a collapsed next section while preserving earlier controls and the editable draft',
  )

  const before = state.files[projectId]['Main.lean']
  const after = before + '\n-- LIVE_FILE_UPDATE_FIXTURE\n'
  state.files[projectId]['Main.lean'] = after
  active.liveChanges = [{ path: 'Main.lean', before, after }]
  active.liveRevision = 1
  await emit(active, 'files-updated', { paths: ['Main.lean'], live: true })
  await emit(active, 'progress', {
    label: 'Checking the saved proof',
    updatedAt: new Date().toISOString(),
  })
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes(
        'LIVE_FILE_UPDATE_FIXTURE',
      ),
    'live saved edit in the editor',
  )
  await until(
    async () =>
      (await work.innerText()).includes('Live edits on · 1 file updated'),
    'saved-edit status',
  )
  assert.match(
    await work.locator('.chat-edit-status').getAttribute('title'),
    /Final Lean verification runs at completion/,
  )
  assert.equal(
    await composer.inputValue(),
    'Keep this draft while I read the trace.',
  )
  report.checks.push(
    'A saved live edit reaches the editor and updates file status without claiming final verification or replacing the draft',
  )
  await liveTurn.getByRole('button', { name: /^View edits/ }).click()
  const review = page.getByRole('dialog')
  await review.waitFor()
  assert.match(await review.innerText(), /LIVE_FILE_UPDATE_FIXTURE/)
  assert.match(
    await review.innerText(),
    /Final Lean verification is still pending/,
  )
  await review.getByRole('button', { name: 'Close', exact: true }).click()

  const beforeReload = await order(liveTurn)
  await fixture.ready()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'reconnected timeline',
  )
  assert.deepEqual(await order(liveTurn), beforeReload)
  assert.deepEqual(await order(oldTurn), [
    'reply',
    'reasoning',
    'reply',
    'reasoning',
    'reply',
  ])
  assert.equal(
    await page.locator('.reasoning-content').count(),
    0,
    'Reloaded traces begin collapsed',
  )
  await page.setViewportSize({ width: 1366, height: 768 })
  await lastLive.locator('summary').click()
  assert.match(
    await lastLive.locator('.reasoning-content').innerText(),
    /NEXT_STEP/,
  )
  await page.screenshot({
    path: path.join(reportDir, 'interleaved-reasoning.png'),
    fullPage: true,
  })
  report.checks.push(
    'Reloading and laptop layout preserve the ordered timeline and independently collapsed sections',
  )
  fixture.assertClean()
  const legacy = await chatBrowserFixture({
    ...structuredClone(setup),
    legacyReasoning: true,
    failReasoningHistory: true,
  })
  try {
    await legacy.ready()
    await until(
      () =>
        legacy.page.evaluate(
          (id) => window.__chatFixture.connected(id),
          active.id,
        ),
      'primary stream despite failed reasoning replay',
    )
    assert.equal(
      await legacy.page
        .getByRole('button', { name: 'Stop', exact: true })
        .isEnabled(),
      true,
    )
    await legacy.page
      .getByLabel('Message Lemex')
      .fill('A follow-up remains editable after a failed replay.')
    await until(
      () =>
        legacy.page.evaluate(() =>
          window.__chatFixture.urls.some((url) => url.endsWith('after=0')),
        ),
      'failed legacy reasoning replay',
    )
    await legacy.emit(
      legacy.state.runs.find((run) => run.id === active.id),
      'status',
      { status: 'completed' },
    )
    await until(
      async () =>
        (await legacy.page
          .getByRole('button', { name: 'Stop', exact: true })
          .count()) === 0,
      'completion despite failed reasoning replay',
    )
    assert.equal(
      await legacy.page.getByLabel('Message Lemex').inputValue(),
      'A follow-up remains editable after a failed replay.',
    )
    assert(
      !(await legacy.page.locator('.assistant-panel').innerText()).includes(
        'Could not load reasoning steps',
      ),
    )
    legacy.assertClean()
    report.checks.push(
      'A failed replay on the running older server never blocks status, completion, Stop, or draft editing',
    )
  } finally {
    await legacy.browser.close()
  }
  active.verification = {
    complete: false,
    compiled: false,
    errors: [
      'VERIFICATION_BLOCKED_FIXTURE: Changes exceed the permitted proof bodies.',
    ],
  }
  await emit(active, 'status', { status: 'completed' })
  const issue = liveTurn.locator('.turn-verification-issue')
  await issue.waitFor()
  await until(
    async () =>
      (await issue.innerText()).includes('VERIFICATION_BLOCKED_FIXTURE'),
    'visible final verification failure',
  )
  assert.match(await liveTurn.innerText(), /Finished · checks need attention/)
  await issue
    .getByRole('button', { name: 'Review checks', exact: true })
    .click()
  await liveTurn.locator('.turn-details[open] .verification-card').waitFor()
  report.checks.push(
    'Final verification failures remain visible in the transcript with an action to inspect the checks',
  )
  console.log(JSON.stringify({ checks: report.checks }, null, 2))
} catch (error) {
  await page.screenshot({
    path: path.join(reportDir, 'failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
