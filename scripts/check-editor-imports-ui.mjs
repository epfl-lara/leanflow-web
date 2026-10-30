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
  releaseSave()
  f.assertClean()
  f.report.checks.push(
    'A completed import build refreshes the visible Lean document, preserves unsaved editor text, and keeps the existing language server connection.',
  )
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
