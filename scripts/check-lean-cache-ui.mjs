#!/usr/bin/env node
// Use real browser editor lifecycles with isolated project and LSP fixtures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.resolve(
  process.env.STUDIO_TEST_REPORT_DIR ||
    path.join(root, '.runtime/lean-cache-ui'),
)
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
      {
        id: otherId,
        name: 'Other cache fixture',
        status: 'ready',
        accessRole: 'viewer',
      },
    ],
    files: {
      [projectId]: {
        'Main.lean': 'def cachedA : Nat := 1\n#check cachedA\n',
        'Second.lean': 'import Main\ndef cachedB : Nat := cachedA\n',
        'Third.lean': 'def cachedC : Nat := 3\n',
        'Fourth.lean': 'def cachedD : Nat := 4\n',
        'Notes.md': '# Notes\n',
        '.lake/packages/library/Basic.lean': 'def externalValue := 5\n',
      },
      [otherId]: {
        'Main.lean': '-- OTHER_PROJECT_SOURCE\nexample : True := by trivial\n',
        'View.lean': '-- VIEWER_SECOND_SOURCE\n',
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
    assert.equal(
      new URL(socket).searchParams.get('expectedUserId'),
      'fixture-owner',
    )
    messages.push({ socket, ...message })
    const uri = message.params?.textDocument?.uri
    if (!uri) return
    const documents = open.get(connection) || new Map()
    open.set(connection, documents)
    if (message.method === 'textDocument/didOpen') {
      if (documents.has(uri)) violations.push('Duplicate didOpen for ' + uri)
      documents.set(uri, message.params.textDocument.version)
      if (documents.size > 3)
        violations.push('More than three Lean documents open')
    } else if (message.method === 'textDocument/didClose') {
      documents.delete(uri)
    } else if (message.method === 'textDocument/didChange') {
      if (message.params.textDocument.version <= documents.get(uri))
        violations.push('Non-increasing version for ' + uri)
      documents.set(uri, message.params.textDocument.version)
    }
  }
  // The collaboration handshake can start its scan before the initial scan
  // has returned. Let the first response open the editor, then install the
  // second listing after its Lean document is already running.
  const handshakeScan = Promise.withResolvers()
  const installBaseline = Promise.withResolvers()
  let listingCount = 0
  let includeRevisions = true
  let nextScan
  await page.route('**/api/projects/*/files', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const scan = ++listingCount
    if (scan === 2) state.files[id]['Handshake.md'] = ''
    const files = Object.entries(state.files[id]).map(([path, content]) => ({
      path,
      size: content.length,
      ...(includeRevisions && { revision: hash(content) }),
      ...(path.startsWith('.lake/') && { readOnly: true }),
    }))
    if (scan === 1) await handshakeScan.promise
    if (scan === 2) {
      handshakeScan.resolve()
      await installBaseline.promise
    }
    const gate = nextScan
    if (gate) {
      nextScan = undefined
      await gate.release.promise
    }
    return route.fulfill({
      json:
        route.request().headers()['x-leanflow-file-listing'] === 'project'
          ? { files: files.filter(({ path }) => !path.startsWith('.lake/')) }
          : files,
    })
  })
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
        new URL(message.socket).pathname === '/websocket/' + projectId,
    )
  async function opened(filename, marker) {
    await until(
      async () =>
        (await page.locator('.editor-loading').count()) === 0 &&
        (await page
          .getByRole('tab', { name: filename, exact: true })
          .getAttribute('aria-selected')) === 'true' &&
        (await page.locator('.monaco-editor .view-lines').innerText()).includes(
          marker,
        ),
      `opening ${filename}`,
    )
    assert.equal(await page.locator('.editor-failure').count(), 0)
  }
  let keepVisits = false
  async function visit(filename, marker) {
    const tab = page.getByRole('tab', { name: filename, exact: true })
    if (await tab.count()) await tab.click()
    else await page.locator(`.file-item[title="${filename}"]`).click()
    await opened(filename, marker)
    if (keepVisits) await tab.dblclick()
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
  installBaseline.resolve()
  await page.locator('.file-item[title="Handshake.md"]').waitFor()
  assert.equal(
    await page.locator('.lean-import-notice').count(),
    0,
    'Installing the first accepted revisioned listing after the proof opens must not report stale imports',
  )
  report.checks.push(
    'A late initial file listing leaves freshly opened goals current.',
  )
  const initialOpens = notifications('didOpen', 'Main.lean').length
  const initialCloses = notifications('didClose', 'Main.lean').length
  await visit('Second.lean', 'cachedB')
  assert.equal(await page.getByRole('tab').count(), 1)
  await visit('Main.lean', 'cachedA')
  assert.equal(await page.getByRole('tab').count(), 1)
  assert.equal(notifications('didOpen', 'Main.lean').length, initialOpens)
  assert.equal(notifications('didClose', 'Main.lean').length, initialCloses)
  assert.equal(notifications('didChange', 'Main.lean').length, 0)
  await visit('Third.lean', 'cachedC')
  await visit('Second.lean', 'cachedB')
  await visit('Main.lean', 'cachedA')
  assert.equal(notifications('didOpen', 'Main.lean').length, initialOpens)
  assert.equal(notifications('didOpen', 'Second.lean').length, 1)
  assert.equal(notifications('didOpen', 'Third.lean').length, 1)
  assert.equal(await page.getByRole('tab').count(), 1)
  report.checks.push(
    'Replacing preview A with B and returning preserves A’s Lean worker and model version without a virtual file rewrite.',
  )
  // The remaining close/keyboard checks exercise explicitly kept tabs.
  keepVisits = true
  await page.getByRole('tab', { name: 'Main.lean', exact: true }).dblclick()

  const protocolCount = () =>
    messages.filter((message) =>
      ['textDocument/didOpen', 'textDocument/didClose'].includes(
        message.method,
      ),
    ).length
  const beforeRefresh = protocolCount()
  async function refreshListing() {
    const response = page.waitForResponse((response) =>
      response.url().endsWith(`/api/projects/${projectId}/files`),
    )
    await page
      .getByRole('button', { name: 'Refresh files', exact: true })
      .click()
    await response
    await page.waitForTimeout(300)
  }
  async function changedProjectFile(path) {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/projects/${projectId}/files`) &&
        response.request().headers()['x-leanflow-file-listing'] === 'project',
    )
    fixture.sendCollaboration({ type: 'files', paths: [path] })
    assert((await response).ok())
  }
  await refreshListing()
  assert.equal(protocolCount(), beforeRefresh)
  state.files[projectId]['Notes.md'] += 'Changed notes.\n'
  await changedProjectFile('Notes.md')
  await page.getByRole('button', { name: /^Dependencies/ }).click()
  await page
    .locator('.file-item[title=".lake/packages/library/Basic.lean"]')
    .waitFor()
  assert.equal(protocolCount(), beforeRefresh)
  assert.equal(await page.locator('.lean-import-notice').count(), 0)
  report.checks.push(
    'Unchanged listings and documentation-only edits preserve Lean workers; revisions, not source sizes, drive invalidation.',
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
  const threeOpens = messages.filter(
    (message) => message.method === 'textDocument/didOpen',
  ).length
  await visit('Second.lean', 'cachedB')
  await visit('Main.lean', 'cachedA')
  await visit('Third.lean', 'cachedC')
  assert.equal(
    messages.filter((message) => message.method === 'textDocument/didOpen')
      .length,
    threeOpens,
  )
  await visit('Fourth.lean', 'cachedD')
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
    'Three tabs reuse Lean workers without reopening; a fourth evicts the least recently used file, keeping at most three workers per editor connection.',
  )

  await visit('Third.lean', 'cachedC')
  const closedSecond = notifications('didClose', 'Second.lean').length
  const openedSecond = notifications('didOpen', 'Second.lean').length
  const thirdOpens = notifications('didOpen', 'Third.lean').length
  state.files[projectId]['Main.lean'] += '-- EXTERNAL_IMPORT_CHANGE\n'
  await changedProjectFile('Main.lean')
  await until(
    () => notifications('didClose', 'Second.lean').length > closedSecond,
    'external import invalidation',
  )
  const refreshImports = page.getByRole('button', {
    name: 'Refresh imports',
    exact: true,
  })
  await refreshImports.waitFor()
  assert.equal(
    notifications('didOpen', 'Third.lean').length,
    thirdOpens,
    'A foreign save must not restart the visible proof',
  )
  const reloaded = page.waitForResponse((response) =>
    response.url().includes('/file?path=Third.lean'),
  )
  await page.getByRole('button', { name: 'Reload file', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Reload saved file' })
    .getByRole('button', { name: 'Reload this file', exact: true })
    .click()
  await reloaded
  await opened('Third.lean', 'cachedC')
  await page.waitForTimeout(300)
  const reusedStaleWorker =
    notifications('didOpen', 'Third.lean').length === thirdOpens
  assert.equal(
    await refreshImports.isVisible(),
    reusedStaleWorker,
    'Reloading the same text only refreshes imports when Lean actually reopens its document',
  )
  const beforeStaleReturn = notifications('didOpen', 'Third.lean').length
  await visit('Second.lean', 'cachedB')
  assert.equal(notifications('didOpen', 'Second.lean').length, openedSecond + 1)
  await visit('Third.lean', 'cachedC')
  const reopenedThird = notifications('didOpen', 'Third.lean').length
  if (reusedStaleWorker)
    assert.equal(
      reopenedThird,
      beforeStaleReturn + 1,
      'An unchanged reload cannot re-cache a worker with stale imports',
    )
  assert.equal(await refreshImports.isVisible(), false)
  const secondBeforeRefresh = notifications('didOpen', 'Second.lean').length
  state.files[projectId]['Main.lean'] += '-- ANOTHER_IMPORT_CHANGE\n'
  await refreshListing()
  await refreshImports.waitFor()
  assert.equal(
    notifications('didOpen', 'Third.lean').length,
    reopenedThird,
    'A later foreign edit still must not automatically restart the proof',
  )
  const beforeExplicitRefresh = notifications('didOpen', 'Third.lean').length
  await refreshImports.click()
  await until(
    () =>
      notifications('didOpen', 'Third.lean').length ===
      beforeExplicitRefresh + 1,
    'explicit import refresh',
  )
  await refreshImports.waitFor({ state: 'hidden' })
  state.files[projectId]['Main.lean'] += '-- CHANGED_BEFORE_IMPORT_BUILD\n'
  await changedProjectFile('Main.lean')
  await refreshImports.waitFor()
  const beforeBuildRefresh = notifications('didOpen', 'Third.lean').length
  state.projects.find(
    (project) => project.id === projectId,
  ).editorImportsVersion = 1
  fixture.sendCollaboration({ type: 'editor-imports', paths: [] })
  await until(
    () =>
      notifications('didOpen', 'Third.lean').length === beforeBuildRefresh + 1,
    'automatic refresh after imports rebuild',
  )
  await refreshImports.waitFor({ state: 'hidden' })
  await visit('Second.lean', 'cachedB')
  assert.equal(
    notifications('didOpen', 'Second.lean').length,
    secondBeforeRefresh + 1,
  )
  report.checks.push(
    'Foreign changes mark current goals stale without restarting them. Reusing a document keeps the notice. An actual reopen, including after an automatic import rebuild, clears it.',
  )

  const thirdCloses = notifications('didClose', 'Third.lean').length
  const secondOpens = notifications('didOpen', 'Second.lean').length
  await page.getByTitle('Close Third.lean', { exact: true }).click()
  await until(
    () => notifications('didClose', 'Third.lean').length > thirdCloses,
    'closed tab releases its worker',
  )
  assert.equal(
    await page.getByRole('tab', { name: 'Third.lean', exact: true }).count(),
    0,
  )
  assert.equal(notifications('didOpen', 'Second.lean').length, secondOpens)
  const secondTab = page.getByRole('tab', { name: 'Second.lean', exact: true })
  await secondTab.focus()
  await page.keyboard.press('Home')
  assert.equal(
    await page
      .getByRole('tab', { name: 'Main.lean', exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  )
  await page.keyboard.press('End')
  assert.equal(
    await page
      .getByRole('tab', { name: 'Fourth.lean', exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  )
  report.checks.push(
    'Closing a background tab releases its Lean worker without rechecking the current file; tab navigation supports keyboard focus.',
  )

  keepVisits = false
  await page.locator('.project-item[title="Other cache fixture"]').click()
  await opened('Main.lean', 'OTHER_PROJECT_SOURCE')
  assert.equal(
    await page
      .getByRole('tablist', { name: 'Open files' })
      .getByRole('tab')
      .count(),
    1,
  )
  const viewerOpens = () =>
    messages.filter(
      (message) =>
        message.method === 'textDocument/didOpen' &&
        new URL(message.socket).pathname === '/websocket/' + otherId &&
        message.params.textDocument.uri.endsWith('/Main.lean'),
    ).length
  const viewerBefore = viewerOpens()
  await visit('View.lean', 'VIEWER_SECOND_SOURCE')
  await visit('Main.lean', 'OTHER_PROJECT_SOURCE')
  assert.equal(viewerOpens(), viewerBefore)
  assert.equal(
    await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
    false,
  )
  report.checks.push(
    'Viewers of shared projects reuse recent Lean work while their files remain read-only.',
  )
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
  const dependency = '.lake/packages/library/Basic.lean'
  const dependencyItem = page.locator(`.file-item[title="${dependency}"]`)
  if (!(await dependencyItem.isVisible()))
    await page.getByRole('button', { name: /^Dependencies/ }).click()
  const finishOpen = Promise.withResolvers()
  let reads = 0
  await page.route('**/api/projects/*/file?*', async (route) => {
    if (
      new URL(route.request().url()).searchParams.get('path') === dependency &&
      ++reads === 2
    ) {
      // The Studio GET selected the file. Its read-only Monaco model has
      // now requested the source, but no Lean document has opened for it.
      await finishOpen.promise
    }
    return route.fallback()
  })
  await dependencyItem.click()
  await until(() => reads >= 2, 'read-only model source request')
  assert.equal(notifications('didOpen', dependency).length, 0)
  state.files[projectId]['Main.lean'] += '-- DURING_FILE_SWITCH\n'
  state.files[projectId]['Switch.md'] = ''
  await changedProjectFile('Main.lean')
  await page.locator('.file-item[title="Switch.md"]').waitFor()
  assert.equal(
    await refreshImports.isVisible(),
    false,
    'An unopened document cannot have stale goals',
  )
  finishOpen.resolve()
  await opened(dependency, 'externalValue')
  assert.equal(await refreshImports.isVisible(), false)
  report.checks.push(
    'A dependency change during navigation is picked up when the newly selected Lean document opens.',
  )

  includeRevisions = false
  await refreshListing()
  await refreshListing()
  assert.equal(
    await refreshImports.isVisible(),
    false,
    'Repeated unversioned listings without file changes must leave the visible goals current',
  )
  // A superseding manual scan must retain the earlier collaboration signal,
  // even though the older server supplies no revision and the size is equal.
  const source = state.files[projectId]['Main.lean']
  state.files[projectId]['Main.lean'] = source.replace('cachedA', 'cachedZ')
  assert.equal(state.files[projectId]['Main.lean'].length, source.length)
  const gate = { release: Promise.withResolvers() }
  nextScan = gate
  fixture.sendCollaboration({ type: 'files', paths: ['Main.lean'] })
  await until(() => !nextScan, 'collaboration file listing')
  await refreshListing()
  await refreshImports.waitFor()
  gate.release.resolve()
  await refreshImports.click()
  await refreshImports.waitFor({ state: 'hidden' })
  report.checks.push(
    'Incomplete metadata keeps ordinary opens clear and still warns about a reported same-size import edit across overlapping scans.',
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
