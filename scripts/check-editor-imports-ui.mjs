#!/usr/bin/env node
// Offline browser fixture: a completed import build refreshes Lean using the
// current editor text, including edits the user has not saved yet.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const id = 'editor-imports-fixture'
const chatId = 'editor-imports-chat'
const project = {
  id,
  name: 'Editor import rebuild',
  status: 'ready',
  toolchain: 'leanprover/lean4:v4.34.1',
}
const run = {
  id: 'editor-imports-run',
  kind: 'agent',
  projectId: id,
  chatId,
  mode: 'proofs',
  status: 'running',
  liveEdits: true,
  liveRevision: 1,
  createdAt: new Date().toISOString(),
  prompt: 'Add a helper module.',
  message: 'Building imports.',
  eventCursor: 0,
  liveChanges: [
    {
      path: 'Helper.lean',
      before: null,
      after: 'theorem helper : True := by trivial\n',
    },
  ],
}
const f = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture' },
    templates: [],
    models: [],
    defaultModel: 'fixture',
    runtime: { ready: true },
  },
  projects: [project],
  files: {
    [id]: {
      'Main.lean': 'import Helper\nexample : True := helper\n',
      'Helper.lean': run.liveChanges[0].after,
      'main.tex':
        '\\documentclass{article}\\begin{document}Theorem\\end{document}',
    },
  },
  chats: [{ id: chatId, projectId: id, title: 'Import rebuild', runCount: 1 }],
  runs: [run],
})
const reportDir = path.resolve('.runtime/editor-imports-ui')
await fs.mkdir(reportDir, { recursive: true })
const opened = []
let releaseSave
const saving = new Promise((resolve) => {
  releaseSave = resolve
})
f.state.onLeanMessage = (message) => {
  if (message.method === 'textDocument/didOpen')
    opened.push(message.params.textDocument)
}
await f.page.route(
  `**/api/projects/${id}/file?path=Main.lean`,
  async (route) => {
    if (route.request().method() === 'PUT') await saving
    return route.fallback()
  },
)
await f.page.route(`**/api/projects/${id}/tex**`, (route) =>
  route.fulfill({
    json: { available: false, engines: [], build: null, lastSuccessful: null },
  }),
)
try {
  await f.ready()
  await until(
    () => opened.some((doc) => doc.uri.endsWith('/Main.lean')),
    'initial Lean document',
  )
  await until(
    () =>
      f.page.evaluate((runId) => window.__chatFixture.connected(runId), run.id),
    'assistant stream',
  )
  const sockets = f.report.sockets.length
  await f.page.locator('.monaco-editor textarea').focus()
  await f.page.keyboard.press(editorShortcuts.documentEnd)
  await f.page.keyboard.insertText('-- unsaved work survives import rebuild\n')
  const before = opened.length
  project.editorImportsVersion = 1
  project.setupBuildStatus = 'passed'
  run.liveRevision++
  await f.emit(run, 'files-updated', {
    paths: ['Helper.lean'],
    live: true,
    reason: 'imports',
  })
  await until(
    () =>
      opened.length > before &&
      opened.at(-1).text.includes('unsaved work survives import rebuild'),
    'Lean document refreshed with current unsaved text',
  )
  assert.equal(
    f.report.sockets.length,
    sockets,
    'Refreshing imports must keep the language server connection',
  )
  assert.match(opened.at(-1).text, /import Helper/)
  assert.match(
    await f.page.locator('.monaco-editor .view-lines').innerText(),
    /unsaved\s+work\s+survives\s+import\s+rebuild/,
  )
  f.report.checks.push(
    'A completed import build refreshes the visible Lean document, preserves unsaved editor text, and keeps the existing language server connection.',
  )

  // The editor worker may exit before the assistant finishes its import build.
  // The rebuilt project still needs a live editor for the current document.
  await f.closeLean({ code: 1011, reason: 'Fixture editor worker stopped.' })
  await until(
    async () =>
      (await f.page.locator('.statusbar').innerText()).includes(
        'Lean server stopped',
      ),
    'editor worker stopped',
  )
  const beforeRecovery = opened.length
  project.editorImportsVersion = 2
  run.liveRevision++
  await f.emit(run, 'files-updated', {
    paths: ['Helper.lean'],
    live: true,
    reason: 'imports',
  })
  await until(
    () =>
      opened.length > beforeRecovery &&
      opened.at(-1).text.includes('unsaved work survives import rebuild'),
    'finished import build reopens the proof on a new Lean connection',
  )
  assert.equal(f.report.sockets.length, sockets + 1)
  f.report.checks.push(
    'A completed import build reconnects a stopped editor worker and reopens the current unsaved proof.',
  )

  releaseSave()
  await until(
    () =>
      f.state.files[id]['Main.lean'].includes(
        'unsaved work survives import rebuild',
      ),
    'saving the preserved edit',
  )
  await f.page.locator('.file-item[title="main.tex"]').click()
  await f.page.getByRole('region', { name: 'LaTeX PDF workspace' }).waitFor()
  await f.closeLean({ code: 1011, reason: 'Fixture editor worker stopped.' })
  const rebuildWhileReading = f.page.waitForResponse((response) =>
    response.url().endsWith('/api/projects'),
  )
  project.editorImportsVersion = 3
  run.liveRevision++
  await f.emit(run, 'files-updated', {
    paths: ['Helper.lean'],
    live: true,
    reason: 'imports',
  })
  await rebuildWhileReading
  assert.equal(f.report.sockets.length, sockets + 1)
  const beforeReturn = opened.length
  await f.page.locator('.file-item[title="Main.lean"]').click()
  await until(
    () =>
      opened.length > beforeReturn &&
      opened.at(-1).text.includes('unsaved work survives import rebuild'),
    'returning to Lean starts the stopped editor',
  )
  assert.equal(f.report.sockets.length, sockets + 2)
  f.report.checks.push(
    'A stopped connection stays idle while the user reads LaTeX and reopens the saved proof when they return to Lean.',
  )

  f.assertClean()
  f.report.passed = true
} catch (error) {
  f.report.passed = false
  f.report.error = error.stack
  process.exitCode = 1
} finally {
  releaseSave()
  await f.browser.close()
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(f.report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(f.report, null, 2))
