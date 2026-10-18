#!/usr/bin/env node
// Isolated account/key saves and refresh recovery. Every API is a fixture.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/settings-recovery-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const models = [{ id: 'fixture-model', name: 'Fixture model' }]
const user = { id: 'settings-owner', name: 'Settings owner', role: 'owner' }
const fixture = await chatBrowserFixture({
  session: {
    user,
    templates: [],
    models,
    savedModels: ['fixture-model'],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [
    { id: 'settings-project', name: 'Settings fixture', status: 'ready' },
  ],
  files: {
    'settings-project': { 'Main.lean': 'example : True := by trivial\n' },
  },
  chats: [
    {
      id: 'settings-chat',
      projectId: 'settings-project',
      title: 'Settings fixture',
    },
  ],
  runs: [],
})
const { page, browser, state, report } = fixture
let provider = {
  configured: true,
  provider: 'rcp',
  baseUrl: 'https://inference.rcp.epfl.ch/v1',
  updatedAt: 'initial',
}
const accounts = [{ ...user, lemex: { configured: true } }]
let releaseAccount
let releaseProvider
let holdProvider = false
let failSession = 0
let failAfterProvider = false
let providerSaves = 0
let failLogout = false
await page.route('**/api/**', async (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  const method = request.method()
  const respond = (value, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    })
  if (endpoint === '/api/session' && failSession > 0) {
    --failSession
    return respond({ error: 'Temporary fixture connection problem.' }, 503)
  }
  if (endpoint === '/api/logout' && failLogout) {
    failLogout = false
    return respond({ error: 'Could not sign out. Please try again.' }, 503)
  }
  if (endpoint === '/api/admin/users') {
    if (method === 'GET') return respond(accounts)
    assert.equal(method, 'POST')
    const body = request.postDataJSON()
    await new Promise((resolve) => {
      releaseAccount = resolve
    })
    const created = {
      id: 'new-fixture-account',
      name: body.name,
      role: body.role,
    }
    accounts.push({ ...created, lemex: { configured: false } })
    return respond({ user: created, token: 'one-time-fixture-token' }, 201)
  }
  if (endpoint === '/api/provider') {
    if (method === 'PUT') {
      if (holdProvider)
        await new Promise((resolve) => {
          releaseProvider = resolve
        })
      ++providerSaves
      provider = {
        ...provider,
        configured: true,
        updatedAt: String(providerSaves),
      }
      state.session.lemex = { configured: true }
      if (failAfterProvider) failSession = 1
    }
    return respond(provider)
  }
  if (endpoint === '/api/settings')
    return respond({
      extraInstructions: '',
      showReasoning: true,
      tools: { lean: true, lean_probe: true, lean_explore: true, exa: true },
    })
  if (endpoint === '/api/models')
    return respond({
      models,
      savedModels: ['fixture-model'],
      defaultModel: 'fixture-model',
    })
  return route.fallback()
})
const settings = () =>
  page.getByRole('dialog', { name: 'Assistant settings', exact: true })
const close = () =>
  settings().getByRole('button', { name: 'Close dialog', exact: true })
async function openSettings() {
  await page
    .getByRole('button', { name: 'Assistant settings', exact: true })
    .click()
  await settings().getByLabel('Your Lemex API key').waitFor()
}
async function assertPendingDialog() {
  assert.equal(await close().isDisabled(), true)
  assert.equal(
    await settings()
      .getByRole('button', { name: 'Save settings', exact: true })
      .isDisabled(),
    true,
  )
  await page.keyboard.press('Escape')
  await page.mouse.click(3, 3)
  assert.equal(await settings().isVisible(), true)
}

try {
  await fixture.ready()
  await page
    .getByLabel('Message Lemex')
    .fill('Keep my question while settings refresh.')
  await openSettings()
  await settings().getByLabel('New account name').fill('Fixture collaborator')
  await settings()
    .getByRole('button', { name: 'Create account and token', exact: true })
    .click()
  await until(() => !!releaseAccount, 'pending account creation')
  await assertPendingDialog()
  assert.equal(
    await settings().getByLabel('Your Lemex API key').isDisabled(),
    true,
  )
  releaseAccount()
  await settings().getByLabel('New sign-in token').waitFor()
  assert.equal(
    await settings().getByLabel('New sign-in token').inputValue(),
    'one-time-fixture-token',
  )
  assert.equal(await close().isEnabled(), true)
  await page.screenshot({
    path: new URL('account-token.png', directory).pathname,
  })
  await close().click()
  report.checks.push(
    'Pending account creation blocks Close, Escape, backdrop, and competing settings saves; its one-time token remains visible after completion',
  )

  await openSettings()
  await settings()
    .getByLabel('Your Lemex API key')
    .fill('fixture-replacement-key')
  holdProvider = true
  failAfterProvider = true
  await settings()
    .getByRole('button', { name: 'Update connection', exact: true })
    .click()
  await until(() => !!releaseProvider, 'pending provider save')
  await assertPendingDialog()
  assert.equal(
    await settings().getByLabel('New account name').isDisabled(),
    true,
  )
  releaseProvider()
  await settings()
    .getByText('Provider and key saved.', { exact: false })
    .waitFor()
  await until(() => close().isEnabled(), 'provider save unlocks dialog')
  await close().click()
  await page
    .getByRole('button', { name: 'Retry workspace refresh', exact: true })
    .waitFor()
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Keep my question while settings refresh.',
  )
  await page
    .getByRole('button', { name: 'Retry workspace refresh', exact: true })
    .click()
  await until(
    () =>
      page
        .getByRole('button', { name: 'Retry workspace refresh', exact: true })
        .count()
        .then((count) => count === 0),
    'workspace refresh recovered',
  )
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Keep my question while settings refresh.',
  )
  report.checks.push(
    'Provider save blocks dismissal; a failed session refresh offers a retry and preserves the current chat draft',
  )

  state.session.lemex = { configured: false }
  holdProvider = false
  await page.reload()
  await page
    .getByRole('heading', { name: 'Welcome, Settings owner.' })
    .waitFor()
  failLogout = true
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'Could not sign out. Please try again.' })
    .waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Sign out', exact: true })
      .isEnabled(),
    true,
  )
  report.checks.push(
    'Onboarding reports a failed sign-out request and keeps the account setup available to retry',
  )
  holdProvider = true
  releaseProvider = undefined
  await page.getByLabel('Your Lemex API key').fill('fixture-onboarding-key')
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  await until(() => !!releaseProvider, 'pending onboarding save')
  assert.equal(
    await page
      .getByRole('button', { name: 'Sign out', exact: true })
      .isDisabled(),
    true,
  )
  releaseProvider()
  await page
    .getByRole('button', { name: 'Retry opening workspace', exact: true })
    .waitFor()
  assert.equal(await page.getByLabel('Your Lemex API key').inputValue(), '')
  await page.screenshot({
    path: new URL('onboarding-refresh-retry.png', directory).pathname,
  })
  await page
    .getByRole('button', { name: 'Retry opening workspace', exact: true })
    .click()
  await page.locator('.monaco-editor').waitFor()
  assert.equal(providerSaves, 2)
  report.checks.push(
    'Onboarding blocks sign-out during key save; a saved connection survives refresh failure and Retry opens the workspace without re-entering the key',
  )
  fixture.assertClean()
  report.inferenceRequests = 0
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
  await page
    .screenshot({ path: new URL('failure.png', directory).pathname })
    .catch(() => {})
} finally {
  releaseAccount?.()
  releaseProvider?.()
  await fs.writeFile(
    new URL('report.json', directory),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks,
      error: report.error,
    }),
  )
  await browser.close()
}
