#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const id = 'setup-recovery-fixture'
const f = await chatBrowserFixture({
  session: {
    user: { id: 'fixture', name: 'Setup fixture' },
    templates: [],
    models: [{ id: 'fixture', name: 'Fixture' }],
    defaultModel: 'fixture',
    runtime: { ready: true },
  },
  projects: [{ id, name: 'Setup recovery', status: 'ready' }],
  files: {
    [id]: {
      'Main.lean': 'example : True := by trivial\n',
      'lakefile.toml': 'name = "fixture"\n',
    },
  },
  chats: [
    { id: 'setup-chat', projectId: id, title: 'Setup fixture', runCount: 0 },
  ],
  runs: [],
})
const initiallyFailed = process.env.SETUP_INITIAL_FAILURE === '1'
if (initiallyFailed)
  Object.assign(f.state.projects[0], {
    status: 'error',
    needsPreparation: true,
    error: 'Dependency setup failed',
    log: 'Fixture dependency compiler failed',
  })
let saved = 0,
  retries = 0
const report = { providerCalls: 0, passed: false }
const reportDir = path.resolve('.runtime/setup-recovery-ui')
await fs.mkdir(reportDir, { recursive: true })
await f.page.route(
  `**/api/projects/${id}/file?path=lakefile.toml`,
  async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    const content = route.request().postDataJSON().content
    saved++
    f.state.files[id]['lakefile.toml'] = content
    Object.assign(f.state.projects[0], {
      status: 'error',
      needsPreparation: true,
      error:
        'Project configuration changed. Retry setup to prepare and test the updated environment.',
    })
    await route.fulfill({
      json: { content, hash: 'saved-fixture', requiresPreparation: true },
    })
  },
)
await f.page.route(`**/api/projects/${id}/prepare`, async (route) => {
  retries++
  Object.assign(f.state.projects[0], {
    status: 'ready',
    needsPreparation: false,
    error: undefined,
  })
  await route.fulfill({ json: f.state.projects[0] })
})
try {
  if (initiallyFailed)
    await f.page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090')
  else await f.ready()
  await f.page
    .getByRole('button', { name: 'lakefile.toml', exact: true })
    .click()
  await until(
    async () =>
      initiallyFailed
        ? (
            await f.page
              .getByLabel('Project file content', { exact: true })
              .inputValue()
          ).includes('name')
        : (
            await f.page.locator('.monaco-editor .view-lines').innerText()
          ).includes('name'),
    'configuration editor loaded',
  )
  if (!initiallyFailed) {
    await f.page.locator('.monaco-editor textarea').focus()
    await f.page.keyboard.press('Control+End')
    await f.page.keyboard.insertText('\n# Updated setup\n')
  } else {
    await f.page
      .getByLabel('Project file content', { exact: true })
      .fill('name = \"fixture\"\n# Updated setup\n')
    assert(
      await f.page
        .getByText('Fixture dependency compiler failed', { exact: true })
        .isVisible(),
    )
  }
  const save = f.page.getByRole('button', { name: 'Save', exact: true })
  await until(() => save.isEnabled(), 'dirty configuration')
  await save.click()
  await f.page
    .getByRole('button', { name: 'Retry setup', exact: true })
    .waitFor()
  assert.equal(saved, 1)
  assert(
    await f.page
      .getByRole('button', { name: /^Check (?:Lean|Project)$/, exact: true })
      .isDisabled(),
  )
  const setupEditor = f.page.getByLabel('Project file content', { exact: true })
  await setupEditor.fill('name = "fixture"\n')
  await f.page.getByRole('button', { name: 'Save', exact: true }).click()
  await until(async () => saved === 2, 'corrected configuration saved')
  await f.page.screenshot({ path: path.join(reportDir, 'retry.png') })
  await f.page.getByRole('button', { name: 'Retry setup', exact: true }).click()
  await until(
    async () =>
      retries === 1 &&
      (await f.page
        .getByRole('button', { name: /^Check (?:Lean|Project)$/, exact: true })
        .isVisible()),
    'prepared editor after retry',
  )
  assert.equal(f.state.files[id]['lakefile.toml'], 'name = "fixture"\n')
  f.assertClean()
  report.passed = true
} finally {
  await f.browser.close()
  await fs.writeFile(
    path.join(reportDir, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report))
}
