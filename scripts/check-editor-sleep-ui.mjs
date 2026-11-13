#!/usr/bin/env node
// Isolated editor and running-agent fixtures; no user data or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/editor-sleep-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const projectId = 'editor-sleep-project'
const run = {
  id: 'editor-sleep-run',
  projectId,
  chatId: 'editor-sleep-chat',
  kind: 'agent',
  mode: 'search',
  status: 'running',
  eventCursor: 0,
  createdAt: '2026-11-13T00:00:00Z',
  prompt: 'Continue this background task.',
  message: 'Working in the background.',
}
let fixture
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'sleep-owner', name: 'Sleep fixture' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [
      { id: projectId, name: 'Editor sleep fixture', status: 'ready' },
    ],
    files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
    chats: [{ id: run.chatId, projectId, title: 'Sleep fixture' }],
    runs: [run],
  })
  const { page, state, report } = fixture
  const messages = []
  report.leanMethods = []
  state.onLeanMessage = (message) => {
    messages.push(message)
    report.leanMethods.push(message.method)
  }
  await page.clock.install()
  await page.addInitScript(() => {
    // Playwright's simulated clock returns performance measures without storing
    // them. Monaco's typing metrics expect getEntriesByName to find each one.
    const entries = new Map()
    const measure = performance.measure.bind(performance)
    const getEntries = performance.getEntriesByName.bind(performance)
    const clearMeasures = performance.clearMeasures.bind(performance)
    performance.measure = (name, ...args) => {
      const entry = measure(name, ...args)
      entries.set(name, [entry])
      return entry
    }
    performance.getEntriesByName = (name, type) =>
      entries.get(name) || getEntries(name, type)
    performance.clearMeasures = (name) => {
      if (name === undefined) entries.clear()
      else entries.delete(name)
      clearMeasures(name)
    }
  })
  await fixture.ready()
  await until(
    () =>
      messages.some(
        (message) => message.method === 'textDocument/documentSymbol',
      ),
    'initial editor ready',
  )
  // Hold only fixture source saves so the browser also has unsaved editor text.
  await page.route('**/api/projects/*/file?*', (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    return route.fulfill({
      status: 503,
      json: { error: 'Fixture keeps an unsaved draft.' },
    })
  })
  const source = page.locator('.monaco-editor textarea').first()
  await source.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('-- SLEEP_UNDO_MARKER')
  const composer = page.getByLabel('Message Lemex')
  await composer.fill('Preserve this chat draft.')
  await source.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowRight')
  await page.clock.runFor(1000)
  await until(
    () => messages.some((message) => message.method === '$/lean/rpc/connect'),
    'infoview RPC session',
  )
  await page.clock.runFor(11_000)
  await until(
    () => messages.some((message) => message.method === '$/lean/rpc/keepAlive'),
    'infoview background keepalive',
  )
  await page.evaluate(() => {
    window.__sleepEditor = document.querySelector('.monaco-editor')
    const cursor = document.querySelector('.monaco-editor .cursor')
    window.__sleepCursor = cursor && [cursor.style.left, cursor.style.top]
  })
  await page.clock.fastForward(29 * 60_000)
  assert(messages.some((message) => message.method === '$/lean/rpc/keepAlive'))
  assert.equal(
    await page
      .getByRole('status')
      .filter({ hasText: 'Lean editor sleeping' })
      .count(),
    0,
  )
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', bubbles: true }),
    )
  })
  await page.clock.fastForward(61_000)
  const sleeping = page
    .getByRole('status')
    .filter({ hasText: 'Lean editor sleeping' })
  await sleeping.waitFor()
  await page.clock.runFor(100)
  await until(
    () => messages.some((message) => message.method === 'shutdown'),
    'editor connection shutdown',
  )
  assert.equal(await composer.inputValue(), 'Preserve this chat draft.')
  assert.deepEqual(
    await page.evaluate(() => {
      const cursor = document.querySelector('.monaco-editor .cursor')
      return cursor && [cursor.style.left, cursor.style.top]
    }),
    await page.evaluate(() => window.__sleepCursor),
  )
  assert(
    await page.evaluate(
      () => window.__sleepEditor === document.querySelector('.monaco-editor'),
    ),
  )
  assert(
    (await page.locator('.monaco-editor .view-lines').innerText()).includes(
      'SLEEP_UNDO_MARKER',
    ),
  )
  assert.equal(run.status, 'running')
  assert(
    await page.evaluate((id) => window.__chatFixture.connected(id), run.id),
  )
  const connections = report.sockets.length
  await fixture.emit(
    run,
    'message',
    ' More work completed while the editor sleeps.',
  )
  await page.clock.fastForward(60_000)
  assert.equal(report.sockets.length, connections)
  assert.equal(await sleeping.count(), 1)
  report.checks.push(
    'Unattended editor sleeps despite background traffic and synthetic input; the running agent and its stream remain active.',
  )

  await source.focus()
  await page.keyboard.press('ArrowRight')
  await page.clock.runFor(100)
  await sleeping.waitFor({ state: 'hidden' })
  await until(
    () => report.sockets.length === connections + 1,
    'one wake connection',
  )
  await until(
    () =>
      messages.filter((message) => message.method === 'textDocument/didOpen')
        .length >= 2,
    'restoring open Lean text',
  )
  assert(
    await page.evaluate(
      () => window.__sleepEditor === document.querySelector('.monaco-editor'),
    ),
  )
  assert.equal(await composer.inputValue(), 'Preserve this chat draft.')
  assert(
    (await page.locator('.monaco-editor .view-lines').innerText()).includes(
      'SLEEP_UNDO_MARKER',
    ),
  )
  await source.focus()
  await page.keyboard.press('Control+z')
  await page.clock.runFor(100)
  assert(
    !(await page.locator('.monaco-editor .view-lines').innerText()).includes(
      'SLEEP_UNDO_MARKER',
    ),
  )
  assert.equal(run.status, 'running')
  assert(!report.requests.some((request) => /\/stop$/.test(request.endpoint)))
  report.checks.push(
    'Trusted keyboard activity reconnects once, preserving the mounted editor, source, chat draft and undo history; no background job is stopped.',
  )
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.unexpectedRequests, [])
  report.ok = true
  await page.screenshot({ path: path.join(output, 'awake.png') })
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
