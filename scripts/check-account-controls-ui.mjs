#!/usr/bin/env node
// Account controls use real React interactions and a closed, persistent API fixture.
// No real accounts, credentials, projects, providers, or model calls are used.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/account-controls-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const users = {
  owner: { id: 'controls-owner', name: 'Controls owner', role: 'owner' },
  admin: { id: 'controls-admin', name: 'Controls admin', role: 'admin' },
  user: { id: 'controls-user', name: 'Controls user', role: 'user' },
}
const projectId = 'account-controls-project'
const initialSource = 'example : True := by trivial\n'
const initialModels = [
  { id: 'fixture/default', name: 'Default fixture model' },
  { id: 'fixture/optional', name: 'Optional fixture model' },
]
const fixture = await chatBrowserFixture({
  session: {
    user: users.owner,
    templates: [],
    models: initialModels,
    savedModels: ['fixture/default'],
    defaultModel: 'fixture/default',
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [
    { id: projectId, name: 'Account controls fixture', status: 'ready' },
  ],
  files: { [projectId]: { 'Main.lean': initialSource } },
  chats: [
    { id: 'controls-chat', projectId, title: 'Account controls fixture' },
  ],
  runs: [],
})
const { page, browser, state, report } = fixture
const settingsFor = () => ({
  extraInstructions: '',
  showReasoning: true,
  tools: { lean: true, lean_probe: true, lean_explore: true, exa: true },
  basePrompt:
    'Fixture proof guidance: verify each declaration before claiming success.',
})
const savedSettings = new Map(
  Object.values(users).map((user) => [user.id, settingsFor()]),
)
const accounts = Object.values(users).map((user) => ({
  ...user,
  lemex: { configured: true },
}))
const access = () => ({
  models: state.session.models,
  savedModels: state.session.savedModels,
  defaultModel: state.session.defaultModel,
})
let authenticated = false
let loginCount = 0
let logoutCount = 0
let failLogout = false
let settingsWrites = 0
let settingsAttempts = 0
let failSettings = false
let holdSettings = false
let releaseSettings
let refreshAttempts = 0
let failRefresh = true
let accountAttempts = 0
let failAccount = false
let adminLists = 0
let rejectSourceSave = false
const createdAccounts = []
state.onSave = ({ respond, save }) =>
  rejectSourceSave
    ? respond({ error: 'Fixture save capacity is temporarily full.' }, 429)
    : save()

await page.route('**/api/**', async (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  const method = request.method()
  const respond = (value, status = 200) =>
    route.fulfill({ status, json: value })
  if (endpoint === '/api/session')
    return authenticated
      ? respond(state.session)
      : respond({ error: 'Please sign in.' }, 401)
  if (endpoint === '/api/login' && method === 'POST') {
    const body = request.postDataJSON()
    assert.deepEqual(Object.keys(body), ['token'])
    loginCount++
    const role = Object.keys(users).find(
      (role) => body.token === `fixture-${role}-login-token`,
    )
    if (!role)
      return respond({ error: 'That access token was not recognized.' }, 401)
    authenticated = true
    state.session.user = users[role]
    return respond({ user: users[role] })
  }
  if (endpoint === '/api/logout' && method === 'POST') {
    if (failLogout) {
      failLogout = false
      return respond({ error: 'Could not sign out. Please try again.' }, 503)
    }
    logoutCount++
    authenticated = false
    return respond({ ok: true })
  }
  if (endpoint === '/api/provider')
    return respond({
      configured: true,
      provider: 'rcp',
      baseUrl: 'https://inference.rcp.epfl.ch/v1',
      updatedAt: 'fixture',
    })
  if (endpoint === '/api/settings') {
    const previous = savedSettings.get(state.session.user.id)
    if (method === 'GET') return respond(previous)
    assert.equal(method, 'PUT')
    const body = request.postDataJSON()
    settingsAttempts++
    assert.deepEqual(Object.keys(body).sort(), [
      'extraInstructions',
      'showReasoning',
      'tools',
    ])
    if (holdSettings)
      await new Promise((resolve) => {
        releaseSettings = resolve
      })
    if (failSettings) {
      failSettings = false
      return respond({ error: 'Settings could not be saved. Try again.' }, 503)
    }
    savedSettings.set(state.session.user.id, { ...previous, ...body })
    settingsWrites++
    return respond(savedSettings.get(state.session.user.id))
  }
  if (endpoint === '/api/models') return respond(access())
  if (endpoint === '/api/models/refresh' && method === 'POST') {
    refreshAttempts++
    if (failRefresh) {
      failRefresh = false
      return respond(
        { error: 'Model discovery is temporarily unavailable. Retry refresh.' },
        503,
      )
    }
    state.session.models = [
      ...initialModels,
      { id: 'fixture/new', name: 'Newly available fixture model' },
    ]
    return respond(access())
  }
  if (endpoint === '/api/models/preferences' && method === 'PUT') {
    state.session.savedModels = request.postDataJSON().savedModels
    return respond(access())
  }
  if (endpoint === '/api/admin/users') {
    assert(
      ['owner', 'admin'].includes(state.session.user.role),
      'Ordinary accounts must not request account administration',
    )
    if (method === 'GET') {
      adminLists++
      return respond(accounts)
    }
    assert.equal(method, 'POST')
    accountAttempts++
    const body = request.postDataJSON()
    assert.deepEqual(Object.keys(body).sort(), ['name', 'role'])
    if (state.session.user.role === 'admin') assert.equal(body.role, 'user')
    if (failAccount) {
      failAccount = false
      return respond(
        { error: 'Account creation is temporarily unavailable. Please retry.' },
        503,
      )
    }
    const created = { id: `controls-invite-${createdAccounts.length}`, ...body }
    createdAccounts.push(created)
    accounts.push({ ...created, lemex: { configured: false } })
    return respond(
      { user: created, token: `fixture-invite-token-${created.id}` },
      201,
    )
  }
  return route.fallback()
})

const settings = () =>
  page.getByRole('dialog', { name: 'Assistant settings', exact: true })
const settingsSave = () =>
  settings().getByRole('button', { name: 'Save settings', exact: true })
const settingsClose = () =>
  settings().getByRole('button', { name: 'Close dialog', exact: true })
const modelSection = () =>
  settings().getByRole('region', { name: 'Model access', exact: true })
async function readyEditor() {
  await page.locator('.monaco-editor').waitFor()
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
}
async function openSettings() {
  await page
    .getByRole('button', { name: 'Assistant settings', exact: true })
    .click()
  await settings()
    .getByLabel('Additional instructions', { exact: true })
    .waitFor()
  await modelSection()
    .getByRole('button', { name: 'Refresh models', exact: true })
    .waitFor()
}
async function login(role) {
  await page
    .getByLabel('Access token', { exact: true })
    .fill(` fixture-${role}-login-token `)
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await readyEditor()
}
async function assertNoStoredTokens() {
  const stored = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  )
  assert(!stored.includes('login-token'))
  assert(!stored.includes('fixture-invite-token'))
}
async function append(text) {
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await page.keyboard.insertText(text)
  await until(
    () => page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
    'dirty source',
  )
}

try {
  await page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090')
  const token = page.getByLabel('Access token', { exact: true })
  await token.waitFor()
  assert.equal(await token.getAttribute('type'), 'password')
  assert(
    await page
      .getByRole('button', { name: 'Open workspace', exact: true })
      .isDisabled(),
  )
  await token.fill('fixture-invalid-token')
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await page
    .getByRole('alert')
    .getByText('That access token was not recognized.', { exact: true })
    .waitFor()
  assert.equal(await page.locator('.monaco-editor').count(), 0)
  await login('owner')
  assert.equal(loginCount, 2)
  await assertNoStoredTokens()
  report.checks.push(
    'Initial sign-in masks the token, disables empty submission, explains invalid tokens, trims a valid token and opens the workspace without storing it in browser storage.',
  )

  await openSettings()
  await settings()
    .getByLabel('Additional instructions', { exact: true })
    .fill('Prefer short named lemmas and include the relevant hypotheses.')
  for (const label of [
    'Reasoning traces',
    'Lean tools',
    'LeanProbe',
    'LeanExplore',
    'Web search',
  ])
    await settings()
      .getByRole('checkbox', { name: new RegExp(`^${label}`) })
      .uncheck()
  await settings().getByText('Built-in proof guidance', { exact: true }).click()
  await settings()
    .getByText(settingsFor().basePrompt, { exact: true })
    .waitFor()
  holdSettings = true
  await settingsSave().click()
  await until(() => !!releaseSettings, 'pending settings write')
  assert(await settingsClose().isDisabled())
  assert(
    await settings()
      .getByLabel('Additional instructions', { exact: true })
      .isDisabled(),
  )
  await page.keyboard.press('Escape')
  assert(await settings().isVisible())
  holdSettings = false
  releaseSettings()
  releaseSettings = undefined
  await settings().waitFor({ state: 'hidden' })
  assert.equal(settingsWrites, 1)
  assert.deepEqual(savedSettings.get(users.owner.id).tools, {
    lean: false,
    lean_probe: false,
    lean_explore: false,
    exa: false,
  })
  await page.reload()
  await readyEditor()
  await openSettings()
  assert.equal(
    await settings().getByLabel('Additional instructions').inputValue(),
    savedSettings.get(users.owner.id).extraInstructions,
  )
  for (const label of [
    'Reasoning traces',
    'Lean tools',
    'LeanProbe',
    'LeanExplore',
    'Web search',
  ])
    assert.equal(
      await settings()
        .getByRole('checkbox', { name: new RegExp(`^${label}`) })
        .isChecked(),
      false,
    )
  report.checks.push(
    'Save settings persists additional instructions, reasoning capture and all four tool switches across reload; its pending write locks controls and dismissal, and proof guidance expands.',
  )

  await settings()
    .getByLabel('Additional instructions')
    .fill('This cancelled edit must not be saved.')
  await settings().getByRole('button', { name: 'Cancel', exact: true }).click()
  await openSettings()
  assert(
    !(
      await settings().getByLabel('Additional instructions').inputValue()
    ).includes('cancelled'),
  )
  await settings()
    .getByLabel('Additional instructions')
    .fill('Retain this instruction through a failed save.')
  failSettings = true
  await settingsSave().click()
  await settings()
    .getByRole('alert')
    .getByText('Settings could not be saved. Try again.', { exact: true })
    .waitFor()
  assert.equal(
    await settings().getByLabel('Additional instructions').inputValue(),
    'Retain this instruction through a failed save.',
  )
  assert(await settingsSave().isEnabled())
  await settingsSave().click()
  await settings().waitFor({ state: 'hidden' })
  assert.equal(settingsAttempts, 3)
  assert.equal(settingsWrites, 2)
  report.checks.push(
    'Cancel leaves saved settings unchanged; a rejected settings save retains the draft, reports the failure and succeeds once when retried.',
  )

  await openSettings()
  await modelSection()
    .getByRole('button', { name: 'Refresh models', exact: true })
    .click()
  await modelSection()
    .getByRole('alert')
    .getByText('Model discovery is temporarily unavailable. Retry refresh.', {
      exact: true,
    })
    .waitFor()
  await modelSection()
    .getByRole('button', { name: 'Refresh models', exact: true })
    .click()
  await modelSection()
    .getByText(/1 saved models · 3 available/)
    .waitFor()
  assert.equal(refreshAttempts, 2)
  await modelSection()
    .getByRole('button', { name: 'Edit saved models', exact: true })
    .click()
  const library = page.getByRole('dialog', { name: 'Your models', exact: true })
  await library
    .getByRole('checkbox', { name: /^Newly available fixture model/ })
    .check()
  await library
    .getByRole('button', { name: 'Save models', exact: true })
    .click()
  await library.waitFor({ state: 'hidden' })
  assert.deepEqual(state.session.savedModels, [
    'fixture/default',
    'fixture/new',
  ])
  await modelSection()
    .getByText(/2 saved models · 3 available/)
    .waitFor()
  assert.equal(state.session.defaultModel, 'fixture/default')
  await settingsClose().click()
  await page.reload()
  await readyEditor()
  await openSettings()
  await modelSection()
    .getByRole('button', { name: 'Edit saved models', exact: true })
    .click()
  assert(
    await library
      .getByRole('checkbox', { name: /^Newly available fixture model/ })
      .isChecked(),
  )
  await library.getByRole('button', { name: 'Cancel', exact: true }).click()
  report.checks.push(
    'Model refresh explains an error and retries; newly available models can be saved from Assistant settings and remain selected after reload without changing the default model.',
  )

  const createAccount = () =>
    settings().getByRole('button', {
      name: 'Create account and token',
      exact: true,
    })
  assert(await createAccount().isDisabled())
  await settings().getByLabel('New account name').fill('Invited administrator')
  await settings().getByLabel('Role', { exact: true }).selectOption('admin')
  failAccount = true
  await createAccount().click()
  await settings()
    .getByRole('alert')
    .getByText('Account creation is temporarily unavailable. Please retry.', {
      exact: true,
    })
    .waitFor()
  assert.equal(
    await settings().getByLabel('New account name').inputValue(),
    'Invited administrator',
  )
  assert.equal(await settings().getByLabel('New sign-in token').count(), 0)
  assert.equal(createdAccounts.length, 0)
  await createAccount().click()
  await settings().getByLabel('New sign-in token').waitFor()
  assert.deepEqual(createdAccounts[0], {
    id: 'controls-invite-0',
    name: 'Invited administrator',
    role: 'admin',
  })
  const newToken = settings().getByLabel('New sign-in token')
  assert.equal(
    await newToken.inputValue(),
    'fixture-invite-token-controls-invite-0',
  )
  assert.equal(await newToken.getAttribute('readonly'), '')
  await newToken.focus()
  assert.deepEqual(
    await newToken.evaluate((input) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
    [0, (await newToken.inputValue()).length],
  )
  await settings()
    .getByRole('button', { name: 'Hide token', exact: true })
    .click()
  assert.equal(await settings().getByLabel('New sign-in token').count(), 0)
  await settingsClose().click()
  await openSettings()
  assert.equal(await settings().getByLabel('New sign-in token').count(), 0)
  assert.equal(accountAttempts, 2)
  await settingsClose().click()
  await assertNoStoredTokens()
  report.checks.push(
    'An owner can invite an administrator; failed creation preserves the form and creates no account. Retry returns a selectable read-only one-time token, and Hide token removes it without revealing it on reopen or storing it locally.',
  )

  rejectSourceSave = true
  await append('-- keep this draft when cancelling sign-out\n')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  const unsaved = page.getByRole('dialog', {
    name: 'Save your changes?',
    exact: true,
  })
  await unsaved.waitFor()
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(logoutCount, 0)
  assert(
    (await page.locator('.view-lines').innerText())
      .replaceAll('\u00a0', ' ')
      .includes('cancelling sign-out'),
  )
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await unsaved
    .getByRole('button', { name: 'Discard edits', exact: true })
    .click()
  await token.waitFor()
  assert.equal(logoutCount, 1)
  assert.equal(state.files[projectId]['Main.lean'], initialSource)
  assert.equal(await token.inputValue(), '')
  rejectSourceSave = false
  await page.reload()
  await token.waitFor()
  assert.equal(await page.locator('.monaco-editor').count(), 0)
  report.checks.push(
    'Signing out protects a dirty source even when autosave is temporarily rejected: Cancel keeps the draft; Discard signs out without saving it, clears the sign-in form, and stays signed out after reload.',
  )

  await login('admin')
  await openSettings()
  assert.equal(await settings().getByLabel('Role', { exact: true }).count(), 0)
  await settings().getByLabel('New account name').fill('Invited ordinary user')
  await createAccount().click()
  await settings().getByLabel('New sign-in token').waitFor()
  assert.deepEqual(createdAccounts[1], {
    id: 'controls-invite-1',
    name: 'Invited ordinary user',
    role: 'user',
  })
  await settings()
    .getByRole('button', { name: 'Hide token', exact: true })
    .click()
  await settingsClose().click()
  rejectSourceSave = true
  await append('-- saved before signing out\n')
  await page
    .getByLabel('Message Lemex')
    .fill('Keep this question until sign-out succeeds.')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await unsaved.waitFor()
  rejectSourceSave = false
  failLogout = true
  await unsaved
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'Could not sign out. Please try again.' })
    .waitFor()
  assert.equal(logoutCount, 1)
  assert.equal(authenticated, true)
  assert.equal(await token.count(), 0)
  assert.equal(await unsaved.count(), 0)
  assert.equal(
    state.files[projectId]['Main.lean'],
    initialSource + '-- saved before signing out\n',
  )
  assert(
    (await page.locator('.view-lines').innerText())
      .replaceAll('\u00a0', ' ')
      .includes('saved before signing out'),
  )
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Keep this question until sign-out succeeds.',
  )
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await token.waitFor()
  assert.equal(logoutCount, 2)
  report.checks.push(
    'An administrator can invite an ordinary user but has no administrator-role selector; Save & continue writes the source first. Failed sign-out keeps the authenticated workspace, saved source and chat draft available; dismissing the error and retrying signs out.',
  )

  await login('user')
  const listsBefore = adminLists
  await openSettings()
  assert.equal(await settings().getByLabel('New account name').count(), 0)
  assert.equal(
    await settings()
      .getByRole('button', { name: 'Create account and token', exact: true })
      .count(),
    0,
  )
  assert.equal(adminLists, listsBefore)
  await settingsClose().click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await token.waitFor()
  assert.equal(logoutCount, 3)
  await assertNoStoredTokens()
  report.checks.push(
    'Ordinary users have personal settings without account-administration controls or admin API requests; a clean workspace signs out directly.',
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
  releaseSettings?.()
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
