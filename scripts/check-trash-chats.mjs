#!/usr/bin/env node
// Browser QA creates only its own Lean project. Every deletion is restored;
// provider runs are blocked, and fixture sources/screenshots remain available.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const dataDir = process.env.STUDIO_DATA_DIR || path.join(root, '.data')
const reportDir = path.join(root, '.runtime/trash-chats')
await fs.mkdir(reportDir, { recursive: true })
const token = (
  await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
).trim()
const startedAt = Date.now(),
  budget = Number(process.env.STUDIO_QA_TIMEOUT_MS || 300_000)
const report = {
  startedAt: new Date().toISOString(),
  projectId: null,
  chats: [],
  receipts: [],
  checks: [],
  errors: [],
  serverErrors: [],
  blockedMutations: [],
}
const chatIds = new Set(),
  trashIds = new Set()
let project, browser, page

async function request(
  endpoint,
  body,
  method = body === undefined ? 'GET' : 'POST',
  expected = 200,
) {
  if (method !== 'GET') {
    const allowed =
      (endpoint === '/api/projects' && !project) ||
      (project && endpoint.startsWith(`/api/projects/${project.id}/`)) ||
      [...chatIds].some((id) => endpoint === `/api/chats/${id}`) ||
      [...trashIds].some((id) => endpoint === `/api/trash/${id}/restore`)
    assert(
      allowed,
      `Refusing mutation outside this QA fixture: ${method} ${endpoint}`,
    )
    assert(
      !endpoint.endsWith('/runs') && !endpoint.endsWith('/check'),
      'QA must never start model runs or checks',
    )
  }
  const response = await fetch(base + endpoint, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.json()
  assert.equal(
    response.status,
    expected,
    `${method} ${endpoint}: ${response.status} ${value.error || ''}`,
  )
  return value
}
async function until(check, label, timeout = 30_000) {
  const deadline = Math.min(Date.now() + timeout, startedAt + budget)
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 180))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
function passed(label) {
  report.checks.push(label)
  console.log(`PASS: ${label}`)
}
const fileEndpoint = (filename) =>
  `/api/projects/${project.id}/file?path=${encodeURIComponent(filename)}`
async function readyEditor(filename = 'Main.lean') {
  await page.locator('.monaco-editor').waitFor({ timeout: 60_000 })
  await page
    .locator('.editor-loading')
    .waitFor({ state: 'hidden', timeout: 60_000 })
  await page
    .locator(`.file-tab span[title="${filename}"]`)
    .waitFor({ timeout: 30_000 })
}
async function confirmDelete(kind, click) {
  await click()
  const dialog = page.getByRole('dialog', {
    name: `Delete ${kind}?`,
    exact: true,
  })
  await dialog.waitFor()
  const endpoint =
    kind === 'chat'
      ? `/api/chats/${await page.getByLabel('Select chat').inputValue()}/trash`
      : `/api/projects/${project.id}/trash`
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === endpoint,
  )
  await dialog
    .getByRole('button', { name: 'Move to Trash', exact: true })
    .click()
  const deleted = await response,
    receipt = await deleted.json()
  assert.equal(deleted.status(), 200, receipt.error)
  trashIds.add(receipt.trashId)
  report.receipts.push(receipt)
  await dialog.waitFor({ state: 'hidden' })
  return receipt
}
async function undo(receipt) {
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/api/trash/${receipt.trashId}/restore`,
  )
  await page
    .locator('.trash-notice')
    .getByRole('button', { name: 'Undo', exact: true })
    .click()
  const restored = await response
  assert.equal(restored.status(), 200, JSON.stringify(await restored.json()))
  await page.locator('.trash-notice').waitFor({ state: 'hidden' })
}
async function newChat() {
  const response = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/projects/${project.id}/chats`,
  )
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  const created = await response,
    chat = await created.json()
  assert.equal(created.status(), 201, chat.error)
  chatIds.add(chat.id)
  report.chats.push(chat.id)
  await until(
    async () => (await page.getByLabel('Select chat').inputValue()) === chat.id,
    'the new selected chat',
  )
  await page.locator('.assistant-starters').waitFor()
  await until(
    async () =>
      (await page.getByLabel('Instructions for Lemex').inputValue()) === '' &&
      !(await page
        .getByRole('button', { name: 'New chat', exact: true })
        .isDisabled()),
    'the cleared new-chat composer',
  )
  assert.equal(await page.locator('.chat-previous-turn').count(), 0)
  return chat
}

try {
  project = await request(
    '/api/projects',
    { name: `Trash and chat QA ${new Date().toISOString()}`, preset: 'lean' },
    'POST',
    201,
  )
  report.projectId = project.id
  report.projectName = project.name
  await fs.writeFile(
    path.join(reportDir, 'fixture.json'),
    JSON.stringify(
      {
        projectId: project.id,
        projectName: project.name,
        createdAt: report.startedAt,
      },
      null,
      2,
    ),
  )
  await until(
    async () => {
      const current = await request(`/api/projects/${project.id}`)
      if (current.status === 'preparing') return false
      assert.equal(current.status, 'ready', current.error)
      return current
    },
    'isolated Lean fixture preparation',
    180_000,
  )
  const original = await request(fileEndpoint('Main.lean'))
  const fixtures = {
    'Notes/Leaf.lean':
      '-- QA leaf preserved byte for byte\nexample : True := by trivial\n',
    'Notes/Nested/Second.lean':
      '-- QA nested proof\nexample : 1 = 1 := by rfl\n',
    'Notes/Readme.txt': 'A recoverable notes folder.\n',
  }
  for (const [filename, content] of Object.entries(fixtures))
    await request(
      fileEndpoint(filename),
      { content, expectedHash: null },
      'PUT',
    )
  await fs.writeFile(
    path.join(reportDir, 'original-sources.json'),
    JSON.stringify({ 'Main.lean': original.content, ...fixtures }, null, 2),
  )
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1680, height: 1080 } })
  page.setDefaultTimeout(30_000)
  await page.addInitScript(
    ({ id }) => {
      localStorage.setItem('lemex-project', id)
      localStorage.setItem(`lemex-file-${id}`, 'Main.lean')
      localStorage.setItem('lemex-theme', 'dark')
    },
    { id: project.id },
  )
  page.on('pageerror', (error) =>
    report.errors.push(error.stack || error.message),
  )
  page.on('response', (response) => {
    if (response.status() >= 500)
      report.serverErrors.push({
        status: response.status(),
        url: response.url(),
      })
  })
  await page.route('**/api/**', async (route) => {
    const current = route.request(),
      endpoint = new URL(current.url()).pathname
    if (['GET', 'HEAD'].includes(current.method())) return route.continue()
    const allowed =
      endpoint === '/api/login' ||
      (endpoint.startsWith(`/api/projects/${project.id}/`) &&
        !endpoint.endsWith('/runs') &&
        !endpoint.endsWith('/check')) ||
      [...chatIds].some(
        (id) =>
          endpoint.startsWith(`/api/chats/${id}/`) &&
          !endpoint.endsWith('/runs'),
      ) ||
      [...trashIds].some((id) => endpoint === `/api/trash/${id}/restore`)
    if (allowed) return route.continue()
    report.blockedMutations.push({ method: current.method(), endpoint })
    await route.abort('blockedbyclient')
  })
  await page.goto(base)
  await page.getByLabel('Access token').fill(token)
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await readyEditor()
  assert(
    await page
      .locator('.sidebar')
      .evaluate((sidebar) =>
        Boolean(
          sidebar
            .querySelector('.sidebar-files-section')
            ?.compareDocumentPosition(
              sidebar.querySelector('.sidebar-projects-section'),
            ) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
    'Files should precede Projects',
  )
  passed('Files appear before Projects in the actual sidebar')

  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n-- QA_UNSAVED_DRAFT\n')
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes(
        'QA_UNSAVED_DRAFT',
      ),
    'the unsaved editor draft',
  )
  await page
    .getByRole('button', { name: 'Move file Main.lean to trash', exact: true })
    .click()
  const cancel = page.getByRole('dialog', { name: 'Delete file?', exact: true })
  assert((await cancel.innerText()).includes('Unsaved changes in this item'))
  await cancel.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert(
    (await page.locator('.view-lines').innerText()).includes(
      'QA_UNSAVED_DRAFT',
    ),
  )
  assert.equal((await request(fileEndpoint('Main.lean'))).hash, original.hash)
  assert.equal(await page.locator('.trash-notice').count(), 0)
  passed('Cancel deletion preserves the unsaved draft and saved bytes')

  const deletedFile = await confirmDelete('file', () =>
    page
      .getByRole('button', {
        name: 'Move file Main.lean to trash',
        exact: true,
      })
      .click(),
  )
  await request(fileEndpoint('Main.lean'), undefined, 'GET', 404)
  await undo(deletedFile)
  assert.equal((await request(fileEndpoint('Main.lean'))).hash, original.hash)
  await page.locator('.file-item[title="Main.lean"]').click()
  await readyEditor()
  assert(
    !(await page.locator('.view-lines').innerText()).includes(
      'QA_UNSAVED_DRAFT',
    ),
  )
  passed('Deleting a file and using Undo restores its original bytes')

  const deletedFolder = await confirmDelete('folder', () =>
    page
      .getByRole('button', { name: 'Move folder Notes to trash', exact: true })
      .click(),
  )
  await request(fileEndpoint('Notes/Leaf.lean'), undefined, 'GET', 404)
  await page.reload()
  await readyEditor()
  await page.getByRole('button', { name: 'Open Trash', exact: true }).click()
  const trashDialog = page.getByRole('dialog', { name: 'Trash', exact: true })
  const folderRow = trashDialog
    .locator('.trash-item')
    .filter({ hasText: project.name })
    .filter({ hasText: 'Notes' })
  await folderRow.waitFor()
  const restoring = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
      `/api/trash/${deletedFolder.trashId}/restore`,
  )
  await folderRow.getByRole('button', { name: 'Restore', exact: true }).click()
  assert.equal((await restoring).status(), 200)
  await folderRow.waitFor({ state: 'hidden' })
  await trashDialog.getByRole('button', { name: 'Close', exact: true }).click()
  for (const [filename, content] of Object.entries(fixtures))
    assert.equal((await request(fileEndpoint(filename))).content, content)
  passed('Folder deletion survives reload in Trash and restores every child')

  const assistant = page.locator('.assistant-panel')
  for (const name of ['Proofs', 'Formalize', 'Optimize', 'Search'])
    await assistant
      .locator('.mode-tabs')
      .getByRole('button', { name, exact: true })
      .waitFor()
  for (const name of ['Repair a proof', 'Find a proof']) {
    await assistant.getByRole('button', { name, exact: true }).click()
    assert.equal(
      await assistant.getByLabel('Time limit (optional)').inputValue(),
      'unlimited',
    )
    assert.equal(
      await assistant
        .getByRole('checkbox', { name: /Edit files live/ })
        .isChecked(),
      true,
    )
  }
  passed(
    'Proofs/Formalize/Optimize/Search are visible; Repair and Prove share Until done and live edits',
  )

  const first = await newChat()
  await request(
    `/api/chats/${first.id}`,
    { title: 'QA first empty conversation' },
    'PATCH',
  )
  await page
    .getByLabel('Instructions for Lemex')
    .fill('A local draft that New chat must clear.')
  const second = await newChat()
  assert.notEqual(first.id, second.id)
  await request(
    `/api/chats/${second.id}`,
    { title: 'QA second empty conversation' },
    'PATCH',
  )
  await page.reload()
  await readyEditor()
  const chatPicker = page.getByLabel('Select chat')
  await until(
    async () =>
      (await chatPicker.locator('option').allTextContents()).some((text) =>
        text.includes('QA second empty conversation'),
      ),
    'persisted chat titles',
  )
  for (const chat of [first, second]) {
    await chatPicker.selectOption(chat.id)
    await page.locator('.assistant-starters').waitFor()
    assert.equal(await page.locator('.user-message').count(), 0)
    assert.equal((await request(`/api/chats/${chat.id}`)).runs.length, 0)
  }
  passed(
    'New chat clears the composer, creates distinct durable IDs, and empty chat switching stays isolated',
  )

  await page.locator('.file-context-picker summary').click()
  await page.getByRole('checkbox', { name: 'Main.lean', exact: true }).check()
  await page
    .getByRole('checkbox', { name: 'Notes/Leaf.lean', exact: true })
    .check()
  assert.equal(await page.locator('.file-context-chip').count(), 2)
  assert.equal(await page.locator('.file-context-count').innerText(), '2/12')
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Remove Main.lean from context',
        exact: true,
      })
      .count(),
    1,
  )
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Remove Notes/Leaf.lean from context',
        exact: true,
      })
      .count(),
    1,
  )
  await page.getByLabel('Filter context files').press('Escape')
  passed('Two real context files show removable chips and the 12-file limit')
  await page.screenshot({
    path: path.join(reportDir, 'chats-and-context.png'),
    fullPage: true,
  })

  const deletedChat = await confirmDelete('chat', () =>
    page
      .getByRole('button', {
        name: 'Delete chat QA second empty conversation',
        exact: true,
      })
      .click(),
  )
  assert(
    !(await request(`/api/projects/${project.id}/chats`)).some(
      (chat) => chat.id === second.id,
    ),
  )
  await undo(deletedChat)
  await until(
    async () =>
      (
        await chatPicker
          .locator('option')
          .evaluateAll((options) => options.map((option) => option.value))
      ).includes(second.id),
    'the restored chat option',
  )
  assert.equal((await request(`/api/chats/${second.id}`)).runs.length, 0)
  passed('Deleting a chat and using Undo restores it with retained history')

  const deletedProject = await confirmDelete('project', () =>
    page
      .getByRole('button', {
        name: `Move project ${project.name} to trash`,
        exact: true,
      })
      .click(),
  )
  await request(`/api/projects/${project.id}`, undefined, 'GET', 404)
  await page
    .locator(`.project-item[title="${project.name}"]`)
    .waitFor({ state: 'hidden' })
  await undo(deletedProject)
  await page.locator(`.project-item[title="${project.name}"]`).waitFor()
  await page.locator(`.project-item[title="${project.name}"]`).click()
  await readyEditor()
  passed(
    'Archiving the current project hides it from API/sidebar and Undo restores it',
  )

  for (const [filename, content] of Object.entries({
    'Main.lean': original.content,
    ...fixtures,
  }))
    assert.equal((await request(fileEndpoint(filename))).content, content)
  assert.equal((await request(`/api/projects/${project.id}/runs`)).length, 0)
  assert(
    !(await request('/api/trash')).some(
      (item) => item.projectId === project.id,
    ),
    'QA left unrestored trash',
  )
  assert.deepEqual(
    report.blockedMutations,
    [],
    'QA attempted an unexpected mutation or provider call',
  )
  assert.deepEqual(report.errors, [], 'Browser JavaScript errors occurred')
  assert.deepEqual(report.serverErrors, [], 'HTTP server errors occurred')
  await page.screenshot({
    path: path.join(reportDir, 'restored-final.png'),
    fullPage: true,
  })
  report.passed = true
  passed(
    'All created sources and chats remain restored; zero provider requests or personal deletions',
  )
} catch (error) {
  report.passed = false
  report.failure = error.stack || error.message
  await page
    ?.screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  if (!report.passed && project) {
    // An assertion failure must not strand this script's deleted fixtures.
    // Restore only receipts attached to the newly created QA project.
    report.failureRecovery = []
    try {
      const ownTrash = (await request('/api/trash'))
        .filter((item) => item.projectId === project.id)
        .sort(
          (a, b) => Number(b.kind === 'project') - Number(a.kind === 'project'),
        )
      for (const item of ownTrash) {
        trashIds.add(item.trashId)
        try {
          await request(`/api/trash/${item.trashId}/restore`, {})
          report.failureRecovery.push({ trashId: item.trashId, restored: true })
        } catch (error) {
          report.failureRecovery.push({
            trashId: item.trashId,
            error: error.message,
          })
        }
      }
    } catch (error) {
      report.failureRecovery.push({ error: error.message })
    }
  }
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser?.close()
}
