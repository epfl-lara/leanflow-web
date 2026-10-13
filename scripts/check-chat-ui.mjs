#!/usr/bin/env node
// Exercise continuous chat and message races with entirely mocked backends.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chatBrowserFixture,
  sleep,
  until,
} from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(root, '.runtime/chat-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'chat-ui-fixture',
  otherProjectId = 'chat-ui-other'
const chatId = 'alpha-chat',
  otherChatId = 'beta-chat'
const earlierAnswer = 'EARLIER_ANSWER: The first proof is complete.'
const earlier = {
  id: 'earlier-proof',
  projectId,
  chatId,
  status: 'completed',
  mode: 'repair',
  createdAt: '2026-10-13T08:00:00Z',
  prompt: 'Earlier proof question.',
  message:
    earlierAnswer +
    '\n\n' +
    `| Lean expression | Result |
| --- | --- |
| \`a \\| b\` | Escaped pipe stays in one cell |
| \`by simp\` | Checked |

- First checked lemma
- Second checked lemma

[Lean reference](https://lean-lang.org/doc/reference/latest/)

![Diagram](https://example.invalid/never-load-this-image.png)`,
  eventCursor: 1,
}
const active = {
  id: 'active-proof',
  projectId,
  chatId,
  status: 'running',
  mode: 'repair',
  createdAt: '2026-10-13T09:00:00Z',
  prompt: 'Continue proving the same theorem.',
  message: 'ACTIVE_ANSWER: I am checking the next proof over ℕ. 🔎\n\n',
  reasoning: 'TRACE_FIXTURE: Inspecting the target and relevant declarations.',
  log: 'ACTIVITY_FIXTURE: lean_diagnostics is running.\n',
  progress: {
    label: 'Checking Main.lean',
    detail: 'Reading diagnostics',
    updatedAt: '2026-10-13T09:00:00Z',
  },
  followups: [],
  liveEdits: false,
  liveChangeCount: 0,
  files: [],
  eventCursor: 2,
}
const project = (id, name) => ({
  id,
  name,
  status: 'ready',
  toolchain: 'leanprover/lean4:v4.34.1',
})
const sources = {
  'Main.lean': 'import Lean\n\nexample : True := by\n  trivial\n',
  'Notes.lean': 'import Lean\n\nexample (a : Nat) : a = a := by\n  rfl\n',
}
Object.assign(earlier, {
  reasoning: 'OLDER_TRACE: This completed run used the existing local lemma.',
  log: 'OLDER_ACTIVITY: Finished a Lean check.\n',
  liveEdits: false,
  // A full snapshot's concrete arrays must outrank stale streamed counts.
  changeCount: 0,
  changes: [
    {
      path: 'Main.lean',
      before: sources['Main.lean'],
      after: sources['Main.lean'] + '\n-- HISTORICAL_REVIEW_DIFF\n',
    },
  ],
  verification: {
    compiled: false,
    complete: false,
    kernelChecked: false,
    kind: 'proof',
    errors: [
      'PRESERVED_VERIFICATION_ERROR: candidate still has a type mismatch',
    ],
    warnings: ['PRESERVED_VERIFICATION_WARNING: unused declaration'],
    axioms: { theorem: ['propext'] },
  },
  usage: {
    total: {
      inputTokens: 1200,
      cachedInputTokens: 120,
      outputTokens: 340,
      reasoningOutputTokens: 140,
      totalTokens: 1540,
    },
    modelContextWindow: 200000,
  },
})
const fixture = await chatBrowserFixture({
  base: process.env.STUDIO_TEST_URL,
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [
      {
        id: 'fixture-model',
        name: 'Fixture model',
        reasoningEfforts: [
          { id: 'low', description: 'Brief reasoning' },
          { id: 'high', description: 'Detailed reasoning' },
        ],
        defaultReasoningEffort: 'low',
      },
      { id: 'fixture-other-model', name: 'Other fixture model' },
    ],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    project(projectId, 'Chat fixture'),
    project(otherProjectId, 'Other chat fixture'),
  ],
  files: {
    [projectId]: { ...sources },
    [otherProjectId]: {
      ...sources,
      'PrivateOnly.lean': 'example : True := by trivial\n',
    },
  },
  chats: [
    { id: chatId, projectId, title: 'Alpha conversation' },
    { id: otherChatId, projectId, title: 'Beta conversation' },
    {
      id: 'other-project-chat',
      projectId: otherProjectId,
      title: 'Other project conversation',
    },
  ],
  runs: [earlier, active],
})
const { page, browser, state, report, emit } = fixture
const composer = page.getByLabel('Message Lemex')
const conversation = page.getByRole('region', {
  name: 'Conversation',
  exact: true,
})
const sendUpdate = page.getByRole('button', {
  name: 'Send update',
  exact: true,
})
const currentTurn = () => page.locator(`[data-run-id="${active.id}"]`)
const messageRequests = () =>
  report.requests.filter(
    (request) =>
      request.method === 'POST' && request.endpoint.endsWith('/messages'),
  )
const runRequests = () =>
  report.requests.filter(
    (request) =>
      request.method === 'POST' && request.endpoint.endsWith('/runs'),
  )
const selectedFiles = async () =>
  page
    .locator('.file-context-chip')
    .evaluateAll((chips) =>
      chips.map((chip) => chip.getAttribute('title')).sort(),
    )
async function chooseFiles(paths) {
  await page.getByLabel('Select files', { exact: true }).click()
  for (const file of Object.keys(sources))
    await page
      .getByRole('checkbox', { name: file, exact: true })
      .setChecked(paths.includes(file))
  await page.getByLabel('Filter context files').press('Escape')
}
async function chooseChat(id) {
  await page.getByLabel('Select chat').selectOption(id)
  await until(
    async () =>
      (await page.getByLabel('Select chat').inputValue()) === id &&
      !(await page.locator('.chat-picker[aria-busy="true"]').count()),
    `chat ${id}`,
  )
}
async function holdUpdate() {
  let pending
  state.onMessage = ({ run, body, respond }) =>
    new Promise((resolve) => {
      assert.equal(
        run.id,
        active.id,
        'Guidance must target the active run in this chat',
      )
      assert.match(
        body.id,
        /^[0-9a-f-]{36}$/i,
        'Each submitted update needs an acknowledgement identity',
      )
      pending = {
        run,
        body,
        async release(status = 'accepted', error) {
          const receipt = {
            id: body.id,
            text: body.text,
            status,
            createdAt: new Date().toISOString(),
            messageOffset: run.message.length,
            ...(error ? { error } : {}),
          }
          await emit(run, 'followup', receipt)
          await respond(structuredClone(run))
          resolve()
          return receipt
        },
      }
    })
  return async () => {
    await until(async () => !!pending, 'captured update request')
    return pending
  }
}
async function assertReceipt(id, text, status) {
  const entry = page.locator(`[data-followup-id="${id}"]`)
  await entry.waitFor()
  await until(
    async () => status.test(await entry.innerText()),
    `receipt ${id} ${status}`,
  )
  assert.equal(
    await entry.count(),
    1,
    'One message receipt must render exactly once',
  )
  assert(
    (await entry.innerText()).includes(text),
    'Receipt omitted its submitted message',
  )
  assert.match(await entry.innerText(), status)
}
async function visible(locator, label) {
  await locator.waitFor({ state: 'visible', timeout: 10000 })
  const box = await locator.boundingBox(),
    viewport = page.viewportSize()
  assert(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    `${label} is outside viewport`,
  )
}

try {
  await fixture.ready()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'active chat stream',
  )
  for (const name of ['Proofs', 'Formalize', 'Optimize', 'Ask & Search'])
    await visible(
      page.locator('.mode-tabs').getByRole('button', { name, exact: true }),
      name,
    )
  assert.equal(
    await page
      .getByRole('button', { name: /Repair a proof|Find a proof/ })
      .count(),
    0,
    'Proofs should not need a second repair/prove choice',
  )
  assert.equal(
    await page.getByLabel('Assistant history').count(),
    0,
    'Continuous chat should not require a per-run selector',
  )
  assert((await conversation.innerText()).includes(earlierAnswer))
  assert((await conversation.innerText()).includes(active.message.trim()))
  const initialOrder = await conversation.innerText()
  assert(
    initialOrder.indexOf(earlier.prompt) < initialOrder.indexOf(active.prompt),
    'Chat turns must be chronological',
  )
  const options = page.locator('.chat-options > summary')
  await visible(options, 'Options')
  await options.click()
  await visible(page.getByLabel(/^Model/), 'Model option')
  assert.equal(await page.getByLabel('Time limit', { exact: false }).count(), 0)
  const effort = page.getByLabel(/^Reasoning effort/)
  assert.equal(await effort.isEnabled(), true)
  assert.deepEqual(
    await effort
      .locator('option')
      .evaluateAll((options) => options.map((option) => option.value)),
    ['', 'low', 'high'],
  )
  await effort.selectOption('high')
  await page.getByLabel(/^Model/).selectOption('fixture-other-model')
  assert.equal(
    await effort.isEnabled(),
    false,
    'Unsupported model must not invent reasoning levels',
  )
  await page.getByLabel(/^Model/).selectOption('fixture-model')
  await options.click()
  report.checks.push(
    'One Proofs section, four modes, accessible options, and continuous chronological history',
  )

  await composer.fill('Please inspect @No')
  const mentions = page.getByRole('listbox', {
    name: 'Project files',
    exact: true,
  })
  await mentions.waitFor()
  assert.equal(await mentions.getByRole('option').count(), 1)
  await mentions
    .getByRole('option', { name: 'Notes.lean', exact: true })
    .click()
  assert.equal(await composer.inputValue(), 'Please inspect @Notes.lean ')
  assert.deepEqual(await selectedFiles(), ['Notes.lean'])
  await composer.fill('Also inspect @Ma')
  await mentions.waitFor()
  await composer.press('Enter')
  assert.equal(await composer.inputValue(), 'Also inspect @Main.lean ')
  assert.deepEqual(await selectedFiles(), ['Main.lean', 'Notes.lean'])
  await composer.fill('No other project @PrivateOnly')
  await page.getByText('No project files match.', { exact: true }).waitFor()
  assert.equal(await mentions.getByRole('option').count(), 0)
  await composer.press('Escape')
  await mentions.waitFor({ state: 'hidden' })
  assert.equal(await composer.inputValue(), 'No other project @PrivateOnly')
  assert.equal(
    messageRequests().length,
    0,
    'Selecting a mention must not submit guidance',
  )
  assert.equal(
    runRequests().length,
    0,
    'Selecting a mention must not create a run',
  )
  report.checks.push(
    '@ file autocomplete filters the selected project, supports mouse/keyboard/Escape, attaches files, and never sends a message on selection',
  )

  await composer.fill('DRAFT_ALPHA: Keep this thought with Alpha.')
  await chooseFiles(['Notes.lean'])
  await chooseChat(otherChatId)
  assert.equal(
    await composer.inputValue(),
    '',
    'An unsent Alpha draft leaked into Beta',
  )
  assert.deepEqual(
    await selectedFiles(),
    [],
    'Unsent Alpha attachments leaked into Beta',
  )
  await composer.fill('DRAFT_BETA: Keep this thought with Beta.')
  await chooseFiles(['Main.lean'])
  await chooseChat(chatId)
  assert.equal(
    await composer.inputValue(),
    'DRAFT_ALPHA: Keep this thought with Alpha.',
  )
  assert.deepEqual(await selectedFiles(), ['Notes.lean'])
  await page.reload()
  await until(
    async () =>
      (await composer.inputValue()) ===
      'DRAFT_ALPHA: Keep this thought with Alpha.',
    'draft after reload',
  )
  assert.deepEqual(await selectedFiles(), ['Notes.lean'])
  await page
    .locator('.project-row')
    .filter({ hasText: 'Other chat fixture' })
    .getByRole('button')
    .first()
    .click()
  await until(
    async () =>
      (await page.locator('.project-item.selected').innerText()).includes(
        'Other chat fixture',
      ),
    'other project',
  )
  assert.equal(
    await composer.inputValue(),
    '',
    'Draft leaked into another project',
  )
  await composer.fill('DRAFT_OTHER_PROJECT')
  await page
    .locator('.project-row')
    .filter({ hasText: /^Chat fixture/ })
    .getByRole('button')
    .first()
    .click()
  await until(
    async () =>
      (await composer.inputValue()) ===
      'DRAFT_ALPHA: Keep this thought with Alpha.',
    'draft after project remount',
  )
  state.session = {
    ...state.session,
    user: { id: 'another-fixture-owner', name: 'Another fixture owner' },
  }
  await page.reload()
  await until(
    async () => (await page.getByLabel('Select chat').inputValue()) === chatId,
    'another mock user',
  )
  assert.equal(
    await composer.inputValue(),
    '',
    'Draft leaked across user identities',
  )
  assert.deepEqual(await selectedFiles(), [])
  state.session = {
    ...state.session,
    user: { id: 'fixture-owner', name: 'Fixture owner' },
  }
  await page.reload()
  await until(
    async () =>
      (await composer.inputValue()) ===
      'DRAFT_ALPHA: Keep this thought with Alpha.',
    'original user draft',
  )
  const oldTurn = page.locator(`[data-run-id="${earlier.id}"]`)
  const table = oldTurn.locator('.markdown-table table')
  await table.waitFor()
  assert.equal(await table.getByRole('columnheader').count(), 2)
  assert.equal(await table.locator('tbody tr').count(), 2)
  assert.equal(await table.locator('tbody td').count(), 4)
  assert.deepEqual(await table.locator('td code').allTextContents(), [
    'a | b',
    'by simp',
  ])
  assert.equal(await oldTurn.locator('.markdown-body ul li').count(), 2)
  const reference = oldTurn.getByRole('link', {
    name: 'Lean reference',
    exact: true,
  })
  assert.equal(
    await reference.getAttribute('href'),
    'https://lean-lang.org/doc/reference/latest/',
  )
  assert.equal(await reference.getAttribute('target'), '_blank')
  assert.match(await reference.getAttribute('rel'), /noopener/)
  assert.equal(await oldTurn.locator('.markdown-body img').count(), 0)
  assert.equal(
    await oldTurn.getByRole('link', { name: /Image: Diagram/ }).count(),
    1,
  )
  report.checks.push(
    'Completed Markdown renders real tables, escaped pipes and Lean inline code, lists and safe external links without fetching remote images',
  )
  const oldRunReads = () =>
    report.requests.filter(
      (request) =>
        request.method === 'GET' &&
        request.endpoint === `/api/runs/${earlier.id}`,
    ).length
  assert.equal(
    oldRunReads(),
    0,
    'Completed trace/diff bodies should load lazily',
  )
  const oldReasoning = oldTurn.locator('.reasoning-trace')
  assert.equal(await oldReasoning.locator('.reasoning-content').count(), 0)
  assert.equal(
    await oldReasoning.evaluate(
      (element) => !!element.closest('.turn-details'),
    ),
    false,
    'Reasoning belongs inline, outside technical Details',
  )
  await oldReasoning.locator('summary').click()
  await until(
    async () => (await oldTurn.textContent()).includes('OLDER_TRACE'),
    'lazy historical reasoning after reload',
  )
  assert(
    oldRunReads() >= 1,
    'Opening historical reasoning must fetch the full run',
  )
  assert(
    await oldReasoning.evaluate(
      (element) =>
        !!(
          element.compareDocumentPosition(
            element
              .closest('.conversation-turn')
              .querySelector('.assistant-message'),
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
    'Reasoning should appear before the assistant response',
  )
  await oldReasoning.locator('summary').click()
  await oldTurn.getByRole('button', { name: /Review changes/ }).click()
  await until(
    async () =>
      (await page.getByRole('dialog').innerText()).includes(
        'HISTORICAL_REVIEW_DIFF',
      ),
    'historical candidate review after reload',
  )
  await page.getByLabel('Close dialog').click()
  await oldTurn.locator('.turn-details > summary').click()
  await oldTurn.getByText('Verification errors', { exact: true }).click()
  await until(
    async () =>
      (await oldTurn.innerText()).includes('PRESERVED_VERIFICATION_ERROR'),
    'full verification diagnostics',
  )
  // Native details toggles are queued. Opening a nested verification section
  // can leave a legitimate lazy inspection pending after cached errors appear.
  // Settle that inspection before changing the shared fixture; otherwise its
  // full response can contain the marker intended for the later compact poll.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  await oldTurn
    .getByText('Loading details…', { exact: true })
    .waitFor({ state: 'hidden' })
  earlier.verification.reason =
    'COMPACT_VERIFICATION_REFRESH: checked saved project'
  earlier.eventCursor += 10
  earlier.updatedAt = new Date().toISOString()
  const readsBeforeCompact = oldRunReads()
  await until(
    async () =>
      (await oldTurn.innerText()).includes('COMPACT_VERIFICATION_REFRESH'),
    'newer compact verification poll',
  )
  assert(
    (await oldTurn.innerText()).includes('PRESERVED_VERIFICATION_ERROR'),
    'Compact poll removed already loaded verification errors',
  )
  assert.equal(
    oldRunReads(),
    readsBeforeCompact,
    'Verification preservation must not rely on refetching a full snapshot',
  )
  report.compactVerificationReads = {
    before: readsBeforeCompact,
    after: oldRunReads(),
  }
  await oldTurn.getByText('Warnings', { exact: true }).click()
  assert((await oldTurn.innerText()).includes('PRESERVED_VERIFICATION_WARNING'))
  await oldTurn.getByText('Axiom audit', { exact: true }).click()
  assert((await oldTurn.innerText()).includes('propext'))
  report.checks.push(
    'Newer compact history verification preserves loaded error, warning and axiom details',
  )
  await oldTurn.locator('.readable-usage > summary').click()
  const usage = oldTurn.locator('.usage-totals')
  await usage.waitFor()
  const usageText = await usage.innerText()
  for (const text of [
    'Input',
    'Output',
    'Cached input',
    'Reasoning output',
    '1,200',
    '340',
    '1,540',
  ])
    assert(usageText.includes(text), `Readable usage omitted ${text}`)
  assert.equal(
    await oldTurn.locator('.usage-raw pre').isVisible(),
    false,
    'Raw JSON should stay collapsed',
  )
  await oldTurn.locator('.usage-raw > summary').click()
  assert(await oldTurn.locator('.usage-raw pre').isVisible())
  await oldTurn.locator('.turn-details > summary').click()
  report.checks.push(
    'Minimal reloaded history exposes inline reasoning, readable usage and candidate review, fetching raw trace/diff bodies only when needed',
  )
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await until(
    async () => (await page.getByLabel('Select chat').inputValue()) !== chatId,
    'new empty conversation',
  )
  assert.equal(await composer.inputValue(), '')
  assert.deepEqual(await selectedFiles(), [])
  assert(!(await conversation.innerText()).includes(earlierAnswer))
  await chooseChat(chatId)
  assert.equal(
    await composer.inputValue(),
    'DRAFT_ALPHA: Keep this thought with Alpha.',
  )
  report.checks.push(
    'Draft text and attachments isolated by user/project/chat through switching, reload, remount, and New chat',
  )

  const firstPending = await holdUpdate()
  await composer.fill('First guidance: use the existing local lemma.')
  const beforeFirst = messageRequests().length
  await sendUpdate.click()
  const first = await firstPending()
  assert.equal(messageRequests().length, beforeFirst + 1)
  assert.equal(runRequests().length, 0, 'Sending guidance started another run')
  assert(
    await composer.isEditable(),
    'A pending acknowledgement locked the draft',
  )
  await composer.fill(
    'NEWER_DRAFT: typed while the first update was being sent.',
  )
  assert.deepEqual(first.body.files, ['Notes.lean'])
  await chooseFiles(['Main.lean'])
  await first.release('accepted')
  await assertReceipt(first.body.id, first.body.text, /accepted|sent|queued/i)
  assert.equal(
    await composer.inputValue(),
    'NEWER_DRAFT: typed while the first update was being sent.',
  )
  assert.deepEqual(
    await selectedFiles(),
    ['Main.lean'],
    'Late acknowledgement removed a newer attachment selection',
  )
  await emit(active, 'message', 'FOLLOWUP_REPLY: I will use that lemma.\n\n')
  await until(
    async () => (await conversation.innerText()).includes('FOLLOWUP_REPLY'),
    'continued assistant response',
  )
  const continuedText = await currentTurn().innerText()
  assert(
    continuedText.indexOf('ACTIVE_ANSWER') <
      continuedText.indexOf(first.body.text),
  )
  assert(
    continuedText.indexOf(first.body.text) <
      continuedText.indexOf('FOLLOWUP_REPLY'),
    'Guidance should be interleaved at its actual response offset',
  )
  report.checks.push(
    'Send update targets the active run exactly once and preserves newer typing; guidance appears in conversation order',
  )

  const secondPending = await holdUpdate()
  await composer.fill('Second guidance: keep the theorem statement unchanged.')
  await sendUpdate.click()
  const second = await secondPending()
  await chooseChat(otherChatId)
  assert.equal(
    await composer.inputValue(),
    'DRAFT_BETA: Keep this thought with Beta.',
  )
  await composer.fill('NEW_BETA_DRAFT: unrelated to Alpha acknowledgement.')
  await second.release('pending')
  await sleep(300)
  assert.equal(await page.getByLabel('Select chat').inputValue(), otherChatId)
  assert.equal(
    await composer.inputValue(),
    'NEW_BETA_DRAFT: unrelated to Alpha acknowledgement.',
  )
  assert(
    !(await conversation.innerText()).includes(second.body.text),
    'Alpha guidance leaked into Beta transcript',
  )
  await chooseChat(chatId)
  assert.equal(
    await composer.inputValue(),
    '',
    'A durable accepted submission should clear only its original draft',
  )
  assert.deepEqual(
    await selectedFiles(),
    [],
    'A durable pending submission should clear captured attachments with its draft',
  )
  await assertReceipt(
    second.body.id,
    second.body.text,
    /pending|queued|waiting/i,
  )
  await emit(active, 'followup', {
    ...active.followups.find((item) => item.id === second.body.id),
    status: 'accepted',
  })
  await assertReceipt(second.body.id, second.body.text, /accepted|sent|queued/i)
  report.checks.push(
    'Late acknowledgement cannot redirect chat or clear another chat draft; pending receipt updates in place',
  )

  state.onMessage = ({ respond }) =>
    respond(
      {
        error:
          'Verification already started. Send this after the current task finishes.',
      },
      409,
    )
  await composer.fill(
    'REJECTED_DRAFT: preserve me when verification has started.',
  )
  await chooseFiles(['Notes.lean'])
  await sendUpdate.click()
  await until(
    async () =>
      (await page.locator('[role="alert"]').allTextContents())
        .join(' ')
        .includes('Verification already started'),
    'failed send feedback',
  )
  assert.equal(
    await composer.inputValue(),
    'REJECTED_DRAFT: preserve me when verification has started.',
  )
  assert.deepEqual(
    await selectedFiles(),
    ['Notes.lean'],
    'HTTP rejection lost submitted attachments',
  )
  const failedPending = await holdUpdate()
  await sendUpdate.click()
  const failed = await failedPending()
  const pendingReceipt = await failed.release('pending')
  await until(
    async () => (await composer.inputValue()) === '',
    'pending guidance clears captured draft',
  )
  assert.deepEqual(await selectedFiles(), [])
  await emit(active, 'followup', {
    ...pendingReceipt,
    status: 'failed',
    error: 'The task stopped before this guidance could be delivered.',
  })
  await assertReceipt(
    failed.body.id,
    failed.body.text,
    /failed|not delivered|stopped/i,
  )
  assert.equal(
    await composer.inputValue(),
    'REJECTED_DRAFT: preserve me when verification has started.',
  )
  assert.deepEqual(
    await selectedFiles(),
    ['Notes.lean'],
    'Failed queued guidance did not restore captured attachments',
  )
  const changedFilesPending = await holdUpdate()
  await sendUpdate.click()
  const changedFiles = await changedFilesPending()
  const changedFilesReceipt = await changedFiles.release('pending')
  await until(
    async () => (await composer.inputValue()) === '',
    'second pending guidance clears draft',
  )
  await chooseFiles(['Main.lean'])
  await emit(active, 'followup', {
    ...changedFilesReceipt,
    status: 'failed',
    error: 'Delivery failed after a newer attachment was selected.',
  })
  await assertReceipt(changedFiles.body.id, changedFiles.body.text, /failed/i)
  assert.equal(
    await composer.inputValue(),
    '',
    'Failed delivery replaced a newer draft revision',
  )
  assert.deepEqual(
    await selectedFiles(),
    ['Main.lean'],
    'Failed delivery overwrote a newer attachment selection',
  )
  report.checks.push(
    'Acknowledged drafts clear captured attachments; HTTP errors retain them, queued failures restore them, and later text/file revisions are preserved',
  )

  await emit(active, 'progress', {
    label: 'Checking Notes.lean',
    detail: 'Independent Lean verification',
    updatedAt: new Date().toISOString(),
  })
  await until(
    async () =>
      (await page.locator('.assistant-panel').innerText()).includes(
        'Checking Notes.lean',
      ),
    'compact current work',
  )
  assert(
    !(await conversation.textContent()).includes('TRACE_FIXTURE'),
    'Closed details mounted reasoning',
  )
  await currentTurn().locator('.turn-details > summary').click()
  await currentTurn().locator('.reasoning-trace > summary').click()
  await until(
    async () => (await currentTurn().textContent()).includes('TRACE_FIXTURE'),
    'reported reasoning detail',
  )
  await currentTurn().locator('.reasoning-trace > summary').click()
  await emit(active, 'reasoning', '\nMore reported reasoning.')
  await sleep(350)
  assert(
    !(await currentTurn().textContent()).includes('TRACE_FIXTURE'),
    'Streaming reopened collapsed reasoning',
  )
  await currentTurn().getByText('Activity', { exact: true }).click()
  await until(
    async () =>
      (await currentTurn().textContent()).includes('ACTIVITY_FIXTURE'),
    'expanded activity content',
  )
  await currentTurn().getByText('Activity', { exact: true }).click()
  await currentTurn().locator('.turn-details > summary').click()
  await page.setViewportSize({ width: 1366, height: 768 })
  await sleep(300)
  await visible(composer, 'Message field at laptop size')
  await visible(
    page.getByRole('button', { name: 'Stop', exact: true }),
    'Stop at laptop size',
  )
  report.laptopConversationHeight = await conversation.evaluate(
    (element) => element.clientHeight,
  )
  await page.screenshot({
    path: path.join(reportDir, 'active-chat-laptop.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  report.checks.push(
    'Compact work status, user-controlled lazy reasoning/activity, and usable laptop layout',
  )

  let finishStop
  state.onStop = ({ run, respond }) =>
    new Promise((resolve) => {
      void emit(run, 'status', { status: 'stopping' }).then(() => {
        finishStop = async () => {
          state.files[projectId]['Notes.lean'] += '\n-- STOP_FINAL_WRITE\n'
          run.liveEdits = true
          run.liveRevision = 1
          run.liveChanges = [
            {
              path: 'Notes.lean',
              before: sources['Notes.lean'],
              after: state.files[projectId]['Notes.lean'],
            },
          ]
          await emit(run, 'status', { status: 'cancelled' })
          await respond(structuredClone(run))
          resolve()
        }
      })
    })
  await page.locator('.file-item[title="Notes.lean"]').click()
  const runsBeforeStop = runRequests().length
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await until(async () => !!finishStop, 'interrupt pending native cleanup')
  await until(
    async () =>
      (await page
        .getByRole('button', { name: 'Stopping…', exact: true })
        .count()) > 0,
    'honest stopping state',
  )
  await chooseChat(otherChatId)
  await composer.fill('BETA_AFTER_INTERRUPT: preserve this draft.')
  await finishStop()
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes(
        'STOP_FINAL_WRITE',
      ),
    'final interrupted file edit',
  )
  assert.equal(await page.getByLabel('Select chat').inputValue(), otherChatId)
  assert.equal(
    await composer.inputValue(),
    'BETA_AFTER_INTERRUPT: preserve this draft.',
  )
  assert.equal(
    runRequests().length,
    runsBeforeStop,
    'Stop unexpectedly launched another run',
  )
  await chooseChat(chatId)
  assert(
    (await conversation.innerText()).includes(first.body.text),
    'Interrupted chat lost accepted guidance',
  )
  assert((await conversation.innerText()).includes('FOLLOWUP_REPLY'))
  report.checks.push(
    'Stop waits for cleanup, preserves transcript and final edits, respects later navigation, and never auto-starts a task',
  )

  await page.reload()
  await until(
    async () =>
      (await page.getByLabel('Select chat').inputValue()) === chatId &&
      (await currentTurn().count()) === 1,
    'stopped transcript after reload',
  )
  const undo = currentTurn().getByRole('button', {
    name: 'Undo agent edits',
    exact: true,
  })
  await undo.waitFor({ state: 'visible' })
  assert(
    await undo.isEnabled(),
    'Reloaded saved changes should remain undoable',
  )
  state.onUndo = async ({ run, respond }) => {
    assert.equal(run.id, active.id)
    state.files[projectId]['Notes.lean'] = sources['Notes.lean']
    run.liveUndone = true
    await emit(run, 'status', { status: 'cancelled' })
    return respond(structuredClone(run))
  }
  await undo.click()
  await until(
    async () => (await currentTurn().innerText()).includes('Edits undone'),
    'reloaded saved changes undo',
  )
  await until(
    async () =>
      !(await page.locator('.view-lines').innerText()).includes(
        'STOP_FINAL_WRITE',
      ),
    'editor refresh after undo',
  )
  report.checks.push(
    'Minimal history preserves Undo for saved edits after reload, and undo refreshes the visible file',
  )

  state.onCreateRun = ({ chat, body, respond }) => {
    const run = {
      id: `continued-${state.runs.length}`,
      projectId: chat.projectId,
      chatId: chat.id,
      status: 'running',
      mode: body.mode,
      prompt: body.prompt,
      files: body.files,
      liveEdits: body.liveEdits,
      maxSeconds: body.maxSeconds,
      message: 'CONTINUED_ANSWER: Continuing with the earlier chat context.',
      reasoning: '',
      log: '',
      eventCursor: 1000 + state.runs.length,
      createdAt: '2026-10-13T14:00:00Z',
    }
    state.runs.push(run)
    return respond(run, 202)
  }
  await composer.fill(
    'Continue after the interruption, using our earlier discussion.',
  )
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(
    async () => (await conversation.innerText()).includes('CONTINUED_ANSWER'),
    'continued chat turn',
  )
  const continuation = state.runs.at(-1)
  assert.equal(continuation.chatId, chatId)
  assert.equal(runRequests().length, runsBeforeStop + 1)
  assert((await conversation.innerText()).includes(earlierAnswer))
  assert((await conversation.innerText()).includes(first.body.text))
  assert(
    (await conversation.innerText()).indexOf('FOLLOWUP_REPLY') <
      (await conversation.innerText()).indexOf('CONTINUED_ANSWER'),
  )
  assert.equal(await composer.inputValue(), '')
  report.checks.push(
    'After interrupt, Send starts exactly one later turn in the same continuous chat with earlier turns still visible',
  )
  await page.screenshot({
    path: path.join(reportDir, 'continuous-conversation.png'),
    fullPage: true,
  })
  fixture.assertClean()
  assert(
    report.laptopConversationHeight >= 200,
    `Laptop conversation is cramped at ${report.laptopConversationHeight}px`,
  )
  report.passed = true
  console.log(
    'PASS: continuous chat, active guidance, durable acknowledgement races, scoped drafts, interrupt, trace/options controls, and laptop usability; all backends mocked',
  )
} catch (error) {
  report.passed = false
  report.failure = error.stack || error.message
  await page
    .screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
