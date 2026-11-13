#!/usr/bin/env node
// Exercise tab interactions in real editors using only isolated API/LSP fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { expect } from '@playwright/test'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/file-tabs-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const projectId = 'file-tabs-project'
let fixture
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'tabs-owner', name: 'Tabs fixture' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
    },
    projects: [{ id: projectId, name: 'File tab fixture', status: 'ready' }],
    files: {
      [projectId]: {
        'Main.lean':
          Array.from({ length: 100 }, (_, i) => `-- Main line ${i + 1}`).join(
            '\n',
          ) + '\n',
        'Second.lean': '-- Second source\n',
        'Third.lean': '-- Third source\n',
        'Notes.md': '# Root notes\n',
        'Notes.txt': 'Plain notes\n',
        'Other/Notes.md': '# Other notes\n',
      },
    },
    chats: [{ id: 'tabs-chat', projectId, title: 'Tabs fixture' }],
    runs: [],
  })
  const { page, state, report } = fixture
  let failSaves = false
  state.onSave = ({ save, respond }) =>
    failSaves
      ? respond({ error: 'FIXTURE_CONFLICT: saved source changed.' }, 409)
      : save()
  const tab = (name) => page.getByRole('tab', { name, exact: true })
  const close = (name) => page.getByTitle(`Close ${name}`, { exact: true })
  const source = () => page.locator('.monaco-editor textarea').first()
  async function ready(name) {
    await until(
      async () =>
        (await tab(name).getAttribute('aria-selected')) === 'true' &&
        (await page.locator('.editor-loading').count()) === 0,
      `selected ${name}`,
    )
  }
  async function visit(name) {
    if (await tab(name).count()) await tab(name).click()
    else await page.locator(`.file-item[title="${name}"]`).click()
    await ready(name)
  }
  await fixture.ready()
  await ready('Main.lean')
  await visit('Second.lean')
  await visit('Third.lean')
  await visit('Main.lean')
  await source().focus()
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 55; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  const position = await page
    .locator('.monaco-editor .cursor')
    .first()
    .evaluate((node) => [node.style.left, node.style.top])
  await visit('Second.lean')
  await visit('Main.lean')
  assert.deepEqual(
    await page
      .locator('.monaco-editor .cursor')
      .first()
      .evaluate((node) => [node.style.left, node.style.top]),
    position,
  )
  await until(
    async () =>
      (
        await page
          .frameLocator('.infoview-host iframe')
          .locator('body')
          .innerText()
      ).includes('Main.lean'),
    'goals follow the restored tab',
  )
  report.checks.push(
    'Tabs restore cursor and scroll position when returning to a long source file, and goals follow the active file.',
  )

  failSaves = true
  await source().focus()
  await page.keyboard.insertText(' UNSAVED_TAB_EDIT')
  await visit('Second.lean')
  assert.equal(await tab('Main.lean').getByLabel('Unsaved changes').count(), 1)
  await expect(tab('Main.lean')).toHaveAccessibleDescription(/Unsaved changes/)
  await close('Main.lean').click()
  const dialog = page.getByRole('dialog', {
    name: 'Save your changes?',
    exact: true,
  })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await visit('Main.lean')
  await source().focus()
  await page.keyboard.press('ArrowRight')
  await until(
    async () =>
      (await page.locator('.monaco-editor .view-lines').innerText()).includes(
        'UNSAVED_TAB_EDIT',
      ),
    'draft visible after restoring the tab',
  )
  assert(!state.files[projectId]['Main.lean'].includes('UNSAVED_TAB_EDIT'))
  await source().focus()
  await page.keyboard.press('Control+z')
  await until(
    async () =>
      !(await page.locator('.monaco-editor .view-lines').innerText()).includes(
        'UNSAVED_TAB_EDIT',
      ),
    'undo after tab navigation',
  )
  report.checks.push(
    'Unsaved edits survive tab navigation and a failed close; cancellation keeps the draft, and undo works across tabs.',
  )
  await visit('Second.lean')
  await source().focus()
  await page.keyboard.insertText(' KEEP_SECOND_DRAFT')
  await visit('Main.lean')
  await source().focus()
  await page.keyboard.insertText(' DISCARD_MAIN_ONLY')
  await close('Main.lean').click()
  await dialog.waitFor()
  await dialog
    .getByRole('button', { name: 'Discard this file', exact: true })
    .click()
  await ready('Second.lean')
  assert.equal(await tab('Main.lean').count(), 0)
  assert.equal(
    await tab('Second.lean').getByLabel('Unsaved changes').count(),
    1,
  )
  await until(
    async () =>
      (await page.locator('.monaco-editor .view-lines').innerText()).includes(
        'KEEP_SECOND_DRAFT',
      ),
    'another tab draft survives scoped discard',
  )
  await source().focus()
  await page.keyboard.press('Control+z')
  await until(
    async () =>
      (await tab('Second.lean').getByLabel('Unsaved changes').count()) === 0,
    'second draft undone',
  )
  await visit('Main.lean')
  report.checks.push(
    'Discard this file closes only the selected draft and preserves unsaved edits in other tabs.',
  )
  failSaves = false

  // A different draft's real hash conflict must not force discarding this tab.
  const secondSaved = state.files[projectId]['Second.lean']
  await visit('Second.lean')
  await source().focus()
  await page.keyboard.insertText(' KEEP_CONFLICTING_SECOND')
  state.files[projectId]['Second.lean'] += '-- changed by another editor\n'
  await visit('Main.lean')
  await source().focus()
  await page.keyboard.insertText(' SAVE_MAIN_INDEPENDENTLY')
  await close('Main.lean').click()
  await ready('Third.lean')
  assert.equal(await dialog.count(), 0)
  assert(
    state.files[projectId]['Main.lean'].includes('SAVE_MAIN_INDEPENDENTLY'),
  )
  assert.equal(
    await tab('Second.lean').getByLabel('Unsaved changes').count(),
    1,
  )
  await visit('Second.lean')
  await source().focus()
  await page.keyboard.press('Control+z')
  state.files[projectId]['Second.lean'] = secondSaved
  await visit('Main.lean')

  // A remotely deleted draft is kept locally while another dirty tab closes.
  failSaves = true
  await visit('Second.lean')
  await source().focus()
  await page.keyboard.insertText(' KEEP_DELETED_SECOND')
  delete state.files[projectId]['Second.lean']
  fixture.sendCollaboration({ type: 'files', removedPaths: ['Second.lean'] })
  await expect(tab('Second.lean')).toHaveAccessibleDescription(
    /deleted|unavailable/i,
  )
  failSaves = false
  await visit('Main.lean')
  await source().focus()
  await page.keyboard.insertText(' SAVE_BESIDE_DELETED_DRAFT')
  await close('Main.lean').click()
  await ready('Third.lean')
  assert.equal(await dialog.count(), 0)
  assert(
    state.files[projectId]['Main.lean'].includes('SAVE_BESIDE_DELETED_DRAFT'),
  )
  assert.equal(
    await tab('Second.lean').getByLabel('Unsaved changes').count(),
    1,
  )
  await close('Second.lean').click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Discard this file', exact: true })
    .click()
  assert.equal(await tab('Second.lean').count(), 0)
  await visit('Main.lean')
  report.checks.push(
    'Closing a dirty tab saves only that file; another tab’s conflict or remotely deleted draft stays intact and does not block it.',
  )
  const rejectNext = async (route) =>
    route.fulfill({
      status: 503,
      json: { error: 'Fixture cannot open the next tab.' },
    })
  await page.route(
    `**/api/projects/${projectId}/file?path=Third.lean`,
    rejectNext,
  )
  await close('Main.lean').click()
  await page
    .getByText('Fixture cannot open the next tab.', { exact: true })
    .waitFor()
  assert.equal(await tab('Main.lean').getAttribute('aria-selected'), 'true')
  await page.unroute(
    `**/api/projects/${projectId}/file?path=Third.lean`,
    rejectNext,
  )
  await close('Main.lean').click()
  await ready('Third.lean')
  assert.equal(await tab('Main.lean').count(), 0)
  await visit('Notes.md')
  await page.locator('.folder-toggle[title="Other"]').click()
  await visit('Other/Notes.md')
  assert.equal(
    await tab('Notes.md').locator('.file-tab-name').innerText(),
    'Notes.md',
  )
  assert.equal(
    await tab('Other/Notes.md').locator('.file-tab-name').innerText(),
    'Other/Notes.md',
  )
  await tab('Other/Notes.md').focus()
  await page.keyboard.press('Delete')
  await visit('Notes.txt')
  await visit('Third.lean')
  const composer = page.getByLabel('Message Lemex')
  await composer.fill('Preserve this chat draft')

  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height })
    if (width === 390)
      await page
        .getByRole('button', { name: 'Close tools panel', exact: true })
        .click()
    // Narrow screens expose the editor through the existing workspace controls.
    await page.evaluate(() =>
      document
        .querySelector('.file-toolbar')
        ?.scrollIntoView({ block: 'nearest' }),
    )
    await page.locator('.file-toolbar').waitFor({ state: 'visible' })
    const bounds = await page.locator('.file-toolbar').evaluate((node) => {
      const toolbar = node.getBoundingClientRect()
      const tabs = node
        .querySelector('[role="tablist"]')
        .getBoundingClientRect()
      const actions = node
        .querySelector('.file-actions')
        .getBoundingClientRect()
      return {
        width: toolbar.width,
        tabs: tabs.width,
        overlap: tabs.right > actions.left + 1,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    })
    assert(
      bounds.tabs >= 70,
      `Tabs must remain usable at ${width}px: ${JSON.stringify(bounds)}`,
    )
    assert(
      !bounds.overlap && !bounds.overflow,
      `Toolbar must fit at ${width}px: ${JSON.stringify(bounds)}`,
    )
    await page.screenshot({ path: path.join(output, `tabs-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  await until(
    () =>
      page
        .locator('html')
        .getAttribute('data-theme')
        .then((value) => value === 'light'),
    'light tab theme',
  )
  await page.screenshot({ path: path.join(output, 'tabs-light.png') })
  await page
    .locator('.file-toolbar')
    .screenshot({ path: path.join(output, 'tabs-toolbar.png') })
  await page.getByRole('button', { name: 'Lemex', exact: true }).click()
  assert.equal(await composer.inputValue(), 'Preserve this chat draft')
  report.checks.push(
    'Tabs scroll within the existing toolbar at desktop, tablet and phone widths, without overlapping actions or changing the chat draft.',
  )
  for (const name of ['Notes.txt', 'Notes.md', 'Third.lean']) {
    await close(name).click()
    await until(async () => (await tab(name).count()) === 0, `closed ${name}`)
  }
  assert.equal(
    await page
      .getByRole('tablist', { name: 'Open files' })
      .getByRole('tab')
      .count(),
    0,
  )
  await page.locator('.file-item[title="Main.lean"]').click()
  await ready('Main.lean')
  report.checks.push(
    'Closing the last tab leaves an empty editor; reopening from the file tree works.',
  )
  fixture.assertClean()
  report.ok = true
} catch (error) {
  if (fixture) {
    fixture.report.failure = error.stack || String(error)
    await fixture.page.screenshot({ path: path.join(output, 'failure.png') })
  }
  throw error
} finally {
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  JSON.stringify(
    { ok: fixture.report.ok, checks: fixture.report.checks, output },
    null,
    2,
  ),
)
