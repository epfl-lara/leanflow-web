#!/usr/bin/env node
// Sharing and permission controls use closed fixture APIs, never real accounts.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/project-sharing-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
const individualPath = 'notes/Proof α.lean'
const individualRequests = []
app.get(
  '/api/projects/sharing-viewer/terminal-recoveries/private-copy/download',
  (request, response) => {
    if (request.query.path !== undefined) {
      individualRequests.push(request.query.path)
      assert.equal(request.query.path, individualPath)
      response.setHeader(
        'Content-Disposition',
        'attachment; filename="Proof.lean"',
      )
      response
        .type('application/octet-stream')
        .send(Buffer.from('PRIVATE_INDIVIDUAL_RECOVERY'))
      return
    }
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="private-terminal.zip"',
    )
    response
      .type('application/zip')
      .send(Buffer.from('PRIVATE_TERMINAL_RECOVERY'))
  },
)
app.use(
  express.static(
    process.env.STUDIO_TEST_DIST || path.join(root, 'client/dist'),
  ),
)
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`
const projects = [
  {
    id: 'sharing-admin',
    name: 'Managed proof',
    accessRole: 'admin',
    kind: 'project',
    status: 'ready',
  },
  {
    id: 'sharing-viewer',
    name: 'Shared proof',
    accessRole: 'viewer',
    kind: 'project',
    status: 'ready',
  },
]
const sharing = {
  members: [{ userId: 'fixture-admin', name: 'Fixture admin', role: 'admin' }],
  links: [],
}
const operations = []
let failInitialSharingLoad = true
let fixture
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'fixture-admin', name: 'Fixture admin', role: 'user' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects,
    files: Object.fromEntries(
      projects.map((project) => [
        project.id,
        {
          'Main.lean': `-- ${project.id}\nexample : True := by trivial\n`,
          'DeleteMe.lean': '-- disposable fixture file\n',
        },
      ]),
    ),
    chats: projects.map((project) => ({
      id: `${project.id}-chat`,
      projectId: project.id,
      title: 'My private discussion',
      runCount: project.accessRole === 'viewer' ? 1 : 0,
    })),
    runs: [
      {
        id: 'private-viewer-run',
        projectId: 'sharing-viewer',
        chatId: 'sharing-viewer-chat',
        status: 'completed',
        mode: 'search',
        model: 'fixture-model',
        file: 'Main.lean',
        prompt: 'MY_PRIVATE_QUESTION',
        message: 'MY_PRIVATE_HISTORY',
        createdAt: '2026-11-12T10:00:00Z',
        updatedAt: '2026-11-12T10:00:01Z',
        changes: [],
        events: [],
      },
    ],
  })
  const { page, state, report } = fixture
  const revokedHistoryRequests = []
  report.revokedHistoryRequests = revokedHistoryRequests
  await page.route(
    (url) =>
      [
        '/api/projects/sharing-viewer/runs',
        '/api/projects/sharing-viewer/chats',
      ].includes(url.pathname),
    (route) => {
      const request = route.request()
      if (
        request.method() !== 'GET' ||
        state.projects.some((project) => project.id === 'sharing-viewer')
      )
        return route.fallback()
      const endpoint = new URL(request.url()).pathname
      // A private-history poll can reach the server as access is revoked.
      // Reject and record it; never serve the retained chat fixture through
      // an inaccessible project's list endpoints.
      report.requests.push({ method: 'GET', endpoint })
      revokedHistoryRequests.push({ method: 'GET', endpoint, status: 404 })
      return route.fulfill({
        status: 404,
        json: { error: 'Project not found.' },
      })
    },
  )
  const terminalRecoveries = []
  await page.route('**/api/projects/*/terminal-recoveries', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.includes('/sharing-viewer/')
        ? terminalRecoveries
        : [],
    }),
  )
  await page.route('**/api/terminal-recoveries', (route) =>
    route.fulfill({
      json: terminalRecoveries.map((copy) => ({
        ...copy,
        projectId: 'sharing-viewer',
      })),
    }),
  )
  await page.route('**/api/provider', (route) =>
    route.fulfill({ json: { configured: false } }),
  )
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      json: {
        extraInstructions: '',
        showReasoning: true,
        tools: { lean: true, lean_probe: true, lean_explore: true, exa: false },
      },
    }),
  )
  await page.route('**/api/projects/*/terminal/stop', (route) =>
    route.fulfill({ json: { stopped: true } }),
  )
  await page.route(
    (url) =>
      url.pathname ===
      '/api/projects/sharing-viewer/terminal-recoveries/private-copy/download',
    (route) => route.continue(),
  )
  const liveSockets = new Map()
  await page.routeWebSocket('**/websocket/collaboration/**', (socket) => {
    const id = new URL(socket.url()).pathname.split('/').at(-1)
    liveSockets.set(id, socket)
  })
  await page.route('**/api/accounts/search?*', (route) =>
    route.fulfill({ json: [{ id: 'collaborator', name: 'Collaborator' }] }),
  )
  await page.route('**/api/projects/sharing-admin/sharing**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const suffix = url.pathname.slice(
      '/api/projects/sharing-admin/sharing'.length,
    )
    const method = request.method()
    const body = request.postData() ? request.postDataJSON() : null
    operations.push({ method, suffix, body })
    if (method === 'GET' && !suffix) {
      if (failInitialSharingLoad) {
        failInitialSharingLoad = false
        return route.fulfill({
          status: 503,
          json: { error: 'Temporary sharing interruption.' },
        })
      }
      return route.fulfill({ json: sharing })
    }
    if (suffix === '/members/collaborator' && method === 'PUT') {
      const previous = sharing.members.findIndex(
        (member) => member.userId === 'collaborator',
      )
      const member = {
        userId: 'collaborator',
        name: 'Collaborator',
        role: body.role,
      }
      if (previous < 0) sharing.members.push(member)
      else sharing.members[previous] = member
      return route.fulfill({ json: member })
    }
    if (suffix === '/members/collaborator' && method === 'DELETE') {
      sharing.members = sharing.members.filter(
        (member) => member.userId !== 'collaborator',
      )
      return route.fulfill({ json: { ok: true } })
    }
    if (suffix === '/links' && method === 'POST') {
      const link = {
        id: 'fixture-link',
        role: body.role,
        createdAt: new Date().toISOString(),
      }
      sharing.links.push(link)
      return route.fulfill({
        json: { ...link, token: 'fixture-invitation-token' },
      })
    }
    if (suffix === '/links/fixture-link' && method === 'DELETE') {
      sharing.links = []
      return route.fulfill({ json: { ok: true } })
    }
    throw new Error(`Unexpected sharing fixture request ${method} ${suffix}`)
  })
  let joins = 0
  await page.route('**/api/project-invitations/join', (route) => {
    joins++
    assert.equal(
      route.request().postDataJSON().token,
      'fixture-invitation-token',
    )
    return route.fulfill({
      json: state.projects.find((project) => project.id === 'sharing-viewer'),
    })
  })
  const selectProject = (name) =>
    page.locator('.project-item').filter({ hasText: name }).click()
  await fixture.ready()
  await page.getByRole('button', { name: 'Share', exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Share project',
    exact: true,
  })
  await dialog.getByRole('alert').waitFor()
  await dialog
    .getByRole('button', { name: 'Retry sharing', exact: true })
    .click()
  await dialog.getByText('People with access', { exact: true }).waitFor()
  assert.equal(
    await dialog.getByLabel('Find an account').getAttribute('maxlength'),
    '80',
  )
  await dialog
    .getByText('Keep at least one project admin.', { exact: true })
    .waitFor()
  await dialog.getByText('You', { exact: true }).waitFor()
  report.checks.push(
    'A failed sharing load retries inside the dialog; search limits match the server and current-account/sole-admin guidance is visible.',
  )
  await dialog.getByLabel('Find an account').fill('collab')
  await dialog.getByRole('button', { name: 'Add editor', exact: true }).click()
  await until(
    () =>
      sharing.members.some(
        (member) =>
          member.userId === 'collaborator' && member.role === 'editor',
      ),
    'editor invitation',
  )
  await dialog.getByLabel('Role for Collaborator').selectOption('viewer')
  assert.equal(
    sharing.members.find((member) => member.userId === 'collaborator').role,
    'editor',
  )
  await dialog
    .getByRole('button', { name: 'Apply role for Collaborator', exact: true })
    .click()
  assert.equal(
    sharing.members.find((member) => member.userId === 'collaborator').role,
    'editor',
  )
  await dialog
    .getByText(
      'This ends the affected account’s terminal, assistant runs, and Lean checks.',
      { exact: false },
    )
    .waitFor()
  await dialog
    .getByRole('button', { name: 'Confirm access change', exact: true })
    .click()
  await until(
    () =>
      sharing.members.some(
        (member) =>
          member.userId === 'collaborator' && member.role === 'viewer',
      ),
    'viewer role update',
  )
  await dialog
    .getByRole('button', { name: 'Remove Collaborator', exact: true })
    .click()
  await dialog
    .getByRole('button', { name: 'Confirm access change', exact: true })
    .click()
  await until(
    () => !sharing.members.some((member) => member.userId === 'collaborator'),
    'membership removal',
  )
  assert.equal(
    await dialog
      .getByLabel('Role for Fixture admin', { exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await dialog
      .getByRole('button', { name: 'Remove Fixture admin', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await dialog
      .getByRole('button', { name: 'Add admin', exact: true })
      .isDisabled(),
    true,
  )
  await dialog.getByLabel('Confirm admin permissions', { exact: true }).check()
  await dialog.getByRole('button', { name: 'Add admin', exact: true }).click()
  await until(
    () =>
      sharing.members.some(
        (member) => member.userId === 'collaborator' && member.role === 'admin',
      ),
    'confirmed admin grant',
  )
  await dialog
    .getByLabel('Role for Fixture admin', { exact: true })
    .selectOption('viewer')
  await dialog
    .getByRole('button', { name: 'Apply role for Fixture admin', exact: true })
    .click()
  await dialog
    .getByText('You will lose access to sharing and project deletion.', {
      exact: false,
    })
    .waitFor()
  await dialog
    .getByRole('button', { name: 'Cancel access change', exact: true })
    .click()
  assert.equal(
    await dialog
      .getByLabel('Role for Fixture admin', { exact: true })
      .inputValue(),
    'admin',
  )
  assert.equal(
    operations.some(
      (operation) =>
        operation.method === 'PUT' &&
        operation.suffix === '/members/fixture-admin',
    ),
    false,
  )
  await until(
    async () =>
      !(await dialog
        .getByLabel('Confirm admin permissions', { exact: true })
        .isChecked()),
    'admin confirmation reset',
  )
  await dialog
    .getByLabel('Role for Collaborator', { exact: true })
    .selectOption('viewer')
  await dialog
    .getByRole('button', { name: 'Apply role for Collaborator', exact: true })
    .click()
  await dialog
    .getByRole('button', { name: 'Confirm access change', exact: true })
    .click()
  await until(
    () =>
      sharing.members.some(
        (member) =>
          member.userId === 'collaborator' && member.role === 'viewer',
      ),
    'admin demotion',
  )
  await dialog
    .getByRole('button', { name: 'Remove Collaborator', exact: true })
    .click()
  await dialog
    .getByRole('button', { name: 'Confirm access change', exact: true })
    .click()
  await until(
    () => !sharing.members.some((member) => member.userId === 'collaborator'),
    'former admin removal',
  )
  report.checks.push(
    'Admin access requires explicitly accepting the sharing/deletion warning; confirmation resets after granting, and the sole remaining admin cannot be removed or demoted.',
  )
  await dialog.getByLabel('New share link role').selectOption('viewer')
  await dialog
    .getByRole('button', { name: 'Create share link', exact: true })
    .click()
  const link = dialog.getByLabel('Viewer share link', { exact: true })
  await link.waitFor()
  assert.equal(
    new URL(await link.inputValue()).hash,
    '#share=fixture-invitation-token',
  )
  assert.equal(sharing.links[0].role, 'viewer')
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click()
  await until(() => sharing.links.length === 0, 'link revocation')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  assert.equal(
    await page
      .getByRole('button', { name: 'Share', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  report.checks.push(
    'Admins can find accounts, assign editor/viewer roles, remove members, and create/copyable/revoke viewer invitation links.',
  )

  await selectProject('Shared proof')
  await until(
    async () => /read only/i.test(await page.locator('.file-tab').innerText()),
    'viewer read-only editor',
  )
  await page.getByText('MY_PRIVATE_HISTORY', { exact: true }).waitFor()
  assert.equal(
    await page.getByRole('button', { name: 'Share', exact: true }).count(),
    0,
  )
  assert.equal(
    await page.getByRole('button', { name: 'Terminal', exact: true }).count(),
    0,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Refresh setup', exact: true })
      .count(),
    0,
  )
  assert.equal(
    await page.getByLabel('Message Lemex', { exact: true }).count(),
    0,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'New chat', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'New file', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Upload', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Move project Shared proof to trash',
        exact: true,
      })
      .count(),
    0,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Move Main.lean to trash', exact: true })
      .count(),
    0,
  )
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.insertText('VIEWER_MUST_NOT_EDIT')
  assert.equal(
    (
      await page.locator('.monaco-editor .view-lines').first().innerText()
    ).includes('VIEWER_MUST_NOT_EDIT'),
    false,
  )
  report.checks.push(
    'Viewers retain their own private chat history and a visible read-only editor; file creation, upload, project deletion, terminal, setup and agent sending are unavailable.',
  )

  state.projects.find((project) => project.id === 'sharing-viewer').accessRole =
    'editor'
  await page.reload()
  await page.getByRole('button', { name: 'Terminal', exact: true }).waitFor()
  await page
    .getByRole('button', { name: 'Refresh setup', exact: true })
    .waitFor()
  await page.getByLabel('Message Lemex', { exact: true }).waitFor()
  assert.equal(
    await page.getByRole('button', { name: 'Share', exact: true }).count(),
    0,
  )
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Move project Shared proof to trash',
        exact: true,
      })
      .count(),
    0,
  )
  report.checks.push(
    'Editors can use their own assistant, terminal and setup controls while sharing and project deletion remain admin actions.',
  )
  await page.route('**/api/projects/sharing-viewer/trash', (route) => {
    assert.equal(route.request().postDataJSON().path, 'DeleteMe.lean')
    delete state.files['sharing-viewer']['DeleteMe.lean']
    return route.fulfill({
      json: {
        trashId: 'editor-file-deletion',
        projectId: 'sharing-viewer',
        kind: 'file',
        path: 'DeleteMe.lean',
        createdAt: new Date().toISOString(),
      },
    })
  })
  await page
    .getByRole('button', {
      name: 'Move file DeleteMe.lean to trash',
      exact: true,
    })
    .click()
  const deletion = page.getByRole('dialog', {
    name: 'Delete file?',
    exact: true,
  })
  await deletion
    .getByRole('button', { name: 'Move to Trash', exact: true })
    .click()
  await page
    .locator('.trash-notice')
    .getByText('Ask a project Admin to restore this item from Trash.', {
      exact: true,
    })
    .waitFor()
  assert.equal(
    await page
      .locator('.trash-notice')
      .getByRole('button', { name: 'Undo', exact: true })
      .count(),
    0,
  )
  assert.equal(
    await page
      .locator('.trash-notice')
      .getByRole('button', { name: 'Open Trash', exact: true })
      .count(),
    0,
  )
  report.checks.push(
    'An Editor file deletion explains that a project Admin can restore it instead of offering an unavailable Undo action.',
  )

  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const terminalPanel = page.getByRole('region', {
    name: 'Project terminal',
    exact: true,
  })
  await terminalPanel
    .getByText('Private working copy', { exact: true })
    .waitFor()
  await terminalPanel
    .getByText('File edits sync from your private copy', { exact: false })
    .waitFor()
  await terminalPanel
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  await terminalPanel.waitFor({ state: 'hidden' })
  state.projects.find((project) => project.id === 'sharing-viewer').accessRole =
    'viewer'
  liveSockets.get('sharing-viewer').send(JSON.stringify({ type: 'access' }))
  await page.getByText('You have viewer access.', { exact: false }).waitFor()
  await until(
    async () => /read only/i.test(await page.locator('.file-tab').innerText()),
    'live viewer downgrade',
  )
  assert.equal(
    await page.getByRole('button', { name: 'Terminal', exact: true }).count(),
    0,
  )
  state.projects.find((project) => project.id === 'sharing-viewer').accessRole =
    'editor'
  liveSockets.get('sharing-viewer').send(JSON.stringify({ type: 'access' }))
  await page.getByLabel('Message Lemex', { exact: true }).waitFor()
  state.onSave = ({ respond }) =>
    respond({ error: 'Fixture conflict preserves draft.' }, 409)
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.insertText('LOCAL_DRAFT_BEFORE_REVOCATION')
  await until(
    async () =>
      (
        await page.locator('.monaco-editor .view-lines').first().innerText()
      ).includes('LOCAL_DRAFT_BEFORE_REVOCATION'),
    'local editor draft',
  )
  terminalRecoveries.push({
    runId: 'private-copy',
    createdAt: new Date().toISOString(),
    message:
      'Main.lean changed in the shared project. Your private terminal copy is preserved.',
  })
  state.projects.splice(
    state.projects.findIndex((project) => project.id === 'sharing-viewer'),
    1,
  )
  liveSockets.get('sharing-viewer').send(JSON.stringify({ type: 'access' }))
  const exportDraft = page.getByRole('button', {
    name: 'Download draft: Main.lean',
    exact: true,
  })
  await exportDraft.waitFor()
  const deniedHistory = await page.evaluate(async () =>
    Promise.all(
      ['runs', 'chats'].map(async (kind) => {
        const response = await fetch(`/api/projects/sharing-viewer/${kind}`)
        return { status: response.status, body: await response.json() }
      }),
    ),
  )
  assert.deepEqual(deniedHistory, [
    { status: 404, body: { error: 'Project not found.' } },
    { status: 404, body: { error: 'Project not found.' } },
  ])
  const downloaded = page.waitForEvent('download')
  await exportDraft.click()
  const download = await downloaded
  const draftPath = await download.path()
  assert.ok(
    (await fs.readFile(draftPath, 'utf8')).includes(
      'LOCAL_DRAFT_BEFORE_REVOCATION',
    ),
  )
  assert.equal(
    await page.getByLabel('Message Lemex', { exact: true }).count(),
    0,
  )
  report.checks.push(
    'Live permission changes update the editor and assistant immediately. Revocation rejects private-history list requests, preserves unsaved source and offers a local draft download.',
  )
  await page.getByText('Recover terminal files', { exact: false }).waitFor()
  const terminalDownload = page.waitForEvent('download')
  await page
    .getByRole('link', { name: 'Download terminal files', exact: true })
    .click()
  const recovered = await terminalDownload
  assert.equal(
    await fs.readFile(await recovered.path(), 'utf8'),
    'PRIVATE_TERMINAL_RECOVERY',
  )
  report.checks.push(
    'Terminal explains private-copy synchronization and private Git history. Caller-private recovery ZIPs remain downloadable after project access ends.',
  )
  page.once('dialog', (dialog) => dialog.accept())
  await page.reload()
  await page
    .getByRole('button', { name: 'Account settings', exact: true })
    .click()
  const settingsDialog = page.getByRole('dialog', {
    name: 'Assistant settings',
    exact: true,
  })
  await settingsDialog.locator('.account-terminal-recoveries summary').click()
  const privateRecovery = settingsDialog.getByRole('link', {
    name: 'Download terminal files',
    exact: true,
  })
  await privateRecovery.waitFor()
  assert.equal(
    await privateRecovery.getAttribute('href'),
    '/api/projects/sharing-viewer/terminal-recoveries/private-copy/download',
  )
  let listingAttempts = 0
  await page.route(
    '**/api/projects/sharing-viewer/terminal-recoveries/private-copy/files',
    (route) => {
      listingAttempts++
      return listingAttempts === 1
        ? route.fulfill({
            status: 503,
            json: { error: 'Temporary recovery listing failure.' },
          })
        : route.fulfill({
            json: {
              files: [
                { path: individualPath, size: 27, downloadable: true },
                {
                  path: 'huge-output.bin',
                  size: 33 * 1024 * 1024,
                  downloadable: false,
                },
              ],
              fileByteLimit: 32 * 1024 * 1024,
            },
          })
    },
  )
  await page.setViewportSize({ width: 390, height: 844 })
  const individualFiles = settingsDialog.locator('.terminal-recovery-files')
  await individualFiles.locator('summary').click()
  await individualFiles
    .getByRole('alert')
    .filter({ hasText: 'Temporary recovery listing failure.' })
    .waitFor()
  await individualFiles
    .getByRole('button', { name: 'Retry recovery files', exact: true })
    .click()
  const individualDownload = individualFiles.getByRole('link', {
    name: `Download ${individualPath}`,
    exact: true,
  })
  await individualDownload.waitFor()
  assert.equal(
    new URL(
      await individualDownload.getAttribute('href'),
      base,
    ).searchParams.get('path'),
    individualPath,
  )
  assert.equal(
    await individualFiles
      .getByRole('link', { name: 'Download huge-output.bin', exact: true })
      .count(),
    0,
  )
  await individualFiles
    .getByText('Ask the server administrator to recover it.', { exact: false })
    .waitFor()
  const recoveredFile = page.waitForEvent('download')
  await individualDownload.click()
  assert.equal(
    await fs.readFile(await (await recoveredFile).path(), 'utf8'),
    'PRIVATE_INDIVIDUAL_RECOVERY',
  )
  assert.deepEqual(individualRequests, [individualPath])
  assert.equal(
    await settingsDialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  report.checks.push(
    'After revocation, private recovery files can be listed with Retry and downloaded individually; oversized files explain administrator recovery and narrow layouts remain usable.',
  )
  await page.keyboard.press('Escape')
  await settingsDialog.waitFor({ state: 'hidden' })
  report.checks.push(
    'Private terminal copies remain discoverable in Account settings after reloading away from a project whose membership ended.',
  )
  terminalRecoveries.push({
    runId: 'too-many-files',
    createdAt: new Date().toISOString(),
    message: 'Private copy with too many entries',
  })
  let boundedListingRequests = 0
  await page.route(
    '**/api/projects/sharing-viewer/terminal-recoveries/too-many-files/files',
    (route) => {
      boundedListingRequests++
      return route.fulfill({
        status: 413,
        json: {
          error:
            'This private copy has too many entries to list or download safely. Ask the server administrator to recover its files.',
        },
      })
    },
  )
  await page
    .getByRole('button', { name: 'Account settings', exact: true })
    .click()
  await settingsDialog.locator('.account-terminal-recoveries > summary').click()
  const boundedRecovery = settingsDialog
    .locator('.terminal-recoveries > ul > li')
    .filter({ hasText: 'Private copy with too many entries' })
  await boundedRecovery.locator('.terminal-recovery-files > summary').click()
  await boundedRecovery
    .getByRole('alert')
    .filter({ hasText: 'Ask the server administrator to recover its files.' })
    .waitFor()
  assert.equal(
    await boundedRecovery
      .getByRole('button', { name: 'Retry recovery files', exact: true })
      .count(),
    0,
  )
  assert.equal(boundedListingRequests, 1)
  await page.keyboard.press('Escape')
  await settingsDialog.waitFor({ state: 'hidden' })
  report.checks.push(
    'A private copy exceeding enumeration limits gives administrator recovery guidance and does not offer an ineffective Retry.',
  )

  state.projects.push({
    id: 'sharing-viewer',
    name: 'Shared proof',
    accessRole: 'viewer',
    kind: 'project',
    status: 'ready',
  })
  state.onSave = null
  await selectProject('Managed proof')
  await page.goto(`${base}/#share=fixture-invitation-token`)
  await until(
    async () =>
      (await page.locator('.workspace-title').innerText()).includes(
        'Shared proof',
      ),
    'invitation target selection',
  )
  await until(() => joins === 1, 'invitation redemption')
  assert.deepEqual(
    await page.evaluate(() => ({
      hash: location.hash,
      pending: sessionStorage.getItem('lemex-project-invitation'),
    })),
    { hash: '', pending: null },
  )
  report.checks.push(
    'Opening an invitation joins and selects the shared project, clears the URL token and removes its pending browser copy.',
  )
  fixture.assertClean()
  report.passed = true
  report.operations = operations
  console.log(JSON.stringify({ passed: true, checks: report.checks }))
} catch (error) {
  if (fixture) {
    fixture.report.failure = error.stack
    fixture.report.visible = await fixture.page.locator('body').innerText()
  }
  throw error
} finally {
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
