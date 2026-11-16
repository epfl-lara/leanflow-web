#!/usr/bin/env node
// Closed provider/API fixture: a startup burst recovers without losing a draft.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/model-discovery-recovery-ui')
await fs.mkdir(output, { recursive: true })
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'discovery-user', name: 'Discovery fixture' },
    templates: [],
    models: [],
    defaultModel: null,
    runtime: { ready: true },
    lemex: {
      configured: true,
      modelError: 'Model discovery is busy.',
      modelErrorRetryable: true,
    },
  },
  projects: [
    { id: 'discovery-project', name: 'Discovery project', status: 'ready' },
  ],
  files: {
    'discovery-project': { 'Main.lean': 'example : True := by trivial\n' },
  },
  chats: [
    {
      id: 'discovery-chat',
      projectId: 'discovery-project',
      title: 'Discovery chat',
    },
  ],
  runs: [],
})
const { page, browser, report } = fixture
let calls = 0
let complete
await page.route('**/api/models', async (route) => {
  calls++
  if (calls === 1)
    return route.fulfill({
      status: 429,
      json: { error: 'Model discovery is busy.' },
    })
  assert.equal(
    calls,
    2,
    'The bounded retry must not overlap discovery requests',
  )
  await new Promise((resolve) => {
    complete = resolve
  })
  return route.fulfill({
    json: {
      models: [
        {
          id: 'recovered-model',
          name: 'Recovered model',
          reasoningEfforts: [{ id: 'high' }],
          defaultReasoningEffort: 'high',
        },
      ],
      defaultModel: 'recovered-model',
      savedModels: ['recovered-model'],
    },
  })
})
try {
  await fixture.ready()
  await page
    .getByRole('alert')
    .filter({
      hasText:
        'Models are loading while the server is busy. Retrying automatically.',
    })
    .waitFor()
  const composer = page.getByLabel('Message Lemex')
  const draft = 'Keep this draft while available models load.'
  await composer.fill(draft)
  assert.equal(
    await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(),
    true,
  )
  await until(() => calls === 1, 'first delayed model retry')
  assert.equal(await composer.inputValue(), draft)
  await until(() => !!complete, 'backed off model retry')
  assert.equal(calls, 2)
  assert.equal(await composer.inputValue(), draft)
  complete()
  await until(
    async () =>
      page.getByRole('button', { name: 'Send', exact: true }).isEnabled(),
    'model discovery recovers Send',
  )
  assert.equal(await composer.inputValue(), draft)
  await page.locator('.chat-options').evaluate((element) => {
    element.open = true
  })
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Model', exact: true })
      .inputValue(),
    'recovered-model',
  )
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Reasoning effort', exact: true })
      .inputValue(),
    'high',
  )
  assert.equal(calls, 2)
  fixture.assertClean()
  report.checks.push(
    'Temporary startup congestion retries with backoff, preserves the draft, and restores model access without changing its advertised reasoning level.',
  )
  report.passed = true
  console.log(JSON.stringify({ passed: true, checks: report.checks }))
} catch (error) {
  report.error = error.stack || String(error)
  throw error
} finally {
  complete?.()
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
