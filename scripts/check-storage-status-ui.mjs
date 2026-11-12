#!/usr/bin/env node
// Closed browser fixture: storage pressure preserves editing, private drafts,
// cancellation, and Viewer access. No providers or production accounts are used.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/storage-status-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(
  express.static(process.env.STUDIO_TEST_DIST || path.resolve('client/dist')),
)
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const base = `http://127.0.0.1:${server.address().port}`
const project = {
  id: 'storage-project',
  name: 'Storage fixture',
  status: 'ready',
  accessRole: 'editor',
}
const source = 'example : True := by trivial\n'
const marker = '-- PRIVATE_STORAGE_DRAFT\n'
const warning = {
  state: 'warning',
  freeBytes: 700,
  reservedBytes: 0,
  availableBytes: 600,
  minimumFreeBytes: 100,
  warningFreeBytes: 800,
  message:
    'Project storage is running low. Ask the server administrator to add space before starting large imports or project jobs.',
}
const blocked = {
  ...warning,
  state: 'blocked',
  freeBytes: 250,
  availableBytes: 150,
  message:
    'Project storage is running low. Ask the server administrator to add space, then retry. Existing work is kept; downloads and recovery remain available.',
}
const ready = {
  ...warning,
  state: 'ready',
  freeBytes: 2000,
  availableBytes: 1900,
  message: null,
}
const checks = []
let fixture, viewer
try {
  const running = {
    id: 'storage-existing-agent',
    kind: 'agent',
    projectId: project.id,
    chatId: 'storage-chat',
    status: 'running',
    mode: 'prove',
    model: 'fixture',
    prompt: 'Existing private work',
    message: '',
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: {
        id: 'storage-editor',
        name: 'Storage Editor',
        role: 'user',
        profileComplete: true,
      },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
      storage: warning,
      lemex: { configured: true },
    },
    projects: [project],
    files: { [project.id]: { 'Main.lean': source } },
    chats: [
      {
        id: 'storage-chat',
        projectId: project.id,
        title: 'Storage private chat',
      },
    ],
    runs: [running],
  })
  const { page, state } = fixture
  let response = 'fail'
  let requests = 0,
    stops = 0
  await page.route('**/api/storage', (route) => {
    assert.equal(route.request().headers()['x-leanflow-user'], 'storage-editor')
    requests++
    return route.fulfill(
      response === 'fail'
        ? {
            status: 503,
            json: { error: 'Fixture storage status is unavailable.' },
          }
        : { json: response === 'blocked' ? blocked : ready },
    )
  })
  state.onSave = ({ respond }) =>
    respond({ error: 'Fixture keeps the private editor draft.' }, 409)
  state.onStop = ({ run, respond }) => {
    stops++
    run.status = 'cancelled'
    return respond(run)
  }
  await fixture.ready()
  const panel = page.getByRole('status', {
    name: 'Project storage status',
    exact: true,
  })
  await panel.waitFor()
  await page
    .getByLabel('Message Lemex')
    .fill('Keep my private conversation draft.')
  const editor = page.locator('.monaco-editor textarea').first()
  await editor.focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText(marker)
  const assertDraft = async () => {
    assert.equal(
      await page.getByLabel('Message Lemex').inputValue(),
      'Keep my private conversation draft.',
    )
    assert.equal(
      await page.evaluate(() => localStorage.getItem('lemex-project')),
      project.id,
    )
    assert(
      (await page.locator('.monaco-editor .view-lines').first().innerText())
        .replaceAll('\u00a0', ' ')
        .includes(marker.trim()),
    )
    assert.equal(state.files[project.id]['Main.lean'], source)
  }
  await assertDraft()
  await panel
    .getByRole('button', { name: 'Refresh storage status', exact: true })
    .click()
  await panel
    .getByText('Storage status could not be refreshed.', { exact: false })
    .waitFor()
  await assertDraft()
  response = 'blocked'
  await panel
    .getByRole('button', { name: 'Refresh storage status', exact: true })
    .click()
  await panel
    .getByText('downloads and recovery remain available', { exact: false })
    .waitFor()
  await assertDraft()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await until(
    () => stops === 1,
    'existing work remains cancellable under storage pressure',
  )
  await assertDraft()
  checks.push(
    'Warnings, failed refresh and blocked admission preserve selected project, private editor/chat drafts, and Stop.',
  )
  state.onSave = ({ save }) => save()
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await until(
    () => state.files[project.id]['Main.lean'] === '',
    'accepted empty source saves while new allocations are blocked',
  )
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Keep my private conversation draft.',
  )
  response = 'ready'
  await panel
    .getByRole('button', { name: 'Refresh storage status', exact: true })
    .click()
  await panel.waitFor({ state: 'hidden' })
  assert.equal(
    await page.evaluate(() => localStorage.getItem('lemex-project')),
    project.id,
  )
  assert.equal(state.files[project.id]['Main.lean'], '')
  assert.ok(requests >= 3)
  fixture.assertClean()
  checks.push(
    'Existing source can be saved empty under pressure; new space clears the warning without reloading or replacing drafts.',
  )
  await page.screenshot({ path: path.join(output, 'storage-recovered.png') })
  await fixture.browser.close()
  fixture = undefined

  viewer = await chatBrowserFixture({
    base,
    session: {
      user: {
        id: 'storage-viewer',
        name: 'Storage Viewer',
        role: 'user',
        profileComplete: true,
      },
      templates: [],
      models: [],
      runtime: { ready: true },
      storage: blocked,
      lemex: { configured: false },
    },
    projects: [{ ...project, accessRole: 'viewer' }],
    files: { [project.id]: { 'Main.lean': source } },
    chats: [
      {
        id: 'viewer-storage-chat',
        projectId: project.id,
        title: 'Viewer storage chat',
      },
    ],
    runs: [],
  })
  let viewerChecks = 0
  let viewerResponse = blocked
  await viewer.page.route('**/api/storage', (route) => {
    assert.equal(route.request().headers()['x-leanflow-user'], 'storage-viewer')
    viewerChecks++
    return route.fulfill({ json: viewerResponse })
  })
  await viewer.ready()
  const viewerPanel = viewer.page.getByRole('status', {
    name: 'Project storage status',
    exact: true,
  })
  await viewerPanel.waitFor()
  viewerResponse = ready
  await viewerPanel
    .getByRole('button', { name: 'Refresh storage status', exact: true })
    .click()
  await viewerPanel.waitFor({ state: 'hidden' })
  assert.ok(viewerChecks >= 1)
  viewer.assertClean()
  checks.push(
    'A Viewer without a provider key can read shared files and refresh storage status.',
  )
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ passed: true, checks }, null, 2) + '\n',
  )
  console.log(checks.map((check) => `PASS ${check}`).join('\n'))
} finally {
  await fixture?.browser.close()
  await viewer?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
