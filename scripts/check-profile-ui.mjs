#!/usr/bin/env node
// Closed browser fixtures: no real accounts, credentials, providers, or proofs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/profile-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const fixture = await chatBrowserFixture({
  session: {
    user: {
      id: 'profile-fixture-user',
      name: 'Invited user',
      role: 'user',
      profileComplete: false,
    },
    templates: [],
    models: [{ id: 'fixture/model', name: 'Fixture model' }],
    defaultModel: 'fixture/model',
    savedModels: ['fixture/model'],
    runtime: { ready: true },
    lemex: { configured: false },
  },
  projects: [
    { id: 'profile-project', name: 'Profile fixture', status: 'ready' },
  ],
  files: {
    'profile-project': { 'Main.lean': 'example : True := by trivial\n' },
  },
  chats: [
    {
      id: 'profile-chat',
      projectId: 'profile-project',
      title: 'Profile fixture',
    },
  ],
  runs: [],
})
const { page, browser, state, report } = fixture
const originalId = state.session.user.id
let authenticated = false
let profileAttempts = 0
let providerSaves = 0
let failProfile = true
let expireProfile = false
let holdProfile = false
let releaseProfile
let holdSession = false
let releaseSession
await page.route('**/api/**', async (route) => {
  const endpoint = new URL(route.request().url()).pathname
  const method = route.request().method()
  const respond = (value, status = 200) =>
    route.fulfill({ status, json: value })
  if (endpoint === '/api/session') {
    if (!authenticated) return respond({ error: 'Please sign in.' }, 401)
    const snapshot = structuredClone(state.session)
    if (holdSession) {
      snapshot.models = snapshot.models.map((model) => ({
        ...model,
        name: `${model.name} (refreshed)`,
      }))
      await new Promise((resolve) => {
        releaseSession = resolve
      })
    }
    return respond(snapshot)
  }
  if (endpoint === '/api/login') {
    const body = route.request().postDataJSON()
    assert.equal(body.token, 'fixture-invitation-token')
    if (body.expectedUserId !== undefined)
      assert.equal(body.expectedUserId, originalId)
    authenticated = true
    return respond({ user: state.session.user })
  }
  if (endpoint === '/api/logout') {
    authenticated = false
    return respond({ ok: true })
  }
  if (endpoint === '/api/profile') {
    assert.equal(method, 'PUT')
    const body = route.request().postDataJSON()
    assert.deepEqual(Object.keys(body), ['name'])
    profileAttempts++
    if (expireProfile) {
      expireProfile = false
      authenticated = false
      return respond({ error: 'Please sign in.' }, 401)
    }
    if (holdProfile)
      await new Promise((resolve) => {
        releaseProfile = resolve
      })
    if (failProfile) {
      failProfile = false
      return respond(
        { error: 'Could not save your profile. Please try again.' },
        503,
      )
    }
    state.session.user = {
      ...state.session.user,
      name: body.name,
      profileComplete: true,
    }
    return respond({ user: state.session.user })
  }
  if (endpoint === '/api/provider') {
    if (method === 'PUT') {
      assert.equal(
        route.request().postDataJSON().apiKey,
        'fixture-provider-key',
      )
      providerSaves++
      state.session.lemex = { configured: true }
    }
    return respond({
      configured: state.session.lemex.configured,
      provider: 'rcp',
    })
  }
  if (endpoint === '/api/settings')
    return respond({
      extraInstructions: '',
      showReasoning: true,
      tools: { lean: true, lean_probe: true, lean_explore: true, exa: true },
    })
  if (endpoint === '/api/models' || endpoint === '/api/models/refresh')
    return respond({
      models: state.session.models,
      defaultModel: state.session.defaultModel,
      savedModels: state.session.savedModels,
    })
  return route.fallback()
})
const settings = () =>
  page.getByRole('dialog', { name: 'Assistant settings', exact: true })
const login = async () => {
  await page
    .getByLabel('Access token', { exact: true })
    .fill('fixture-invitation-token')
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
}
try {
  await page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090')
  const contact = page.getByRole('link', { name: 'lazar.milikic@epfl.ch' })
  await contact.waitFor()
  assert.equal(
    await contact.getAttribute('href'),
    'mailto:lazar.milikic@epfl.ch',
  )
  await login()
  await page.getByLabel('Display name', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('Your Lemex API key').count(), 0)
  await page
    .getByLabel('Display name', { exact: true })
    .fill('Invited user draft')
  expireProfile = true
  await page
    .getByRole('button', { name: 'Save profile and continue', exact: true })
    .click()
  const recovery = page.getByRole('dialog', {
    name: 'Sign in to continue',
    exact: true,
  })
  await recovery
    .getByLabel('Access token', { exact: true })
    .fill('fixture-invitation-token')
  await recovery
    .getByRole('button', { name: 'Continue in workspace', exact: true })
    .click()
  await recovery.waitFor({ state: 'hidden' })
  assert.equal(
    await page.getByLabel('Display name', { exact: true }).inputValue(),
    'Invited user draft',
  )
  await page.getByLabel('Display name', { exact: true }).fill('Invited user')
  await page
    .getByRole('button', { name: 'Save profile and continue', exact: true })
    .click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'Could not save your profile.' })
    .waitFor()
  assert.equal(
    await page.getByLabel('Display name', { exact: true }).inputValue(),
    'Invited user',
  )
  holdProfile = true
  await page
    .getByRole('button', { name: 'Save profile and continue', exact: true })
    .click()
  await until(() => !!releaseProfile, 'profile save pending')
  assert.equal(
    await page
      .getByRole('button', { name: 'Sign out', exact: true })
      .isDisabled(),
    true,
  )
  releaseProfile()
  holdProfile = false
  releaseProfile = undefined
  await page.getByLabel('Your Lemex API key').waitFor()
  assert.equal(state.session.user.name, 'Invited user')
  assert.equal(state.session.user.profileComplete, true)
  await page.getByLabel('Your Lemex API key').fill('fixture-provider-key')
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  await page.locator('.monaco-editor').waitFor()
  report.checks.push(
    'Landing page offers email access requests; invitation login confirms the profile before API setup, supports unchanged names and save retry, and blocks sign-out during saving.',
  )

  await page
    .getByLabel('Message Lemex')
    .fill('Keep this draft while I rename my account.')
  await page
    .getByRole('button', { name: 'Account settings', exact: true })
    .click()
  await settings().getByLabel('Account ID', { exact: true }).waitFor()
  assert.equal(
    await settings().getByLabel('Account ID', { exact: true }).inputValue(),
    originalId,
  )
  assert.equal(
    await settings()
      .getByLabel('Account ID', { exact: true })
      .getAttribute('readonly'),
    '',
  )
  await settings()
    .getByRole('button', { name: 'Copy account ID', exact: true })
    .waitFor()
  await page.screenshot({
    path: new URL('account-settings.png', directory).pathname,
  })
  holdSession = true
  await settings()
    .getByRole('button', { name: 'Refresh models', exact: true })
    .click()
  await until(() => !!releaseSession, 'model refresh waiting for session')
  await settings()
    .getByLabel('Display name', { exact: true })
    .fill('Renamed collaborator')
  holdProfile = true
  await settings()
    .getByRole('button', { name: 'Save profile', exact: true })
    .click()
  await until(() => !!releaseProfile, 'settings profile save pending')
  assert.equal(
    await settings()
      .getByRole('button', { name: 'Close dialog', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await settings().getByLabel('Your Lemex API key').isDisabled(),
    true,
  )
  await page.keyboard.press('Escape')
  assert.equal(await settings().isVisible(), true)
  releaseProfile()
  holdProfile = false
  releaseProfile = undefined
  await settings().getByText('Profile saved.', { exact: true }).waitFor()
  const staleSession = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/session',
  )
  releaseSession()
  holdSession = false
  releaseSession = undefined
  await staleSession
  assert.equal(
    await settings().getByLabel('Account ID', { exact: true }).inputValue(),
    originalId,
  )
  await settings()
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  await page
    .locator('.chat-options summary')
    .filter({ hasText: 'Fixture model (refreshed)' })
    .waitFor()
  assert.match(
    await page
      .getByRole('button', { name: 'Account settings', exact: true })
      .innerText(),
    /Renamed collaborator/,
  )
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Keep this draft while I rename my account.',
  )
  await page.screenshot({
    path: new URL('profile-updated.png', directory).pathname,
  })
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await login()
  await page.locator('.monaco-editor').waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Save profile and continue', exact: true })
      .count(),
    0,
  )
  assert.equal(state.session.user.id, originalId)
  assert.equal(providerSaves, 1)
  assert.equal(profileAttempts, 4)
  report.checks.push(
    'The account button opens profile and API settings; renaming preserves the account ID, connection, and chat draft, survives a delayed model refresh, blocks competing saves, and persists across sign-out and login.',
  )

  state.session.models = []
  state.session.lemex.modelError = 'Fixture model discovery unavailable.'
  await page.reload()
  await page
    .getByRole('button', { name: 'Open API key settings', exact: true })
    .click()
  await settings().getByLabel('Your Lemex API key').waitFor()
  report.checks.push('Model-loading errors open API settings directly.')
  fixture.assertClean()
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
  await page
    .screenshot({ path: new URL('failure.png', directory).pathname })
    .catch(() => {})
} finally {
  releaseProfile?.()
  releaseSession?.()
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
