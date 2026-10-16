#!/usr/bin/env node
// Project source and definition replies are fixtures; no worker or provider runs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.runtime/definition-project-scope-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(
  express.static(
    process.env.STUDIO_TEST_DIST || path.join(root, 'client/dist'),
  ),
)
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const main = '#check sharedValue\n'
const sources = {
  alpha: 'def sharedValue : Nat := 11 -- ALPHA_PREVIEW\n',
  beta: 'def sharedValue : Nat := 222 -- BETA_PREVIEW\n',
}
const fixture = await chatBrowserFixture({
  base: `http://127.0.0.1:${server.address().port}`,
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [{ id: 'fixture', name: 'Fixture' }],
    defaultModel: 'fixture',
    runtime: { ready: true },
  },
  projects: ['alpha', 'beta'].map((id) => ({
    id,
    name: `${id} project`,
    status: 'ready',
  })),
  files: Object.fromEntries(
    Object.entries(sources).map(([id, content]) => [
      id,
      {
        'Main.lean': `-- ${id.toUpperCase()}_MAIN\n${main}`,
        'Util.lean': content,
      },
    ]),
  ),
  chats: ['alpha', 'beta'].map((projectId) => ({
    id: `${projectId}-chat`,
    projectId,
    title: 'Fixture chat',
  })),
  runs: [],
  definitionLocations: [
    {
      uri: 'file:///workspace/Util.lean',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 100 },
      },
    },
  ],
})
const { page, report } = fixture
const sourceReads = []
report.consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') report.consoleErrors.push(message.text())
})
page.on('request', (request) => {
  const url = new URL(request.url())
  if (request.method() === 'GET' && url.pathname.endsWith('/file'))
    sourceReads.push({
      endpoint: url.pathname,
      path: url.searchParams.get('path'),
    })
})
try {
  await fixture.ready()
  await page
    .locator('.file-item')
    .and(page.getByTitle('Util.lean', { exact: true }))
    .click()
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes('ALPHA_PREVIEW'),
    'alpha Util source',
  )
  await page
    .locator('.file-item')
    .and(page.getByTitle('Main.lean', { exact: true }))
    .click()
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes('Main.lean'),
    'alpha Main source',
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await page
    .locator('.project-item')
    .and(page.getByTitle('beta project', { exact: true }))
    .click()
  await until(
    async () =>
      (await page.locator('.workspace-title').innerText()).includes(
        'beta project',
      ) && (await page.locator('.file-tab').innerText()).includes('Main.lean'),
    'beta Main source',
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes('BETA_MAIN'),
    'beta editor model',
  )
  await until(
    () => report.sockets.some((url) => url.endsWith('/websocket/beta')),
    'beta Lean connection',
  )
  await until(
    async () =>
      (await page.locator('.statusbar').innerText()).includes('Lean connected'),
    'beta Lean initialized',
  )
  const identifier = page
    .locator('.view-line')
    .filter({ hasText: '#check sharedValue' })
  await identifier.click({ button: 'right', position: { x: 90, y: 8 } })
  await page.getByRole('menuitem', { name: 'Peek', exact: true }).hover()
  await page.getByRole('menuitem', { name: /^Peek Definition/ }).hover()
  await page.keyboard.press('Enter')
  await page.locator('.peekview-widget').waitFor({ timeout: 10000 })
  await until(
    async () =>
      (await page.locator('.peekview-widget').innerText()).includes(
        'BETA_PREVIEW',
      ),
    'Beta definition preview',
  )
  const preview = await page.locator('.peekview-widget').innerText()
  report.preview = preview
  assert(
    !preview.includes('ALPHA_PREVIEW'),
    'Alpha virtual source cannot leak into Beta preview',
  )
  assert(
    sourceReads.some(
      (read) =>
        read.endpoint === '/api/projects/beta/file' &&
        read.path === 'Util.lean',
    ),
    'Beta previews must read Beta source through its scoped API',
  )
  report.checks.push(
    'Definition previews fetch the selected project source after a same-path file was opened in another project.',
  )
  await page.mouse.move(0, 0)
  await page.keyboard.press('Escape')
  await identifier.click({ button: 'right', position: { x: 90, y: 8 } })
  await page.getByRole('menuitem', { name: /^Go to Definition/ }).hover()
  await page.keyboard.press('Enter')
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes('Util.lean') &&
      (await page.locator('.view-lines').innerText()).includes('BETA_PREVIEW'),
    'Beta definition source',
  )
  assert.equal(
    report.requests.filter(
      (request) =>
        request.method === 'PUT' && request.endpoint.endsWith('/file'),
    ).length,
    0,
    'Browser cache cleanup never writes project source files',
  )
  report.checks.push(
    'Go to Definition opens the selected project definition after cache cleanup without writing any project files.',
  )
  report.sourceReads = sourceReads
  fixture.assertClean()
  assert.deepEqual(report.consoleErrors, [])
  report.passed = true
} catch (error) {
  report.failure = error.stack
  await page.screenshot({
    path: path.join(output, 'failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await fixture.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
console.log(JSON.stringify({ passed: true, checks: report.checks, output }))
