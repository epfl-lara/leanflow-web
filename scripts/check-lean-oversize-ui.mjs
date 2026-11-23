#!/usr/bin/env node
// Exercise startup rejection, recovery and an oversized source in the real editor.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  chatBrowserFixture,
  until,
  sleep,
} from './lib/chat-browser-fixture.mjs'

const id = 'lean-oversize-fixture'
const source = 'example : True := by trivial\n'
const f = await chatBrowserFixture({
  session: {
    user: { id: 'fixture', name: 'Editor fixture' },
    templates: [],
    models: [{ id: 'fixture', name: 'Fixture' }],
    defaultModel: 'fixture',
    runtime: { ready: true },
  },
  projects: [{ id, name: 'Lean payload fixture', status: 'ready' }],
  files: { [id]: { 'Main.lean': source, 'Second.lean': '-- second module\n' } },
  chats: [
    {
      id: 'oversize-chat',
      projectId: id,
      title: 'Editor fixture',
      runCount: 0,
    },
  ],
  runs: [],
})
const reportDir = path.resolve('.runtime/lean-oversize-ui')
await fs.mkdir(reportDir, { recursive: true })
let saves = 0,
  attempts = 0
let allowSaves = false
await f.page.route(
  `**/api/projects/${id}/file?path=Main.lean`,
  async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    const input = route.request().postDataJSON()
    attempts++
    if (!allowSaves)
      return route.fulfill({
        status: 429,
        headers: { 'Retry-After': '1' },
        json: {
          error:
            'Source uploads and saves are busy. Wait a moment and try again. Your unsaved edits are preserved.',
        },
      })
    assert.equal(
      input.expectedHash,
      createHash('sha256').update(source).digest('hex'),
    )
    f.state.files[id]['Main.lean'] = input.content
    saves++
    await route.fulfill({
      json: {
        hash: createHash('sha256').update(input.content).digest('hex'),
        requiresPreparation: false,
      },
    })
  },
)
try {
  const queueReason =
    'No Lean editor became free in time. Reopen the file to join the waiting list again.'
  let rejectStartup = true
  let admitRetry, initializeRetry
  f.state.onLeanMessage = (message, _url, socket) => {
    if (message.method !== 'initialize') return
    if (rejectStartup) {
      socket.close({ code: 1013, reason: queueReason })
    } else {
      const notify = (params) =>
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: '$/leanflow/editorQueue',
            params,
          }),
        )
      notify({ state: 'waiting', position: 1, total: 1 })
      admitRetry = () => notify({ state: 'active' })
      initializeRetry = () =>
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              capabilities: { textDocumentSync: 1 },
              serverInfo: { name: 'Browser fixture', version: '0.2.0' },
            },
          }),
        )
    }
    return true
  }
  await f.page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:4173')
  const startupAlert = f.page.getByRole('alert').getByText(queueReason)
  const goals = f.page.locator('.infoview-host')
  await startupAlert.waitFor({ timeout: 60000 })
  await f.page
    .getByText('Live goals are unavailable while Lean is disconnected.')
    .waitFor()
  assert(await goals.isHidden())
  const connected = f.page.locator('.statusbar').getByText('Lean connected')
  rejectStartup = false
  await f.page.locator('.file-item[title="Second.lean"]').dblclick()
  const queueNotice = f.page.locator('[data-editor-queue="waiting"]')
  await queueNotice.waitFor()
  assert(
    await startupAlert.isHidden(),
    'The current queue position takes priority over the previous failure',
  )
  assert(
    await goals.isHidden(),
    'A queued reconnection cannot show stale goals',
  )
  admitRetry()
  await queueNotice.waitFor({ state: 'hidden' })
  assert(await goals.isHidden(), 'Admission alone cannot restore live goals')
  initializeRetry()
  await connected.waitFor()
  await startupAlert.waitFor({ state: 'hidden' })
  await goals.waitFor({ state: 'visible' })
  await f.page.getByRole('button', { name: 'Failure log', exact: true }).click()
  const log = f.page.getByRole('region', { name: 'Failure log' })
  await log.getByText(queueReason, { exact: true }).waitFor()
  assert.equal(await log.locator('li').count(), 1)
  await log.getByRole('button', { name: 'Close failure log' }).click()
  await f.page.locator('.file-item[title="Main.lean"]').dblclick()
  await until(
    async () =>
      (await f.page.locator('.monaco-editor .view-lines').innerText()).includes(
        'True',
      ),
    'original file after automatic recovery',
  )
  f.report.checks.push(
    'A rejection before initialization shows the worker queue timeout and hides stale goals. Opening another Lean file reconnects automatically, restores goals and clears the alert.',
  )
  await f.page.locator('.monaco-editor textarea').focus()
  await f.page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await f.page.keyboard.insertText('-- unsaved before disconnect\n')
  const save = f.page.getByRole('button', { name: 'Save', exact: true })
  await until(() => save.isEnabled(), 'unsaved edit')
  const connections = f.report.sockets.length
  const reason =
    'Lean source files must be at most 8 MiB. Reduce the file or split Lean sources into smaller modules.'
  await f.closeLean({ code: 1009, reason })
  await f.page.getByText('Lean checking paused', { exact: true }).waitFor()
  await f.page.getByText(reason, { exact: true }).waitFor()
  await sleep(2000)
  assert.equal(
    f.report.sockets.length,
    connections,
    'A rejected source cannot trigger automatic reconnections',
  )
  await f.page
    .locator('.autosave-alert')
    .getByText(/Autosave will retry: Source uploads and saves are busy/)
    .waitFor()
  assert(
    attempts >= 1,
    'Autosave should remain available when Lean checking is paused',
  )
  assert.equal(saves, 0)
  assert.equal(f.state.files[id]['Main.lean'], source)
  await f.page.locator('.monaco-editor textarea').focus()
  await f.page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
  )
  await f.page.keyboard.insertText('-- still editable after disconnect\n')
  await save.click()
  await f.page
    .getByText(
      'Source uploads and saves are busy. Wait a moment and try again. Your unsaved edits are preserved.',
      { exact: true },
    )
    .waitFor()
  assert.equal(f.state.files[id]['Main.lean'], source)
  assert(await save.isEnabled(), 'A rejected save retains the dirty buffer')
  allowSaves = true
  await save.click()
  await until(async () => saves === 1, 'preserved edits saved')
  assert.equal(
    f.state.files[id]['Main.lean'],
    source +
      '-- unsaved before disconnect\n-- still editable after disconnect\n',
  )
  f.report.checks.push(
    'A 1009 close explains why Lean checking paused without reconnecting; autosave and manual save report capacity rejection, retain edits, and save both edits once capacity returns',
  )
  f.assertClean()
  f.report.passed = true
} catch (error) {
  f.report.failure = String(error)
  f.report.status = await f.page
    .locator('.statusbar')
    .textContent()
    .catch(() => '')
  f.report.notices = await f.page
    .locator('.lean-connection-notice')
    .allTextContents()
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(f.report, null, 2) + '\n',
  )
  await f.browser.close()
}
console.log(
  JSON.stringify({ passed: f.report.passed, checks: f.report.checks }),
)
