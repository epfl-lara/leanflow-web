#!/usr/bin/env node
// Test RCP waiting, cancellation and provider-limit guidance with closed fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import {
  RCP_WAIT_MESSAGE,
  providerLimitMessage,
} from '../server/provider-requests.mjs'
import { RCP_BASE_URL } from '../server/provider-endpoint.mjs'

const output = new URL('../.runtime/rcp-queue-ui/', import.meta.url)
await fs.mkdir(output, { recursive: true })
const projectId = 'rcp-fixture-project',
  chatId = 'rcp-fixture-chat'
const provider = {
  LEMEX_BASE_URL: RCP_BASE_URL,
  LEMEX_API_KEY: 'fixture-only-key',
}
const run = {
  id: 'queued-rcp-fixture',
  projectId,
  chatId,
  kind: 'agent',
  status: 'queued',
  mode: 'search',
  createdAt: new Date().toISOString(),
  prompt: 'Explain Nat.add_comm',
  message: '',
  eventCursor: 1,
  progress: { label: 'Waiting for RCP key', detail: RCP_WAIT_MESSAGE },
}
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'RCP queue fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: chatId, projectId, title: 'Explain Nat.add_comm' }],
  runs: [run],
})
const { page, browser, emit, report, state } = fixture
let stops = 0
state.onStop = ({ run, respond }) => {
  stops++
  run.status = 'cancelled'
  run.progress = { label: 'Stopped', detail: 'Stopped by the user.' }
  return respond(run)
}
try {
  await fixture.ready()
  const work = page.locator('.chat-current-work')
  await work.getByText('Waiting for RCP key', { exact: true }).waitFor()
  await work.getByText(RCP_WAIT_MESSAGE, { exact: true }).waitFor()
  assert(
    await work.getByRole('button', { name: 'Stop', exact: true }).isEnabled(),
  )
  await page.screenshot({
    path: new URL('waiting.png', output).pathname,
    fullPage: true,
  })
  await work.getByRole('button', { name: 'Stop', exact: true }).click()
  await until(() => stops === 1, 'queued stop request')
  await work.waitFor({ state: 'hidden' })
  report.checks.push(
    'Queued RCP work explains automatic start and can be stopped immediately',
  )

  run.status = 'running'
  run.progress = {
    label: 'Waiting for RCP',
    detail: providerLimitMessage('HTTP 429', provider, { retrying: true }),
  }
  await fixture.ready()
  await work.getByText('Waiting for RCP', { exact: true }).waitFor()
  await work.getByText(run.progress.detail, { exact: true }).waitFor()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), run.id),
    'RCP fixture event stream',
  )
  await emit(run, 'progress', { label: 'Working' })
  await work.getByText('Working', { exact: true }).waitFor()
  assert.equal(await work.getByText(/retrying automatically/).count(), 0)
  report.checks.push(
    'External RCP throttling explains retry behavior and clears when work resumes',
  )

  run.error = providerLimitMessage(
    { codexErrorInfo: 'usageLimitExceeded' },
    provider,
  )
  await emit(run, 'error', { message: run.error })
  await emit(run, 'status', { status: 'failed' })
  await page
    .locator(`[data-run-id="${run.id}"]`)
    .getByText(run.error, { exact: true })
    .waitFor()
  assert.equal(
    await page.getByText('fixture-only-key', { exact: false }).count(),
    0,
  )
  report.checks.push(
    'Exhausted quota gives visible portal/key guidance without exposing credentials',
  )
  fixture.assertClean()
  console.log(
    JSON.stringify({ checks: report.checks, errors: report.errors }, null, 2),
  )
} finally {
  await fs.writeFile(
    new URL('report.json', output),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
}
