#!/usr/bin/env node
// Real account, API, websocket, disk and browser interactions. No provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { createSharingLiveFixture } from './lib/sharing-live-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const directory = path.resolve('.runtime/sharing-validation')
await fs.mkdir(directory, { recursive: true })
const report = { checks: [], errors: [], providerCalls: 0, passed: false }
const record = (name, details = {}) => {
  report.checks.push({ name, ...details })
  console.log(`PASS ${name}`)
}
async function until(check, label, timeout = 25000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`Timed out: ${label}`)
}
let fixture, browser
const pages = {}
const contexts = []
try {
  fixture = await createSharingLiveFixture()
  console.log('Real isolated server and five accounts ready')
  browser = await chromium.launch({ headless: true })
  const makePage = async (
    key,
    { loginUI = true, url = fixture.origin } = {},
  ) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    })
    contexts.push(context)
    const page = await context.newPage()
    page.on('pageerror', (error) =>
      report.errors.push({
        account: key,
        message: error.message,
        stack: error.stack,
      }),
    )
    page.on('request', (request) => {
      if (request.url().startsWith('https://provider.example/'))
        report.providerCalls++
    })
    await page.goto(url)
    if (loginUI) {
      await page
        .getByLabel('Access token', { exact: true })
        .fill(fixture.accounts[key].token)
      await page
        .getByRole('button', { name: 'Open workspace', exact: true })
        .click()
    } else {
      const response = await context.request.post(
        fixture.origin + '/api/login',
        {
          data: { token: fixture.accounts[key].token },
          headers: { Origin: fixture.origin },
        },
      )
      assert.equal(response.status(), 200)
      await page.reload()
    }
    await until(
      async () =>
        !(await page.getByLabel('Access token', { exact: true }).isVisible()),
      `${key} sign in`,
    )
    pages[key] = page
    return page
  }
  const admin = await makePage('admin')
  const select = async (page, name = fixture.project.name) => {
    await page.locator('.project-item').filter({ hasText: name }).click()
    await page.locator('.monaco-editor textarea').first().waitFor()
    await page
      .locator('.editor-loading')
      .waitFor({ state: 'hidden' })
      .catch(() => {})
  }
  await select(admin)
  record('Real Admin login opens the prepared pinned Lean project')
  const editorA = await makePage('editorA'),
    editorB = await makePage('editorB'),
    viewer = await makePage('viewer'),
    outsider = await makePage('outsider')
  await Promise.all([select(editorA), select(editorB), select(viewer)])
  assert.equal(
    await outsider
      .locator('.project-item')
      .filter({ hasText: fixture.project.name })
      .count(),
    0,
  )
  const foreign = await fixture.request(
    'outsider',
    `/api/projects/${fixture.project.id}/file?path=Main.lean`,
  )
  assert.equal(foreign.status, 404)
  record(
    'Separate Editor, Viewer and nonmember sessions enforce actual project access',
  )
  const source = () =>
    fixture.studio.workspaces.readFile(
      fixture.project.id,
      fixture.accounts.admin.id,
      'Main.lean',
    )
  const text = (page) =>
    page
      .locator('.monaco-editor .view-lines')
      .first()
      .innerText()
      .then((value) => value.replaceAll('\u00a0', ' '))
  const append = async (page, value) => {
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press(editorShortcuts.documentEnd)
    await page.keyboard.insertText(value)
  }
  const prepend = async (page, value) => {
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press(editorShortcuts.documentStart)
    await page.keyboard.insertText(value)
  }
  await until(
    () => fixture.studio.projectDocuments.clients.size >= 4,
    'four authenticated shared document connections',
  )
  // Hold actual setup before its Lake command while another account has an
  // offline draft. Setup must notify peers, preserve that draft and resume
  // publishing once the same pinned environment is ready again.
  const runBeforeSetup = fixture.runtime.run.bind(fixture.runtime)
  let releaseSetup
  const setupGate = new Promise((resolve) => {
    releaseSetup = resolve
  })
  let setupPaused = false
  fixture.runtime.run = async (...args) => {
    if (!setupPaused && args[1][0] === 'lake') {
      setupPaused = true
      await setupGate
    }
    return runBeforeSetup(...args)
  }
  try {
    await editorB.context().setOffline(true)
    await append(editorB, '-- SETUP_RETAINED_DRAFT\n')
    const setup = await fixture.request(
      'admin',
      `/api/projects/${fixture.project.id}/prepare`,
      {
        method: 'POST',
        body: {},
      },
    )
    assert.equal(setup.status, 200)
    await until(() => setupPaused, 'actual setup paused before Lake')
    await editorB.context().setOffline(false)
    await until(
      async () =>
        (await editorA
          .getByText('Preparing libraries', { exact: true })
          .count()) > 0,
      'other editor receives setup status',
    )
    assert(!(await source()).content.includes('SETUP_RETAINED_DRAFT'))
  } finally {
    releaseSetup()
    await fixture.studio.workspaces.jobs.get(fixture.project.id)
    fixture.runtime.run = runBeforeSetup
    await editorB.context().setOffline(false)
  }
  await until(
    async () => (await source()).content.includes('SETUP_RETAINED_DRAFT'),
    'draft resumes live saving after collaborator setup',
  )
  await append(editorB, '-- AFTER_SETUP_RETRY\n')
  await until(
    async () => (await source()).content.includes('AFTER_SETUP_RETRY'),
    'later typing remains live after setup',
  )
  record(
    'Collaborator setup announces status and resumes preserved drafts and later typing without reload',
  )
  const started = Date.now()
  await Promise.all([
    prepend(editorA, '-- editor A concurrent\n'),
    append(editorB, '-- editor B concurrent\n'),
  ])
  await until(async () => {
    const value = (await source()).content
    return (
      value.includes('editor A concurrent') &&
      value.includes('editor B concurrent')
    )
  }, 'concurrent edits durable')
  await until(
    async () =>
      (await text(admin)).includes('editor A concurrent') &&
      (await text(viewer)).includes('editor B concurrent'),
    'all viewers observe merged source',
  )
  record(
    'Real simultaneous Monaco edits converge on disk and all browser sessions',
    { elapsedMs: Date.now() - started },
  )
  const savedBefore = (await source()).content
  await admin.locator('.monaco-editor textarea').first().focus()
  await admin.keyboard.press('ControlOrMeta+z')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(
    (await source()).content,
    savedBefore,
    'Undo in a tab that only received remote edits must not delete collaborator work',
  )
  await admin
    .locator('.monaco-editor .view-lines')
    .first()
    .click({ button: 'right' })
  const undoMenu = admin
    .locator('.monaco-menu .action-label')
    .filter({ hasText: /^Undo\b/ })
    .first()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const menuOfferedUndo = (await undoMenu.count()) > 0
  if (
    menuOfferedUndo &&
    (await undoMenu.getAttribute('aria-disabled')) !== 'true'
  )
    await undoMenu.click()
  else await admin.keyboard.press('Escape')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(
    (await source()).content,
    savedBefore,
    'Any offered context-menu Undo must also preserve remote-only edits',
  )
  record('Keyboard Undo cannot delete another collaborator edits', {
    contextMenuUndo: menuOfferedUndo
      ? 'also checked'
      : 'not offered by this editor menu',
  })
  await append(viewer, '-- VIEWER_MUST_NOT_WRITE\n')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal((await source()).content, savedBefore)
  assert(!(await text(viewer)).includes('VIEWER_MUST_NOT_WRITE'))
  record('Viewer typing cannot modify its real read-only editor or saved files')
  // Edit retained Main.lean remotely while Editor A is looking at another file.
  await editorA
    .locator('.file-item')
    .and(editorA.getByTitle('Other.lean', { exact: true }))
    .click()
  await until(
    async () => (await text(editorA)).includes('second file'),
    'open retained second buffer',
  )
  await append(editorB, '-- hidden-buffer update\n')
  await until(
    async () => (await source()).content.includes('hidden-buffer update'),
    'hidden update durable',
  )
  await editorA
    .locator('.file-item')
    .and(editorA.getByTitle('Main.lean', { exact: true }))
    .click()
  await until(
    async () => (await text(editorA)).includes('hidden-buffer update'),
    'retained Main receives remote update',
  )
  record('Retained hidden buffers receive remote edits without stale overwrite')
  for (let round = 0; round < 6; round++) {
    await Promise.all([
      append(editorA, `-- BURST_A_${round}\n`),
      append(editorB, `-- BURST_B_${round}\n`),
    ])
  }
  await until(async () => {
    const value = (await source()).content
    return Array.from({ length: 6 }, (_, round) => [
      `BURST_A_${round}`,
      `BURST_B_${round}`,
    ])
      .flat()
      .every((marker) => value.split(marker).length === 2)
  }, 'same-position editing burst converges exactly once')
  await until(
    async () =>
      (await text(viewer)).includes('BURST_A_5') &&
      (await text(viewer)).includes('BURST_B_5'),
    'viewer catches burst',
  )
  record(
    'Repeated same-position concurrent typing converges without dropped or duplicate edits',
    { concurrentRounds: 6 },
  )
  await editorA.locator('.monaco-editor textarea').first().focus()
  await editorA.keyboard.press(editorShortcuts.documentEnd)
  await prepend(editorB, '-- PREFIX_FOR_CURSOR\n')
  await until(
    async () => (await text(editorA)).includes('PREFIX_FOR_CURSOR'),
    'prefix reaches cursor-owning editor',
  )
  await editorA.keyboard.insertText('-- CURSOR_RETAINED_AT_END\n')
  await until(
    async () => (await source()).content.includes('CURSOR_RETAINED_AT_END'),
    'cursor insertion durable',
  )
  assert((await source()).content.endsWith('-- CURSOR_RETAINED_AT_END\n'))
  record(
    'Remote prefix insertion preserves the other editor logical cursor position',
  )
  await append(editorA, '-- LOCAL_UNDO_TARGET\n')
  await until(
    async () => (await source()).content.includes('LOCAL_UNDO_TARGET'),
    'local undo target saved',
  )
  await append(editorB, '-- REMOTE_UNDO_SURVIVES\n')
  await until(
    async () => (await text(editorA)).includes('REMOTE_UNDO_SURVIVES'),
    'remote edit reaches local undo tab',
  )
  await editorA.locator('.monaco-editor textarea').first().focus()
  await editorA.keyboard.press('ControlOrMeta+z')
  await until(async () => {
    const value = (await source()).content
    return (
      !value.includes('LOCAL_UNDO_TARGET') &&
      value.includes('REMOTE_UNDO_SURVIVES')
    )
  }, 'selective local undo preserves remote edit')
  await editorA.keyboard.press('ControlOrMeta+Shift+z')
  await until(async () => {
    const value = (await source()).content
    return (
      value.includes('LOCAL_UNDO_TARGET') &&
      value.includes('REMOTE_UNDO_SURVIVES')
    )
  }, 'selective redo restores local edit while preserving remote edit')
  record('Local Undo and Redo retain subsequent remote edits on the same file')

  // Drop only collaboration transport while ordinary HTTP stays available.
  const disconnectedRestWrites = []
  const trackDisconnectedWrites = (request) => {
    if (
      request.method() === 'PUT' &&
      new URL(request.url()).pathname ===
        `/api/projects/${fixture.project.id}/file`
    )
      disconnectedRestWrites.push(request.postData())
  }
  editorA.on('request', trackDisconnectedWrites)
  const upgradeHandlers = fixture.studio.server.listeners('upgrade')
  let blockCollaboration = true
  const blockUpgrade = (request, socket, head) => {
    const url = new URL(request.url, fixture.origin)
    if (
      blockCollaboration &&
      url.pathname === `/websocket/collaboration/${fixture.project.id}` &&
      fixture.studio.auth.identify(request)?.id === fixture.accounts.editorA.id
    ) {
      assert.equal(
        url.searchParams.get('expectedUserId'),
        fixture.accounts.editorA.id,
      )
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      )
      return
    }
    for (const handler of upgradeHandlers)
      handler.call(fixture.studio.server, request, socket, head)
  }
  fixture.studio.server.removeAllListeners('upgrade')
  fixture.studio.server.on('upgrade', blockUpgrade)
  try {
    for (const client of fixture.studio.projectDocuments.clients)
      if (client.actor === fixture.accounts.editorA.id) client.ws.terminate()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await append(editorA, '-- HTTP_ONLINE_WS_DRAFT\n')
    await append(editorB, '-- ONLINE_DURING_WS_FAILURE\n')
    assert.equal(
      (
        await editorA.context().request.get(fixture.origin + '/api/session')
      ).status(),
      200,
    )
    await new Promise((resolve) => setTimeout(resolve, 1900))
    assert(
      !(await source()).content.includes('HTTP_ONLINE_WS_DRAFT'),
      'A lost live connection cannot publish the stale draft through REST autosave',
    )
    assert.deepEqual(disconnectedRestWrites, [])
  } finally {
    editorA.removeListener('request', trackDisconnectedWrites)
    blockCollaboration = false
    fixture.studio.server.removeListener('upgrade', blockUpgrade)
    for (const handler of upgradeHandlers)
      fixture.studio.server.on('upgrade', handler)
  }
  await until(async () => {
    const value = (await source()).content
    return (
      value.includes('HTTP_ONLINE_WS_DRAFT') &&
      value.includes('ONLINE_DURING_WS_FAILURE')
    )
  }, 'live-only reconnect merges draft with concurrent HTTP-online source')
  record(
    'A disconnected live socket cannot fall back to an unsafe REST overwrite while HTTP stays online',
  )
  const recovery = await fixture.studio.workspaces.terminalSnapshot(
    fixture.project.id,
    fixture.accounts.editorA.id,
    'browser-recovery-discard',
  )
  await fixture.studio.workspaces.retainTerminalSnapshot(
    recovery,
    'Your private terminal files are ready to recover.',
  )
  await editorA.reload()
  await select(editorA)
  await editorA
    .getByText('Recover terminal files', { exact: false })
    .first()
    .waitFor()
  const recoveryDelete = editorA.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes(`/terminal-recoveries/${recovery.runId}`),
  )
  await editorA
    .getByRole('button', { name: 'Discard recovery copy', exact: true })
    .click()
  await editorA
    .getByRole('button', { name: 'Confirm discard', exact: true })
    .click()
  assert.equal((await recoveryDelete).status(), 200)
  await assert.rejects(fs.stat(path.dirname(recovery.root)), { code: 'ENOENT' })
  record(
    'A real private recovery copy is discarded only after its explicit UI confirmation',
  )
  // Real sharing dialog search and direct Admin warning.
  await admin.getByRole('button', { name: 'Share', exact: true }).click()
  const dialog = admin.getByRole('dialog', {
    name: 'Share project',
    exact: true,
  })
  await dialog.getByText('People with access', { exact: true }).waitFor()
  await dialog
    .getByLabel('Find an account')
    .fill(fixture.accounts.outsider.name)
  await dialog.getByRole('button', { name: 'Add admin', exact: true }).waitFor()
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
      fixture.studio.workspaces.get(
        fixture.project.id,
        fixture.accounts.outsider.id,
      ).accessRole === 'admin',
    'named account admin grant',
  )
  record('Actual account search and acknowledged Admin delegation work')
  // Direct account becomes viewer, then original creator no longer has special rights.
  await dialog
    .getByLabel(`Role for ${fixture.accounts.outsider.name}`, { exact: true })
    .selectOption('viewer')
  await dialog
    .getByRole('button', {
      name: `Apply role for ${fixture.accounts.outsider.name}`,
      exact: true,
    })
    .click()
  await dialog
    .getByRole('button', { name: 'Confirm access change', exact: true })
    .click()
  await until(
    () =>
      fixture.studio.workspaces.get(
        fixture.project.id,
        fixture.accounts.outsider.id,
      ).accessRole === 'viewer',
    'admin downgrade',
  )
  record('Delegated admin can be demoted through actual sharing API/UI')
  // Create a viewer link through the UI and redeem it in a fresh signed-in nonmember context.
  await dialog.getByLabel('New share link role').selectOption('viewer')
  await dialog
    .getByRole('button', { name: 'Create share link', exact: true })
    .click()
  const link = dialog.locator('input[readonly]').last()
  await link.waitFor()
  const invitation = await link.inputValue()
  assert(new URL(invitation).hash.startsWith('#share='))
  // Actual UI DELETE, including JSON request admission and server200 response.
  const removedResponse = admin.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response
        .url()
        .endsWith(`/sharing/members/${fixture.accounts.outsider.id}`),
  )
  await dialog
    .getByRole('button', {
      name: `Remove ${fixture.accounts.outsider.name}`,
      exact: true,
    })
    .click()
  await dialog
    .getByRole('button', { name: 'Confirm access change', exact: true })
    .click()
  assert.equal((await removedResponse).status(), 200)
  record(
    'Real sharing dialog membership removal succeeds through JSON admission',
  )
  await dialog
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  await outsider.goto(invitation)
  await until(
    async () =>
      (await outsider
        .locator('.project-item')
        .filter({ hasText: fixture.project.name })
        .count()) === 1,
    'real invitation redemption',
  )
  await until(
    () => !new URL(outsider.url()).hash.includes('share='),
    'invitation URL scrub',
  )
  assert.equal(
    fixture.studio.workspaces.get(
      fixture.project.id,
      fixture.accounts.outsider.id,
    ).accessRole,
    'viewer',
  )
  record(
    'Real invitation link joins the account and removes its token from the address',
  )
  await admin.getByRole('button', { name: 'Share', exact: true }).click()
  const revokedResponse = admin.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes('/sharing/links/'),
  )
  await dialog.getByRole('button', { name: 'Revoke', exact: true }).click()
  assert.equal((await revokedResponse).status(), 200)
  const revokedToken = new URLSearchParams(
    new URL(invitation).hash.slice(1),
  ).get('share')
  const revokedJoin = await fixture.request(
    'editorB',
    '/api/project-invitations/join',
    { method: 'POST', body: { token: revokedToken } },
  )
  assert.equal(revokedJoin.status, 404)
  await dialog
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  record(
    'Real sharing dialog revokes its invitation and server rejects later redemption',
  )

  // Private chats/provider settings remain separate even for project admins.
  const privateChat = await fixture.request(
    'editorA',
    `/api/projects/${fixture.project.id}/chats`,
    { method: 'POST', body: { title: 'Editor A private conversation' } },
  )
  assert.equal(privateChat.status, 201)
  const chat = await privateChat.json()
  for (const actor of ['admin', 'editorB', 'viewer'])
    assert.equal(
      (await fixture.request(actor, `/api/chats/${chat.id}`)).status,
      404,
    )
  const privateFiles = await fixture.request(
    'admin',
    `/api/projects/${fixture.privateProject.id}/files`,
  )
  assert.equal(privateFiles.status, 404)
  const providerA = await fixture.request('editorA', '/api/provider'),
    providerB = await fixture.request('editorB', '/api/provider')
  assert.equal(providerA.status, 200)
  assert.equal(providerB.status, 200)
  assert(
    !JSON.stringify(await providerA.json()).includes(
      `offline-fixture-${fixture.accounts.editorA.id}`,
    ),
  )
  record(
    'Actual per-account chat/provider and unrelated-project privacy boundaries hold',
  )
  // Downgrade while editor is open: the actual server closes its transport and UI becomes readonly.
  const downgrade = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorB.id}`,
    { method: 'PUT', body: { role: 'viewer' } },
  )
  assert.equal(downgrade.status, 200)
  await downgrade.json()
  await until(
    async () =>
      (await editorB
        .getByText(/View access|view access|View only|view only/)
        .count()) > 0 ||
      !(await editorB
        .getByRole('button', { name: 'Terminal', exact: true })
        .count()),
    'live viewer permission UI',
  )
  const beforeDowngrade = (await source()).content
  await append(editorB, '-- DOWNGRADED_MUST_NOT_WRITE\n')
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal((await source()).content, beforeDowngrade)
  record(
    'Live downgrade revokes write permission in actual open editor session',
  )
  // Offline local draft versus a remote update: must survive and never overwrite silently.
  const contextA = editorA.context()
  await contextA.setOffline(true)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await append(editorA, '-- OFFLINE_LOCAL_DRAFT\n')
  await append(admin, '-- ONLINE_REMOTE_EDIT\n')
  await until(
    async () => (await source()).content.includes('ONLINE_REMOTE_EDIT'),
    'online edit while collaborator offline',
  )
  await contextA.setOffline(false)
  await until(
    async () => (await text(editorA)).includes('OFFLINE_LOCAL_DRAFT'),
    'offline draft remains visible',
  )
  // Resolve only after proving local draft remains; reload may intentionally discard.
  await until(async () => {
    const value = (await source()).content
    return (
      value.includes('OFFLINE_LOCAL_DRAFT') &&
      value.includes('ONLINE_REMOTE_EDIT')
    )
  }, 'offline and online edits both become durable after reconnect')
  record('Offline and online edits survive reconnection and converge durably')
  await contextA.setOffline(true)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await append(editorA, '-- REVOKED_LOCAL_DRAFT\n')
  const revokedMember = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorA.id}`,
    { method: 'DELETE', body: {} },
  )
  assert.equal(revokedMember.status, 200)
  await revokedMember.json()
  await contextA.setOffline(false)
  await editorA
    .getByText('Your access to this project has ended.', { exact: false })
    .waitFor()
  const draftDownload = editorA.waitForEvent('download')
  await editorA
    .getByRole('button', { name: 'Download draft: Main.lean', exact: true })
    .click()
  const draft = await draftDownload
  assert.equal(await draft.failure(), null)
  const chunks = []
  for await (const chunk of await draft.createReadStream()) chunks.push(chunk)
  assert(Buffer.concat(chunks).toString().includes('REVOKED_LOCAL_DRAFT'))
  assert(!(await source()).content.includes('REVOKED_LOCAL_DRAFT'))
  record(
    'Actual membership revocation preserves a local unsaved draft for download without publishing it',
  )
  const persistentChatResponse = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/chats`,
    { method: 'POST', body: { title: 'Private chat retained across restart' } },
  )
  assert.equal(persistentChatResponse.status, 201)
  const persistentChat = await persistentChatResponse.json()

  const keylessAccount = await fixture.studio.auth.createUser(
    fixture.accounts.admin,
    { name: 'Keyless Sharing Viewer' },
  )
  fixture.accounts.keylessViewer = {
    id: keylessAccount.user.id,
    name: keylessAccount.user.name,
    token: keylessAccount.token,
  }
  const keylessLinkResponse = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/links`,
    { method: 'POST', body: { role: 'viewer' } },
  )
  assert.equal(keylessLinkResponse.status, 201)
  const keylessLink = await keylessLinkResponse.json()
  const keyless = await makePage('keylessViewer', {
    url: `${fixture.origin}/#share=${keylessLink.token}`,
  })
  await keyless.getByLabel('Display name', { exact: true }).waitFor()
  assert.equal(
    await keyless.locator('.monaco-editor textarea').count(),
    0,
    'Profile confirmation stays mandatory',
  )
  await keyless
    .getByRole('button', { name: 'Save profile and continue', exact: true })
    .click()
  await keyless.locator('.monaco-editor textarea').first().waitFor()
  await until(
    async () => (await text(keyless)).includes('ONLINE_REMOTE_EDIT'),
    'keyless viewer opens invited shared source',
  )
  assert.equal(
    await keyless.getByLabel('Your Lemex API key', { exact: true }).count(),
    0,
  )
  const keylessProvider = await (
    await fixture.request('keylessViewer', '/api/provider')
  ).json()
  assert.equal(keylessProvider.configured, false)
  const keylessRun = await fixture.request(
    'keylessViewer',
    `/api/projects/${fixture.project.id}/runs`,
    { method: 'POST', body: { mode: 'search', prompt: 'must not run' } },
  )
  assert.equal(keylessRun.status, 403)
  const keylessUpgrade = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.keylessViewer.id}`,
    { method: 'PUT', body: { role: 'editor' } },
  )
  assert.equal(keylessUpgrade.status, 200)
  await keylessUpgrade.json()
  await keyless.getByLabel('Your Lemex API key', { exact: true }).waitFor()
  assert.equal(
    await keyless.locator('.monaco-editor textarea').count(),
    0,
    'Keyless Editor retains provider setup requirement',
  )
  for (let cycle = 0; cycle < 3; cycle++) {
    const downgrade = await fixture.request(
      'admin',
      `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.keylessViewer.id}`,
      { method: 'PUT', body: { role: 'viewer' } },
    )
    assert.equal(downgrade.status, 200)
    await downgrade.json()
    await keyless.locator('.monaco-editor textarea').first().waitFor()
    // Promote as soon as the editor mounts, including pending Lean startup.
    const upgrade = await fixture.request(
      'admin',
      `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.keylessViewer.id}`,
      { method: 'PUT', body: { role: 'editor' } },
    )
    assert.equal(upgrade.status, 200)
    await upgrade.json()
    await keyless.getByLabel('Your Lemex API key', { exact: true }).waitFor()
  }
  record(
    'Keyless invited Viewer confirms their profile, reads without an API key, and survives repeated Editor promotion and Viewer reopen during Lean startup',
  )
  const viewerReturnGrant = await fixture.request(
    'editorB',
    `/api/projects/${fixture.privateProject.id}/sharing/members/${fixture.accounts.keylessViewer.id}`,
    { method: 'PUT', body: { role: 'viewer' } },
  )
  assert.equal(viewerReturnGrant.status, 200)
  await viewerReturnGrant.json()
  await keyless.reload()
  await keyless
    .getByRole('button', {
      name: `Open viewer project: ${fixture.privateProject.name}`,
      exact: true,
    })
    .click()
  await until(
    async () =>
      (await keyless.locator('.workspace-title').innerText()).includes(
        fixture.privateProject.name,
      ),
    'keyless mixed-role return to viewer project',
  )
  await keyless.locator('.monaco-editor textarea').first().waitFor()
  assert.equal(
    await keyless.getByLabel('Your Lemex API key', { exact: true }).count(),
    0,
  )
  record(
    'A keyless account can return from Editor setup to a Viewer project without adding credentials',
  )

  // Use a new account/context after restart; no browser-side mocked state can restore data.
  const beforeRestart = (await source()).content
  await Promise.all(contexts.map((context) => context.close()))
  contexts.length = 0
  await fixture.restart()
  const restarted = await makePage('admin')
  await select(restarted)
  await until(
    async () => (await text(restarted)).includes('ONLINE_REMOTE_EDIT'),
    'durable source after restart',
  )
  assert.equal((await source()).content, beforeRestart)
  assert.equal(
    fixture.studio.workspaces.get(
      fixture.project.id,
      fixture.accounts.editorB.id,
    ).accessRole,
    'viewer',
  )
  const restoredChatResponse = await fixture.request(
    'admin',
    `/api/chats/${persistentChat.id}`,
  )
  assert.equal(restoredChatResponse.status, 200)
  const restoredChat = await restoredChatResponse.json()
  assert.equal(restoredChat.chat.title, 'Private chat retained across restart')
  assert.equal(
    (await fixture.request('editorB', `/api/chats/${persistentChat.id}`))
      .status,
    404,
  )
  record('Source, memberships and private history survive real server restart')
  assert.equal(report.providerCalls, 0)
  assert.deepEqual(report.errors, [])
  report.passed = true
} catch (error) {
  const redactedError = Object.values(fixture?.accounts || {})
    .reduce(
      (value, account) =>
        value.replaceAll(account.token, '[test account token]'),
      String(error.stack),
    )
    .replace(/#share=[A-Za-z0-9_%=-]+/g, '#share=[invitation]')
  report.failure = redactedError
  report.browserState = {}
  for (const [key, page] of Object.entries(pages)) {
    report.browserState[key] = {
      url: page.url().split('#')[0],
      body: (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 4000),
      text: await page
        .locator('.monaco-editor .view-lines')
        .first()
        .innerText()
        .catch(() => ''),
      alerts: await page
        .locator('[role=alert],.error-message,.notice-message')
        .allTextContents()
        .catch(() => []),
      tabs: await page
        .locator('.file-tab')
        .allTextContents()
        .catch(() => []),
    }
  }
  report.durableSource = fixture
    ? (
        await fixture.studio.workspaces
          .readFile(fixture.project.id, fixture.accounts.admin.id, 'Main.lean')
          .catch(() => ({ content: '' }))
      ).content
    : ''
  console.error(redactedError)
  process.exitCode = 1
} finally {
  await Promise.allSettled(contexts.map((context) => context.close()))
  await browser?.close()
  await fixture?.close()
  await fs.writeFile(
    path.join(directory, 'live-browser-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
