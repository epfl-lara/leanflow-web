#!/usr/bin/env node
// Exercise the disabled editor refactor boundary against real, isolated Lean.
// All sources and credentials are disposable. No user project or provider is used.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import { chromium } from '@playwright/test'
import { Runtime } from '../server/runtime.mjs'
import { createStudio } from '../server/studio.mjs'
import { until } from './lib/chat-browser-fixture.mjs'

const directory = path.resolve('.runtime/rename-ui', randomUUID())
const dataDir = path.join(directory, 'data')
const toolchain = 'leanprover/lean4:v4.33.0'
const main = 'def blank : Nat := 7\ndef existing : Nat := 9\n'
const use =
  'import Main\ndef readBlank (blankC : Nat) : Nat := blank + blankC\n#eval readBlank 1\n'
const report = {
  directory,
  toolchain,
  providerCalls: 0,
  checks: [],
  passed: false,
}
await fs.mkdir(directory, { recursive: true })
const runtime = new Runtime({ dataDir, scope: 'helper', cpus: 1, memory: '2g' })
let studio, browser, socket, page
try {
  studio = await createStudio({
    dataDir,
    runtime,
    config: {
      defaultModel: 'offline-fixture',
      models: [],
      provider: {},
      redact: String,
      lemex: {},
    },
  })
  assert(runtime.ready, runtime.error)
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const project = await studio.workspaces.create('owner', {
    name: 'Disabled unsafe refactors',
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: toolchain + '\n' },
      {
        path: 'lakefile.toml',
        content:
          'name = "rename_safety"\ndefaultTargets = ["Main", "Use"]\n[[lean_lib]]\nname = "Main"\n[[lean_lib]]\nname = "Use"\n',
      },
      { path: 'Main.lean', content: main },
      { path: 'Use.lean', content: use },
    ],
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const before = await runtime.run(
    project.root,
    ['lake', 'env', 'lean', 'Use.lean'],
    { network: 'none', timeoutMs: 60000 },
  )
  assert.equal(before.code, 0, before.stdout + before.stderr)
  assert.equal(before.stdout.trim(), '8')
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  })
  const login = await context.request.post(base + '/api/login', {
    data: { token },
  })
  assert(login.ok())
  await context.addInitScript(
    ({ id }) => {
      localStorage.setItem('lemex-project', id)
      localStorage.setItem(`lemex-file-${id}`, 'Main.lean')
    },
    { id: project.id },
  )
  page = await context.newPage()
  const browserErrors = []
  page.on('pageerror', (error) => browserErrors.push(String(error)))
  await page.goto(base)
  const editor = page.locator('.monaco-editor textarea').first()
  await editor.waitFor({ timeout: 60000 })
  await page
    .locator('.editor-loading')
    .waitFor({ state: 'hidden', timeout: 60000 })
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('-- unsaved note\n')
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await until(() => save.isEnabled(), 'unsaved user text')
  await page.keyboard.press('Control+Home')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('F2')
  const disabled = page
    .getByRole('alert')
    .filter({ hasText: 'Automatic Lean rename and refactoring are disabled' })
  await disabled.waitFor()
  assert.equal(await page.locator('.rename-box input').count(), 0)
  assert.equal(await save.isEnabled(), true)
  assert.match(await page.locator('.view-lines').innerText(), /unsaved\s+note/)
  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menuitem', {
    name: /Rename Symbol \(unavailable\)/,
  })
  await menu.waitFor()
  await menu.hover()
  await page.keyboard.press('Enter')
  await disabled.waitFor()
  assert.equal(await page.locator('.rename-box input').count(), 0)
  report.checks.push(
    'F2 and the context menu explain that rename is disabled without opening a rename box or changing the unsaved draft.',
  )

  socket = new WebSocket(
    base.replace('http:', 'ws:') + '/websocket/' + project.id,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const pending = new Map()
  let sequence = 0
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw)),
      item = pending.get(message.id)
    if (item && !message.method) {
      clearTimeout(item.timer)
      pending.delete(message.id)
      item.resolve(message)
    }
  })
  await once(socket, 'open')
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence,
        timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('Timed out on ' + method))
        }, 30000)
      pending.set(id, { resolve, timer })
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  const initialized = await request('initialize', {
    processId: null,
    rootUri: 'file:///workspace',
    capabilities: { workspace: { applyEdit: true } },
  })
  assert(!initialized.error, JSON.stringify(initialized))
  assert.equal(initialized.result.capabilities.renameProvider, false)
  assert.equal(initialized.result.capabilities.codeActionProvider, false)
  assert.equal(
    initialized.result.capabilities.executeCommandProvider,
    undefined,
  )
  socket.send(
    JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }),
  )
  const position = {
    textDocument: { uri: 'file:///workspace/Main.lean' },
    position: { line: 0, character: 5 },
  }
  for (const newName of ['blankC', 'existing']) {
    const response = await request('textDocument/rename', {
      ...position,
      newName,
    })
    assert.equal(response.error?.code, -32803)
    assert.match(response.error.message, /program meaning/)
  }
  for (const method of [
    'textDocument/prepareRename',
    'textDocument/codeAction',
    'codeAction/resolve',
    'workspace/executeCommand',
    'workspace/willRenameFiles',
  ]) {
    const response = await request(method, position)
    assert.equal(response.error?.code, -32803)
  }
  report.checks.push(
    'Real Lean advertises no rename/refactor providers, and old clients or direct requests cannot bypass the restriction, including capture and duplicate-name cases.',
  )
  socket.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: position.textDocument.uri,
          languageId: 'lean4',
          version: 1,
          text: main,
        },
      },
    }),
  )
  const hover = await request('textDocument/hover', position)
  assert(hover.result?.contents, JSON.stringify(hover))
  const definition = await request('textDocument/definition', position)
  assert(definition.result, JSON.stringify(definition))
  report.checks.push(
    'Hover and definition requests still work on the same connection after rejected refactors.',
  )
  for (const [filename, expected] of [
    ['Main.lean', main],
    ['Use.lean', use],
  ])
    assert.equal(
      (await studio.workspaces.readFile(project.id, 'owner', filename)).content,
      expected,
    )
  report.checks.push(
    'Blocked operations leave both saved project files unchanged, and the original evaluation remains 8.',
  )
  socket.close()
  await once(socket, 'close')
  socket = null

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname.endsWith('/file'),
  )
  await save.click()
  assert.equal((await saved).status(), 200)
  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean'))
      .content,
    main + '-- unsaved note\n',
  )
  await page.locator('.file-item[title="Use.lean"]').click()
  await page
    .locator('.editor-loading')
    .waitFor({ state: 'hidden', timeout: 60000 })
  await editor.focus()
  await page.keyboard.press('F2')
  await disabled.waitFor()
  assert.equal(await page.locator('.rename-box input').count(), 0)
  const build = await runtime.run(project.root, ['lake', 'build'], {
    network: 'none',
    timeoutMs: 60000,
  })
  assert.equal(build.code, 0, build.stdout + build.stderr)
  const after = await runtime.run(
    project.root,
    ['lake', 'env', 'lean', 'Use.lean'],
    { network: 'none', timeoutMs: 60000 },
  )
  assert.equal(after.code, 0, after.stdout + after.stderr)
  assert.equal(after.stdout.trim(), '8')
  report.checks.push(
    'Manual editing and saving remain available, file switching keeps rename disabled, and the project still builds with its original behavior.',
  )
  report.browserErrors = browserErrors
  assert.deepEqual(browserErrors, [])
  report.passed = true
  await page.screenshot({ path: path.join(directory, 'rename-disabled.png') })
} catch (error) {
  report.failure = error.stack || String(error)
  if (page) {
    report.pageText = await page.locator('body').innerText()
    await page.screenshot({ path: path.join(directory, 'failure.png') })
  }
  throw error
} finally {
  socket?.terminate()
  await browser?.close()
  await studio?.close()
  await fs.writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report, null, 2))
