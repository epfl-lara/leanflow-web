#!/usr/bin/env node
// Closed provider/API fixture: a startup burst recovers without losing a draft.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/model-discovery-recovery-ui')
await fs.mkdir(output, { recursive: true })
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'discovery-user', name: 'Discovery fixture' },
    templates: [],
    models: [],
    defaultModel: null,
    runtime: { ready: true },
    lemex: {
      configured: true,
      modelError: 'Model discovery is busy.',
      modelErrorRetryable: true,
    },
  },
  projects: [
    { id: 'discovery-project', name: 'Discovery project', status: 'ready' },
    { id: 'second-project', name: 'Second project', status: 'ready' },
  ],
  files: {
    'discovery-project': { 'Main.lean': 'example : True := by trivial\n' },
    'second-project': { 'Main.lean': 'example : 1 = 1 := rfl\n' },
  },
  chats: [
    {
      id: 'discovery-chat',
      projectId: 'discovery-project',
      title: 'Discovery chat',
    },
  ],
  runs: [],
})
const { page, browser, report } = fixture
let calls = 0
let complete
const projectId = 'discovery-project'
const checkLog = 'Main.lean:5: unsolved goals'
await page.route(`**/api/projects/${projectId}/check`, (route) =>
  route.fulfill({
    status: 202,
    json: { id: 'proof-check', status: 'failed', log: checkLog },
  }),
)
await page.route('**/api/models', async (route) => {
  calls++
  if (calls === 1)
    return route.fulfill({
      status: 429,
      json: { error: 'Model discovery is busy.' },
    })
  assert.equal(
    calls,
    2,
    'The bounded retry must not overlap discovery requests',
  )
  await new Promise((resolve) => {
    complete = resolve
  })
  return route.fulfill({
    json: {
      models: [
        {
          id: 'recovered-model',
          name: 'Recovered model',
          reasoningEfforts: [{ id: 'high' }],
          defaultReasoningEffort: 'high',
        },
      ],
      defaultModel: 'recovered-model',
      savedModels: ['recovered-model'],
    },
  })
})
try {
  await fixture.ready()
  await page
    .getByRole('alert')
    .filter({
      hasText:
        'Models are loading while the server is busy. Retrying automatically.',
    })
    .waitFor()
  const composer = page.getByLabel('Message Lemex')
  const draft = 'Keep this draft while available models load.'
  await composer.fill(draft)
  assert.equal(
    await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(),
    true,
  )
  await until(() => calls >= 1, 'first delayed model retry')
  assert.equal(await composer.inputValue(), draft)
  await until(() => !!complete, 'backed off model retry')
  assert.equal(calls, 2)
  assert.equal(await composer.inputValue(), draft)
  await page.getByRole('button', { name: 'Check Project', exact: true }).click()
  const output = page
    .locator('.build-output')
    .getByText(checkLog, { exact: true })
  await output.waitFor()
  const projectLists = () =>
    report.requests.filter((request) => request.endpoint === '/api/projects')
      .length
  const listsBefore = projectLists()
  complete()
  await until(
    async () =>
      page.getByRole('button', { name: 'Send', exact: true }).isEnabled(),
    'model discovery recovers Send',
  )
  assert.equal(await composer.inputValue(), draft)
  assert(
    await output.isVisible(),
    'Discovering models must keep the latest Lean check output visible',
  )
  assert.equal(
    projectLists(),
    listsBefore,
    'Discovering models must not reload the project list',
  )
  await page.locator('.chat-options').evaluate((element) => {
    element.open = true
  })
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Model', exact: true })
      .inputValue(),
    'recovered-model',
  )
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Reasoning effort', exact: true })
      .inputValue(),
    'high',
  )
  assert.equal(calls, 2)
  const selectProject = (name) =>
    page
      .locator('.project-item')
      .and(page.getByTitle(name, { exact: true }))
      .click()
  await selectProject('Second project')
  await page
    .getByLabel('Open files')
    .getByRole('tab', { name: 'Main.lean' })
    .waitFor()
  assert.equal(await page.locator('.build-output').count(), 0)
  await selectProject('Discovery project')
  const check = page.getByRole('button', { name: 'Check Project', exact: true })
  await check.click()
  await output.waitFor()

  await page.route('**/api/logout', (route) =>
    route.fulfill({ json: { ok: true } }),
  )
  await page.route('**/api/login', (route) => {
    const user = { id: 'second-participant', name: 'Second participant' }
    fixture.state.session = {
      ...fixture.state.session,
      user,
      lemex: { configured: true },
      models: [{ id: 'recovered-model', name: 'Recovered model' }],
    }
    return route.fulfill({ json: { user } })
  })
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByLabel('Access token', { exact: true }).fill('fixture-only')
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await check.waitFor()
  assert.equal(
    await page.locator('.user-name').innerText(),
    'Second participant',
  )
  assert.equal(await page.locator('.build-output').count(), 0)
  fixture.assertClean()
  report.checks.push(
    'Temporary startup congestion retries with backoff, preserves the draft, and restores model access without changing its advertised reasoning level.',
    'Model discovery preserves the current Lean check result without reloading the participant’s project list.',
    'Switching projects and signing into another account clear the previous Lean check output.',
  )
  report.passed = true
  console.log(JSON.stringify({ passed: true, checks: report.checks }))
} catch (error) {
  report.error = error.stack || String(error)
  throw error
} finally {
  complete?.()
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
