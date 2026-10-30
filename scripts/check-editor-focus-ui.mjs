#!/usr/bin/env node
// Delay the real editor's font dependency while all API/Lean traffic is mocked.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/editor-focus-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const projectId = 'editor-focus-project'
const source = 'example : True := by trivial\n'
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'editor-focus-owner', name: 'Focus fixture', role: 'user' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    savedModels: ['fixture-model'],
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [{ id: projectId, name: 'Editor focus fixture', status: 'ready' }],
  files: {
    [projectId]: {
      'Main.lean': source,
      'Other.lean': '-- Other file\n' + source,
    },
  },
  chats: [
    { id: 'editor-focus-chat', projectId, title: 'Editor focus', runCount: 0 },
  ],
  runs: [],
})
const { page, browser, report } = fixture
const composer = page.getByLabel('Message Lemex')
let held = []
let hold = true
await page.route('**/assets/JuliaMono-Regular-*.ttf', async (route) => {
  if (hold)
    await new Promise((resolve) => {
      held.push(resolve)
    })
  await route.continue()
})
async function releaseEditor() {
  hold = false
  for (const release of held) release()
  held = []
}
async function loadUntilEditorWaits() {
  hold = true
  held = []
  await page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090', {
    waitUntil: 'domcontentloaded',
  })
  await composer.waitFor()
  await until(() => held.length > 0, 'editor font held before initialization')
}
async function editorReady() {
  await page.locator('.monaco-editor').waitFor()
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await until(
    async () =>
      (await page.locator('.statusbar').innerText()).includes('Lean connected'),
    'mock editor connected',
  )
}
try {
  await loadUntilEditorWaits()
  await composer.fill('Keep this question in the assistant')
  await releaseEditor()
  await editorReady()
  assert.equal(
    await composer.evaluate((element) => element === document.activeElement),
    true,
  )
  await page.keyboard.type(' while Lean finishes loading.')
  assert.equal(
    await composer.inputValue(),
    'Keep this question in the assistant while Lean finishes loading.',
  )
  assert.equal(
    await page
      .locator('.statusbar')
      .innerText()
      .then((text) => text.includes('Unsaved changes')),
    false,
  )
  report.checks.push(
    'Delayed editor initialization preserves composer focus and subsequent typing; source files remain unchanged',
  )

  await loadUntilEditorWaits()
  await page.locator('.chat-options').evaluate((element) => {
    element.open = true
  })
  await page.getByRole('button', { name: 'Add models…', exact: true }).click()
  const library = page.getByRole('dialog', { name: 'Your models', exact: true })
  const search = library.getByLabel('Search all available models')
  await search.focus()
  await releaseEditor()
  await editorReady()
  assert.equal(
    await search.evaluate((element) => element === document.activeElement),
    true,
  )
  await page.keyboard.type('Fixture')
  assert.equal(await search.inputValue(), 'Fixture')
  await page.screenshot({
    path: new URL('modal-focus-preserved.png', directory).pathname,
  })
  await library
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  report.checks.push(
    'Delayed editor initialization preserves modal search focus and keyboard input',
  )

  await page.locator('.file-item[title="Other.lean"]').click()
  await until(
    () =>
      page
        .locator('.file-item[title="Other.lean"]')
        .getAttribute('aria-current')
        .then((value) => value === 'true'),
    'explicit file navigation',
  )
  await editorReady()
  await until(
    () =>
      page
        .locator('.monaco-editor')
        .evaluate((element) => element.contains(document.activeElement)),
    'explicit file navigation focuses editor',
  )
  report.checks.push(
    'Explicit file navigation still focuses the selected editor',
  )
  fixture.assertClean()
  report.inferenceRequests = 0
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
  await page
    .screenshot({ path: new URL('failure.png', directory).pathname })
    .catch(() => {})
} finally {
  await releaseEditor()
  await fs.writeFile(
    new URL('report.json', directory),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks,
      error: report.error,
    }),
  )
  await browser.close()
}
