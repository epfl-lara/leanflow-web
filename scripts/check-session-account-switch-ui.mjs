#!/usr/bin/env node
// Real isolated auth, HTTP and private chat storage. Lean and agent execution are
// fixtures; the provider is never called. Exercises actual two-tab UI account switching.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { createStudio } from '../server/studio.mjs'
import { fixtureModelDiscovery } from '../server/tests/fixtures/model-discovery.mjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/session-account-switch-ui')
await fs.mkdir(output, { recursive: true })
const dataDir = await fs.mkdtemp(path.join(output, 'data-'))
const dist = process.env.STUDIO_TEST_DIST || path.resolve('client/dist')
const app = express()
app.use(express.static(dist))
const assets = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
let studio, fixture
const result = { checks: [] }
try {
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async run(root, args) {
      if (args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'lake' && args[1] === 'update')
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      return {
        code: 0,
        stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '',
        stderr: '',
      }
    },
  }
  studio = await createStudio({
    dataDir,
    runtime,
    modelDiscoverer: fixtureModelDiscovery,
    titleGenerator: async () => null,
    config: {
      models: [{ id: 'fixture-model' }],
      defaultModel: 'fixture-model',
      provider: { LEMEX_BASE_URL: 'https://provider.example/v1' },
      lemex: {},
      redact: String,
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${studio.server.address().port}`
  const owner = {
    id: 'owner',
    name: 'Account Alpha',
    token: (
      await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
    ).trim(),
  }
  await studio.auth.updateProfile(owner, { name: owner.name })
  const created = await studio.auth.createUser(owner, { name: 'Account Beta' })
  const beta = {
    id: created.user.id,
    name: 'Account Beta',
    token: created.token,
  }
  await studio.auth.updateProfile(beta, { name: beta.name })
  for (const user of [owner, beta])
    await studio.providers.save(
      user.id,
      `offline-${user.id}`,
      'https://provider.example/v1',
    )
  const project = await studio.workspaces.create(owner.id, {
    name: 'Shared switch fixture',
    preset: 'lean',
    autoRepair: false,
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, owner.id).status, 'ready')
  const grant = await fetch(
    origin + `/api/projects/${project.id}/sharing/members/${beta.id}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'editor' }),
    },
  )
  assert.equal(grant.status, 200)
  const alphaChat = studio.chats.create(owner.id, project.id, {
    title: 'Alpha private chat',
  })
  studio.chats.create(beta.id, project.id, {
    title: 'BETA_PRIVATE_CHAT_SENTINEL',
  })
  const sent = []
  studio.agents.start = async (actor, projectId, body) => {
    sent.push({ actor, projectId, prompt: body.prompt, chatId: body.chatId })
    const run = studio.events.create(actor, {
      ...body,
      kind: 'agent',
      projectId,
    })
    studio.events.updateMetadata(run.id, {
      status: 'failed',
      error: 'Isolated audit stopped before provider execution.',
    })
    return studio.events.getMetadata(run.id, actor)
  }
  fixture = await chatBrowserFixture({
    base: origin,
    session: { user: owner, templates: [], models: [{ id: 'fixture-model' }] },
    projects: [project],
    files: { [project.id]: { 'Main.lean': 'example : True := by trivial\n' } },
    chats: [alphaChat],
    runs: [],
  })
  const { page, browser, report } = fixture
  await page.route('**/api/**', (route) => route.continue())
  const assetMatcher = (url) =>
    !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/websocket/')
  const assetHandler = async (route) => {
    const url = new URL(route.request().url())
    url.port = String(assets.address().port)
    const response = await route.fetch({ url: url.href })
    await route.fulfill({ response })
  }
  await page.route(assetMatcher, assetHandler)
  await page.routeWebSocket('**/websocket/collaboration/**', (socket) => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'open')
        socket.send(
          JSON.stringify({
            type: 'error',
            path: message.path,
            status: 429,
            message: 'Fixture uses version-checked saving.',
          }),
        )
    })
  })
  const login = await page.context().request.post(origin + '/api/login', {
    data: { token: owner.token },
    headers: { Origin: origin },
  })
  assert.equal(login.status(), 200)
  await fixture.ready()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  const draft = 'ALPHA_PRIVATE_UNSENT_DRAFT_SENTINEL'
  await page.getByLabel('Message Lemex').fill(draft)
  assert((await page.locator('.user-name').innerText()).includes('Alpha'))
  // Actual second-tab UI sign-out and Beta sign-in, sharing browser cookies.
  const second = await page.context().newPage()
  await second.route(assetMatcher, assetHandler)
  await second.routeWebSocket('**/websocket/**', (socket) =>
    socket.close({
      code: 1000,
      reason: 'No editor worker in isolated account probe',
    }),
  )
  await second.goto(origin)
  await second.getByRole('button', { name: 'Sign out', exact: true }).click()
  await second.getByLabel('Access token', { exact: true }).fill(beta.token)
  await second
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await until(
    () =>
      second
        .locator('.user-name')
        .innerText()
        .then((name) => name.includes('Beta'))
        .catch(() => false),
    'second tab UI signed in as Beta',
  )
  await page.bringToFront()
  const cookieSession = await (
    await page.context().request.get(origin + '/api/session')
  ).json()
  assert.equal(cookieSession.user.id, beta.id)
  const recovery = page.getByRole('dialog', {
    name: 'Sign in to continue',
    exact: true,
  })
  await recovery.waitFor({ timeout: 15000 })
  assert((await page.locator('.user-name').innerText()).includes('Alpha'))
  assert.equal(await page.getByLabel('Message Lemex').inputValue(), draft)
  const options = await page
    .getByLabel('Select chat')
    .locator('option')
    .allTextContents()
  assert(!options.some((value) => value.includes('BETA_PRIVATE_CHAT_SENTINEL')))
  assert.equal(sent.length, 0)
  result.checks.push(
    'A second-tab account switch opens same-account recovery before any private Beta history reaches Alpha, preserving the Alpha draft.',
  )
  await recovery.getByLabel('Access token', { exact: true }).fill(beta.token)
  await recovery
    .getByRole('button', { name: 'Continue in workspace', exact: true })
    .click()
  await recovery
    .getByRole('alert')
    .filter({ hasText: 'different account' })
    .waitFor()
  const unchanged = await (
    await page.context().request.get(origin + '/api/session')
  ).json()
  assert.equal(unchanged.user.id, beta.id)
  assert.equal(await page.getByLabel('Message Lemex').inputValue(), draft)
  result.checks.push(
    'A wrong-account recovery token is rejected without changing the shared cookie or clearing the draft.',
  )
  await recovery.getByLabel('Access token', { exact: true }).fill(owner.token)
  await recovery
    .getByRole('button', { name: 'Continue in workspace', exact: true })
    .click()
  await recovery.waitFor({ state: 'hidden' })
  assert.equal(await page.getByLabel('Message Lemex').inputValue(), draft)
  assert.equal(sent.length, 0)
  await page.getByLabel('Message Lemex').press('Control+Enter')
  await until(() => sent.length > 0, 'explicit send after Alpha recovery')
  assert.equal(sent[0].actor, owner.id)
  assert.equal(sent[0].prompt, draft)
  assert((await page.locator('.user-name').innerText()).includes('Alpha'))
  result.checks.push(
    'Only explicit send after Alpha reauthentication dispatches the preserved prompt, and server agent admission uses Alpha.',
  )
  const raceContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  const racePage = await raceContext.newPage()
  await racePage.route(assetMatcher, assetHandler)
  await racePage.routeWebSocket('**/websocket/**', (socket) =>
    socket.close({ code: 1000, reason: 'No worker in login race fixture' }),
  )
  await racePage.route('**/api/login', async (route) => {
    const response = await route.fetch()
    assert.equal((await response.json()).user.id, owner.id)
    // The Alpha login cookie has arrived, then another tab signs into Beta
    // before Alpha's successful login response body is consumed.
    const switched = await raceContext.request.post(origin + '/api/login', {
      data: { token: beta.token },
      headers: { Origin: origin },
    })
    assert.equal(switched.status(), 200)
    const headers = { ...response.headers() }
    delete headers['set-cookie']
    await route.fulfill({ response, headers })
  })
  await racePage.goto(origin)
  await racePage.getByLabel('Access token', { exact: true }).fill(owner.token)
  await racePage
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await racePage
    .getByRole('alert')
    .filter({ hasText: 'Another account is signed in' })
    .waitFor()
  assert.equal(await racePage.locator('.user-name').count(), 0)
  const raceCookie = await (
    await raceContext.request.get(origin + '/api/session')
  ).json()
  assert.equal(raceCookie.user.id, beta.id)
  result.checks.push(
    'A cookie changed between successful login and session refresh cannot substitute a different account for the token just entered.',
  )
  await raceContext.close()
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors))
  result.passed = true
  result.errors = report.errors
  await page.screenshot({ path: path.join(output, 'recovered.png') })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  result.error = error.stack
  await fixture?.page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  await fixture?.browser.close()
  await studio?.close()
  await new Promise((resolve) => assets.close(resolve))
  await fs.rm(dataDir, { recursive: true, force: true })
}
