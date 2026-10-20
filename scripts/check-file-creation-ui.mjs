#!/usr/bin/env node
// Serve the built client separately; every API and Lean request uses fixtures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/file-creation-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(path.join(root, 'client/dist')))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const projectId = 'file-creation-project'
const projectName = 'Creation fixture'
let fixture
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: projectName, status: 'ready', preset: 'lean' },
    ],
    files: {
      [projectId]: {
        'Main.lean': 'example : True := by trivial\n',
        'Main/Existing.lean': '-- Existing module\n',
        ...Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`Note${i}.md`, '# Note\n']),
        ),
      },
    },
    chats: [{ id: 'creation-chat', projectId, title: 'Fixture chat' }],
    runs: [],
  })
  const { page, state, report } = fixture
  const sources = state.files[projectId]
  const folders = new Set(['Main'])
  const writes = []
  const hash = (content) => createHash('sha256').update(content).digest('hex')
  let failNextFolder = false
  let releaseFolder = null
  let delayNextFolder = false
  let folderListingStatus = 200
  let failNextFileListing = false
  await page.route('**/api/projects/*/files', async (route) => {
    if (!failNextFileListing) return route.fallback()
    failNextFileListing = false
    return route.fulfill({
      status: 503,
      json: { error: 'File list temporarily unavailable.' },
    })
  })
  await page.route('**/api/projects/*/folders', async (route) => {
    const request = route.request()
    if (request.method() === 'GET')
      return route.fulfill({
        status: folderListingStatus,
        json:
          folderListingStatus === 200
            ? [...folders].sort()
            : {
                error:
                  folderListingStatus === 404
                    ? 'API endpoint not found.'
                    : 'Folders temporarily unavailable.',
              },
      })
    assert.equal(request.method(), 'POST')
    const { path: filename } = request.postDataJSON()
    writes.push({ kind: 'folder', path: filename })
    if (delayNextFolder) {
      delayNextFolder = false
      await new Promise((resolve) => {
        releaseFolder = resolve
      })
      releaseFolder = null
    }
    if (failNextFolder) {
      failNextFolder = false
      return route.fulfill({
        status: 409,
        json: {
          error:
            'A file or folder with this name already exists. Choose another name.',
        },
      })
    }
    folders.add(filename)
    return route.fulfill({ status: 201, json: { path: filename } })
  })
  await page.route('**/api/projects/*/file?*', async (route) => {
    const request = route.request()
    if (request.method() !== 'PUT') return route.fallback()
    const filename = new URL(request.url()).searchParams.get('path')
    const body = request.postDataJSON()
    assert.equal(
      body.expectedHash,
      filename in sources ? hash(sources[filename]) : null,
    )
    writes.push({ kind: 'file', path: filename, ...body })
    sources[filename] = body.content
    await route.fulfill({
      json: {
        hash: hash(body.content),
        content: body.content,
        requiresPreparation: false,
      },
    })
  })
  const dialog = (kind) =>
    page.getByRole('dialog', { name: `Create a ${kind}`, exact: true })
  const open = async (kind) => {
    await page.getByRole('button', { name: `New ${kind}`, exact: true }).click()
    await dialog(kind).waitFor()
    assert.equal(
      await dialog(kind).getByLabel('Create in', { exact: true }).inputValue(),
      '',
    )
  }
  const create = async (kind, name, parent = '') => {
    await open(kind)
    await dialog(kind)
      .getByLabel(kind === 'file' ? 'File name' : 'Folder name', {
        exact: true,
      })
      .fill(name)
    await dialog(kind)
      .getByLabel('Create in', { exact: true })
      .selectOption(parent)
    const normalizedName = kind === 'folder' ? name.replace(/\/+$/, '') : name
    assert(
      (await dialog(kind).locator('.entry-path-preview').innerText()).includes(
        `${projectName} / ${parent ? parent + '/' : ''}${normalizedName}`,
      ),
    )
    await dialog(kind)
      .getByRole('button', { name: `Create ${kind}`, exact: true })
      .click()
  }
  const fileButton = (filename) =>
    page.locator('.file-item').and(page.getByTitle(filename, { exact: true }))
  const folderButton = (filename) =>
    page
      .locator('.folder-toggle')
      .and(page.getByTitle(filename, { exact: true }))

  await fixture.ready()
  assert(
    (await page.locator('.project-root-label').innerText()).includes(
      projectName,
    ),
  )
  assert(
    (await page.locator('.project-root-label').innerText()).includes(
      'Project root',
    ),
  )
  const projectBounds = await page.locator('.project-root-label').boundingBox()
  const fileBounds = await fileButton('Main.lean').boundingBox()
  assert(
    projectBounds && fileBounds && fileBounds.x > projectBounds.x,
    'Project contents should be indented beneath the project root',
  )
  for (const kind of ['file', 'folder']) {
    await open(kind)
    assert(
      (await dialog(kind).innerText()).includes(
        'Main is a folder inside it; Main.lean is a separate file.',
      ),
    )
    await dialog(kind)
      .getByRole('button', { name: 'Cancel', exact: true })
      .click()
  }
  assert.equal(writes.length, 0)
  report.checks.push(
    'Separate creation actions explain the project root and Main folder; cancellation creates nothing.',
  )

  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.insertText('\n-- Unsaved fixture edit\n')
  await until(
    () => page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
    'unsaved edit',
  )
  delayNextFolder = true
  await create('folder', 'Proofs')
  await until(() => !!releaseFolder, 'pending folder creation')
  assert(
    await dialog('folder')
      .getByRole('button', { name: 'Create folder', exact: true })
      .isDisabled(),
  )
  assert(
    await dialog('folder')
      .getByRole('button', { name: 'Cancel', exact: true })
      .isDisabled(),
  )
  await page.keyboard.press('Escape')
  assert(await dialog('folder').isVisible())
  releaseFolder()
  await dialog('folder').waitFor({ state: 'hidden' })
  assert(await folderButton('Proofs').isVisible())
  assert.equal(
    await folderButton('Proofs').getAttribute('aria-expanded'),
    'true',
  )
  assert.equal(await page.getByText('Empty folder', { exact: true }).count(), 1)
  assert(
    writes
      .filter((entry) => entry.kind === 'file')
      .every((entry) => entry.path === 'Main.lean'),
    'Folder creation must not create or alter another file',
  )
  assert(
    (await page.locator('.monaco-editor .view-lines').innerText())
      .replaceAll('\u00a0', ' ')
      .includes('Unsaved fixture edit'),
    'The editor draft survives folder creation, whether pending or autosaved',
  )
  assert(
    (await page
      .getByRole('button', { name: 'Save', exact: true })
      .isEnabled()) || sources['Main.lean'].includes('Unsaved fixture edit'),
  )
  report.checks.push(
    'Creating an empty folder shows and expands it, preserves unsaved edits, and guards repeated submissions while pending.',
  )

  await create('folder', 'Nested', 'Proofs')
  await dialog('folder').waitFor({ state: 'hidden' })
  assert(await folderButton('Proofs/Nested').isVisible())
  await create('folder', 'Proofs')
  await dialog('folder').getByRole('alert').waitFor()
  assert.equal(writes.filter((entry) => entry.path === 'Proofs').length, 1)
  await dialog('folder')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  const creationWrites = () =>
    writes.filter(
      (entry) => entry.kind === 'folder' || entry.path !== 'Main.lean',
    )
  const writesBeforeSetupNames = creationWrites().length
  for (const kind of ['folder', 'file']) {
    await open(kind)
    await dialog(kind)
      .getByLabel(kind === 'folder' ? 'Folder name' : 'File name', {
        exact: true,
      })
      .fill('lakefile.lean/Sub')
    await dialog(kind)
      .getByRole('button', { name: `Create ${kind}`, exact: true })
      .click()
    assert(
      (await dialog(kind).getByRole('alert').innerText()).includes(
        'setup files cannot be used as folders',
      ),
    )
    await dialog(kind)
      .getByRole('button', { name: 'Cancel', exact: true })
      .click()
  }
  assert.equal(creationWrites().length, writesBeforeSetupNames)
  failNextFolder = true
  await create('folder', 'Race')
  await dialog('folder').getByRole('alert').waitFor()
  await dialog('folder')
    .getByLabel('Folder name', { exact: true })
    .fill('Retry')
  await dialog('folder')
    .getByRole('button', { name: 'Create folder', exact: true })
    .click()
  await dialog('folder').waitFor({ state: 'hidden' })
  assert(await folderButton('Retry').isVisible())
  report.checks.push(
    'Nested locations work; duplicate names and server conflicts preserve the dialog and allow retry.',
  )

  await page.getByLabel('Filter files', { exact: true }).fill('Proofs/Nested')
  assert(await folderButton('Proofs/Nested').isVisible())
  await create('file', 'Extra.lean', 'Proofs/Nested')
  await dialog('file').waitFor({ state: 'hidden' })
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes(
        'Proofs/Nested/Extra.lean',
      ),
    'new file opened',
  )
  assert(await fileButton('Proofs/Nested/Extra.lean').isVisible())
  assert.equal(
    await page.getByLabel('Filter files', { exact: true }).inputValue(),
    '',
  )
  assert(sources['Main.lean'].includes('-- Unsaved fixture edit'))
  assert.equal(sources['Proofs/Nested/Extra.lean'], '')
  assert.deepEqual(
    writes.filter((entry) => entry.kind === 'file').map((entry) => entry.path),
    ['Main.lean', 'Proofs/Nested/Extra.lean'],
  )
  await create('file', 'notes.md')
  await dialog('file').waitFor({ state: 'hidden' })
  assert.equal(sources['notes.md'], '')
  await create('file', 'Proofs')
  await dialog('file').getByRole('alert').waitFor()
  await dialog('file')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  report.checks.push(
    'New files save existing edits with the expected hash, open at the selected location, support root files, and reject folder collisions.',
  )

  await page.reload()
  await folderButton('Retry').waitFor()
  await folderButton('Retry').click()
  assert(await page.getByText('Empty folder', { exact: true }).isVisible())
  fixture.assertClean()
  await page.screenshot({ path: path.join(output, 'project-files.png') })
  await open('file')
  await dialog('file')
    .getByLabel('Create in', { exact: true })
    .selectOption('Main')
  await dialog('file')
    .getByLabel('File name', { exact: true })
    .fill('Extra.lean')
  await page.screenshot({ path: path.join(output, 'create-file.png') })
  report.checks.push(
    'Empty folders remain available after refresh and in the location picker.',
  )
  await dialog('file')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  for (const status of [404, 503]) {
    folderListingStatus = status
    await page.evaluate(
      (id) => localStorage.setItem(`lemex-file-${id}`, 'Main.lean'),
      projectId,
    )
    await fixture.ready()
    await until(
      () =>
        page
          .getByRole('button', { name: 'New folder', exact: true })
          .isDisabled(),
      `folder action unavailable after ${status}`,
    )
    assert(await fileButton('Main.lean').isVisible())
    assert(await folderButton('Main').isVisible())
    assert((await page.locator('.file-tab').innerText()).includes('Main.lean'))
    assert.equal(await page.locator('.workspace-alert').count(), 0)
    await create('file', `Available${status}.md`)
    await dialog('file').waitFor({ state: 'hidden' })
    assert.equal(sources[`Available${status}.md`], '')
    assert(await fileButton(`Available${status}.md`).isVisible())
    assert(
      await page
        .getByRole('button', { name: 'New folder', exact: true })
        .isDisabled(),
    )
  }
  folderListingStatus = 200
  await page.getByRole('button', { name: 'Refresh files', exact: true }).click()
  await until(
    () =>
      page.getByRole('button', { name: 'New folder', exact: true }).isEnabled(),
    'folders recovered',
  )
  assert(await folderButton('Retry').isVisible())
  report.checks.push(
    'Missing and temporarily failing folder endpoints preserve file listing, opening and creation; refresh restores folder support.',
  )
  await create('folder', 'Trailing/')
  await dialog('folder').waitFor({ state: 'hidden' })
  assert(await folderButton('Trailing').isVisible())
  assert(folders.has('Trailing'))
  const writesBeforeAbsolute = writes.length
  await open('folder')
  await dialog('folder')
    .getByLabel('Folder name', { exact: true })
    .fill('/Outside')
  await dialog('folder')
    .getByRole('button', { name: 'Create folder', exact: true })
    .click()
  assert(
    (await dialog('folder').getByRole('alert').innerText()).includes(
      'without a leading /',
    ),
  )
  assert.equal(writes.length, writesBeforeAbsolute)
  await dialog('folder')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  for (const kind of ['folder', 'file']) {
    const name =
      kind === 'file' ? 'CreatedDespiteRefresh.md' : 'CreatedDespiteRefresh'
    failNextFileListing = true
    await create(kind, name)
    await dialog(kind).waitFor({ state: 'hidden' })
    await until(
      async () =>
        (await page.locator('.workspace-alert').innerText()).includes(
          `Created ${kind} ${name}`,
        ),
      'creation acknowledged after refresh failure',
    )
    assert(
      kind === 'folder'
        ? await folderButton(name).isVisible()
        : await fileButton(name).isVisible(),
    )
    assert.equal(
      writes.filter((entry) => entry.kind === kind && entry.path === name)
        .length,
      1,
    )
    await page
      .getByRole('button', { name: 'Refresh files', exact: true })
      .click()
  }
  report.checks.push(
    'Trailing folder slashes are accepted, absolute paths explain how to fix the name, and successful creation remains acknowledged when refresh fails.',
  )
  await page.evaluate(() => localStorage.setItem('lemex-layout-sidebar', '180'))
  await page.reload()
  await until(
    () =>
      page.getByRole('button', { name: 'New folder', exact: true }).isEnabled(),
    'narrow sidebar loaded',
  )
  const sidebar = await page.locator('.sidebar').boundingBox()
  assert(sidebar)
  for (const name of ['New file', 'New folder', 'Refresh files']) {
    const bounds = await page
      .getByRole('button', { name, exact: true })
      .boundingBox()
    assert(
      bounds && bounds.x + bounds.width <= sidebar.x + sidebar.width,
      `${name} should remain inside the narrow sidebar`,
    )
  }
  report.checks.push(
    'Creation and refresh controls remain accessible at the minimum sidebar width.',
  )
  fixture.assertClean()
  report.ok = true
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log('File and folder creation browser checks passed.')
} catch (error) {
  if (fixture) {
    fixture.report.ok = false
    fixture.report.failure = error.stack || error.message
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(fixture.report, null, 2),
    )
    await fixture.page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {})
  }
  throw error
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
