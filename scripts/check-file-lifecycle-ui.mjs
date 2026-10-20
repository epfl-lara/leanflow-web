#!/usr/bin/env node
// Real browser/editor, closed in-memory APIs and Lean transport; no provider.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const directory = new URL('../.runtime/file-lifecycle-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const projectId = 'file-lifecycle-project'
const sources = Object.fromEntries(
  ['Main', 'Other', 'Fresh', 'Last', 'Delayed', 'Fail'].map((name) => [
    `${name}.lean`,
    `-- ${name.toUpperCase()}_SOURCE\nexample : True := by trivial\n`,
  ]),
)
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'file-lifecycle-owner', name: 'Fixture owner', role: 'user' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [
    { id: projectId, name: 'File lifecycle fixture', status: 'ready' },
  ],
  files: { [projectId]: { ...sources } },
  chats: [
    { id: 'lifecycle-chat', projectId, title: 'Keep my draft', runCount: 0 },
  ],
  runs: [],
})
const { page, browser, report, state } = fixture
const editor = () => page.locator('.monaco-editor textarea').first()
const editorText = () =>
  page.locator('.monaco-editor .view-lines').first().innerText()
const fileButton = (name) =>
  page.locator('.file-item').and(page.getByTitle(name, { exact: true }))
const save = () =>
  page
    .locator('.file-actions')
    .getByRole('button', { name: /^Save(?: all.*)?$/ })
const reload = () =>
  page.getByRole('button', { name: 'Reload file', exact: true })
const reloadDialog = () =>
  page.getByRole('dialog', { name: 'Reload saved file', exact: true })
const unsaved = () =>
  page.getByRole('dialog', { name: 'Save your changes?', exact: true })
const composer = page.getByLabel('Message Lemex')
let blockSaves = false,
  holdSave = false,
  releaseSave
state.onSave = async ({ respond, save }) => {
  if (blockSaves)
    return respond({ error: 'FIXTURE_SAVE_CONFLICT: save is paused.' }, 409)
  if (holdSave) {
    holdSave = false
    await new Promise((resolve) => {
      releaseSave = resolve
    })
  }
  return save()
}
let failRead = null,
  holdRead = null,
  releaseRead
await page.route(`**/api/projects/${projectId}/file?*`, async (route) => {
  if (route.request().method() !== 'GET') return route.fallback()
  const filename = new URL(route.request().url()).searchParams.get('path')
  if (filename === failRead)
    return route.fulfill({
      status: 503,
      json: { error: 'FIXTURE_READ_UNAVAILABLE: retry opening the file.' },
    })
  if (filename === holdRead) {
    holdRead = null
    await new Promise((resolve) => {
      releaseRead = resolve
    })
  }
  return route.fallback()
})
async function append(text) {
  await editor().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText(text)
}
async function opened(name, marker) {
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes(name) &&
      (await editorText()).includes(marker),
    `open ${name}`,
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
}
async function open(name, marker) {
  await fileButton(name).click()
  await opened(name, marker)
}
async function askReload() {
  await reload().click()
  await reloadDialog().waitFor()
}
try {
  await fixture.ready()
  blockSaves = true
  holdRead = 'Other.lean'
  await fileButton('Other.lean').click()
  await until(
    () => !!releaseRead,
    'second file open held while editing the first',
  )
  await append('-- KEEP_MAIN_DRAFT\n')
  releaseRead()
  releaseRead = null
  await opened('Other.lean', 'OTHER_SOURCE')
  await append('-- KEEP_OTHER_DRAFT\n')
  await page
    .locator('.autosave-alert')
    .filter({ hasText: 'Autosave paused' })
    .waitFor()
  await open('Main.lean', 'KEEP_MAIN_DRAFT')
  assert.equal(state.files[projectId]['Main.lean'], sources['Main.lean'])
  assert.equal(state.files[projectId]['Other.lean'], sources['Other.lean'])
  report.checks.push(
    'Typing while another file opens retains the previous dirty buffer; switching between dirty buffers after an autosave conflict never overwrites their saved sources.',
  )

  await askReload()
  await reloadDialog()
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  assert((await editorText()).includes('KEEP_MAIN_DRAFT'))
  await askReload()
  await reloadDialog()
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  assert((await editorText()).includes('KEEP_MAIN_DRAFT'))
  await askReload()
  await page.keyboard.press('Escape')
  await reloadDialog().waitFor({ state: 'hidden' })
  assert((await editorText()).includes('KEEP_MAIN_DRAFT'))
  failRead = 'Main.lean'
  await askReload()
  await reloadDialog()
    .getByRole('button', { name: 'Reload this file', exact: true })
    .click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'FIXTURE_READ_UNAVAILABLE' })
    .waitFor()
  assert((await editorText()).includes('KEEP_MAIN_DRAFT'))
  failRead = null
  holdRead = 'Main.lean'
  await askReload()
  await reloadDialog()
    .getByRole('button', { name: 'Reload this file', exact: true })
    .click()
  await until(() => !!releaseRead, 'reload response held')
  assert(
    await reloadDialog()
      .getByRole('button', { name: 'Cancel', exact: true })
      .isDisabled(),
  )
  assert(
    await reloadDialog()
      .getByRole('button', { name: 'Reload this file', exact: true })
      .isDisabled(),
  )
  await page.keyboard.press('Escape')
  assert(await reloadDialog().isVisible())
  releaseRead()
  releaseRead = null
  await reloadDialog().waitFor({ state: 'hidden' })
  await until(
    async () => !(await editorText()).includes('KEEP_MAIN_DRAFT'),
    'only current file reloaded',
  )
  assert.equal(
    await page
      .getByRole('alert')
      .filter({ hasText: 'FIXTURE_READ_UNAVAILABLE' })
      .count(),
    0,
    'Successful reload clears its earlier failure message',
  )
  await open('Other.lean', 'KEEP_OTHER_DRAFT')
  report.checks.push(
    'Reload Cancel, close and Escape preserve drafts; failed reload preserves text; pending reload blocks dismissal; successful reload discards only the current file.',
  )

  await fileButton('Fresh.lean').click()
  await unsaved().waitFor()
  await unsaved().getByRole('button', { name: 'Cancel', exact: true }).click()
  assert((await editorText()).includes('KEEP_OTHER_DRAFT'))
  await fileButton('Fresh.lean').click()
  await unsaved().waitFor()
  await unsaved()
    .getByRole('button', { name: 'Discard edits', exact: true })
    .click()
  await opened('Fresh.lean', 'FRESH_SOURCE')
  await open('Other.lean', 'OTHER_SOURCE')
  assert(!(await editorText()).includes('KEEP_OTHER_DRAFT'))
  assert.equal(state.files[projectId]['Other.lean'], sources['Other.lean'])
  report.checks.push(
    'Failed-save navigation Cancel keeps the current draft; Discard opens the requested file and restores the discarded buffer without a write.',
  )

  await append('-- SAVE_BEFORE_LEAVING\n')
  await fileButton('Last.lean').click()
  await unsaved().waitFor()
  await unsaved()
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click()
  await unsaved()
    .getByRole('alert')
    .filter({ hasText: 'FIXTURE_SAVE_CONFLICT' })
    .waitFor()
  assert((await editorText()).includes('SAVE_BEFORE_LEAVING'))
  blockSaves = false
  holdSave = true
  await unsaved()
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click()
  await until(() => !!releaseSave, 'navigation save response held')
  assert(
    await unsaved()
      .getByRole('button', { name: 'Cancel', exact: true })
      .isDisabled(),
  )
  assert(
    await unsaved()
      .getByRole('button', { name: 'Discard edits', exact: true })
      .isDisabled(),
  )
  await page.keyboard.press('Escape')
  assert(await unsaved().isVisible())
  releaseSave()
  releaseSave = null
  await opened('Last.lean', 'LAST_SOURCE')
  assert(state.files[projectId]['Other.lean'].includes('SAVE_BEFORE_LEAVING'))
  report.checks.push(
    'Save & continue retains the dialog and draft on failure, blocks conflicting actions while saving, and opens the destination only after a successful save.',
  )

  holdRead = 'Delayed.lean'
  await fileButton('Delayed.lean').click()
  await until(() => !!releaseRead, 'open response held')
  assert(await fileButton('Main.lean').isDisabled())
  assert(await reload().isDisabled())
  assert(await save().isDisabled())
  assert((await editorText()).includes('LAST_SOURCE'))
  releaseRead()
  releaseRead = null
  await opened('Delayed.lean', 'DELAYED_SOURCE')
  failRead = 'Fail.lean'
  await fileButton('Fail.lean').click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'FIXTURE_READ_UNAVAILABLE' })
    .waitFor()
  assert((await editorText()).includes('DELAYED_SOURCE'))
  failRead = null
  await open('Fail.lean', 'FAIL_SOURCE')
  report.checks.push(
    'Pending file opens disable competing sidebar/save/reload actions and retain the old view; a failed open preserves it and retry loads the intended file.',
  )

  blockSaves = true
  await append('-- PANEL_DRAFT\n')
  await composer.fill('Keep this unsent question through panel changes.')
  const connections = report.sockets.length
  await page
    .getByRole('button', { name: 'Close tools panel', exact: true })
    .click()
  await page.getByRole('button', { name: 'Lemex', exact: true }).click()
  await composer.waitFor()
  assert.equal(
    await composer.inputValue(),
    'Keep this unsent question through panel changes.',
  )
  assert((await editorText()).includes('PANEL_DRAFT'))
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  assert((await editorText()).includes('PANEL_DRAFT'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'Close tools panel', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Open projects and files', exact: true })
    .click()
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click()
  await page
    .getByRole('button', { name: 'Open projects and files', exact: true })
    .click()
  await fileButton('Main.lean').click()
  await unsaved().waitFor()
  await unsaved().getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click()
  assert((await editorText()).includes('PANEL_DRAFT'))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.getByRole('button', { name: 'Lemex', exact: true }).click()
  await composer.waitFor()
  assert.equal(
    await composer.inputValue(),
    'Keep this unsent question through panel changes.',
  )
  assert.equal(report.sockets.length, connections)
  blockSaves = false
  await editor().focus()
  await page.keyboard.press('ControlOrMeta+s')
  await until(
    () => state.files[projectId]['Fail.lean'].includes('PANEL_DRAFT'),
    'keyboard save after panel reopening',
  )
  report.checks.push(
    'Assistant close/reopen, Goals toggles, mobile sidebar close/reopen and canceled file navigation preserve editor and chat drafts without reconnecting Lean; keyboard Save still works.',
  )

  fixture.assertClean()
  report.passed = true
  report.providerCalls = 0
  await page.screenshot({ path: new URL('final.png', directory).pathname })
  console.log(JSON.stringify({ passed: true, checks: report.checks }, null, 2))
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
  report.pageText = await page
    .locator('body')
    .innerText()
    .catch(() => '')
  await page
    .screenshot({ path: new URL('failure.png', directory).pathname })
    .catch(() => {})
  throw error
} finally {
  releaseSave?.()
  releaseRead?.()
  await fs.writeFile(
    new URL('result.json', directory),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
