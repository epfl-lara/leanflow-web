#!/usr/bin/env node
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
  ].map((slug) => ({
    slug,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ['low', 'medium', 'high'].map((effort) => ({
      effort,
    })),
  })),
})
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'model-options-user', name: 'Fixture' },
    templates: [],
    models: catalogModels(catalog, DEFAULT_MODEL),
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
    ({ projectId }) => {
      const key = `lemex-chat-options:model-options-user:${projectId}`
      if (!localStorage.getItem(key))
        localStorage.setItem(
          key,
          JSON.stringify({
            model: 'Qwen/Qwen3.8-27B',
            efforts: { ['deepseek-ai/DeepSeek-V4.1-Flash']: 'low' },
            liveEdits: false,
          }),
        )
    },
    { projectId },
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
  await openOptions()
  assert.equal(await model.inputValue(), DEFAULT_MODEL)
  assert.equal(await effort.inputValue(), 'max')
  assert.deepEqual(await levels(), ['', 'low', 'high', 'xhigh', 'max'])
  assert.equal(await page.getByLabel('Edit files live').isChecked(), false)
  report.checks.push(
    'DeepSeek max opens even with an old saved model/effort; edit preference is preserved',
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
  assert.equal(await effort.inputValue(), 'xhigh')
  assert.deepEqual(await levels(), ['', 'low', 'medium', 'xhigh'])
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
