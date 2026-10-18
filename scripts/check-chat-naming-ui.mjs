#!/usr/bin/env node
// Entirely mocked APIs: no provider calls, project writes, or production chats.
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
const reportDir = path.join(root, '.runtime/chat-naming-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'naming-project'
const otherProjectId = 'naming-other-project'
const chatId = 'naming-alpha'
const otherChatId = 'naming-beta'
const emptyChatId = 'naming-empty'
const active = {
  id: 'naming-active-run',
  projectId,
  chatId,
  status: 'running',
  mode: 'repair',
  createdAt: '2026-10-13T09:00:00Z',
  eventCursor: 1,
  prompt: 'Prove the transitivity lemma.',
  message: 'ACTIVE_PROOF: Inspecting the statement.',
  followups: [],
  files: [],
  liveEdits: true,
}
const fixture = await chatBrowserFixture({
  launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {},
  session: {
    user: { id: 'naming-owner', name: 'Naming owner' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Naming project',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
    {
      id: otherProjectId,
      name: 'Other naming project',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: {
    [projectId]: { 'Main.lean': 'import Lean\nexample : True := by trivial\n' },
    [otherProjectId]: {
      'Main.lean': 'import Lean\nexample : True := by trivial\n',
    },
  },
  chats: [
    { id: chatId, projectId, title: 'Alpha conversation', runCount: 1 },
    { id: otherChatId, projectId, title: 'Beta conversation', runCount: 1 },
    { id: emptyChatId, projectId, title: 'New chat', runCount: 0 },
    {
      id: 'naming-other-chat',
      projectId: otherProjectId,
      title: 'Other project conversation',
      runCount: 1,
    },
  ],
  runs: [
    active,
    {
      id: 'naming-completed-run',
      projectId,
      chatId: otherChatId,
      status: 'completed',
      mode: 'repair',
      createdAt: '2026-10-13T08:00:00Z',
      eventCursor: 1,
      prompt: 'Prove symmetry.',
      message: 'BETA_ANSWER: Complete.',
    },
  ],
})
const { page, browser, state, report, emit } = fixture
const namingRequests = []
report.namingRequests = namingRequests
let onRename = null
let onSuggest = null
await page.route('**/api/chats/**', async (route) => {
  const request = route.request(),
    endpoint = new URL(request.url()).pathname,
    method = request.method()
  const match = /^\/api\/chats\/([^/]+)(\/title)?$/.exec(endpoint)
  if (!match || !['PATCH', 'POST'].includes(method)) return route.fallback()
  const chat = state.chats.find(
    (entry) => entry.id === decodeURIComponent(match[1]),
  )
  if (!chat) return route.fallback()
  const body = request.postDataJSON()
  namingRequests.push({ method, endpoint, body })
  const respond = (value, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    })
  if (method === 'PATCH' && !match[2]) {
    if (onRename) return onRename({ chat, body, respond })
    chat.title = body.title
    chat.updatedAt = new Date().toISOString()
    return respond(chat)
  }
  if (method === 'POST' && match[2]) {
    assert.deepEqual(
      body,
      {},
      'Only the server should choose the naming model and context',
    )
    if (onSuggest) return onSuggest({ chat, respond })
    return respond({
      title: 'Transitivity of the order relation',
      model: 'fixture-deepseek',
    })
  }
  return route.fallback()
})
const composer = page.getByLabel('Message Lemex')
const selector = page.getByLabel('Select chat')
const renameButton = page.getByRole('button', {
  name: 'Rename chat',
  exact: true,
})
const form = page.getByRole('form', { name: 'Rename chat', exact: true })
const nameInput = page.getByLabel('Chat name', { exact: true })
const patches = () =>
  namingRequests.filter((request) => request.method === 'PATCH')
async function openRename() {
  await renameButton.click()
  await form.waitFor()
}
async function chooseChat(id) {
  await selector.selectOption(id)
  await until(
    async () =>
      (await selector.inputValue()) === id &&
      !(await page.locator('.chat-picker[aria-busy="true"]').count()),
    `chat ${id}`,
  )
}
async function holdSuggestion() {
  let release
  onSuggest = ({ respond }) =>
    new Promise((resolve) => {
      release = async (title) => {
        await respond({ title, model: 'fixture-deepseek' }).catch(() => {})
        resolve()
      }
    })
  await page
    .getByRole('button', { name: 'Suggest a name', exact: true })
    .click()
  await until(async () => !!release, 'held title suggestion')
  return release
}
async function selectedTitle() {
  return selector.locator('option:checked').innerText()
}

try {
  await fixture.ready()
  await until(
    async () => (await selector.inputValue()) === chatId,
    'selected chat',
  )
  await composer.fill('DRAFT_ALPHA: Keep this while renaming.')
  await openRename()
  assert.equal(await nameInput.inputValue(), 'Alpha conversation')
  assert.equal(await nameInput.getAttribute('maxlength'), '120')
  assert.equal(
    await nameInput.evaluate((input) => input === document.activeElement),
    true,
  )
  await nameInput.fill('Cancelled name')
  await nameInput.press('Escape')
  assert.equal(await form.count(), 0)
  assert.equal(patches().length, 0)
  assert.equal(
    await renameButton.evaluate((button) => button === document.activeElement),
    true,
  )
  await openRename()
  await nameInput.fill('    ')
  await nameInput.press('Enter')
  assert.match(await form.getByRole('alert').innerText(), /1 and 120/)
  assert.equal(patches().length, 0)
  await nameInput.fill('  Order transitivity  ')
  await nameInput.press('Enter')
  await until(async () => !(await form.count()), 'manual rename saved')
  assert.equal(
    state.chats.find((chat) => chat.id === chatId).title,
    'Order transitivity',
  )
  assert.match(await selectedTitle(), /^Order transitivity/)
  assert.equal(await selector.inputValue(), chatId)
  assert.equal(
    await composer.inputValue(),
    'DRAFT_ALPHA: Keep this while renaming.',
  )
  assert.equal(
    await page.getByRole('button', { name: 'Stop', exact: true }).isEnabled(),
    true,
  )
  await emit(active, 'message', '\nSTREAM_AFTER_RENAME: Still working.')
  await until(
    async () =>
      (
        await page
          .getByRole('region', { name: 'Conversation', exact: true })
          .innerText()
      ).includes('STREAM_AFTER_RENAME'),
    'stream still connected',
  )
  report.checks.push(
    'Manual rename trims whitespace, validates empty names, supports Enter/Escape, and preserves the active proof, stream, selection and composer draft',
  )

  await page.reload()
  await until(
    async () => /^Order transitivity/.test(await selectedTitle()),
    'renamed chat after reload',
  )
  assert.equal(
    await composer.inputValue(),
    'DRAFT_ALPHA: Keep this while renaming.',
  )
  await openRename()
  onRename = ({ respond }) =>
    respond({ error: 'RENAME_FAILURE: Please try again.' }, 503)
  await nameInput.fill('Preserve failed rename')
  await nameInput.press('Enter')
  await until(
    async () =>
      (await form.getByRole('alert').innerText()).includes('RENAME_FAILURE'),
    'rename failure',
  )
  assert.equal(await nameInput.inputValue(), 'Preserve failed rename')
  assert.match(await selectedTitle(), /^Order transitivity/)
  onRename = null
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  report.checks.push(
    'Saved names survive reload; failed rename retains the editable name and existing chat title',
  )

  await openRename()
  const beforeSuggestion = patches().length
  await page
    .getByRole('button', { name: 'Suggest a name', exact: true })
    .click()
  await until(
    async () =>
      (await nameInput.inputValue()) === 'Transitivity of the order relation',
    'suggested name',
  )
  assert.equal(
    patches().length,
    beforeSuggestion,
    'Suggestion must not save before user review',
  )
  assert.match(await selectedTitle(), /^Order transitivity/)
  await nameInput.fill('Transitivity using existing order lemmas')
  await nameInput.press('Enter')
  await until(async () => !(await form.count()), 'edited suggestion saved')
  assert.match(
    await selectedTitle(),
    /^Transitivity using existing order lemmas/,
  )
  await openRename()
  onSuggest = ({ respond }) =>
    respond(
      { error: 'SUGGESTION_FAILURE: Naming is temporarily unavailable.' },
      503,
    )
  await page
    .getByRole('button', { name: 'Suggest a name', exact: true })
    .click()
  await until(
    async () =>
      (await form.getByRole('alert').innerText()).includes(
        'SUGGESTION_FAILURE',
      ),
    'suggestion failure',
  )
  assert.equal(
    await nameInput.inputValue(),
    'Transitivity using existing order lemmas',
  )
  assert.equal(
    await form.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
    true,
  )
  report.checks.push(
    'DeepSeek suggestion fills an editable preview without saving; failure leaves manual naming available',
  )

  const releaseTyped = await holdSuggestion()
  await nameInput.fill('My more specific title')
  await composer.fill('DRAFT_ALPHA: Typing while naming runs.')
  await releaseTyped('STALE_SUGGESTION: do not replace manual edits')
  await until(
    async () =>
      (await page
        .getByRole('button', { name: 'Suggest a name', exact: true })
        .count()) === 1,
    'suggestion finished after manual edit',
  )
  assert.equal(await nameInput.inputValue(), 'My more specific title')
  await nameInput.press('Escape')

  await openRename()
  const releaseWhileComposing = await holdSuggestion()
  await composer.fill('DRAFT_ALPHA: Keep focus in the proof message.')
  await releaseWhileComposing('A name suggested while composing')
  await until(
    async () =>
      (await nameInput.inputValue()) === 'A name suggested while composing',
    'suggestion while composing',
  )
  assert.equal(
    await composer.evaluate((input) => input === document.activeElement),
    true,
    'A completed title suggestion stole focus from the proof message',
  )
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()

  await openRename()
  const releaseChat = await holdSuggestion()
  assert.equal(await selector.isEnabled(), true)
  assert.equal(
    await page
      .getByRole('button', { name: 'New chat', exact: true })
      .isEnabled(),
    true,
  )
  await chooseChat(otherChatId)
  assert.equal(await form.count(), 0)
  await composer.fill('DRAFT_BETA: Keep this in Beta.')
  await openRename()
  await nameInput.fill('Beta manual title')
  await releaseChat('STALE_ALPHA_NAME')
  await sleep(200)
  assert.equal(await selector.inputValue(), otherChatId)
  assert.equal(await nameInput.inputValue(), 'Beta manual title')
  assert.equal(await composer.inputValue(), 'DRAFT_BETA: Keep this in Beta.')
  await nameInput.press('Escape')
  report.checks.push(
    'Pending suggestions leave navigation and typing usable; late replies cannot overwrite newer manual edits or another chat',
  )

  await chooseChat(chatId)
  await openRename()
  let releaseRename
  onRename = ({ chat, body, respond }) =>
    new Promise((resolve) => {
      releaseRename = async () => {
        chat.title = body.title
        await respond(chat)
        resolve()
      }
    })
  await nameInput.fill('Alpha renamed after navigation')
  await nameInput.press('Enter')
  await until(async () => !!releaseRename, 'held rename')
  await chooseChat(otherChatId)
  await openRename()
  await nameInput.fill('Unrelated Beta draft name')
  await releaseRename()
  await sleep(200)
  assert.equal(await selector.inputValue(), otherChatId)
  assert.equal(await nameInput.inputValue(), 'Unrelated Beta draft name')
  assert.equal(await composer.inputValue(), 'DRAFT_BETA: Keep this in Beta.')
  assert.match(
    await selector.locator(`option[value="${chatId}"]`).innerText(),
    /^Alpha renamed after navigation/,
  )
  onRename = null
  await nameInput.press('Escape')
  report.checks.push(
    'A delayed save updates only its original chat label and cannot close another chat rename form or change its draft',
  )

  await chooseChat(emptyChatId)
  await openRename()
  assert.equal(
    await page
      .getByRole('button', { name: 'Suggest a name', exact: true })
      .count(),
    0,
  )
  await nameInput.fill('Planned formalization')
  await nameInput.press('Enter')
  await until(
    async () => /^Planned formalization/.test(await selectedTitle()),
    'empty chat manual rename',
  )
  await chooseChat(chatId)
  await openRename()
  const releaseProject = await holdSuggestion()
  await page
    .locator('.project-row')
    .filter({ hasText: 'Other naming project' })
    .getByRole('button')
    .first()
    .click()
  await until(
    async () => (await selector.inputValue()) === 'naming-other-chat',
    'other project selected',
  )
  await openRename()
  await nameInput.fill('Other project manual title')
  await releaseProject('STALE_PROJECT_TITLE')
  await sleep(200)
  assert.equal(await nameInput.inputValue(), 'Other project manual title')
  assert.equal(await selector.inputValue(), 'naming-other-chat')
  report.checks.push(
    'Empty chats remain manually nameable; project navigation isolates pending suggestions and rename state',
  )

  await page.setViewportSize({ width: 1366, height: 768 })
  await sleep(250)
  const elements = [
    nameInput,
    form.getByRole('button', { name: 'Save', exact: true }),
    form.getByRole('button', { name: 'Cancel', exact: true }),
    composer,
  ]
  for (const element of elements) {
    const box = await element.boundingBox(),
      viewport = page.viewportSize()
    assert(
      box &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1,
      'Rename/composer control is outside laptop viewport',
    )
  }
  assert(
    await nameInput.evaluate((input) => input.clientWidth >= 100),
    'Chat name input is too cramped',
  )
  await page.screenshot({
    path: path.join(reportDir, 'rename-laptop.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.screenshot({
    path: path.join(reportDir, 'rename-desktop.png'),
    fullPage: true,
  })
  report.checks.push(
    'Inline naming controls and composer remain visible at laptop size',
  )
  fixture.assertClean()
  assert.equal(
    report.requests.filter(
      (request) =>
        request.method === 'POST' &&
        /\/(runs|stop|messages)$/.test(request.endpoint),
    ).length,
    0,
    'Renaming must never change or restart agent work',
  )
  report.passed = true
  console.log(
    `PASS: ${report.checks.length} chat naming checks; all APIs and provider replies mocked`,
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
