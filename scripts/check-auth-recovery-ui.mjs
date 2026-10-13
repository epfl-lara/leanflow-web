#!/usr/bin/env node
// Exercise the real editor and recovery dialog with all APIs and Lean mocked.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(root, '.runtime/auth-recovery-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'recovery-project'
const chatId = 'recovery-chat'
const user = { id: 'recovery-owner', name: 'Recovery owner' }
const fixture = await chatBrowserFixture({
  session: {
    user,
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    { id: projectId, name: 'Session recovery fixture', status: 'ready' },
  ],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [
    { id: chatId, projectId, title: 'Unsaved conversation', runCount: 0 },
  ],
  runs: [],
})
const { page, browser, state, report } = fixture
let expired = false
let holdGit = false
let delayedGit
let saveAttempts = 0
let savedContent
const logins = []
await page.addInitScript(() => {
  window.__recoveryEvents = { expired: 0, restored: 0 }
  window.addEventListener(
    'leanflow:session-expired',
    () => window.__recoveryEvents.expired++,
  )
  window.addEventListener(
    'leanflow:session-restored',
    () => window.__recoveryEvents.restored++,
  )
})
// Runs before the fixture routes. Anything not modeled falls back to its closed
// API allowlist, so this script cannot reach real project data or providers.
await page.route('**/api/**', async (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  const respond = (value, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    })
  if (endpoint === '/api/login' && request.method() === 'POST') {
    const body = request.postDataJSON()
    logins.push(body)
    assert.equal(body.expectedUserId, user.id)
    if (body.token === 'wrong-account-fixture-token')
      return respond(
        { error: 'This token belongs to a different account.' },
        409,
      )
    if (body.token !== 'correct-fixture-token')
      return respond({ error: 'That access token was not recognized.' }, 401)
    expired = false
    return respond({ user })
  }
  if (holdGit && endpoint.endsWith('/git') && request.method() === 'GET') {
    holdGit = false
    delayedGit = () =>
      respond({ error: 'Delayed expired session response.' }, 401)
    return
  }
  if (endpoint.endsWith('/file') && request.method() === 'PUT') {
    saveAttempts++
    if (expired) return respond({ error: 'Session expired.' }, 401)
    savedContent = request.postDataJSON().content
    state.files[projectId]['Main.lean'] = savedContent
    return respond({
      content: savedContent,
      hash: createHash('sha256').update(savedContent).digest('hex'),
    })
  }
  if (expired) return respond({ error: 'Session expired.' }, 401)
  return route.fallback()
})

try {
  await fixture.ready()
  const composer = page.getByLabel('Message Lemex')
  const draft = 'Keep this draft while I renew my session.'
  await composer.fill(draft)
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('-- unsaved recovery marker\n')
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await until(() => save.isEnabled(), 'dirty editor')
  await page.evaluate(() => {
    window.__recoveryEditor = document.querySelector('.monaco-editor')
  })
  const socketsBefore = report.sockets.length
  holdGit = true
  await page
    .getByRole('button', { name: 'Refresh Git status', exact: true })
    .click()
  await until(() => !!delayedGit, 'old-session request in flight')
  expired = true
  await save.click()

  const dialog = page.getByRole('dialog', { name: 'Sign in to continue' })
  await dialog.waitFor()
  assert.equal(saveAttempts, 1)
  assert.equal(await composer.inputValue(), draft)
  assert(await page.locator('.file-toolbar .dirty-dot').isVisible())
  assert(
    await page.evaluate(
      () =>
        window.__recoveryEditor === document.querySelector('.monaco-editor'),
    ),
  )
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await until(
    () => dialog.isVisible(),
    'recovery remains available after repeated Escape',
  )
  report.checks.push(
    'Expired save shows recovery without unmounting the dirty editor or chat draft',
  )

  const tokenInput = dialog.getByLabel('Access token')
  const continueButton = dialog.getByRole('button', {
    name: 'Continue in workspace',
  })
  await tokenInput.fill('wrong-account-fixture-token')
  await continueButton.click()
  await dialog
    .getByRole('alert')
    .filter({ hasText: 'different account' })
    .waitFor()
  assert.equal(await composer.inputValue(), draft)
  await tokenInput.fill('invalid-fixture-token')
  await continueButton.click()
  await dialog
    .getByRole('alert')
    .filter({ hasText: 'not recognized' })
    .waitFor()
  report.checks.push(
    'Wrong-account and invalid tokens keep the recovery dialog and unsaved work intact',
  )

  await tokenInput.fill('correct-fixture-token')
  await continueButton.click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(
    saveAttempts,
    1,
    'Recovery must not replay a failed save automatically',
  )
  assert.equal(await composer.inputValue(), draft)
  assert(await save.isEnabled())
  assert.equal(
    report.sockets.length,
    socketsBefore,
    'Editor was reconnected or remounted',
  )
  assert(
    await page.evaluate(
      () =>
        window.__recoveryEditor === document.querySelector('.monaco-editor'),
    ),
  )
  report.checks.push(
    'Same-account renewal restores workspace access without replaying writes or resetting the editor',
  )

  const beforeStale = await page.evaluate(() => window.__recoveryEvents.expired)
  await delayedGit()
  await page
    .getByRole('button', { name: 'Refresh Git status', exact: true })
    .waitFor({ state: 'hidden' })
  assert.equal(
    await page.evaluate(() => window.__recoveryEvents.expired),
    beforeStale,
  )
  assert.equal(await dialog.count(), 0)
  report.checks.push(
    'A delayed 401 from before renewal cannot reopen the recovery dialog',
  )

  await save.click()
  await until(() => save.isDisabled(), 'explicit save succeeds')
  assert.equal(saveAttempts, 2)
  assert.match(savedContent, /unsaved recovery marker/)
  assert.equal(await composer.inputValue(), draft)
  assert.equal(await page.locator('.dirty-dot').count(), 0)
  assert.equal(logins.length, 3)
  assert.equal(
    report.requests.filter(
      (request) => !['GET', 'HEAD'].includes(request.method),
    ).length,
    0,
  )
  fixture.assertClean()
  report.checks.push(
    'Explicit retry saves the preserved edit while the unsent chat draft stays unchanged',
  )
  report.passed = true
  await page.screenshot({ path: path.join(reportDir, 'recovered.png') })
  console.log(
    `PASS: ${report.checks.length} session recovery checks; all APIs and Lean mocked`,
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
