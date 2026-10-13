#!/usr/bin/env node
// Real Lean document symbols, then an isolated browser interaction fixture.
// No user workspace, agent run, model provider, or server mutation is involved.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const source = `namespace Demo
/-- A comment with a fake theorem decoy : False := by sorry.
    /- Nested comment with def anotherDecoy := 1. -/
-/
theorem first (n : Nat) : n + 0 = n := by
  have h : n = n := by rfl
  exact h

def quoted : String := "theorem notADeclaration : False := by sorry"

theorem second : True := by
  trivial

example : True := by
  trivial
end Demo
`
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'leanflow-proof-outline-'),
)
const reportDir = path.resolve('.runtime/proof-focus-ui')
await fs.mkdir(reportDir, { recursive: true })
const file = path.join(temporary, 'Main.lean')
await fs.writeFile(file, source)
const lean = spawn(process.env.LEAN_TEST_BINARY || 'lean', ['--server'], {
  cwd: temporary,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
lean.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-8000)
})
let buffer = Buffer.alloc(0)
let sequence = 0
const pending = new Map()
const send = (value) => {
  const payload = JSON.stringify({ jsonrpc: '2.0', ...value })
  lean.stdin.write(
    `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
  )
}
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Real Lean timed out on ${method}: ${stderr}`))
    }, 30000)
    pending.set(id, { resolve, reject, timer })
    send({ id, method, params })
  })
lean.on('error', (error) => {
  for (const item of pending.values()) {
    clearTimeout(item.timer)
    item.reject(error)
  }
  pending.clear()
})
lean.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd < 0) return
    const length = Number(
      /Content-Length:\s*(\d+)/i.exec(
        buffer.subarray(0, headerEnd).toString(),
      )?.[1],
    )
    if (!Number.isFinite(length) || buffer.length < headerEnd + 4 + length)
      return
    const message = JSON.parse(
      buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString(),
    )
    buffer = buffer.subarray(headerEnd + 4 + length)
    const item = pending.get(message.id)
    if (item) {
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error(JSON.stringify(message.error)))
      else item.resolve(message.result)
    }
  }
})
let browser
let pageForFailure
let browserReport
const result = { checks: [], providerCalls: 0 }
try {
  const initialized = await request('initialize', {
    processId: null,
    rootUri: pathToFileURL(temporary).href,
    capabilities: {
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      },
    },
  })
  assert(initialized.capabilities.documentSymbolProvider)
  send({ method: 'initialized', params: {} })
  send({
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: pathToFileURL(file).href,
        languageId: 'lean4',
        version: 1,
        text: source,
      },
    },
  })
  const symbols = await request('textDocument/documentSymbol', {
    textDocument: { uri: pathToFileURL(file).href },
  })
  const names = symbols
    .flatMap((item) => item.children || [])
    .map((item) => item.name)
  assert.deepEqual(names, ['first', 'quoted', 'second', 'example'])
  result.leanServerInfo = initialized.serverInfo
  result.leanVersion = (
    await promisify(execFile)(process.env.LEAN_TEST_BINARY || 'lean', [
      '--version',
    ])
  ).stdout.trim()
  result.symbols = symbols
  result.checks.push(
    'Real Lean LSP returns exact parsed declaration ranges; nested comments and strings do not add fake proofs.',
  )
  await request('shutdown', null)
  send({ method: 'exit' })

  const projectId = 'proof-focus-fixture',
    chatId = 'proof-focus-chat'
  const fixture = await chatBrowserFixture({
    session: {
      user: { id: 'proof-fixture-owner', name: 'Fixture' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { revision: 'fixture', available: true },
    },
    projects: [
      {
        id: projectId,
        name: 'Proof focus fixture',
        status: 'ready',
        toolchain: 'fixture',
      },
    ],
    files: { [projectId]: { 'Main.lean': source } },
    chats: [{ id: chatId, projectId, title: 'Focused proof', runCount: 0 }],
    runs: [],
  })
  const { page, report } = fixture
  pageForFailure = page
  browserReport = report
  browser = fixture.browser
  let documentSymbols = symbols
  // Feed the real compiler's symbols into the browser's normal Lean client.
  await page.routeWebSocket('**/websocket/**', (socket) => {
    report.sockets.push(socket.url())
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (!('id' in message)) return
      let response = null
      if (message.method === 'initialize')
        response = {
          capabilities: { textDocumentSync: 1, documentSymbolProvider: true },
          serverInfo: { name: 'Real-symbol fixture', version: '0.2.0' },
        }
      if (message.method === 'textDocument/documentSymbol')
        response = documentSymbols
      if (message.method === '$/lean/rpc/connect')
        response = { sessionId: 'fixture-session' }
      if (/plainGoal/.test(message.method || '')) response = { goals: [] }
      if (message.method === '$/lean/rpc/call') {
        if (message.params?.method === 'Lean.Widget.getInteractiveGoals')
          response = { goals: [] }
        if (message.params?.method === 'Lean.Widget.getInteractiveDiagnostics')
          response = []
        if (message.params?.method === 'Lean.Widget.getWidgets')
          response = { widgets: [] }
      }
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: response }),
      )
    })
  })
  await fixture.ready()
  const toolbar = page.getByLabel('Focus a proof', { exact: true })
  await toolbar.getByRole('button', { name: 'Outline', exact: true }).click()
  await page
    .getByRole('button', { name: 'Demo.first line 2', exact: true })
    .waitFor()
  await page.getByLabel('Find a declaration').fill('second')
  assert.equal(
    await page
      .getByRole('list', { name: 'Declarations in this file' })
      .getByRole('button')
      .count(),
    1,
  )
  await page
    .getByRole('button', { name: 'Demo.second line 11', exact: true })
    .click()
  await toolbar.getByRole('button', { name: 'Ask Lemex', exact: true }).click()
  await until(
    async () =>
      (await page.getByLabel('Focused proof', { exact: true }).count()) > 0,
    'chat focus chip',
  )
  assert.match(
    await page.getByLabel('Focused proof', { exact: true }).innerText(),
    /second/,
  )
  assert.equal(
    report.requests.filter((entry) => entry.method === 'POST').length,
    0,
    'Focusing must not send or save',
  )
  assert.equal(
    report.sockets.length,
    1,
    'Outline navigation must not restart Lean',
  )
  result.checks.push(
    'Search and choose a declaration, focus it in chat without sending, and preserve the same Lean connection.',
  )

  const sourceEditor = page.locator('.monaco-editor textarea').first()
  await sourceEditor.focus()
  await page.keyboard.press('ArrowRight')
  assert.match(await toolbar.innerText(), /Demo\.second/)
  await page.keyboard.press('Control+Home')
  assert.equal(
    await toolbar
      .getByRole('button', { name: 'Ask Lemex', exact: true })
      .isDisabled(),
    true,
  )
  await page
    .getByLabel('Focused proof', { exact: true })
    .getByRole('button', { name: /Demo\.second/ })
    .click()
  await until(
    async () => /Demo\.second/.test(await toolbar.innerText()),
    'proof chip reveal',
  )
  result.checks.push(
    'Cursor at the end of a proof identifies it; empty-context clicks never select the entire file; clicking the chat chip reveals its lines.',
  )

  const composer = page.getByLabel('Message Lemex')
  await composer.fill('Keep my custom instructions.')
  await toolbar.getByRole('button', { name: 'Optimize', exact: true }).click()
  assert.equal(await composer.inputValue(), 'Keep my custom instructions.')
  await until(
    async () =>
      (await page
        .getByLabel('Assistant mode')
        .getByRole('button', { name: 'Optimize', exact: true })
        .getAttribute('aria-pressed')) === 'true',
    'optimize mode',
  )
  result.checks.push(
    'Optimize changes the task mode while preserving the current message draft.',
  )

  // Keyboard-only selection still works when no symbols are available, and
  // captures new unsaved text rather than an old source snapshot.
  documentSymbols = []
  const editor = page.locator('.monaco-editor textarea').first()
  await editor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('-- fresh unsaved selection')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  await toolbar.getByRole('button', { name: 'Ask Lemex', exact: true }).click()
  assert.match(
    await page.getByLabel('Focused proof', { exact: true }).innerText(),
    /1/,
  )
  assert.equal(report.sockets.length, 1)
  await sourceEditor.focus()
  await page.keyboard.press('Control+End')
  await page
    .getByLabel('Focused proof', { exact: true })
    .getByRole('button', { name: /Selected proof/ })
    .click()
  await until(
    async () => /Selected lines · line 1/.test(await toolbar.innerText()),
    'unsaved line reveal',
  )
  assert.match(
    await page.locator('.monaco-editor').innerText(),
    /fresh.unsaved.selection/,
  )
  assert.equal(
    report.requests.filter((entry) => entry.method === 'POST').length,
    0,
  )
  result.checks.push(
    'Unsaved explicit line selection works with no outline; clicking its chat chip reveals the lines without reloading, saving, or losing editor edits.',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'Close tools panel', exact: true })
    .click()
  await toolbar.getByRole('button', { name: 'Outline', exact: true }).click()
  const outlineBox = await page.locator('.proof-outline-popover').boundingBox()
  assert(outlineBox.x >= 0 && outlineBox.x + outlineBox.width <= 391)
  await page.getByLabel('Find a declaration').press('Escape')
  assert.equal(await page.locator('.proof-outline-popover').count(), 0)
  await toolbar
    .getByRole('button', { name: 'Ask Lemex', exact: true })
    .click({ trial: true })
  result.checks.push(
    'Outline and focus actions remain accessible at 390px; Escape dismisses the searchable outline.',
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.getByRole('button', { name: 'Lemex', exact: true }).click()
  fixture.assertClean()
  await page.screenshot({ path: path.join(reportDir, 'focused-proof.png') })
  result.passed = true
  result.browser = report
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  console.log(
    JSON.stringify(
      { checks: result.checks, report: path.join(reportDir, 'result.json') },
      null,
      2,
    ),
  )
} catch (error) {
  result.failure = error.stack || String(error)
  result.browser = browserReport
  if (pageForFailure) {
    result.pageText = await pageForFailure
      .locator('body')
      .innerText()
      .catch(() => '')
    await pageForFailure
      .screenshot({ path: path.join(reportDir, 'failure.png') })
      .catch(() => {})
  }
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  throw error
} finally {
  for (const item of pending.values()) clearTimeout(item.timer)
  lean.kill('SIGTERM')
  await browser?.close()
  await fs.rm(temporary, { recursive: true, force: true })
}
