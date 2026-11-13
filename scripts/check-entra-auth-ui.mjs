#!/usr/bin/env node
// Real React interactions; all accounts, provider pages, projects and Lean are mocked.
// Start the client locally, then set STUDIO_TEST_URL to that disposable server.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/entra-auth-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const projectId = 'entra-project'
const user = {
  id: 'entra-user',
  name: 'EPFL fixture user',
  role: 'user',
  profileComplete: true,
}
const fixture = await chatBrowserFixture({
  base,
  session: {
    user,
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    savedModels: ['fixture-model'],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [{ id: projectId, name: 'EPFL fixture', status: 'ready' }],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: 'entra-chat', projectId, title: 'EPFL fixture' }],
  runs: [],
})
const { page, browser, state, report } = fixture
const context = page.context()
let enabled = false
let authenticated = false
let expired = false
let expireSave = false
let rejectIdentity = false
let failNextSession = false
let omitLinkToken = true
let finalizations = 0
let saves = 0
const starts = []
report.starts = starts
report.popupUrls = []
context.on('page', (popup) => {
  popup.on('request', (request) => {
    if (request.isNavigationRequest()) report.popupUrls.push(request.url())
  })
  popup.on('pageerror', (error) => report.errors.push(error.message))
})

// Intercept at context level so popup requests cannot contact Microsoft.
// Main-page routes take precedence; any unexpected popup API stays isolated.
await context.route('**/api/**', (route) =>
  route.fulfill({
    status: 503,
    json: { error: 'Unexpected popup API request.' },
  }),
)
await context.route('https://login.microsoftonline.com/**', (route) => {
  const attempt = new URL(route.request().url()).searchParams.get('attempt')
  return route.fulfill({
    contentType: 'text/html',
    body: `<script>location.replace(${JSON.stringify(`${base}/__entra-fixture/complete?attempt=${attempt}`)})</script>`,
  })
})
await context.route('**/__entra-fixture/complete?*', (route) => {
  const attempt = Number(
    new URL(route.request().url()).searchParams.get('attempt'),
  )
  assert(Number.isSafeInteger(attempt) && starts[attempt])
  const options = starts[attempt]
  if (!rejectIdentity) {
    authenticated = true
    expired = false
  }
  const message = {
    type: 'leanflow-entra-complete',
    ok: !rejectIdentity,
    ...(options.mode === 'link' &&
      !omitLinkToken && { linkToken: 'l'.repeat(43) }),
    ...(rejectIdentity && {
      error: 'This EPFL sign-in does not match the account you have open.',
    }),
  }
  return route.fulfill({
    contentType: 'text/html',
    body: `<script>window.opener.postMessage(${JSON.stringify(message)}, ${JSON.stringify(new URL(base).origin)}); window.close();</script>`,
  })
})
await page.route('**/api/**', async (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  const respond = (json, status = 200) => route.fulfill({ status, json })
  if (endpoint === '/api/auth/entra') return respond({ enabled })
  if (endpoint === '/api/auth/entra/start') {
    assert.equal(request.method(), 'POST')
    const options = request.postDataJSON()
    if (authenticated || expired) {
      assert.equal(options.expectedUserId, user.id)
      assert.equal(request.headers()['x-leanflow-user'], user.id)
    } else {
      assert.equal(options.expectedUserId, undefined)
      assert.equal(request.headers()['x-leanflow-user'], undefined)
    }
    starts.push(options)
    return respond({
      url: `https://login.microsoftonline.com/fixture/authorize?attempt=${starts.length - 1}`,
    })
  }
  if (endpoint === '/api/auth/entra/link') {
    assert.equal(request.method(), 'POST')
    assert.equal(request.headers()['x-leanflow-user'], user.id)
    assert.deepEqual(request.postDataJSON(), { token: 'l'.repeat(43) })
    finalizations++
    state.session.user.entraLinked = true
    return respond({ ok: true })
  }
  if (endpoint === '/api/login') {
    assert.equal(request.postDataJSON().token, 'fixture-token')
    failNextSession = true
    return respond({ user: { ...user, id: 'stale-account' } })
  }
  if (endpoint === '/api/session') {
    if (failNextSession) {
      failNextSession = false
      assert.equal(request.headers()['x-leanflow-user'], 'stale-account')
      return respond({ error: 'Fixture session unavailable.' }, 503)
    }
    return !authenticated || expired
      ? respond({ error: 'Sign in again.' }, 401)
      : respond(state.session)
  }
  if (endpoint.endsWith('/file') && request.method() === 'PUT') {
    saves++
    if (expireSave) {
      expired = true
      expireSave = false
    }
    if (expired) return respond({ error: 'Session expired.' }, 401)
  }
  if (expired) return respond({ error: 'Session expired.' }, 401)
  if (endpoint === '/api/settings')
    return respond({
      extraInstructions: '',
      showReasoning: true,
      tools: { lean: true, lean_probe: true, lean_explore: true, exa: true },
    })
  if (endpoint === '/api/provider')
    return respond({ configured: true, provider: 'rcp' })
  if (endpoint === '/api/models')
    return respond({
      models: state.session.models,
      savedModels: state.session.savedModels,
      defaultModel: state.session.defaultModel,
    })
  return route.fallback()
})

try {
  await page.goto(base)
  await page.getByLabel('Access token', { exact: true }).waitFor()
  // Wait for the disabled metadata response before checking the absent button.
  await until(
    () =>
      page
        .getByRole('button', { name: 'Open workspace', exact: true })
        .isVisible(),
    'token login',
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Sign in with EPFL', exact: true })
      .count(),
    0,
  )
  report.checks.push(
    'Disabled EPFL sign-in leaves invitation-token login available',
  )
  console.log('PASS: disabled EPFL controls')

  enabled = true
  await page.reload()
  await page.getByLabel('Access token', { exact: true }).fill('fixture-token')
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'Fixture session unavailable.' })
    .waitFor()
  await page
    .getByRole('button', { name: 'Sign in with EPFL', exact: true })
    .click()
  console.log('Checking EPFL popup completion')
  await page.locator('.monaco-editor').waitFor({ timeout: 60000 })
  await page
    .locator('.editor-loading')
    .waitFor({ state: 'hidden', timeout: 60000 })
  assert.equal(starts[0].mode, 'login')
  report.checks.push('EPFL popup login opens the existing workspace')
  report.checks.push(
    'Failed token session loading does not bind subsequent EPFL login to a stale account',
  )

  await page
    .getByRole('button', { name: 'Assistant settings', exact: true })
    .click()
  const settings = page.getByRole('dialog', {
    name: 'Assistant settings',
    exact: true,
  })
  await settings
    .getByRole('button', { name: 'Link EPFL account', exact: true })
    .click()
  await settings
    .getByRole('alert')
    .filter({ hasText: 'could not be linked' })
    .waitFor()
  assert.equal(finalizations, 0)
  assert.equal(state.session.user.entraLinked, undefined)
  omitLinkToken = false
  await settings
    .getByRole('button', { name: 'Link EPFL account', exact: true })
    .click()
  await settings
    .getByText('Your EPFL account is linked for sign-in.', { exact: true })
    .waitFor()
  const closeSettings = settings.getByRole('button', {
    name: 'Close dialog',
    exact: true,
  })
  await until(
    () => closeSettings.isEnabled(),
    'linking releases the settings dialog',
  )
  assert.equal(starts[1].mode, 'link')
  assert.equal(finalizations, 1)
  assert.equal(state.session.user.id, user.id)
  assert.equal(state.session.user.role, 'user')
  await closeSettings.click()
  report.checks.push(
    'Explicit linking retains the account and leaves settings responsive',
  )

  const composer = page.getByLabel('Message Lemex')
  const draft = 'Preserve my draft during EPFL renewal.'
  await composer.fill(draft)
  await page.evaluate(() => {
    window.__entraEditor = document.querySelector('.monaco-editor')
  })
  expireSave = true
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('-- EPFL unsaved marker\n')
  const recovery = page.getByRole('dialog', {
    name: 'Sign in to continue',
    exact: true,
  })
  await recovery.waitFor()
  rejectIdentity = true
  await recovery
    .getByRole('button', { name: 'Sign in with EPFL', exact: true })
    .click()
  await recovery
    .getByRole('alert')
    .filter({ hasText: 'does not match' })
    .waitFor()
  assert.equal(await composer.inputValue(), draft)
  assert.equal(await page.locator('.file-toolbar .dirty-dot').count(), 1)
  assert.equal(saves, 1)
  report.checks.push(
    'A different EPFL identity cannot restore the workspace or discard drafts',
  )

  rejectIdentity = false
  await recovery
    .getByRole('button', { name: 'Sign in with EPFL', exact: true })
    .click()
  await recovery.waitFor({ state: 'hidden' })
  assert.equal(await composer.inputValue(), draft)
  assert.equal(await page.locator('.file-toolbar .dirty-dot').count(), 1)
  assert.equal(saves, 1, 'Renewal must not replay a failed save')
  assert(
    await page.evaluate(
      () => window.__entraEditor === document.querySelector('.monaco-editor'),
    ),
  )
  assert.equal(starts.length, 5)
  fixture.assertClean()
  report.checks.push(
    'Same-account EPFL renewal preserves the editor and unsent draft without replaying writes',
  )
  report.passed = true
  console.log(
    `PASS: ${report.checks.length} EPFL sign-in browser checks; identity provider and workspace mocked`,
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
  await page
    .screenshot({ path: new URL('failure.png', directory).pathname })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    new URL('result.json', directory),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
