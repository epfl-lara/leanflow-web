#!/usr/bin/env node
// Closed APIs and Lean: verify that first-time visitors do not load the editor.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/startup-loading-ui')
await fs.mkdir(output, { recursive: true })
const session = {
  user: {
    id: 'startup-user',
    name: 'Startup user',
    role: 'user',
    profileComplete: true,
  },
  templates: [],
  models: [{ id: 'fixture-model', name: 'Fixture model' }],
  defaultModel: 'fixture-model',
  runtime: { ready: true },
  lemex: { configured: true },
}
const fixture = await chatBrowserFixture({
  session,
  projects: [
    { id: 'startup-project', name: 'Startup project', status: 'ready' },
  ],
  files: {
    'startup-project': { 'Main.lean': 'example : True := by trivial\n' },
  },
  chats: [
    {
      id: 'startup-chat',
      projectId: 'startup-project',
      title: 'Startup chat',
      runCount: 0,
    },
  ],
  runs: [],
})
const { page, browser, report } = fixture
let signedIn = false
const editorRequests = []
await page.route('**/api/session', (route) =>
  signedIn
    ? route.fallback()
    : route.fulfill({ status: 401, json: { error: 'Sign in.' } }),
)
await page.route('**/api/login', (route) => {
  assert.equal(route.request().postDataJSON().token, 'startup-fixture-token')
  signedIn = true
  return route.fulfill({ json: { user: session.user } })
})
await page.route('**/assets/LeanWorkspace-*.js', (route) => {
  editorRequests.push(route)
})
try {
  await page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090')
  await page.getByLabel('Access token', { exact: true }).waitFor()
  assert.equal(editorRequests.length, 0, 'Sign-in must not download the editor')
  report.checks.push('Sign-in opens without downloading the Lean editor.')
  await page
    .getByLabel('Access token', { exact: true })
    .fill('startup-fixture-token')
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await page.getByText('Loading editor…', { exact: true }).waitFor()
  assert.equal(editorRequests.length, 1)
  const composer = page.getByLabel('Message Lemex')
  await composer.fill('Keep this draft while the editor loads.')
  assert.equal(
    await composer.inputValue(),
    'Keep this draft while the editor loads.',
  )
  report.checks.push(
    'A slow editor download keeps the workspace and chat draft responsive.',
  )
  await editorRequests.shift().abort('connectionreset')
  await page
    .getByRole('button', { name: 'Retry loading editor', exact: true })
    .waitFor()
  assert.equal(
    await composer.inputValue(),
    'Keep this draft while the editor loads.',
  )
  await page
    .getByRole('button', { name: 'Retry loading editor', exact: true })
    .click()
  await until(() => editorRequests.length === 1, 'editor download retried')
  await editorRequests.shift().continue()
  await page.locator('.monaco-editor textarea').first().waitFor()
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  assert.equal(
    await composer.inputValue(),
    'Keep this draft while the editor loads.',
  )
  report.checks.push(
    'A failed download retries without reloading or resetting the chat draft.',
  )
  fixture.assertClean()
  report.passed = true
  console.log(JSON.stringify({ passed: true, checks: report.checks }))
} catch (error) {
  report.error = error.stack || String(error)
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
