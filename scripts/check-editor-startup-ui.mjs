#!/usr/bin/env node
// Keep ordinary saving responsive when Lean rejects its initialize request.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const directory = path.resolve('.runtime/editor-startup-review')
await fs.mkdir(directory, { recursive: true })
const app = express()
app.use(
  express.static(process.env.STUDIO_TEST_DIST || path.resolve('client/dist')),
)
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`
const projectId = 'editor-startup-project'
let fixture
let connections = 0
const document = new Y.Doc()
document.getText('source').insert(0, 'example : True := by trivial\n')
let collaborationSocket
const hash = (content) => createHash('sha256').update(content).digest('hex')
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'Editor startup fixture', status: 'ready' },
    ],
    files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
    chats: [{ id: 'startup-chat', projectId, title: 'Startup fixture' }],
    runs: [],
  })
  const { page, state, report } = fixture
  const sendDocument = (extra = {}) => {
    const content = document.getText('source').toString()
    state.files[projectId]['Main.lean'] = content
    collaborationSocket.send(
      JSON.stringify({
        type: 'document',
        path: 'Main.lean',
        documentId: 'startup-document',
        update: Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64'),
        content,
        hash: hash(content),
        ...extra,
      }),
    )
  }
  await page.routeWebSocket(
    `**/websocket/collaboration/${projectId}`,
    (socket) => {
      collaborationSocket = socket
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw))
        if (message.type === 'open')
          sendDocument({ openRequestId: message.requestId })
        if (message.type === 'update') {
          Y.applyUpdate(document, Buffer.from(message.update, 'base64'))
          sendDocument({ ack: message.requestId })
        }
      })
      socket.send(JSON.stringify({ type: 'ready' }))
    },
  )
  await page.routeWebSocket(`**/websocket/${projectId}`, (socket) => {
    connections++
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.method === 'initialize')
        socket.close({ code: 1011, reason: 'Isolated initialization failure' })
    })
  })
  await page.goto(base)
  await page.locator('.monaco-editor textarea').first().waitFor()
  await page
    .getByText(
      'Lean could not connect. Use Restart Lean or reopen the project to retry.',
      { exact: true },
    )
    .waitFor()
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.editor-failure').count(), 0)
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- SAVED_AFTER_INITIALIZATION_FAILURE\n')
  await until(
    () =>
      state.files[projectId]['Main.lean'].includes(
        'SAVED_AFTER_INITIALIZATION_FAILURE',
      ),
    'typing saved after failed Lean initialization',
  )
  report.checks.push(
    'An initial Lean connection rejection keeps Monaco typing bound to the source buffer and live saves.',
  )
  document
    .getText('source')
    .insert(0, '-- REMOTE_AFTER_INITIALIZATION_FAILURE\n')
  sendDocument()
  await until(
    async () =>
      (await page.locator('.monaco-editor .view-lines').innerText()).includes(
        'REMOTE_AFTER_INITIALIZATION_FAILURE',
      ),
    'remote source synchronized after failed Lean initialization',
  )
  report.checks.push(
    'A live collaborator source update still reaches Monaco after failed Lean initialization.',
  )
  await page
    .getByRole('button', { name: 'Restart Lean', exact: true })
    .first()
    .click()
  await until(() => connections > 1, 'Restart Lean retries a failed startup')
  report.restartConnectionAttempts = connections - 1
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- SAVED_AFTER_RESTART_FAILURE\n')
  await until(
    () =>
      state.files[projectId]['Main.lean'].includes(
        'SAVED_AFTER_RESTART_FAILURE',
      ),
    'typing saved after another failed Lean connection',
  )
  report.checks.push(
    'Restart Lean opens a fresh connection after failed initialization and keeps subsequent typing saved when retry also fails.',
  )
  fixture.assertClean()
  report.ok = true
} catch (error) {
  if (fixture) {
    fixture.report.failure = error.stack || String(error)
    fixture.report.pageText = await fixture.page.locator('body').innerText()
  }
  throw error
} finally {
  if (fixture) {
    await fs.writeFile(
      path.join(directory, 'report.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  document.destroy()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  JSON.stringify(
    {
      ok: fixture.report.ok,
      checks: fixture.report.checks,
      restartConnectionAttempts: fixture.report.restartConnectionAttempts,
      directory,
    },
    null,
    2,
  ),
)
