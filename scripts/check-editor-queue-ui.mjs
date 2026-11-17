#!/usr/bin/env node
// Hold LSP initialize while testing actual built Monaco, without Lean or users.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/editor-queue-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'editor-queue-project'
let fixture
try {
  fixture = await chatBrowserFixture({
    base: process.env.STUDIO_TEST_URL || 'http://127.0.0.1:4173',
    session: {
      user: { id: 'queue-owner', name: 'Queue fixture' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'Editor queue fixture', status: 'ready' },
      {
        id: 'queue-other-project',
        name: 'Other queue project',
        status: 'ready',
      },
    ],
    files: {
      [projectId]: { 'Main.lean': 'example : True := by trivial\n' },
      'queue-other-project': {
        'Main.lean': '-- OTHER_QUEUE_PROJECT\nexample : True := by trivial\n',
      },
    },
    chats: [{ id: 'queue-chat', projectId, title: 'Queue fixture' }],
    runs: [],
  })
  const { page, state, report } = fixture
  const messages = []
  const closed = []
  report.leanMessages = messages
  report.console = []
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type()))
      report.console.push(message.text())
  })
  let socket,
    initialize,
    connections = 0
  const send = (message) => socket.send(JSON.stringify(message))
  const notice = (params) =>
    send({ jsonrpc: '2.0', method: '$/leanflow/editorQueue', params })
  await page.routeWebSocket(
    (url) => url.pathname === `/websocket/${projectId}`,
    (connection) => {
      socket = connection
      connections++
      const id = connections
      connection.onClose(() => closed.push(id))
      connection.onMessage((raw) => {
        const message = JSON.parse(String(raw))
        messages.push(message)
        if (message.method === 'initialize') {
          initialize = message
          notice({ state: 'waiting', position: 3, total: 4 })
          return
        }
        if (!('id' in message)) return
        let result = null
        if (message.method === '$/lean/rpc/connect')
          result = { sessionId: 'queue-fixture' }
        if (/plainGoal/.test(message.method || '')) result = { goals: [] }
        if (message.method === 'textDocument/documentSymbol') result = []
        if (message.method === '$/lean/rpc/call') {
          const method = message.params?.method
          if (method === 'Lean.Widget.getInteractiveGoals')
            result = { goals: [] }
          if (method === 'Lean.Widget.getInteractiveDiagnostics') result = []
          if (method === 'Lean.Widget.getWidgets') result = { widgets: [] }
        }
        connection.send(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result }),
        )
      })
    },
  )
  await page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:4173')
  const source = page.locator('.monaco-editor textarea').first()
  await source.waitFor({ timeout: 60000 })
  const waiting = page.locator('[data-editor-queue="waiting"]')
  await waiting.waitFor()
  assert.match(await waiting.innerText(), /position 3 of 4/)
  for (const button of await page
    .getByRole('button', { name: 'Restart Lean', exact: true })
    .all())
    assert(
      await button.isDisabled(),
      'Waiting must not start a competing Lean restart',
    )
  assert.equal(connections, 1)
  assert.equal(
    messages.filter((message) => message.method === 'initialize').length,
    1,
  )
  assert(!messages.some((message) => message.method === 'initialized'))
  report.checks.push(
    'The built editor shows a bounded public position while LSP initialize is still pending.',
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await source.focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- SAVED_WHILE_WAITING\n')
  await until(
    () => state.files[projectId]['Main.lean'].includes('SAVED_WHILE_WAITING'),
    'saving while queued',
  )
  const mounted = await source.elementHandle()
  notice({ state: 'waiting', position: 1, total: 2 })
  await until(
    async () => /position 1 of 2/.test(await waiting.innerText()),
    'updated queue position',
  )
  await page.screenshot({ path: path.join(output, 'waiting.png') })
  report.checks.push(
    'Typing and hash-checked canonical saving remain available; position updates do not reconnect or replace Monaco.',
  )
  notice({ state: 'starting' })
  await page.locator('[data-editor-queue="starting"]').waitFor()
  notice({ state: 'active' })
  send({
    jsonrpc: '2.0',
    id: initialize.id,
    result: {
      capabilities: { textDocumentSync: 1 },
      serverInfo: { name: 'Queue fixture', version: '1.0.0' },
    },
  })
  await until(
    () => messages.some((message) => message.method === 'textDocument/didOpen'),
    'promotion sends current source',
  )
  await page.locator('[data-editor-queue]').waitFor({ state: 'hidden' })
  await until(
    async () =>
      /Lean connected/.test(await page.locator('.statusbar').innerText()),
    'promoted Lean connection',
  )
  assert.equal(
    connections,
    1,
    'Automatic promotion uses the existing WebSocket',
  )
  assert.equal(
    messages.filter((message) => message.method === 'initialize').length,
    1,
  )
  assert(
    await mounted.evaluate((element) => element.isConnected),
    'Monaco remains mounted',
  )
  assert(
    messages
      .find((message) => message.method === 'textDocument/didOpen')
      .params.textDocument.text.includes('SAVED_WHILE_WAITING'),
  )
  await source.focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- SAVED_AFTER_PROMOTION\n')
  await until(
    () => state.files[projectId]['Main.lean'].includes('SAVED_AFTER_PROMOTION'),
    'saving after promotion',
  )
  report.checks.push(
    'Promotion completes the original initialize, opens the latest saved text, clears the notice and preserves further editing and saving.',
  )
  await page
    .getByRole('button', { name: 'Restart Lean', exact: true })
    .first()
    .click()
  await until(() => connections === 2, 'a second queued visit')
  await waiting.waitFor()
  await page
    .locator('.project-item')
    .and(page.getByTitle('Other queue project', { exact: true }))
    .click()
  await until(
    () => closed.includes(2),
    'project switch cancels the pending socket',
    3000,
  )
  await until(
    async () =>
      /OTHER_QUEUE_PROJECT/.test(
        await page.locator('.monaco-editor .view-lines').innerText(),
      ),
    'other project source',
  )
  await page.locator('[data-editor-queue]').waitFor({ state: 'hidden' })
  await until(
    async () =>
      /Lean connected/.test(await page.locator('.statusbar').innerText()),
    'other project connects after queued cancellation',
  )
  assert.equal(connections, 2, 'The abandoned project never reconnects')
  report.checks.push(
    'Switching projects cancels the pending queue socket promptly, clears its position and opens the next project without admitting the abandoned one.',
  )
  fixture.assertClean()
  report.connections = connections
  report.ok = true
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
      path.join(output, 'report.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
}
console.log(
  JSON.stringify(
    { ok: fixture.report.ok, checks: fixture.report.checks, output },
    null,
    2,
  ),
)
