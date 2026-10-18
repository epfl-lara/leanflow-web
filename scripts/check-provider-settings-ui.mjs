#!/usr/bin/env node
// Browser-only fixtures: no real account, provider, project, or model inference.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { DEFAULT_MODEL } from '../server/model-catalog.mjs'
import { RCP_BASE_URL } from '../server/provider-endpoint.mjs'

const directory = new URL('../.runtime/provider-settings-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const rcpModels = [
  {
    id: DEFAULT_MODEL,
    name: 'DeepSeek V4.1 Flash 1017',
    reasoningEfforts: [{ id: 'max' }],
    defaultReasoningEffort: 'max',
  },
]
const customModels = [
  {
    id: 'custom/model',
    name: 'Fixture Custom Model',
    reasoningEfforts: [{ id: 'low' }, { id: 'high' }],
    defaultReasoningEffort: 'high',
  },
]
const fixture = await chatBrowserFixture({
  launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {},
  session: {
    user: {
      id: 'provider-fixture-user',
      name: 'Provider Fixture',
      role: 'user',
    },
    templates: [],
    models: rcpModels,
    defaultModel: DEFAULT_MODEL,
    savedModels: [DEFAULT_MODEL],
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [
    {
      id: 'provider-project',
      name: 'Provider fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.35.0-rc4',
    },
  ],
  files: {
    'provider-project': { 'Main.lean': 'example : True := by trivial\n' },
  },
  chats: [
    {
      id: 'provider-chat',
      projectId: 'provider-project',
      title: 'Provider fixture',
      runCount: 0,
    },
  ],
  runs: [],
})
const { page, state, browser, report } = fixture
let provider = {
  configured: true,
  provider: 'rcp',
  baseUrl: RCP_BASE_URL,
  defaultBaseUrl: RCP_BASE_URL,
  updatedAt: 'initial',
}
const saved = []
await page.route('**/api/provider', async (route) => {
  if (route.request().method() === 'PUT') {
    const body = route.request().postDataJSON()
    assert(body.apiKey.startsWith('fixture-'))
    saved.push(body)
    const custom = body.provider === 'custom'
    provider = {
      ...provider,
      configured: true,
      provider: body.provider,
      baseUrl: custom ? body.baseUrl : RCP_BASE_URL,
      updatedAt: String(saved.length),
    }
    state.session.models = custom ? customModels : rcpModels
    state.session.defaultModel = custom ? 'custom/model' : DEFAULT_MODEL
    state.session.savedModels = [state.session.defaultModel]
    state.session.lemex = { configured: true, ...provider }
  }
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(provider),
  })
})
await page.route('**/api/settings', (route) =>
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      extraInstructions: '',
      basePrompt: 'Fixture prompt',
      showReasoning: true,
      tools: { lean: true, lean_probe: true, lean_explore: true, exa: true },
    }),
  }),
)
await page.route('**/api/models', (route) =>
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      models: state.session.models,
      savedModels: state.session.savedModels,
      defaultModel: state.session.defaultModel,
    }),
  }),
)
try {
  await fixture.ready()
  await page
    .getByRole('button', { name: 'Assistant settings', exact: true })
    .click()
  let dialog = page.getByRole('dialog', {
    name: 'Assistant settings',
    exact: true,
  })
  await dialog.getByLabel('Provider', { exact: true }).waitFor()
  assert.equal(
    await dialog.getByLabel('Provider', { exact: true }).inputValue(),
    'rcp',
  )
  assert.equal(await dialog.getByLabel('API base URL').count(), 0)
  assert(
    await dialog.getByRole('link', { name: /EPFL RCP portal/ }).isVisible(),
  )
  await page.screenshot({
    path: new URL('rcp-default.png', directory).pathname,
  })
  await dialog.getByLabel('Provider', { exact: true }).selectOption('custom')
  assert.equal(
    await dialog.getByRole('link', { name: /EPFL RCP portal/ }).count(),
    0,
  )
  await dialog.getByLabel('API base URL').fill('https://custom.example.com/v1')
  await dialog.getByLabel('Your Lemex API key').fill('fixture-custom-key')
  await dialog
    .getByRole('button', { name: 'Update connection', exact: true })
    .click()
  await until(() => saved.length === 1, 'custom connection submitted')
  await dialog.getByText(/Fixture Custom Model/).waitFor()
  assert.equal(await dialog.getByLabel('Your Lemex API key').inputValue(), '')
  assert.deepEqual(saved[0], {
    apiKey: 'fixture-custom-key',
    provider: 'custom',
    baseUrl: 'https://custom.example.com/v1',
  })
  await page.screenshot({
    path: new URL('custom-provider.png', directory).pathname,
  })
  await dialog
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Assistant settings', exact: true })
    .click()
  dialog = page.getByRole('dialog', { name: 'Assistant settings', exact: true })
  await until(
    async () =>
      (await dialog.getByLabel('Provider', { exact: true }).inputValue()) ===
      'custom',
    'saved provider reopened',
  )
  assert.equal(
    await dialog.getByLabel('API base URL').inputValue(),
    'https://custom.example.com/v1',
  )
  await dialog.getByLabel('Provider', { exact: true }).selectOption('rcp')
  await dialog.getByLabel('Your Lemex API key').fill('fixture-rcp-key')
  await dialog
    .getByRole('button', { name: 'Update connection', exact: true })
    .click()
  await until(() => saved.length === 2, 'RCP restored')
  await dialog.getByText(/Default: DeepSeek V4.1 Flash 1017/).waitFor()
  assert.equal(saved[1].baseUrl, undefined)
  await dialog
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  state.session.lemex = { configured: false }
  await page.reload()
  await page
    .getByRole('heading', { name: 'Welcome, Provider Fixture.' })
    .waitFor()
  assert.equal(
    await page.getByLabel('Provider', { exact: true }).inputValue(),
    'rcp',
  )
  await page.getByLabel('Provider', { exact: true }).selectOption('custom')
  await page.getByLabel('API base URL').fill('https://custom.example.com/v1')
  await page.getByLabel('Your Lemex API key').fill('fixture-onboarding-key')
  await page
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  await page.locator('.monaco-editor').waitFor()
  assert.equal(saved.length, 3)
  report.checks.push(
    'RCP opens by default with its key portal; custom provider fields are optional',
  )
  report.checks.push(
    'Saving a provider refreshes model access, clears the key field and persists across settings reopen',
  )
  report.checks.push(
    'Switching back restores the RCP default; first-login setup also supports another provider',
  )
  report.inferenceRequests = 0
  fixture.assertClean()
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
  await page
    .screenshot({ path: new URL('failure.png', directory).pathname })
    .catch(() => {})
} finally {
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
