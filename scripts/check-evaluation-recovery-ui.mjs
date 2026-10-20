#!/usr/bin/env node
// Mock all backend traffic; verify recovery preserves unsaved editor text.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const id = 'evaluation-recovery-fixture'
const source = '#eval show IO Unit from do\n  IO.println "Hello"\n'
const f = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture' },
    templates: [],
    models: [],
    defaultModel: 'fixture',
    runtime: { ready: true },
  },
  projects: [{ id, name: 'Evaluation recovery', status: 'ready' }],
  files: { [id]: { 'Main.lean': source } },
  chats: [{ id: 'fixture-chat', projectId: id, title: 'Fixture', runCount: 0 }],
  runs: [],
})
const reportDir = path.resolve('.runtime/evaluation-recovery-ui')
await fs.mkdir(reportDir, { recursive: true })
let job = {
  id: 'fixture-check',
  createdAt: new Date().toISOString(),
  status: 'running',
  log: 'Waiting for evaluation',
}
let stopped = 0
await f.page.route(`**/api/projects/${id}/file?path=Main.lean`, (route) => {
  if (route.request().method() !== 'PUT') return route.fallback()
  const body = route.request().postDataJSON()
  assert.equal(
    body.expectedHash,
    createHash('sha256').update(source).digest('hex'),
  )
  f.state.files[id]['Main.lean'] = body.content
  return route.fulfill({
    json: {
      hash: createHash('sha256').update(body.content).digest('hex'),
      requiresPreparation: false,
    },
  })
})
await f.page.route(`**/api/projects/${id}/check`, (route) =>
  route.fulfill({ status: 202, json: job }),
)
await f.page.route('**/api/jobs/fixture-check', (route) =>
  route.fulfill({ json: job }),
)
await f.page.route('**/api/jobs/fixture-check/stop', (route) => {
  stopped++
  job = { ...job, status: 'cancelled' }
  return route.fulfill({ json: job })
})
try {
  await f.ready()
  await f.page
    .getByRole('button', { name: 'Check Project', exact: true })
    .click()
  await f.page
    .getByRole('button', { name: 'Stop check', exact: true })
    .waitFor()
  await f.page.locator('.monaco-editor textarea').focus()
  await f.page.keyboard.press(editorShortcuts.documentEnd)
  await f.page.keyboard.insertText('-- unsaved work survives recovery\n')
  await f.page.getByRole('button', { name: 'Stop check', exact: true }).click()
  await until(() => stopped === 1, 'check cancellation')
  await until(
    () =>
      f.page
        .getByRole('button', { name: 'Check Project', exact: true })
        .isEnabled(),
    'check can run again',
  )
  const reason =
    'Lean is still processing line 1. Large imports and proofs can take time. You can keep editing, or restart Lean if it seems stuck.'
  f.sendLean({
    jsonrpc: '2.0',
    method: '$/leanflow/processing',
    params: { message: reason },
  })
  await f.page.getByText(reason, { exact: true }).waitFor()
  const connections = f.report.sockets.length
  await f.page
    .getByRole('button', { name: 'Restart Lean', exact: true })
    .first()
    .click()
  await until(
    () => f.report.sockets.length > connections,
    'new Lean connection',
  )
  await until(
    () =>
      f.page
        .getByRole('button', { name: 'Restart Lean', exact: true })
        .isEnabled(),
    'Lean restarted',
  )
  await until(
    async () => (await f.page.getByText(reason, { exact: true }).count()) === 0,
    'timeout notice cleared',
  )
  assert(
    await f.page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
  )
  await f.page.getByRole('button', { name: 'Save', exact: true }).click()
  await until(
    () =>
      f.state.files[id]['Main.lean'] ===
      source + '-- unsaved work survives recovery\n',
    'unsaved buffer retained',
  )
  job = {
    ...job,
    status: 'failed',
    error:
      'Lean checking reached its time limit. Inspect the last module in the build output.',
    log: 'Compiling a large module\n',
  }
  await f.page
    .getByRole('button', { name: 'Check Project', exact: true })
    .click()
  await f.page.getByRole('alert').filter({ hasText: job.error }).waitFor()
  assert(
    await f.page
      .getByText('Compiling a large module', { exact: true })
      .isVisible(),
  )
  f.assertClean()
  f.report.checks.push(
    'Checks can be cancelled; stationary progress shows a neutral notice with recovery controls; restarting preserves unsaved text; failed checks show their explanation above the log.',
  )
  f.report.passed = true
} catch (error) {
  f.report.passed = false
  f.report.error = error.stack
  process.exitCode = 1
} finally {
  await f.page.screenshot({
    path: path.join(reportDir, 'browser.png'),
    fullPage: true,
  })
  await f.browser.close()
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(f.report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(f.report, null, 2))
