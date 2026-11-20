#!/usr/bin/env node
import assert from 'node:assert/strict'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const projectId = 'private-project-fixture'
const chatId = 'failure-log-chat'
const run = {
  id: 'private-run-id',
  projectId,
  chatId,
  createdAt: new Date().toISOString(),
  eventCursor: 0,
  mode: 'proofs',
  status: 'running',
  prompt: 'private-assistant-prompt',
}
const verificationRun = {
  ...run,
  id: 'private-verification-run',
  chatId: 'verification-chat',
}
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'failure-log-user', name: 'Fixture user', role: 'user' },
    templates: [],
    models: [{ id: 'fixture', name: 'Fixture' }],
    defaultModel: 'fixture',
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [{ id: projectId, name: 'Fixture project', status: 'ready' }],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [
    { id: chatId, projectId, title: 'Fixture chat' },
    { id: verificationRun.chatId, projectId, title: 'Verification chat' },
  ],
  runs: [run, verificationRun],
})

const { page, state } = fixture
const toggle = page.getByRole('button', { name: 'Failure log', exact: true })
const log = page.getByRole('region', { name: 'Failure log', exact: true })
const empty = log.getByText('No failures recorded in this tab yet.')
const checkFile = page.getByRole('button', { name: 'Check File', exact: true })
try {
  await fixture.ready()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), run.id),
    'Lemex status stream',
  )
  await toggle.click()
  await empty.waitFor()

  // A rejected request updates an already open log while workspace controls
  // stay usable. Folding repeats keeps a busy service from flooding the list.
  await page.route(`**/api/projects/${projectId}/files`, (route) =>
    route.fulfill({
      status: 503,
      headers: { 'Retry-After': '10' },
      json: { error: 'private-response-detail' },
    }),
  )
  const refresh = page.getByRole('button', {
    name: 'Refresh files',
    exact: true,
  })
  await refresh.click()
  await log.getByText('HTTP 503', { exact: true }).waitFor()
  await refresh.click()
  await log.getByText('2 occurrences', { exact: true }).waitFor()
  await page.unroute(`**/api/projects/${projectId}/files`)

  // A successful HTTP response can carry a failed run or check result.
  run.error = 'private-provider-detail'
  await fixture.emit(run, 'status', { status: 'failed' })
  await log.getByText('Run failed', { exact: true }).waitFor()
  await until(
    () =>
      page.evaluate(
        (id) => window.__chatFixture.connected(id),
        verificationRun.id,
      ),
    'Lemex verification stream',
  )
  await fixture.emit(verificationRun, 'verification', {
    complete: false,
    reason: 'private-verification-detail',
  })
  await fixture.emit(verificationRun, 'status', { status: 'completed' })
  await log.getByText('Final checks did not pass', { exact: true }).waitFor()

  let job
  await page.route(`**/api/projects/${projectId}/check`, (route) => {
    job = {
      id: 'private-job-id',
      projectId,
      checkScope: 'file',
      status: 'running',
      createdAt: new Date().toISOString(),
    }
    return route.fulfill({ json: job })
  })
  await page.route('**/api/jobs/private-job-id', (route) =>
    route.fulfill({ json: job }),
  )
  await checkFile.click()
  await page.getByRole('button', { name: 'Stop check', exact: true }).waitFor()
  job.status = 'failed'
  job.result = { timedOut: true }
  job.log = 'private-compiler-output'
  await log.getByText('Check timed out', { exact: true }).waitFor()
  assert.equal(await log.getByRole('listitem').count(), 4)

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await log.getByRole('button', { name: 'Copy log', exact: true }).click()
  const copy = await page.evaluate(() => navigator.clipboard.readText())
  assert.match(copy, /\d{4}-\d{2}-\d{2}T.* · Lean file check · Check timed out/)
  assert.match(copy, /Lemex run · Run failed/)
  assert.match(copy, /Lemex run · Final checks did not pass/)
  assert.match(copy, /List project files · HTTP 503 \(2 occurrences\)/)
  assert.doesNotMatch(copy, /private-|Main\.lean/)
  assert.doesNotMatch(await log.innerText(), /private-|Main\.lean/)

  await log.getByRole('button', { name: 'Close failure log' }).click()
  await log.waitFor({ state: 'hidden' })
  assert.equal(
    await toggle.evaluate((button) => document.activeElement === button),
    true,
  )
  await toggle.click()
  await log.getByText('Check timed out', { exact: true }).waitFor()

  await page.route('**/api/logout', (route) =>
    route.fulfill({ json: { ok: true } }),
  )
  await page.route('**/api/login', (route) => {
    state.session = {
      ...state.session,
      user: { ...state.session.user, id: 'next-log-user', name: 'Next user' },
    }
    return route.fulfill({ json: { user: state.session.user } })
  })
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByLabel('Access token').fill('fixture-token')
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await toggle.click()
  await empty.waitFor()
  fixture.assertClean()
  console.log(
    'Verified live failure summaries, clipboard output, and account isolation.',
  )
} finally {
  await fixture.browser.close()
}
