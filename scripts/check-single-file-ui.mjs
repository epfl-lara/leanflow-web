#!/usr/bin/env node
// Single-file UI checks use mocked APIs and Lean, with no provider calls or user data.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const reportDir = path.resolve('.runtime/single-file-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'single-file-existing'
const f = await chatBrowserFixture({
  launchOptions: { channel: 'chromium' },
  session: {
    user: { id: 'single-file-owner', name: 'Single file fixture' },
    templates: [
      {
        id: 'mathlib',
        name: 'Mathlib',
        ready: true,
        toolchain: 'leanprover/lean4:v4.35.0-rc4',
      },
    ],
    models: [
      {
        id: 'fixture-model',
        name: 'Fixture',
        reasoningEfforts: [{ id: 'high' }],
        defaultReasoningEffort: 'high',
      },
    ],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { available: true },
  },
  projects: [{ id: projectId, name: 'Regular project', status: 'ready' }],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [
    { id: 'single-file-chat', projectId, title: 'Existing chat', runCount: 0 },
  ],
  runs: [],
})
const { page, state, report } = f
const requests = []
let rejectCreate = false
let preparation = 'ready'
const deleted = new Map()
await page.route('**/api/projects/*/trash', async (route) => {
  const id = new URL(route.request().url()).pathname.split('/')[3]
  const project = state.projects.find((item) => item.id === id)
  const receipt = {
    trashId: `trash-${id}`,
    projectId: id,
    projectName: project.name,
    name: project.name,
    workspaceKind: project.kind,
    kind: 'project',
    path: null,
    createdAt: new Date().toISOString(),
  }
  deleted.set(receipt.trashId, { project, receipt })
  state.projects = state.projects.filter((item) => item.id !== id)
  await route.fulfill({ json: receipt })
})
await page.route('**/api/trash/*/restore', async (route) => {
  const id = new URL(route.request().url()).pathname.split('/')[3]
  const entry = deleted.get(id)
  state.projects.push(entry.project)
  deleted.delete(id)
  await route.fulfill({ json: { ...entry.receipt, restored: true } })
})
await page.route('**/api/playground', async (route) =>
  route.fulfill({ json: { state: preparation } }),
)
await page.route('**/api/playground/prepare', async (route) => {
  preparation = 'verifying'
  await route.fulfill({ status: 202, json: { state: preparation } })
  setTimeout(() => {
    preparation = 'ready'
  }, 100)
})
await page.route('**/api/projects/*/rename', async (route) => {
  const id = new URL(route.request().url()).pathname.split('/')[3]
  const project = state.projects.find((item) => item.id === id)
  project.name = route.request().postDataJSON().name
  await route.fulfill({ json: project })
})
const hash = (text) => createHash('sha256').update(text).digest('hex')
await page.route('**/api/projects', async (route) => {
  if (route.request().method() !== 'POST') return route.fallback()
  const input = route.request().postDataJSON()
  requests.push(input)
  if (rejectCreate)
    return route.fulfill({
      status: 503,
      json: {
        error:
          'Mathlib Playground is not prepared on this server. Ask the administrator to prepare Mathlib, then try again.',
      },
    })
  const project = {
    id: `single-${requests.length}`,
    name: input.file?.path || 'Scratch.lean',
    kind: 'single-file',
    protected: false,
    preset: 'mathlib',
    status: 'ready',
    toolchain: state.session.templates[0].toolchain,
  }
  state.projects.push(project)
  state.files[project.id] = {
    'Main.lean':
      input.file?.content || 'import Mathlib\n\n-- Write a proof here.\n',
    'lakefile.toml': 'name = "ProofWorkspace"\n',
    'lean-toolchain': project.toolchain + '\n',
    'lake-manifest.json': '{"version":"1.2.0","packages":[]}\n',
    '.gitignore': '.lake/\n',
  }
  await route.fulfill({ status: 201, json: project })
})
await page.route('**/api/projects/*/file?*', async (route) => {
  if (route.request().method() !== 'PUT') return route.fallback()
  const url = new URL(route.request().url())
  const id = url.pathname.split('/')[3]
  const file = url.searchParams.get('path')
  const input = route.request().postDataJSON()
  assert.equal(input.expectedHash, hash(state.files[id][file]))
  state.files[id][file] = input.content
  await route.fulfill({
    json: {
      content: input.content,
      hash: hash(input.content),
      requiresPreparation: false,
    },
  })
})
await page.route('**/api/projects/*/convert', async (route) => {
  const id = new URL(route.request().url()).pathname.split('/')[3]
  const project = state.projects.find((project) => project.id === id)
  project.kind = 'project'
  await route.fulfill({ json: project })
})

const editorText = async () =>
  (await page.locator('.monaco-editor .view-lines').innerText()).replaceAll(
    '\u00a0',
    ' ',
  )
const newSingle = () =>
  page
    .getByRole('button', { name: 'New playground', exact: true })
    .first()
    .click()
async function edit(marker) {
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(marker)
  await until(
    () => page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
    'unsaved source',
  )
}
async function awaitSingle() {
  await page.getByRole('button', { name: 'Check File', exact: true }).waitFor()
  await until(
    async () => (await editorText()).includes('import Mathlib'),
    'Mathlib single file',
  )
}

try {
  await f.ready()
  state.projects = []
  await page.reload()
  await page
    .getByRole('heading', { name: 'Start with your project.', exact: true })
    .waitFor()
  await newSingle()
  await awaitSingle()
  assert.deepEqual(requests[0], { kind: 'single-file' })
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(
    await page.getByRole('region', { name: 'Files', exact: true }).count(),
    0,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Source control', exact: false })
      .count(),
    0,
  )
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Move playground Scratch.lean to trash',
        exact: true,
      })
      .count(),
    1,
  )
  assert.equal(await page.getByLabel('Message Lemex').isVisible(), true)
  report.checks.push(
    'One-click Mathlib single file opens without a project dialog; file tree and Git are hidden; rename/delete controls and Lemex remain available',
  )
  const playgroundSection = page.locator('details[aria-label="Playgrounds"]')
  await playgroundSection
    .getByRole('button', { name: 'New playground', exact: true })
    .waitFor()
  assert.equal(
    await page
      .locator('.sidebar-projects-section > .single-file-actions')
      .count(),
    0,
  )
  await playgroundSection.locator('summary').click()
  assert.equal(
    await playgroundSection
      .getByRole('button', { name: 'New playground', exact: true })
      .isVisible(),
    false,
  )
  await playgroundSection.locator('summary').click()
  await page.screenshot({
    path: path.join(reportDir, 'playground-section-desktop.png'),
    fullPage: true,
  })
  report.checks.push(
    'Playground creation and file import belong to the collapsible Playgrounds section; the sidebar footer only creates projects',
  )

  const savedId = state.projects[0].id
  await edit('\n-- single file saved marker\n')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await until(
    () =>
      state.files[savedId]['Main.lean'].includes('single file saved marker'),
    'saved single file',
  )
  assert.match(state.files[savedId]['Main.lean'], /single file saved marker/)
  await page.reload()
  await awaitSingle()
  assert.match(await editorText(), /single file saved marker/)
  report.checks.push(
    'Single-file saves use conflict hashes and reopening restores saved contents',
  )

  await edit('\n-- unsaved download marker\n')
  const download = page.waitForEvent('download')
  await page
    .getByRole('button', { name: 'Download .lean', exact: true })
    .click()
  const result = await download
  assert.equal(result.suggestedFilename(), 'Scratch.lean')
  assert.match(
    await fs.readFile(await result.path(), 'utf8'),
    /unsaved download marker/,
  )
  await newSingle()
  await page
    .getByRole('dialog', { name: 'Save your changes?', exact: true })
    .waitFor()
  assert.equal(requests.length, 1)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.match(await editorText(), /unsaved download marker/)
  report.checks.push(
    'Download includes unsaved text; starting another file asks about unsaved edits and cancel preserves them',
  )

  const renameButton = page.getByRole('button', {
    name: 'Rename playground Scratch.lean',
    exact: true,
  })
  const deleteButton = page.getByRole('button', {
    name: 'Move playground Scratch.lean to trash',
    exact: true,
  })
  await page.locator('.project-row').filter({ has: renameButton }).hover()
  const renameBounds = await renameButton.boundingBox()
  const deleteBounds = await deleteButton.boundingBox()
  assert(
    renameBounds.x + renameBounds.width <= deleteBounds.x,
    'Rename and delete controls must not overlap',
  )
  await renameButton.click()
  const renameDialog = page.getByRole('dialog', {
    name: 'Rename playground',
    exact: true,
  })
  await renameDialog.waitFor()
  assert.equal(
    await renameDialog
      .getByLabel('Name', { exact: true })
      .evaluate((input) => input === document.activeElement),
    true,
  )
  await renameDialog.getByLabel('Name', { exact: true }).fill('Natural numbers')
  await page.screenshot({
    path: path.join(reportDir, 'playground-rename-desktop.png'),
    fullPage: true,
  })
  await renameDialog
    .getByRole('button', { name: 'Save name', exact: true })
    .click()
  await renameDialog.waitFor({ state: 'hidden' })
  assert.match(await editorText(), /unsaved download marker/)
  assert.match(
    await page.locator('.workspace-title').innerText(),
    /Natural numbers/,
  )
  const renamedDownload = page.waitForEvent('download')
  await page
    .getByRole('button', { name: 'Download .lean', exact: true })
    .click()
  assert.equal(
    (await renamedDownload).suggestedFilename(),
    'Natural numbers.lean',
  )
  report.checks.push(
    'Desktop rename is distinct from delete, focuses the name, preserves unsaved text, and updates the header and download name',
  )

  const chat = {
    id: 'single-file-preserved-chat',
    projectId: savedId,
    title: 'Scratch discussion',
    runCount: 0,
  }
  state.chats.push(chat)
  await page.getByLabel('Message Lemex').fill('Keep this chat draft')
  await page
    .getByRole('button', { name: 'Convert to project', exact: true })
    .click()
  await page.getByRole('region', { name: 'Files', exact: true }).waitFor()
  await page
    .getByRole('button', { name: 'Source control', exact: false })
    .waitFor()
  assert.match(await editorText(), /unsaved download marker/)
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Keep this chat draft',
  )
  assert.equal(state.projects[0].protected, false)
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Move project Natural numbers to trash',
        exact: true,
      })
      .count(),
    1,
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  report.checks.push(
    'Conversion reveals project controls and preserves unsaved editor text, chat draft, project identity and deletion controls',
  )
  await until(async () => {
    const save = page.getByRole('button', { name: 'Save', exact: true })
    return (await save.count()) === 1 && (await save.isDisabled())
  }, 'conversion file saved before upload')

  const upload = 'import Mathlib\n\nexample (n : ℕ) : n = n := by rfl\n'
  await page
    .getByLabel('Upload a single Lean file', { exact: true })
    .setInputFiles({
      name: 'Uploaded.lean',
      mimeType: 'text/plain',
      buffer: Buffer.from(upload),
    })
  await awaitSingle()
  assert.deepEqual(requests.at(-1), {
    kind: 'single-file',
    file: { path: 'Uploaded.lean', content: upload },
  })
  assert.equal(state.files[state.projects.at(-1).id]['Main.lean'], upload)
  assert.match(state.files[savedId]['Main.lean'], /single file saved marker/)
  report.checks.push(
    'Uploading a UTF-8 .lean file opens an independent Mathlib file and preserves previous work',
  )

  await page.screenshot({
    path: path.join(reportDir, 'single-file-desktop.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'Close tools panel', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Download .lean', exact: true })
    .waitFor()
  const mobileDownload = page.waitForEvent('download')
  await page
    .getByRole('button', { name: 'Download .lean', exact: true })
    .click()
  assert.equal((await mobileDownload).suggestedFilename(), 'Uploaded.lean')
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  )
  await page.screenshot({
    path: path.join(reportDir, 'single-file-mobile.png'),
    fullPage: true,
  })
  await page
    .getByRole('button', { name: 'Open projects and files', exact: true })
    .click()
  assert.equal(
    await page
      .getByRole('button', { name: 'New playground', exact: true })
      .isVisible(),
    true,
  )
  const mobileRename = page.getByRole('button', {
    name: 'Rename playground Uploaded.lean',
    exact: true,
  })
  await page.locator('.project-row').filter({ has: mobileRename }).hover()
  await mobileRename.click()
  await renameDialog.getByLabel('Name', { exact: true }).fill('Mobile proof')
  await page.screenshot({
    path: path.join(reportDir, 'playground-rename-mobile.png'),
    fullPage: true,
  })
  await renameDialog
    .getByRole('button', { name: 'Save name', exact: true })
    .click()
  await renameDialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).click()
  report.checks.push(
    'Mobile rename opens the correct dialog and its controls fit the viewport',
  )
  report.checks.push(
    'Single-file controls fit a narrow viewport and remain accessible from the mobile sidebar',
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await until(async () => {
    const workbench = await page.locator('.workbench').boundingBox()
    return workbench?.width > 500
  }, 'desktop workspace after closing the mobile sidebar overlay')

  const count = requests.length
  await page
    .getByLabel('Upload a single Lean file', { exact: true })
    .setInputFiles({
      name: 'bad.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('bad'),
    })
  await page
    .getByRole('alert')
    .getByText('Choose one .lean file.', { exact: true })
    .waitFor()
  assert.equal(requests.length, count)
  rejectCreate = true
  await newSingle()
  await page
    .getByRole('alert')
    .getByText(/Mathlib Playground is not prepared/)
    .waitFor()
  assert.equal(state.projects.length, 2)
  const retainedDownload = page.waitForEvent('download')
  await page
    .getByRole('button', { name: 'Download .lean', exact: true })
    .click()
  assert.equal(
    await fs.readFile(await (await retainedDownload).path(), 'utf8'),
    upload,
  )
  report.checks.push(
    'Invalid file types and server preparation failures show actionable errors without replacing the open source',
  )

  state.session.templates[0].ready = false
  await page.reload()
  await awaitSingle()
  assert.equal(
    await page
      .getByRole('button', { name: 'New playground', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Open .lean file', exact: true })
      .isDisabled(),
    true,
  )
  report.checks.push(
    'Unavailable Mathlib disables single-file creation without substituting another Lean environment',
  )

  state.session.templates[0].ready = true
  state.session.templates[0].playgroundState = 'failed'
  state.session.templates[0].playgroundReady = false
  preparation = 'failed'
  await page.reload()
  await awaitSingle()
  await edit('\n-- preparation retry keeps edits\n')
  await page.getByLabel('Message Lemex').fill('Keep this retry draft')
  await page
    .getByRole('button', { name: 'Retry Mathlib preparation', exact: true })
    .click()
  await until(
    () =>
      page
        .getByRole('button', { name: 'New playground', exact: true })
        .isEnabled(),
    'background Mathlib retry',
  )
  assert.match(await editorText(), /preparation retry keeps edits/)
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Keep this retry draft',
  )
  report.checks.push(
    'Background Mathlib verification can be retried without reloading the session, editor, or chat draft',
  )

  const trashButton = page.getByRole('button', {
    name: 'Move playground Mobile proof to trash',
    exact: true,
  })
  await page.locator('.project-row').filter({ has: trashButton }).hover()
  await trashButton.click()
  const deleteDialog = page.getByRole('dialog', {
    name: 'Delete playground?',
    exact: true,
  })
  await deleteDialog.waitFor()
  await deleteDialog.getByText(/Save or discard unsaved edits/).waitFor()
  await deleteDialog
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  assert.match(await editorText(), /preparation retry keeps edits/)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await until(async () => {
    const save = page.getByRole('button', { name: 'Save', exact: true })
    return (await save.count()) === 1 && (await save.isDisabled())
  }, 'saved file before deleting playground')
  await page.locator('.project-row').filter({ has: trashButton }).hover()
  await trashButton.click()
  await deleteDialog
    .getByRole('button', { name: 'Move to Trash', exact: true })
    .click()
  await until(() => state.projects.length === 1, 'deleted playground')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await until(() => state.projects.length === 2, 'restored playground')
  assert.equal(
    state.files[state.projects.find((item) => item.name === 'Mobile proof').id][
      'Main.lean'
    ].includes('preparation retry keeps edits'),
    true,
  )
  report.checks.push(
    'Delete targets the private playground, warns about unsaved edits, and Undo restores the saved source',
  )
  const failed = state.projects.find((item) => item.name === 'Mobile proof')
  failed.status = 'error'
  failed.needsPreparation = true
  failed.error = 'Mathlib Playground needs a new check.'
  await page.evaluate(
    (id) => localStorage.setItem('lemex-project', id),
    failed.id,
  )
  await page.reload()
  await page
    .getByRole('button', { name: 'Retry opening', exact: true })
    .waitFor()
  assert.equal(
    await page.getByRole('region', { name: 'Files', exact: true }).count(),
    0,
  )
  assert.equal(await page.locator('.setup-editor-details').count(), 0)
  const fallback = page.getByLabel('Project file content', { exact: true })
  await fallback.waitFor()
  await fallback.fill(
    state.files[failed.id]['Main.lean'] +
      '\n-- editable after opening failed\n',
  )
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await until(
    () =>
      state.files[failed.id]['Main.lean'].includes(
        'editable after opening failed',
      ),
    'failed playground saved source',
  )
  await page
    .getByRole('button', { name: 'Convert to project', exact: true })
    .click()
  await until(() => failed.kind === 'project', 'failed playground conversion')
  await page.getByRole('region', { name: 'Files', exact: true }).waitFor()
  report.checks.push(
    'A failed playground keeps its file editable, offers retry, and exposes setup editing only after conversion',
  )
  f.assertClean()
  report.passed = true
} catch (error) {
  report.failure = error.stack
  await page.screenshot({
    path: path.join(reportDir, 'failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await f.browser.close()
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks }))
