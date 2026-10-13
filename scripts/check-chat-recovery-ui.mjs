#!/usr/bin/env node
// Isolated chat races and transient errors: all API, stream and Lean traffic is mocked.
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
const reportDir = path.join(root, '.runtime/chat-recovery-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'chat-recovery-fixture',
  chatId = 'alpha',
  otherChat = 'beta'
const longAnswer = Array.from(
  { length: 45 },
  (_, i) =>
    `Paragraph ${i}: inspect earlier proof explanations while the agent keeps working.\n\n`,
).join('')
const active = {
  id: 'active-run',
  projectId,
  chatId,
  status: 'running',
  mode: 'proofs',
  createdAt: '2026-10-13T09:00:00Z',
  prompt: 'Prove the current theorem.',
  message: longAnswer,
  eventCursor: 1,
  followups: [],
  liveEdits: false,
}
const fixture = await chatBrowserFixture({
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
      name: 'Recovery fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [
    { id: chatId, projectId, title: 'Alpha conversation' },
    { id: otherChat, projectId, title: 'Beta conversation' },
  ],
  runs: [
    active,
    {
      ...active,
      id: 'beta-run',
      chatId: otherChat,
      status: 'completed',
      eventCursor: 0,
    },
  ],
})
const { page, browser, report, state, emit } = fixture
const composer = page.getByLabel('Message Lemex')
const picker = page.getByLabel('Select chat')
const conversation = page.getByRole('region', {
  name: 'Conversation',
  exact: true,
})
const alertText = async () =>
  (await page.getByRole('alert').allTextContents()).join('\n')
const postChats = () =>
  report.requests.filter(
    (item) =>
      item.method === 'POST' &&
      item.endpoint === `/api/projects/${projectId}/chats`,
  )
const geometry = () =>
  conversation.evaluate((element) => ({
    top: element.scrollTop,
    gap: element.scrollHeight - element.clientHeight - element.scrollTop,
  }))
async function choose(id) {
  await picker.selectOption(id)
  await until(
    async () =>
      (await picker.inputValue()) === id &&
      !(await page.locator('.chat-picker[aria-busy="true"]').count()),
    `selected chat ${id}`,
  )
}
async function pauseReading() {
  await conversation.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await sleep(150)
  const bounds = await conversation.boundingBox()
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  )
  await page.mouse.wheel(0, -500)
  await until(
    async () =>
      (await geometry()).gap > 200 &&
      (await page
        .getByRole('button', { name: 'Jump to latest', exact: true })
        .isVisible()),
    'paused reading',
  )
  return (await geometry()).top
}
async function holdUpdate() {
  let pending
  state.onMessage = ({ run, body, respond }) =>
    new Promise((resolve) => {
      pending = async (accepted) => {
        if (accepted) {
          await emit(run, 'followup', {
            id: body.id,
            text: body.text,
            status: 'accepted',
            messageOffset: run.message.length,
            createdAt: new Date().toISOString(),
          })
          await respond(structuredClone(run))
        } else await respond({ error: 'UPDATE_REJECTED_FIXTURE' }, 409)
        resolve()
      }
    })
  return async () => {
    await until(async () => !!pending, 'held update')
    return pending
  }
}

let failSnapshot = true,
  failedSnapshots = 0,
  failHistory = false
await page.route(`**/api/runs/${active.id}`, (route) => {
  if (failSnapshot) {
    failedSnapshots++
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'SNAPSHOT_OFFLINE_FIXTURE' }),
    })
  }
  return route.fallback()
})
await page.route(`**/api/chats/${otherChat}`, (route) =>
  failHistory
    ? route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'HISTORY_OFFLINE_FIXTURE' }),
      })
    : route.fallback(),
)

try {
  await fixture.ready()
  await until(
    async () => (await alertText()).includes('SNAPSHOT_OFFLINE_FIXTURE'),
    'initial snapshot failure',
  )
  assert(failedSnapshots >= 1)
  assert.equal(
    await page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    false,
  )
  // Successful unrelated requests must not dismiss the failing stream's error.
  await choose(otherChat)
  assert((await alertText()).includes('SNAPSHOT_OFFLINE_FIXTURE'))
  failSnapshot = false
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'stream reconnects after its initial snapshot failed',
  )
  await until(
    async () => !(await alertText()).includes('SNAPSHOT_OFFLINE_FIXTURE'),
    'snapshot error clears after recovery',
  )
  report.checks.push(
    'Initial snapshot failure retries and connects; unrelated successful requests do not erase its error',
  )
  const connectionsBefore = await page.evaluate(
    () => window.__chatFixture.urls.length,
  )
  await page.evaluate((id) => window.__chatFixture.disconnect(id), active.id)
  await until(
    () =>
      page.evaluate(
        ({ id, before }) =>
          window.__chatFixture.connected(id) &&
          window.__chatFixture.urls.length > before,
        { id: active.id, before: connectionsBefore },
      ),
    'hard-closed EventSource reconnects after a successful snapshot',
  )
  report.checks.push(
    'A permanently closed EventSource is replaced after snapshot recovery rather than falling back to polling forever',
  )

  await choose(chatId)
  failHistory = true
  await choose(otherChat)
  await until(
    async () => (await alertText()).includes('HISTORY_OFFLINE_FIXTURE'),
    'history error',
  )
  await sleep(4500)
  assert(
    (await alertText()).includes('HISTORY_OFFLINE_FIXTURE'),
    'Successful project/snapshot polling erased failed history',
  )
  await choose(chatId)
  assert(
    !(await alertText()).includes('HISTORY_OFFLINE_FIXTURE'),
    'History error leaked to another chat',
  )
  await choose(otherChat)
  failHistory = false
  await until(
    async () =>
      (await conversation.innerText()).includes('Paragraph 44') &&
      !(await alertText()).includes('HISTORY_OFFLINE_FIXTURE'),
    'failed history retries and clears only after recovery',
  )
  report.checks.push(
    'History failure is scoped to its chat and retries automatically without unrelated polling hiding it',
  )

  await choose(chatId)
  const releaseAccepted = await holdUpdate()
  await composer.fill('Use the useful local lemma.')
  await pauseReading()
  await page.getByRole('button', { name: 'Send update', exact: true }).click()
  await (
    await releaseAccepted()
  )(true)
  await until(
    async () => (await geometry()).gap < 24,
    'successful update resumes following',
  )
  await emit(
    active,
    'message',
    '\n\nThe latest response after accepted guidance.\n\n'.repeat(8),
  )
  await until(
    async () => (await geometry()).gap < 24,
    'continued follow after accepted update',
  )
  report.checks.push(
    'Successful Send update resumes following in the unchanged visible chat',
  )

  const releaseRejected = await holdUpdate()
  await composer.fill('Keep my draft when delivery fails.')
  const reading = await pauseReading()
  await page.getByRole('button', { name: 'Send update', exact: true }).click()
  await (
    await releaseRejected()
  )(false)
  await until(
    async () => (await alertText()).includes('UPDATE_REJECTED_FIXTURE'),
    'send error',
  )
  await sleep(4500)
  assert(
    (await alertText()).includes('UPDATE_REJECTED_FIXTURE'),
    'Recovered polling cleared a user action error',
  )
  assert.equal(
    await composer.inputValue(),
    'Keep my draft when delivery fails.',
  )
  assert(
    Math.abs((await geometry()).top - reading) <= 3,
    'Rejected send moved the reading position',
  )
  report.checks.push(
    'Rejected guidance keeps the draft and scroll position; background recovery never dismisses its action error',
  )

  const releaseNavigated = await holdUpdate()
  await composer.fill('Guidance acknowledged after changing chats.')
  await page.getByRole('button', { name: 'Send update', exact: true }).click()
  const late = await releaseNavigated()
  await choose(otherChat)
  await choose(chatId)
  const returnedReading = await pauseReading()
  await late(true)
  await sleep(350)
  assert(
    Math.abs((await geometry()).top - returnedReading) <= 3,
    'Late acknowledgement after leaving and returning resumed follow',
  )
  report.checks.push(
    'Leaving and returning to a chat while a send is pending preserves the new reading position',
  )

  let failFileRefresh = true
  await page.route(`**/api/projects/${projectId}/file?*`, (route) =>
    failFileRefresh
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'FILE_REFRESH_OFFLINE_FIXTURE' }),
        })
      : route.fallback(),
  )
  active.liveEdits = true
  active.liveRevision = 1
  active.liveChanges = [
    {
      path: 'Main.lean',
      before: 'example : True := by trivial\n',
      after: 'example : True := by trivial\n-- first edit\n',
    },
  ]
  await emit(active, 'files-updated', { paths: ['Main.lean'] })
  await until(
    async () => (await alertText()).includes('FILE_REFRESH_OFFLINE_FIXTURE'),
    'stream file refresh fails',
  )
  active.liveRevision = 2
  state.files[projectId]['Main.lean'] =
    'example : True := by trivial\n-- FINAL_RECOVERED_FILE_REVISION\n'
  active.liveChanges[0].after = state.files[projectId]['Main.lean']
  await emit(active, 'status', { status: 'completed' })
  await until(
    () => page.evaluate((id) => !window.__chatFixture.connected(id), active.id),
    'terminal stream closes during failed file refresh',
  )
  await sleep(400)
  assert((await alertText()).includes('FILE_REFRESH_OFFLINE_FIXTURE'))
  failFileRefresh = false
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes(
        'FINAL_RECOVERED_FILE_REVISION',
      ) && !(await alertText()).includes('FILE_REFRESH_OFFLINE_FIXTURE'),
    'final file revision and its stream error recover through project polling',
  )
  report.checks.push(
    'A failed streamed file refresh recovers the final revision after stream completion and clears the same shared error',
  )

  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await until(async () => (await picker.inputValue()) === '', 'new unsent chat')
  await composer.fill('UNSENT_NEW_CHAT: check this statement.')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  assert.equal(
    await composer.inputValue(),
    'UNSENT_NEW_CHAT: check this statement.',
  )
  assert.equal(
    postChats().length,
    0,
    'New chat clicks created empty persisted chats',
  )
  assert.equal(await picker.locator('option:checked').innerText(), 'New chat')
  await page.reload()
  await until(
    async () =>
      (await composer.inputValue()) ===
        'UNSENT_NEW_CHAT: check this statement.' &&
      (await picker.inputValue()) === '',
    'unsent chat restored after reload',
  )
  assert.equal(postChats().length, 0)
  await emit(active, 'status', { status: 'cancelled' })
  await until(
    async () =>
      await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(),
    'active run ends',
  )
  state.onCreateRun = ({ respond }) =>
    respond({ error: 'RUN_CREATE_FAILED_FIXTURE' }, 503)
  let releaseFirstChat
  state.onCreateChat = ({ chat, respond }) =>
    new Promise((resolve) => {
      releaseFirstChat = async () => {
        await respond(chat, 201)
        resolve()
      }
    })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(async () => !!releaseFirstChat, 'held first chat creation')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await releaseFirstChat()
  state.onCreateChat = null
  await until(
    async () => (await alertText()).includes('RUN_CREATE_FAILED_FIXTURE'),
    'failed first send',
  )
  const persistedId = await picker.inputValue()
  assert(persistedId)
  assert.equal(postChats().length, 1)
  assert.equal(
    await composer.inputValue(),
    'UNSENT_NEW_CHAT: check this statement.',
  )
  state.onCreateRun = ({ chat, body, respond }) => {
    const run = {
      ...active,
      id: 'new-success',
      chatId: chat.id,
      status: 'running',
      prompt: body.prompt,
      message: longAnswer,
      followups: [],
      eventCursor: 20,
      createdAt: '2026-10-13T10:00:00Z',
    }
    state.runs.push(run)
    return respond(run, 202)
  }
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(
    async () =>
      (await composer.inputValue()) === '' &&
      (await page.locator('[data-run-id="new-success"]').count()),
    'retry succeeds',
  )
  assert.equal(await picker.inputValue(), persistedId)
  assert.equal(postChats().length, 1, 'Retry created a duplicate empty chat')
  await until(
    async () => (await geometry()).gap < 24,
    'first successful send follows answer',
  )
  report.checks.push(
    'New chat is a durable local draft until first send; failed first send preserves it and retries in the same single persisted chat',
  )
  report.checks.push(
    'Redundant New chat while its first send is pending keeps the created conversation attached and visible',
  )

  let failChatList = true
  await page.route(`**/api/projects/${projectId}/chats`, (route) =>
    failChatList && route.request().method() === 'GET'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'CHAT_LIST_OFFLINE_FIXTURE' }),
        })
      : route.fallback(),
  )
  await choose(chatId)
  await page.reload()
  await until(
    async () => (await alertText()).includes('CHAT_LIST_OFFLINE_FIXTURE'),
    'initial chat list failure',
  )
  failChatList = false
  await until(
    async () =>
      (await picker.inputValue()) === chatId &&
      !(await alertText()).includes('CHAT_LIST_OFFLINE_FIXTURE'),
    'saved chat restores after the initial list recovers',
  )

  let failProjectRuns = true
  await page.route(`**/api/projects/${projectId}/runs?*`, (route) =>
    failProjectRuns
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'PROJECT_RUNS_OFFLINE_FIXTURE' }),
        })
      : route.fallback(),
  )
  await page.reload()
  await until(
    async () =>
      (await picker.inputValue()) === chatId &&
      (await alertText()).includes('PROJECT_RUNS_OFFLINE_FIXTURE'),
    'chat restored independently of a failing project activity request',
  )
  failProjectRuns = false
  await until(
    async () => !(await alertText()).includes('PROJECT_RUNS_OFFLINE_FIXTURE'),
    'project activity recovery',
  )
  report.checks.push(
    'Initial chat-list failure restores the saved conversation when it recovers, independently of project activity failures',
  )

  failChatList = true
  await page.reload()
  await until(
    async () => (await alertText()).includes('CHAT_LIST_OFFLINE_FIXTURE'),
    'list unavailable while starting a draft',
  )
  await composer.fill('KEEP_MY_NEW_DRAFT_WHILE_RECONNECTING')
  failChatList = false
  await until(
    async () =>
      !(await alertText()).includes('CHAT_LIST_OFFLINE_FIXTURE') &&
      (await picker.locator('option').count()) > 1,
    'chat list recovers after typing',
  )
  await sleep(4500)
  assert.equal(await picker.inputValue(), '')
  assert.equal(
    await composer.inputValue(),
    'KEEP_MY_NEW_DRAFT_WHILE_RECONNECTING',
  )
  assert.equal(
    await page.evaluate(
      (key) => localStorage.getItem(key),
      `lemex-chat:fixture-owner:${projectId}`,
    ),
    'new',
  )

  // An explicit New chat choice also takes precedence without any typing.
  await choose(chatId)
  failChatList = true
  await page.reload()
  await until(
    async () => (await alertText()).includes('CHAT_LIST_OFFLINE_FIXTURE'),
    'list unavailable before navigation',
  )
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  failChatList = false
  await until(
    async () =>
      !(await alertText()).includes('CHAT_LIST_OFFLINE_FIXTURE') &&
      (await picker.locator('option').count()) > 1,
    'chat list recovers after navigation',
  )
  await sleep(4500)
  assert.equal(await picker.inputValue(), '')
  assert.equal(
    await composer.inputValue(),
    'KEEP_MY_NEW_DRAFT_WHILE_RECONNECTING',
  )
  report.checks.push(
    'Startup recovery preserves typing or explicit navigation made while chats were unavailable',
  )

  // Let an old startup list arrive after the first send has created a chat.
  // Neither its selection nor its stale options may overwrite the new chat.
  for (const run of state.runs) run.status = 'completed'
  let holdInitialList = true,
    releaseInitialList
  await page.route(`**/api/projects/${projectId}/chats`, (route) => {
    if (route.request().method() !== 'GET' || !holdInitialList)
      return route.fallback()
    holdInitialList = false
    const values = structuredClone(state.chats)
    return new Promise((resolve) => {
      releaseInitialList = async () => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(values),
        })
        resolve()
      }
    })
  })
  await page.evaluate(
    ({ projectId, chatId }) =>
      localStorage.setItem(`lemex-chat:fixture-owner:${projectId}`, chatId),
    { projectId, chatId },
  )
  await page.reload()
  await until(
    async () => !!releaseInitialList && (await composer.isVisible()),
    'held startup chat list',
  )
  await composer.fill(
    'STARTUP_FIRST_SEND: keep this newly created chat selected.',
  )
  let startupChat
  state.onCreateRun = ({ chat, body, respond }) => {
    startupChat = chat.id
    const run = {
      ...active,
      id: 'startup-first-run',
      chatId: chat.id,
      status: 'completed',
      liveEdits: false,
      liveRevision: 0,
      prompt: body.prompt,
      message: 'Startup send completed.',
      eventCursor: 30,
    }
    state.runs.push(run)
    return respond(run, 202)
  }
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(
    async () => !!startupChat && (await picker.inputValue()) === startupChat,
    'first sent chat is attached',
  )
  await releaseInitialList()
  await sleep(350)
  assert.equal(await picker.inputValue(), startupChat)
  assert((await conversation.innerText()).includes('STARTUP_FIRST_SEND'))
  report.checks.push(
    'A late startup list cannot redirect the first send or remove its newly created chat option',
  )

  fixture.assertClean()
  report.passed = true
  console.log(
    `PASS: ${report.checks.length} chat recovery, lazy chat, and send-follow race checks; all APIs mocked`,
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
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
