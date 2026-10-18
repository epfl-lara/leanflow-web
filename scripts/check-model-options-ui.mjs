#!/usr/bin/env node
import profiles from '../server/lemex-models.json' with { type: 'json' }
// All API calls are fixtures; serve the client on STUDIO_TEST_URL.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { catalogModels } from '../server/config.mjs'
import { DEFAULT_MODEL, rcpModelCatalog } from '../server/model-catalog.mjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const reportDir = new URL('../.runtime/model-options-ui/', import.meta.url)
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'model-options-fixture'
const catalog = rcpModelCatalog({
  models: [
    DEFAULT_MODEL,
    'Qwen/Qwen3.8-27B',
    'zai-org/GLM-5.3-Flash',
    'moonshotai/Kimi-K2.7-Code',
  ].map(
    (slug) =>
      profiles.models.find((model) => model.slug === slug) || {
        slug,
        default_reasoning_level: null,
        supported_reasoning_levels: [],
      },
  ),
})
const fixture = await chatBrowserFixture({
  launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {},
  session: {
    user: { id: 'model-options-user', name: 'Fixture' },
    templates: [],
    models: [
      ...catalogModels(catalog, DEFAULT_MODEL),
      { id: 'provider/extra', name: 'Extra available model' },
    ],
    savedModels: catalog.models.map((model) => model.slug),
    defaultModel: DEFAULT_MODEL,
    runtime: { ready: true },
    lemex: { available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Model options fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: 'model-chat', projectId, title: 'Options', runCount: 0 }],
  runs: [],
})
const { page, browser, state, report } = fixture
const model = page.getByRole('combobox', { name: 'Model', exact: true })
const effort = page.getByRole('combobox', {
  name: 'Reasoning effort',
  exact: true,
})
const levels = () =>
  effort
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value))
async function openOptions() {
  await page.locator('.chat-options').evaluate((element) => {
    element.open = true
  })
}
try {
  await page.addInitScript(
    ({ projectId, defaultModel }) => {
      const key = `lemex-chat-options:model-options-user:${projectId}`
      if (!localStorage.getItem(key))
        localStorage.setItem(
          key,
          JSON.stringify({
            model: 'Qwen/Qwen3.8-27B',
            efforts: { [defaultModel]: 'max' },
            liveEdits: false,
          }),
        )
    },
    { projectId, defaultModel: DEFAULT_MODEL },
  )
  state.onCreateRun = ({ chat, body, respond }) => {
    const run = {
      ...body,
      chatId: chat.id,
      id: `selection-${state.runs.length}`,
      projectId,
      status: 'completed',
      createdAt: new Date().toISOString(),
      message: 'Fixture response.',
      followups: [],
    }
    state.runs.push(run)
    return respond(run, 201)
  }
  await fixture.ready()
  await page.route('**/api/models/preferences', async (route) => {
    const body = route.request().postDataJSON()
    state.session.savedModels = body.savedModels
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        models: state.session.models,
        savedModels: body.savedModels,
        defaultModel: DEFAULT_MODEL,
      }),
    })
  })
  await openOptions()
  assert.equal(await model.inputValue(), DEFAULT_MODEL)
  assert.equal(await effort.inputValue(), 'max')
  assert.deepEqual(await levels(), ['', 'none', 'low', 'high', 'xhigh', 'max'])
  assert.equal(
    await page.getByLabel('Edit files live', { exact: true }).isChecked(),
    false,
  )
  report.checks.push(
    'DeepSeek max opens even with an old saved model/effort; edit preference is preserved',
  )

  for (const [name, expected] of [
    ['Ask & Search', 'high'],
    ['Proofs', 'max'],
    ['Formalize', 'max'],
    ['Optimize', 'max'],
  ]) {
    await page
      .locator('.mode-tabs')
      .getByRole('button', { name, exact: true })
      .click()
    assert.equal(await effort.inputValue(), expected)
  }
  await page
    .locator('.mode-tabs')
    .getByRole('button', { name: 'Ask & Search', exact: true })
    .click()
  await effort.selectOption('low')
  await page
    .locator('.mode-tabs')
    .getByRole('button', { name: 'Proofs', exact: true })
    .click()
  assert.equal(await effort.inputValue(), 'max')
  await page
    .locator('.mode-tabs')
    .getByRole('button', { name: 'Ask & Search', exact: true })
    .click()
  assert.equal(await effort.inputValue(), 'low')
  await effort.selectOption('')
  await page.getByLabel('Message Lemex').fill('Use the provider default.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(
    () => state.runs.some((run) => run.prompt === 'Use the provider default.'),
    'provider default request',
  )
  assert.equal(state.runs.at(-1).effort, null)
  await page
    .locator('.mode-tabs')
    .getByRole('button', { name: 'Formalize', exact: true })
    .click()
  assert.equal(await effort.inputValue(), 'max')
  await page
    .locator('.mode-tabs')
    .getByRole('button', { name: 'Ask & Search', exact: true })
    .click()
  assert.equal(await effort.inputValue(), '')
  await effort.selectOption('high')
  await page
    .locator('.mode-tabs')
    .getByRole('button', { name: 'Proofs', exact: true })
    .click()
  report.checks.push(
    'Ask & Search starts high and the other three modes start max; deliberate per-mode choices and provider-default null are preserved',
  )

  assert.equal(
    await page.locator('.chat-options').getByRole('searchbox').count(),
    0,
  )
  assert.equal(await model.locator('option').count(), 4)
  assert.equal(await model.locator('option[value="provider/extra"]').count(), 0)
  await page.getByRole('button', { name: 'Add models…', exact: true }).click()
  const library = page.getByRole('dialog', { name: 'Your models', exact: true })
  const search = library.getByRole('searchbox', {
    name: 'Search all available models',
  })
  await search.fill('Extra')
  assert.equal(await library.getByRole('checkbox').count(), 1)
  await library
    .getByRole('checkbox', {
      name: 'Extra available model provider/extra',
      exact: true,
    })
    .check()
  await library
    .getByRole('button', { name: 'Save models', exact: true })
    .click()
  await library.waitFor({ state: 'hidden' })
  assert.equal(await model.inputValue(), DEFAULT_MODEL)
  assert.equal(await effort.inputValue(), 'max')
  assert.equal(await model.locator('option[value="provider/extra"]').count(), 1)
  assert.equal(await model.locator('option').count(), 5)
  report.checks.push(
    'Main picker only shows saved models; adding from the searchable library preserves model and effort',
  )

  await page.getByRole('button', { name: 'Add models…', exact: true }).click()
  await library.getByRole('searchbox').fill('DeepSeek')
  await library.getByRole('checkbox').uncheck()
  await library.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert(state.session.savedModels.includes(DEFAULT_MODEL))
  assert.equal(await model.inputValue(), DEFAULT_MODEL)
  report.checks.push(
    'Cancelling model list edits leaves saved choices unchanged',
  )

  for (const selectedEffort of ['max', 'low']) {
    await effort.selectOption(selectedEffort)
    await page.getByLabel('Message Lemex').fill('Check the fixture proof.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await until(
      () => state.runs.some((run) => run.effort === selectedEffort),
      'selected effort reaches run request',
    )
    assert.equal(state.runs.at(-1).model, DEFAULT_MODEL)
  }
  report.checks.push(
    'Default max and a deliberate lower effort reach the run request unchanged',
  )

  await model.selectOption('Qwen/Qwen3.8-27B')
  assert.equal(await effort.inputValue(), 'medium')
  assert.deepEqual(await levels(), ['', 'none', 'low', 'medium', 'xhigh'])
  await model.selectOption(DEFAULT_MODEL)
  assert.equal(await effort.inputValue(), 'low')
  await model.selectOption('Qwen/Qwen3.8-27B')
  assert.equal(await effort.inputValue(), 'medium')
  await model.selectOption('zai-org/GLM-5.3-Flash')
  assert.equal(await effort.inputValue(), 'max')
  assert.deepEqual(await levels(), ['', 'low', 'high', 'max'])
  await model.selectOption('moonshotai/Kimi-K2.7-Code')
  assert.equal(await effort.isEnabled(), false)
  await page
    .getByText('This model has no adjustable reasoning effort.', {
      exact: true,
    })
    .waitFor()
  report.checks.push(
    'Qwen and GLM offer their own levels; fixed reasoning models disable the selector',
  )

  await page.reload()
  await page.getByLabel('Message Lemex').waitFor()
  await openOptions()
  assert.equal(await model.inputValue(), DEFAULT_MODEL)
  assert.equal(await effort.inputValue(), 'max')
  report.checks.push(
    'Reload returns to DeepSeek max after temporary model/effort choices',
  )
  assert(state.session.savedModels.includes('provider/extra'))
  assert.equal(await model.locator('option[value="provider/extra"]').count(), 1)
  await page.getByRole('button', { name: 'Add models…', exact: true }).click()
  await library.getByRole('searchbox').fill('DeepSeek')
  await library.getByRole('checkbox').uncheck()
  await library
    .getByRole('button', { name: 'Save models', exact: true })
    .click()
  await library.waitFor({ state: 'hidden' })
  assert.equal(await model.inputValue(), DEFAULT_MODEL)
  assert.equal(await effort.inputValue(), 'max')
  assert.match(await model.locator('option:checked').innerText(), /current/)
  await model.selectOption('Qwen/Qwen3.8-27B')
  assert.equal(
    await model.locator(`option[value="${DEFAULT_MODEL}"]`).count(),
    0,
  )
  report.checks.push(
    'Saved list survives reload; removing the current model preserves its session choice until an explicit switch',
  )
  await page.screenshot({ path: path.join(reportDir.pathname, 'default.png') })
  fixture.assertClean()
  report.passed = true
  console.log(
    `PASS: ${report.checks.length} model option checks; all APIs mocked`,
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
  await page
    .screenshot({
      path: path.join(reportDir.pathname, 'failure.png'),
      fullPage: true,
    })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    new URL('result.json', reportDir),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
