#!/usr/bin/env node
// Hold LSP initialize while testing actual built Monaco, without Lean or users.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  chatBrowserFixture,
  installEditorClock,
  until,
} from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/editor-queue-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'editor-queue-project'
const sources = {
  'Main.lean': 'theorem queueFirst : True := by trivial\n',
  'Second.lean': 'theorem queueSecond : True := by trivial\n',
}
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
      [projectId]: { ...sources },
      'queue-other-project': {
        'Main.lean': '-- OTHER_QUEUE_PROJECT\nexample : True := by trivial\n',
      },
    },
    chats: [{ id: 'queue-chat', projectId, title: 'Queue fixture' }],
    runs: [],
  })
  const { page, state, report } = fixture
  const checkRequests = []
  let checkJob
  await page.route(`**/api/projects/${projectId}/check`, async (route) => {
    const body = route.request().postDataJSON()
    checkRequests.push({
      body,
      source: state.files[projectId][body.path],
      user: route.request().headers()['x-leanflow-user'],
    })
    checkJob = {
      id: `queue-check-${checkRequests.length}`,
      projectId,
      createdAt: new Date().toISOString(),
      status: 'queued',
      file: body.path,
      checkScope: body.scope,
      log: 'Waiting for a check worker.',
    }
    await route.fulfill({ status: 202, json: checkJob })
  })
  await page.route('**/api/jobs/queue-check-*', (route) =>
    route.fulfill({ json: checkJob }),
  )
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
        const document = message.params?.textDocument
        if (
          ['textDocument/didOpen', 'textDocument/didChange'].includes(
            message.method,
          )
        ) {
          const { uri, version } = document
          send({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: { uri, version, diagnostics: [], isIncremental: false },
          })
          send({
            jsonrpc: '2.0',
            method: '$/lean/fileProgress',
            params: { textDocument: { uri, version }, processing: [] },
          })
        }
        if (!('id' in message)) return
        let result = null
        if (message.method === '$/lean/rpc/connect')
          result = { sessionId: 'queue-fixture' }
        if (/plainGoal/.test(message.method || '')) result = { goals: [] }
        if (message.method === 'textDocument/documentSymbol') {
          const path = document.uri.split('/').at(-1)
          result = [
            {
              name: path === 'Second.lean' ? 'queueSecond' : 'queueFirst',
              kind: 12,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: sources[path].trimEnd().length },
              },
            },
          ]
        }
        if (message.method === 'textDocument/waitForDiagnostics') result = {}
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
  await installEditorClock(page)
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
  const tab = (name) => page.getByRole('tab', { name, exact: true })
  await page.locator('.file-item[title="Second.lean"]').dblclick()
  await until(
    async () =>
      (await tab('Second.lean').getAttribute('aria-selected')) === 'true' &&
      (await page.locator('.monaco-editor .view-lines').innerText()).includes(
        'queueSecond',
      ),
    'second file opens while waiting',
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await source.focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- SECOND_SAVED_WHILE_WAITING\n')
  await until(
    () =>
      state.files[projectId]['Second.lean'].includes(
        'SECOND_SAVED_WHILE_WAITING',
      ),
    'saving the second file while queued',
  )
  assert.equal(
    await page
      .getByRole('tablist', { name: 'Open files' })
      .getByRole('tab')
      .count(),
    2,
  )
  assert.equal(connections, 1)
  assert(!messages.some((message) => message.method === 'initialized'))
  assert.equal(
    checkRequests.length,
    0,
    'Waiting and editing do not submit background checks',
  )
  await source.focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- CHECK_THIS_REVISION\n')
  await waiting
    .getByRole('button', { name: 'Check this file', exact: true })
    .click()
  const outputPanel = page.locator('.build-output')
  await outputPanel
    .getByText('File check · Second.lean', { exact: true })
    .waitFor()
  await outputPanel.getByText('queued', { exact: true }).waitFor()
  assert.deepEqual(checkRequests[0].body, {
    path: 'Second.lean',
    scope: 'file',
  })
  assert.equal(checkRequests[0].user, 'queue-owner')
  assert(checkRequests[0].source.includes('CHECK_THIS_REVISION'))
  await source.focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- EDITED_DURING_CHECK\n')
  await until(
    () => state.files[projectId]['Second.lean'].includes('EDITED_DURING_CHECK'),
    'editing continues during separate file check',
  )
  checkJob = {
    ...checkJob,
    status: 'completed',
    checkMethod: 'lean-file',
    log: 'Second.lean compiled.',
    result: {
      code: 0,
      checkedSnapshot: 'a'.repeat(64),
      hasWarnings: false,
      sourceChanged: true,
    },
  }
  await outputPanel
    .getByText('Second.lean compiled.', { exact: true })
    .waitFor()
  await outputPanel
    .getByText('Passed · earlier version', { exact: true })
    .waitFor()
  assert(await outputPanel.locator('output.success svg').isVisible())
  await outputPanel.getByText(/again to check current sources/).waitFor()
  assert.equal(checkRequests.length, 1)
  assert.equal(connections, 1)
  assert(!messages.some((message) => message.method === 'initialized'))
  report.checks.push(
    'A waiting editor submits exactly one file-only check of its saved selection, keeps editing and sees its own completed job before Lean admission.',
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
  await page.clock.fastForward(29 * 60_000)
  notice({ state: 'starting' })
  await page.locator('[data-editor-queue="starting"]').waitFor()
  notice({ state: 'active' })
  send({
    jsonrpc: '2.0',
    id: initialize.id,
    result: {
      capabilities: { textDocumentSync: 1, documentSymbolProvider: true },
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
  const checked = (name) =>
    page
      .locator('.proof-outline-entry')
      .filter({ has: page.getByText(name, { exact: true }) })
      .getByRole('img', { name: 'Lean checked', exact: true })
  const openedWithEdits = (path) =>
    messages.some(
      (message) =>
        message.method === 'textDocument/didOpen' &&
        message.params.textDocument.uri === 'file:///workspace/' + path &&
        message.params.textDocument.text === state.files[projectId][path],
    )
  await checked('queueSecond').waitFor()
  assert(openedWithEdits('Second.lean'))
  await page.clock.fastForward(2 * 60_000)
  assert(
    !messages.some((message) => message.method === 'shutdown'),
    'Time spent waiting must not put a newly promoted editor to sleep',
  )
  await tab('Main.lean').click()
  await checked('queueFirst').waitFor()
  assert(openedWithEdits('Main.lean'))
  assert.equal(connections, 1)
  await source.focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- SAVED_AFTER_PROMOTION\n')
  await until(
    () => state.files[projectId]['Main.lean'].includes('SAVED_AFTER_PROMOTION'),
    'saving after promotion',
  )
  report.checks.push(
    'Two edited file tabs share one queue position and one Lean connection. On promotion each file opens with its own saved text and current checked theorem.',
  )
  await page.getByRole('button', { name: 'Check Project', exact: true }).click()
  await outputPanel.getByText('queued', { exact: true }).waitFor()
  await outputPanel.getByText('Project check', { exact: true }).waitFor()
  assert.deepEqual(checkRequests[1].body, { path: 'Main.lean' })
  checkJob = {
    ...checkJob,
    status: 'completed',
    checkMethod: 'lake-check',
    result: { code: 0, hasWarnings: false },
    log: 'Project targets checked.',
  }
  await outputPanel
    .getByText('Project targets checked.', { exact: true })
    .waitFor()
  await outputPanel
    .locator('output.success')
    .filter({ hasText: 'Completed' })
    .waitFor()
  await page.getByRole('button', { name: 'Check File', exact: true }).click()
  await outputPanel
    .getByText('File check · Main.lean', { exact: true })
    .waitFor()
  assert.deepEqual(checkRequests[2].body, { path: 'Main.lean', scope: 'file' })
  checkJob = {
    ...checkJob,
    status: 'failed',
    error: 'Main.lean:1: fixture compiler error',
    log: '',
    result: { code: 1, sourceChanged: true },
  }
  await outputPanel
    .getByRole('alert')
    .filter({ hasText: 'Main.lean:1: fixture compiler error' })
    .waitFor()
  assert.equal(await outputPanel.getByText(/earlier version/).count(), 0)
  await page.getByRole('button', { name: 'Check File', exact: true }).click()
  await outputPanel.getByText('queued', { exact: true }).waitFor()
  checkJob = {
    ...checkJob,
    status: 'failed',
    error: 'Saved version did not compile.',
    result: { code: 1, checkedSnapshot: 'b'.repeat(64), sourceChanged: true },
  }
  await outputPanel
    .getByText('Failed · earlier version', { exact: true })
    .waitFor()
  assert(await outputPanel.locator('output.danger svg').isVisible())
  for (const sourceChanged of [false, true]) {
    await page.getByRole('button', { name: 'Check File', exact: true }).click()
    await outputPanel.getByText('queued', { exact: true }).waitFor()
    checkJob = {
      ...checkJob,
      status: 'completed',
      checkMethod: 'lean-file',
      log: 'Main.lean:1:8: warning: declaration uses sorry',
      result: {
        code: 0,
        hasWarnings: true,
        checkedSnapshot: 'c'.repeat(64),
        sourceChanged,
        truncated: sourceChanged,
      },
    }
    const label = sourceChanged
      ? 'Compiled with warnings · earlier version'
      : 'Compiled with warnings'
    await outputPanel.getByText(label, { exact: true }).waitFor()
    assert(await outputPanel.locator('output.warning svg').isVisible())
    await outputPanel.getByText(/Review Lean’s warnings/).waitFor()
    await outputPanel.getByText(/declaration uses sorry/).waitFor()
    assert.equal(
      await outputPanel.getByText(/again to check current sources/).count(),
      Number(sourceChanged),
    )
  }
  await page.getByRole('button', { name: 'Check File', exact: true }).click()
  await outputPanel.getByText('queued', { exact: true }).waitFor()
  checkJob = {
    ...checkJob,
    status: 'completed',
    result: { code: 0, hasWarnings: false, truncated: true },
  }
  await outputPanel.getByText('Completed', { exact: true }).waitFor()
  assert.equal(await outputPanel.locator('output svg').count(), 0)
  assert.equal(await outputPanel.locator('output.success').count(), 0)
  for (const [checkMethod, label] of [
    ['lake-check', 'Verified with warnings'],
    ['lake-build', 'Compiled with warnings'],
  ]) {
    await page
      .getByRole('button', { name: 'Check Project', exact: true })
      .click()
    await outputPanel.getByText('queued', { exact: true }).waitFor()
    checkJob = {
      ...checkJob,
      status: 'completed',
      checkMethod,
      result: { code: 0, hasWarnings: true },
      log: 'Main.lean:3:0: warning: declaration uses sorry',
    }
    await outputPanel.getByText(label, { exact: true }).waitFor()
    assert(await outputPanel.locator('output.warning svg').isVisible())
    await outputPanel.getByText(/declaration uses sorry/).waitFor()
  }
  await page.getByRole('button', { name: 'Check Project', exact: true }).click()
  await outputPanel.getByText('queued', { exact: true }).waitFor()
  checkJob = {
    ...checkJob,
    status: 'failed',
    checkMethod: 'lake-check',
    result: { code: 1, hasWarnings: true },
    error: 'Project verification failed.',
  }
  await outputPanel.getByText('Failed', { exact: true }).waitFor()
  assert(await outputPanel.locator('output.danger svg').isVisible())
  assert.equal(await outputPanel.locator('output.warning').count(), 0)
  report.checks.push(
    'Project checks distinguish kernel verification with warnings from compiler-only warnings, preserve a clean success, and keep a failing kernel check visibly failed.',
  )
  report.checks.push(
    'Clean, warning and failed file checks have distinct visible symbols and labels. Current and earlier warning results both retain Lean’s diagnostic.',
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
