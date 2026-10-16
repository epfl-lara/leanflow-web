#!/usr/bin/env node
// Use real browser editor lifecycles with isolated project and LSP fixtures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/lean-cache-ui')
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
const projectId = 'lean-cache-project'
const otherId = 'other-lean-cache-project'
const hash = (content) => createHash('sha256').update(content).digest('hex')
let fixture
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'Lean cache fixture', status: 'ready' },
      { id: otherId, name: 'Other cache fixture', status: 'ready' },
    ],
    files: {
      [projectId]: {
        'Main.lean': 'def cachedA : Nat := 1\n#check cachedA\n',
        'Second.lean': 'import Main\ndef cachedB : Nat := cachedA\n',
        'Third.lean': 'def cachedC : Nat := 3\n',
      },
      [otherId]: {
        'Main.lean': '-- OTHER_PROJECT_SOURCE\nexample : True := by trivial\n',
      },
    },
    chats: [
      { id: 'cache-chat', projectId, title: 'Cache fixture' },
      { id: 'other-cache-chat', projectId: otherId, title: 'Other fixture' },
    ],
    runs: [],
  })
  const { page, state, report } = fixture
  const messages = [],
    open = new Map(),
    violations = []
  report.leanNotifications = messages
  state.onLeanMessage = (message, socket, connection) => {
    messages.push({ socket, ...message })
    const uri = message.params?.textDocument?.uri
    if (!uri) return
    const documents = open.get(connection) || new Map()
    open.set(connection, documents)
    if (message.method === 'textDocument/didOpen') {
      if (documents.has(uri)) violations.push('Duplicate didOpen for ' + uri)
      documents.set(uri, message.params.textDocument.version)
      if (documents.size > 2)
        violations.push('More than two Lean documents open')
    } else if (message.method === 'textDocument/didClose') {
      documents.delete(uri)
    } else if (message.method === 'textDocument/didChange') {
      if (message.params.textDocument.version <= documents.get(uri))
        violations.push('Non-increasing version for ' + uri)
      documents.set(uri, message.params.textDocument.version)
    }
  }
  await page.route('**/api/projects/*/file?*', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    const filename = new URL(route.request().url()).searchParams.get('path')
    const { content, expectedHash } = route.request().postDataJSON()
    assert.equal(expectedHash, hash(state.files[projectId][filename]))
    state.files[projectId][filename] = content
    return route.fulfill({
      json: { content, hash: hash(content), requiresPreparation: false },
    })
  })
  const notifications = (method, filename) =>
    messages.filter(
      (message) =>
        message.method === 'textDocument/' + method &&
        message.params.textDocument.uri === 'file:///workspace/' + filename &&
        message.socket.endsWith('/' + projectId),
    )
  async function opened(filename, marker) {
    await until(
      async () =>
        (await page.locator('.editor-loading').count()) === 0 &&
        (await page.locator('.file-toolbar').innerText()).includes(filename) &&
        (await page.locator('.monaco-editor .view-lines').innerText()).includes(
          marker,
        ),
      `opening ${filename}`,
    )
    assert.equal(await page.locator('.editor-failure').count(), 0)
  }
  async function visit(filename, marker) {
    await page.locator(`.file-item[title="${filename}"]`).click()
    await opened(filename, marker)
  }
  await fixture.ready()
  await until(
    () =>
      messages.some(
        (message) =>
          message.method === 'textDocument/documentSymbol' &&
          message.params.textDocument.uri === 'file:///workspace/Main.lean',
      ),
    'initial file ready',
  )
  const initialOpens = notifications('didOpen', 'Main.lean').length
  const initialCloses = notifications('didClose', 'Main.lean').length
  await visit('Second.lean', 'cachedB')
  await visit('Main.lean', 'cachedA')
  assert.equal(notifications('didOpen', 'Main.lean').length, initialOpens)
  assert.equal(notifications('didClose', 'Main.lean').length, initialCloses)
  assert.equal(notifications('didChange', 'Main.lean').length, 0)
  report.checks.push(
    'Switching A to B and back preserves A’s Lean worker and model version without a virtual file rewrite.',
  )

  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('-- SAVED_CACHE_CHANGE\n')
  await until(
    () => notifications('didChange', 'Main.lean').length > 0,
    'incremental Lean edit',
  )
  assert.equal(notifications('didClose', 'Second.lean').length, 0)
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await save.click()
  await until(async () => !(await save.isEnabled()), 'saving the source')
  await until(
    () => notifications('didClose', 'Second.lean').length === 1,
    'invalidating the cached importer after save',
  )
  await visit('Second.lean', 'cachedB')
  assert.equal(notifications('didOpen', 'Second.lean').length, 2)
  await visit('Main.lean', 'SAVED_CACHE_CHANGE')
  assert.equal(notifications('didOpen', 'Main.lean').length, initialOpens)
  report.checks.push(
    'Typing in A keeps the cached importer warm; saving invalidates it while A retains incremental elaboration.',
  )

  await visit('Third.lean', 'cachedC')
  await until(
    () => notifications('didClose', 'Second.lean').length === 2,
    'least-recent-file eviction',
  )
  await visit('Second.lean', 'cachedB')
  await until(
    () => notifications('didClose', 'Main.lean').length === initialCloses + 1,
    'bounded cached workers',
  )
  report.checks.push(
    'Visiting a third source evicts the least recently used file and keeps at most two Lean workers per editor connection.',
  )

  await visit('Third.lean', 'cachedC')
  const closedSecond = notifications('didClose', 'Second.lean').length
  const openedSecond = notifications('didOpen', 'Second.lean').length
  state.files[projectId]['Main.lean'] += '-- EXTERNAL_IMPORT_CHANGE\n'
  await page.getByRole('button', { name: 'Refresh files', exact: true }).click()
  await until(
    () => notifications('didClose', 'Second.lean').length > closedSecond,
    'external import invalidation',
  )
  await visit('Second.lean', 'cachedB')
  assert.equal(notifications('didOpen', 'Second.lean').length, openedSecond + 1)
  report.checks.push(
    'Refreshing project sources invalidates cached importers even when the visible file and its own contents did not change.',
  )

  await page.locator('.project-item[title="Other cache fixture"]').click()
  await opened('Main.lean', 'OTHER_PROJECT_SOURCE')
  await page.locator('.project-item[title="Lean cache fixture"]').click()
  await opened('Second.lean', 'cachedB')
  assert(
    !(await page.locator('.monaco-editor .view-lines').innerText()).includes(
      'OTHER_PROJECT_SOURCE',
    ),
  )
  report.checks.push(
    'Project switching disposes the recent-file cache and does not reuse same-named sources across projects.',
  )
  assert.deepEqual(violations, [])
  assert(
    messages
      .filter((message) => message.method === 'textDocument/didOpen')
      // Upstream may send an initial registration before the bridge is ready;
      // an omitted mode defaults to always in Lean. Refreshes must never use once.
      .every(
        (message) =>
          message.params.dependencyBuildMode === undefined ||
          message.params.dependencyBuildMode === 'always',
      ),
    'fresh and refreshed files must continue building updated imports',
  )
  fixture.assertClean()
  report.ok = true
  await page.screenshot({ path: path.join(output, 'cache.png') })
} catch (error) {
  if (fixture) {
    fixture.report.failure = error.stack || String(error)
    fixture.report.pageText = await fixture.page.locator('body').innerText()
    await fixture.page.screenshot({ path: path.join(output, 'failure.png') })
  }
  throw error
} finally {
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  JSON.stringify(
    { ok: fixture.report.ok, checks: fixture.report.checks, output },
    null,
    2,
  ),
)
