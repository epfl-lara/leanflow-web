#!/usr/bin/env node
// Closed APIs and Lean fixture: recovery preserves drafts and never starts work.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/project-file-recovery-ui')
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
  id: 'file-recovery-project',
  name: 'File recovery fixture',
  status: 'ready',
  accessRole: 'admin',
}
const healthy = {
  id: 'file-recovery-healthy',
  name: 'Healthy fixture',
  status: 'ready',
  accessRole: 'admin',
}
const paused = {
  ...project,
  status: 'error',
  needsPreparation: false,
  fileRecoveryRequired: true,
  error: 'Project files need recovery.',
}
const source = 'example : True := by trivial\n'
const marker = '-- PRIVATE_RECOVERY_DRAFT\n'
const userId = 'file-recovery-admin'
const checks = []
let fixture, viewer, releaseSuccess
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: {
        id: userId,
        name: 'Recovery Admin',
        role: 'user',
        profileComplete: true,
      },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [project, healthy],
    files: {
      [project.id]: { 'Main.lean': source },
      [healthy.id]: { 'Main.lean': '-- healthy source\n' },
    },
    chats: [
      {
        id: 'recovery-chat',
        projectId: project.id,
        title: 'Private recovery chat',
      },
    ],
    runs: [],
  })
  const { page, state } = fixture
  let collaboration
  await page.routeWebSocket('**/websocket/collaboration/**', (socket) => {
    collaboration = socket
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'open')
        socket.send(
          JSON.stringify({
            type: 'error',
            path: message.path,
            status: 429,
            message: 'Fixture uses ordinary version-checked saving.',
          }),
        )
    })
  })
  state.onSave = ({ respond }) =>
    respond({ error: 'Fixture keeps this local draft for recovery.' }, 409)
  const downloads = []
  await page.route(`**/api/projects/${project.id}/download`, (route) => {
    assert.equal(route.request().headers()['x-leanflow-user'], userId)
    downloads.push(project.id)
    return route.fulfill({
      status: 200,
      contentType: 'application/zip',
      headers: { 'Content-Disposition': 'attachment; filename="recovery.zip"' },
      body: 'AVAILABLE_SAVED_PROJECT_FILES',
    })
  })
  let attempts = 0
  await page.route(
    `**/api/projects/${project.id}/file-recovery/retry`,
    async (route) => {
      assert.equal(route.request().method(), 'POST')
      assert.deepEqual(route.request().postDataJSON(), {})
      assert.equal(route.request().headers()['x-leanflow-user'], userId)
      attempts++
      if (attempts === 1)
        return route.fulfill({
          status: 409,
          json: {
            error:
              'Another collaborator has active work in this project. Wait for it to finish.',
          },
        })
      if (attempts === 2)
        return route.fulfill({
          status: 503,
          json: {
            error:
              'Recovery is still blocked. Ask the server administrator to check project storage.',
          },
        })
      await new Promise((resolve) => {
        releaseSuccess = resolve
      })
      state.projects = [project, healthy]
      return route.fulfill({ json: project })
    },
  )
  await fixture.ready()
  const chatDraft = 'Keep this private conversation draft during file recovery.'
  await page.getByLabel('Message Lemex').fill(chatDraft)
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText(marker)
  await until(
    () => page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
    'local recovery draft',
  )
  state.projects = [paused, healthy]
  collaboration.send(JSON.stringify({ type: 'project' }))
  const panel = page.getByRole('region', {
    name: 'Project file recovery',
    exact: true,
  })
  await panel.waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Retry setup', exact: true })
      .count(),
    0,
  )
  const selected = () =>
    page.evaluate(() => localStorage.getItem('lemex-project'))
  async function assertDraft() {
    assert.equal(await selected(), project.id)
    const pending = page.waitForEvent('download')
    await panel
      .getByRole('button', { name: 'Download draft: Main.lean', exact: true })
      .click()
    assert.equal(
      await fs.readFile(await (await pending).path(), 'utf8'),
      source + marker,
    )
    assert.equal(state.files[project.id]['Main.lean'], source)
  }
  await assertDraft()
  const projectDownload = page.waitForEvent('download')
  await panel
    .getByRole('button', { name: 'Download project', exact: true })
    .click()
  assert.equal(
    await fs.readFile(await (await projectDownload).path(), 'utf8'),
    'AVAILABLE_SAVED_PROJECT_FILES',
  )
  assert.deepEqual(downloads, [project.id])
  checks.push(
    'Paused recovery offers saved-project and local-draft downloads without changing the selected project or source.',
  )
  const retry = panel.getByRole('button', {
    name: 'Retry file recovery',
    exact: true,
  })
  await retry.click()
  await panel
    .getByRole('alert')
    .filter({ hasText: 'Another collaborator has active work' })
    .waitFor()
  await assertDraft()
  await retry.click()
  await panel
    .getByRole('alert')
    .filter({ hasText: 'Recovery is still blocked' })
    .waitFor()
  await assertDraft()
  await retry.click()
  await until(() => !!releaseSuccess, 'held file recovery response')
  assert.equal(await panel.getAttribute('aria-busy'), 'true')
  assert(
    await panel
      .getByRole('button', { name: 'Recovering project files…', exact: true })
      .isDisabled(),
  )
  assert.equal(await selected(), project.id)
  releaseSuccess()
  releaseSuccess = undefined
  await panel.waitFor({ state: 'hidden' })
  await page.locator('.monaco-editor textarea').first().waitFor()
  await until(
    () =>
      page
        .locator('.monaco-editor .view-lines')
        .first()
        .innerText()
        .then((text) => text.replaceAll('\u00a0', ' ').includes(marker.trim())),
    'preserved editor draft after recovery',
  )
  assert.equal(await page.getByLabel('Message Lemex').inputValue(), chatDraft)
  assert.equal(await selected(), project.id)
  assert.equal(state.files[project.id]['Main.lean'], source)
  assert.equal(attempts, 3)
  assert.equal(state.files[healthy.id]['Main.lean'], '-- healthy source\n')
  fixture.assertClean()
  checks.push(
    '409 and 503 recovery failures preserve drafts; pending recovery is explicit; success keeps the same visit, editor text and personal chat draft.',
  )
  await page.screenshot({ path: path.join(output, 'recovered.png') })
  await fixture.browser.close()
  fixture = undefined

  const viewerId = 'file-recovery-viewer'
  viewer = await chatBrowserFixture({
    base,
    session: {
      user: {
        id: viewerId,
        name: 'Recovery Viewer',
        role: 'user',
        profileComplete: true,
      },
      templates: [],
      models: [],
      runtime: { ready: true },
      lemex: { configured: false },
    },
    projects: [{ ...paused, accessRole: 'viewer' }],
    files: { [project.id]: { 'Main.lean': source } },
    chats: [
      {
        id: 'viewer-recovery-chat',
        projectId: project.id,
        title: 'Viewer private chat',
      },
    ],
    runs: [],
  })
  await viewer.page.route(`**/api/projects/${project.id}/download`, (route) => {
    assert.equal(route.request().headers()['x-leanflow-user'], viewerId)
    return route.fulfill({
      status: 200,
      contentType: 'application/zip',
      body: 'VIEWER_PROJECT_FILES',
    })
  })
  await viewer.page.goto(base)
  const viewerPanel = viewer.page.getByRole('region', {
    name: 'Project file recovery',
    exact: true,
  })
  await viewerPanel.waitFor()
  assert.equal(
    await viewer.page
      .getByRole('button', { name: 'Retry file recovery', exact: true })
      .count(),
    0,
  )
  await viewerPanel
    .getByText('Ask a project Admin to retry file recovery.', { exact: false })
    .waitFor()
  assert.equal(
    await viewer.page.getByLabel('Your Lemex API key', { exact: true }).count(),
    0,
  )
  const viewerDownload = viewer.page.waitForEvent('download')
  await viewerPanel
    .getByRole('button', { name: 'Download project', exact: true })
    .click()
  assert.equal(
    await fs.readFile(await (await viewerDownload).path(), 'utf8'),
    'VIEWER_PROJECT_FILES',
  )
  viewer.state.projects = [{ ...project, accessRole: 'viewer' }]
  await viewerPanel
    .getByRole('button', { name: 'Refresh project status', exact: true })
    .click()
  await viewerPanel.waitFor({ state: 'hidden' })
  await viewer.page.locator('.monaco-editor').waitFor()
  assert.equal(
    await viewer.page.evaluate(() => localStorage.getItem('lemex-project')),
    project.id,
  )
  assert.equal(
    await viewer.page.getByLabel('Your Lemex API key', { exact: true }).count(),
    0,
  )
  viewer.assertClean()
  checks.push(
    'A keyless Viewer can download a paused project and refresh after Admin recovery without provider setup, retry permissions or a change of project.',
  )
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ passed: true, checks }, null, 2),
  )
  console.log(JSON.stringify({ passed: true, checks }, null, 2))
} catch (error) {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ passed: false, checks, error: error.stack }, null, 2),
  )
  await (viewer || fixture)?.page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  releaseSuccess?.()
  await fixture?.browser.close()
  await viewer?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
