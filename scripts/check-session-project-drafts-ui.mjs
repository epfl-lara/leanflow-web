#!/usr/bin/env node
// Closed browser/editor fixture; no real projects, credentials or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/session-project-drafts-ui')
await fs.mkdir(output, { recursive: true })
await fs.rm(path.join(output, 'result.json'), { force: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const shared = {
  id: 'shared-draft-project',
  name: 'Shared draft project',
  status: 'ready',
  accessRole: 'editor',
}
const own = {
  id: 'own-draft-project',
  name: 'Other project',
  status: 'ready',
  accessRole: 'admin',
}
const source = '-- saved source\nexample : True := by trivial\n'
const marker = '-- KEEP_PRIVATE_DRAFT\n'
let fixture, collaboration
const checks = []
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: {
        id: 'draft-reviewer',
        name: 'Draft reviewer',
        role: 'user',
        profileComplete: true,
      },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [shared, own],
    files: {
      [shared.id]: { 'Main.lean': source },
      [own.id]: { 'Main.lean': '-- other project\n' },
    },
    chats: [
      { id: 'shared-chat', projectId: shared.id, title: 'Shared chat' },
      { id: 'own-chat', projectId: own.id, title: 'Other chat' },
    ],
    runs: [],
  })
  const { page, state } = fixture
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
            message: 'Use ordinary version-checked saving in this fixture.',
          }),
        )
    })
  })
  await page.route('**/api/provider', (route) =>
    route.fulfill({ json: { configured: false } }),
  )
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      json: {
        extraInstructions: '',
        showReasoning: true,
        tools: {
          lean: true,
          lean_probe: true,
          lean_explore: false,
          exa: false,
        },
      },
    }),
  )
  await page.route(`**/api/projects/${shared.id}/checks`, (route) =>
    route.fulfill({ json: [] }),
  )
  await page.route(
    `**/api/projects/${shared.id}/terminal-recoveries`,
    (route) => route.fulfill({ json: [] }),
  )
  await page.route('**/api/profile', (route) => {
    state.session = {
      ...state.session,
      user: {
        ...state.session.user,
        name: route.request().postDataJSON().name,
      },
    }
    return route.fulfill({ json: { user: state.session.user } })
  })
  await page.route('**/api/project-invitations/join', (route) =>
    route.fulfill({
      status: 404,
      json: { error: 'The project invitation is no longer available.' },
    }),
  )
  state.onSave = ({ respond }) =>
    respond({ error: 'The saved file changed. Your draft is kept.' }, 409)
  const editorText = () =>
    page
      .locator('.monaco-editor .view-lines')
      .first()
      .innerText()
      .then((text) => text.replaceAll('\u00a0', ' '))
  const downloadDraft = () =>
    page
      .locator('.revoked-access-notice')
      .getByRole('button', { name: 'Download draft: Main.lean', exact: true })
  async function renameProfile(name) {
    await page
      .getByRole('button', { name: 'Account settings', exact: true })
      .click()
    const dialog = page.getByRole('dialog', {
      name: 'Assistant settings',
      exact: true,
    })
    await dialog.getByLabel('Display name', { exact: true }).fill(name)
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/projects',
    )
    await dialog
      .getByRole('button', { name: 'Save profile', exact: true })
      .click()
    await dialog.getByText('Profile saved.', { exact: true }).waitFor()
    await refreshed
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    await dialog
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click()
  }
  const selectedId = () =>
    page.evaluate(() => localStorage.getItem('lemex-project'))
  await fixture.ready()
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText(marker)
  await until(
    () => editorText().then((text) => text.includes(marker.trim())),
    'editor draft',
  )
  await page.evaluate((id) => localStorage.setItem('lemex-project', id), own.id)
  await renameProfile('Renamed draft reviewer')
  assert(
    (
      await page.locator('.project-item[aria-current=page]').innerText()
    ).includes(shared.name),
  )
  assert((await editorText()).includes(marker.trim()))
  await page.evaluate(
    (id) => localStorage.setItem('lemex-project', id),
    shared.id,
  )
  checks.push(
    'A profile save keeps the selected project and its unsaved source even if another tab changed the remembered project.',
  )

  state.projects = [own]
  collaboration.send(JSON.stringify({ type: 'access' }))
  await downloadDraft().waitFor()
  await renameProfile('Renamed again')
  assert.equal(
    await selectedId(),
    shared.id,
    'A profile refresh must retain a revoked project with an unsaved draft.',
  )
  await downloadDraft().waitFor()
  const download = page.waitForEvent('download')
  await downloadDraft().click()
  assert.equal(
    await fs.readFile(await (await download).path(), 'utf8'),
    source + marker,
  )
  assert.equal(state.files[shared.id]['Main.lean'], source)
  checks.push(
    'Revoked-access drafts remain downloadable after a profile/session refresh.',
  )

  await page.evaluate(() => {
    location.hash = 'share=expired-fixture-invitation'
  })
  const dismissedRefresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/projects',
  )
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await dismissedRefresh
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  await until(
    () =>
      page.evaluate(
        () => sessionStorage.getItem('lemex-project-invitation') === null,
      ),
    'invitation dismissed',
  )
  assert.equal(await selectedId(), shared.id)
  await downloadDraft().waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  checks.push(
    'Dismissing an unavailable invitation keeps the revoked-project draft.',
  )
  page.once('dialog', (dialog) => void dialog.accept())
  await page.reload()
  await page.locator('.monaco-editor').waitFor()
  await until(
    () => selectedId().then((id) => id === own.id),
    'accessible fallback after fresh reload',
  )
  await until(
    () => editorText().then((text) => text.includes('other project')),
    'fallback project source',
  )
  assert.equal(await page.locator('.revoked-access-notice').count(), 0)
  checks.push(
    'A fresh reload with an inaccessible remembered project selects an accessible fallback.',
  )

  const setupMarker = '-- KEEP_DRAFT_THROUGH_ACCOUNT_SETUP\n'
  const ownSavedSource = state.files[own.id]['Main.lean']
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText(setupMarker)
  await until(
    () => editorText().then((text) => text.includes(setupMarker.trim())),
    'draft before account setup reappears',
  )
  let logoutRequests = 0
  await page.route('**/api/logout', (route) => {
    logoutRequests++
    return route.fulfill({ json: { ok: true } })
  })
  // The settings refresh discovers that the account's provider is no longer
  // configured. All provider traffic stays inside the existing closed fixture.
  state.session = {
    ...state.session,
    lemex: { ...state.session.lemex, configured: false },
  }
  await page
    .getByRole('button', { name: 'Account settings', exact: true })
    .click()
  const settings = page.getByRole('dialog', {
    name: 'Assistant settings',
    exact: true,
  })
  await settings
    .getByLabel('Your Lemex API key', { exact: true })
    .fill('fixture-key-with-no-provider-call')
  await settings
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  const setup = page.locator('.account-setup')
  await setup.waitFor()
  const signOut = setup.getByRole('button', { name: 'Sign out', exact: true })
  const signOutConfirmation = page.getByRole('dialog', {
    name: 'Save your changes?',
    exact: true,
  })
  await signOut.click()
  await until(
    async () => logoutRequests > 0 || (await signOutConfirmation.isVisible()),
    'account setup sign-out decision',
  )
  assert.equal(
    logoutRequests,
    0,
    'account setup must preserve unsaved work before issuing logout',
  )
  const setupDownload = page.waitForEvent('download')
  await signOutConfirmation
    .getByRole('button', { name: 'Download draft: Main.lean', exact: true })
    .click()
  assert.equal(
    await fs.readFile(await (await setupDownload).path(), 'utf8'),
    ownSavedSource + setupMarker,
  )
  await signOutConfirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await signOutConfirmation.waitFor({ state: 'hidden' })
  assert.equal(logoutRequests, 0)
  await setup.waitFor()
  await signOut.click()
  await signOutConfirmation.waitFor()
  await signOutConfirmation
    .getByRole('button', { name: 'Discard edits', exact: true })
    .click()
  await until(() => logoutRequests === 1, 'explicit discard permits sign-out')
  await setup.waitFor({ state: 'hidden' })
  assert.equal(state.files[own.id]['Main.lean'], ownSavedSource)
  checks.push(
    'Account setup sign-out keeps unsaved work downloadable, Cancel preserves the draft without logout, and only explicit discard permits sign-out.',
  )
  fixture.assertClean()
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ passed: true, checks }, null, 2),
  )
  console.log(JSON.stringify({ passed: true, checks }, null, 2))
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
