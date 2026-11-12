#!/usr/bin/env node
// Separate chats share a project; all providers, workspaces and Lean are fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = new URL('../.runtime/parallel-chats-ui/', import.meta.url)
await fs.mkdir(output, { recursive: true })
const projectId = 'parallel-project',
  alphaChat = 'alpha-chat'
const alpha = {
  id: 'alpha-run',
  projectId,
  chatId: alphaChat,
  kind: 'agent',
  status: 'running',
  mode: 'proofs',
  model: 'fixture-model',
  effort: 'high',
  createdAt: '2026-11-12T10:00:00Z',
  prompt: 'Prove the first theorem.',
  message: 'ALPHA_REPLY: Checking Main.lean.',
  liveEdits: true,
  liveRevision: 0,
  followups: [],
  reasoningBlocks: [],
  eventCursor: 1,
  progress: { label: 'Alpha is working' },
}
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [
      {
        id: 'fixture-model',
        name: 'Fixture model',
        reasoningEfforts: [{ id: 'high' }, { id: 'max' }],
        defaultReasoningEffort: 'max',
      },
    ],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { available: true, revision: 'fixture' },
  },
  projects: [
    {
      id: projectId,
      name: 'Parallel chat fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: {
    [projectId]: {
      'Main.lean': 'example : True := by trivial\n',
      'Helper.lean': 'example : True := by trivial\n',
    },
  },
  chats: [{ id: alphaChat, projectId, title: 'Alpha proof' }],
  runs: [alpha],
})
const { page, browser, state, report, emit } = fixture
const composer = page.getByLabel('Message Lemex')
const conversation = page.getByRole('region', {
  name: 'Conversation',
  exact: true,
})
const work = page.locator('.chat-current-work')
const updates = [],
  stops = []
let beta, betaChat, releaseStop
const connected = (run) =>
  until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), run.id),
    `stream for ${run.id}`,
  )
const chooseChat = async (id) => {
  await page.getByLabel('Select chat').selectOption(id)
  await until(
    async () => (await page.getByLabel('Select chat').inputValue()) === id,
    `selected chat ${id}`,
  )
}
state.onCreateRun = ({ chat, body, respond }) => {
  assert.equal(body.model, 'fixture-model')
  assert.equal(body.effort, 'high')
  assert.equal(body.liveEdits, true)
  betaChat = chat.id
  chat.title = 'Beta proof'
  beta = {
    ...alpha,
    id: 'beta-run',
    chatId: chat.id,
    ...body,
    createdAt: '2026-11-12T10:01:00Z',
    message: 'BETA_REPLY: Checking Helper.lean.',
    progress: { label: 'Beta is working' },
    followups: [],
    reasoningBlocks: [],
    eventCursor: 2,
  }
  state.runs.push(beta)
  return respond(beta, 202)
}
state.onMessage = async ({ run, body, respond }) => {
  updates.push({ id: run.id, text: body.text })
  await emit(run, 'followup', {
    id: body.id,
    text: body.text,
    status: 'accepted',
    messageOffset: run.message.length,
    createdAt: new Date().toISOString(),
  })
  return respond(run)
}
state.onStop = ({ run, respond }) => {
  stops.push(run.id)
  run.status = 'stopping'
  return new Promise((resolve) => {
    releaseStop = async () => {
      run.status = 'cancelled'
      await respond(run)
      resolve()
    }
  })
}
try {
  await fixture.ready()
  await connected(alpha)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await composer.fill('Prove the second theorem independently.')
  assert(
    await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(),
  )
  await page.locator('.chat-options > summary').click()
  await page
    .getByLabel('Reasoning effort', { exact: true })
    .selectOption('high')
  await page.locator('.chat-options > summary').click()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(() => !!beta, 'second run admission')
  await connected(beta)
  await work.getByText('Beta is working', { exact: true }).waitFor()
  await page
    .getByRole('navigation', { name: 'Other active chats' })
    .getByText('2 active chats')
    .waitFor()
  assert((await conversation.innerText()).includes('BETA_REPLY'))
  assert(!(await conversation.innerText()).includes('ALPHA_REPLY'))
  report.checks.push(
    'New chat starts a second same-project task while preserving its selected model, reasoning effort and live-edit choice',
  )

  await composer.fill('BETA_UPDATE: Use the helper lemma.')
  await page.getByRole('button', { name: 'Send update', exact: true }).click()
  await until(() => updates.length === 1, 'Beta follow-up')
  await until(
    async () => (await composer.inputValue()) === '',
    'Beta acknowledgement',
  )
  assert.equal(updates[0].id, beta.id)
  state.files[projectId]['Main.lean'] =
    '-- ALPHA_BACKGROUND_EDIT\nexample : True := by trivial\n'
  alpha.liveRevision = 1
  alpha.liveChangeCount = 1
  alpha.liveChangePaths = ['Main.lean']
  await emit(alpha, 'files-updated', { paths: ['Main.lean'], live: true })
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes(
        'ALPHA_BACKGROUND_EDIT',
      ),
    'background chat updates the editor',
  )
  await page
    .getByRole('navigation', { name: 'Other active chats' })
    .getByRole('button', { name: 'Alpha proof', exact: true })
    .click()
  await connected(alpha)
  await work.getByText('Alpha is working', { exact: true }).waitFor()
  await emit(alpha, 'message', ' ALPHA_STREAM_CONTINUES')
  await until(
    async () =>
      (await conversation.innerText()).includes('ALPHA_STREAM_CONTINUES'),
    'Alpha live response',
  )
  assert(!(await conversation.innerText()).includes('BETA_REPLY'))
  await composer.fill('ALPHA_UPDATE: Keep this proof separate.')
  await page.getByRole('button', { name: 'Send update', exact: true }).click()
  await until(() => updates.length === 2, 'Alpha follow-up')
  await until(
    async () => (await composer.inputValue()) === '',
    'Alpha acknowledgement',
  )
  assert.equal(updates[1].id, alpha.id)
  report.checks.push(
    'Switching chats follows the selected run, sends updates to that run only, and refreshes saved files from background work',
  )

  await chooseChat(betaChat)
  await connected(beta)
  await work.getByText('Beta is working', { exact: true }).waitFor()
  await composer.fill('BETA_DRAFT_WHILE_BOTH_WORK')
  for (const [width, height] of [
    [1366, 768],
    [390, 650],
  ]) {
    await page.setViewportSize({ width, height })
    const send = page.getByRole('button', { name: 'Send update', exact: true })
    assert(await send.isEnabled())
    await send.scrollIntoViewIfNeeded()
    await send.click({ trial: true })
    const stop = work.getByRole('button', { name: 'Stop', exact: true })
    await stop.scrollIntoViewIfNeeded()
    await stop.click({ trial: true })
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    )
  }
  await page.setViewportSize({ width: 1600, height: 1000 })
  report.checks.push(
    'Two active chats keep their navigation, Send update and Stop controls usable on laptop and phone screens',
  )
  await page.screenshot({
    path: new URL('two-active-chats.png', output).pathname,
    fullPage: true,
  })
  await work.getByRole('button', { name: 'Stop', exact: true }).click()
  await until(() => !!releaseStop, 'pending Beta stop')
  // A final poll can arrive while the Stop acknowledgement is still delayed.
  await emit(beta, 'status', { status: 'cancelled' })
  await conversation
    .locator(`[data-run-id="${beta.id}"] .turn-status`)
    .filter({ hasText: /^Stopped$/ })
    .waitFor()
  assert(
    await work
      .getByRole('button', { name: 'Stopping…', exact: true })
      .isDisabled(),
  )
  await chooseChat(alphaChat)
  await connected(alpha)
  await work.getByText('Alpha is working', { exact: true }).waitFor()
  await composer.fill('ALPHA_DRAFT_SURVIVES_STOP')
  assert(
    await page
      .getByRole('button', { name: 'Send update', exact: true })
      .isEnabled(),
  )
  await releaseStop()
  await until(
    async () =>
      (await page
        .getByRole('navigation', { name: 'Other active chats' })
        .count()) === 0,
    'only Alpha remains active',
  )
  assert.deepEqual(stops, [beta.id])
  assert.equal(alpha.status, 'running')
  assert.equal(await composer.inputValue(), 'ALPHA_DRAFT_SURVIVES_STOP')
  await emit(alpha, 'message', ' ALPHA_AFTER_BETA_STOP')
  await until(
    async () =>
      (await conversation.innerText()).includes('ALPHA_AFTER_BETA_STOP'),
    'Alpha continues after stopping Beta',
  )
  assert(!(await conversation.innerText()).includes('BETA_REPLY'))
  await page.reload()
  await connected(alpha)
  await work.getByText('Alpha is working', { exact: true }).waitFor()
  assert.equal(await composer.inputValue(), 'ALPHA_DRAFT_SURVIVES_STOP')
  await chooseChat(betaChat)
  await until(
    async () => (await conversation.innerText()).includes('BETA_REPLY'),
    'stopped Beta history',
  )
  await composer.fill('BETA_NEXT_REQUEST')
  assert(
    await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(),
  )
  report.checks.push(
    'Stopping one chat leaves another run, its streaming output and its draft usable; reload restores both histories correctly',
  )
  fixture.assertClean()
  console.log(
    `PASS: ${report.checks.length} parallel chat checks; all backends mocked`,
  )
} catch (error) {
  await page.screenshot({
    path: new URL('failure.png', output).pathname,
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    new URL('report.json', output),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
}
