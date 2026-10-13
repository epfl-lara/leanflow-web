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

const source = `import Std
namespace Demo
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
  const outline = page.getByRole('region', { name: 'File outline' })
  const list = outline.getByRole('list', { name: 'Declarations in this file' })
  const entry = (name) =>
    list.locator('.proof-outline-entry').filter({ hasText: name })
  await entry('Demo.first').waitFor()
  assert.equal(await list.locator('.proof-outline-entry').count(), 5)
  assert.deepEqual(
    await list.locator('.proof-outline-kind').allTextContents(),
    ['import', 'theorem', 'def', 'theorem', 'example'],
  )
  assert.match(await entry('Std').innerText(), /L1/)
  assert.equal(
    await list.getByRole('button', { name: 'Focus Std in chat' }).count(),
    0,
  )
  assert(!/decoy|notADeclaration/.test(await list.innerText()))
  const filesBox = await page
    .getByRole('region', { name: 'Files', exact: true })
    .boundingBox()
  const outlineBox = await outline.boundingBox()
  const projectsBox = await page
    .getByRole('region', { name: 'Projects', exact: true })
    .boundingBox()
  assert(filesBox.y < outlineBox.y && outlineBox.y < projectsBox.y)
  assert.equal(await page.locator('.proof-focus-toolbar').count(), 0)
  result.checks.push(
    'A permanent sidebar Outline sits below Files and above Projects, labels imports/theorems/definitions/examples, and ignores comment/string decoys.',
  )

  await page.getByLabel('Find a declaration').fill('second')
  assert.equal(await list.locator('.proof-outline-entry').count(), 1)
  await entry('Demo.second').focus()
  await page.keyboard.press('Enter')
  await until(
    async () =>
      (await entry('Demo.second').getAttribute('aria-current')) === 'location',
    'selected outline declaration',
  )
  assert.match(await outline.innerText(), /Demo\.second · lines 12–13/)
  assert.equal(
    await page.getByLabel('Focused proof', { exact: true }).count(),
    0,
    'Navigating does not silently send or attach.',
  )
  await outline.getByRole('button', { name: 'Ask Lemex', exact: true }).click()
  await page.getByLabel('Focused proof', { exact: true }).waitFor()
  const searchMode = page
    .getByLabel('Assistant mode')
    .getByRole('button', { name: 'Ask & Search', exact: true })
  await until(
    async () => (await searchMode.getAttribute('aria-pressed')) === 'true',
    'Ask Lemex opens Ask & Search',
  )
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Explain this proof or definition and find relevant lemmas. Do not edit files.',
  )
  assert.match(
    await page.getByLabel('Focused proof', { exact: true }).innerText(),
    /second/,
  )
  assert.equal(
    report.requests.filter((request) => request.method === 'POST').length,
    0,
  )
  assert.equal(report.sockets.length, 1)
  result.checks.push(
    'Filter and navigate by keyboard, then Ask Lemex opens Ask & Search with the exact proof and an explanation prompt without a save, run, or Lean reconnect.',
  )

  const sourceEditor = page.locator('.monaco-editor textarea').first()
  await sourceEditor.focus()
  await page.keyboard.press('ArrowRight')
  assert.match(await outline.innerText(), /Demo\.second/)
  await page.keyboard.press('Control+Home')
  await until(
    async () =>
      await outline
        .getByRole('button', { name: 'Ask Lemex', exact: true })
        .isDisabled(),
    'no proof at import header',
  )
  await page
    .getByLabel('Focused proof', { exact: true })
    .getByRole('button', { name: /Demo\.second/ })
    .click()
  await until(
    async () => /Demo\.second · lines/.test(await outline.innerText()),
    'chat chip reveals proof',
  )
  result.checks.push(
    'The proof end remains recognized, an import header cannot become a proof automatically, and the chat target reveals its exact lines.',
  )

  const composer = page.getByLabel('Message Lemex')
  await composer.fill('Keep my custom instructions.')
  await outline.getByRole('button', { name: 'Optimize', exact: true }).click()
  assert.equal(await composer.inputValue(), 'Keep my custom instructions.')
  await until(
    async () =>
      (await page
        .getByLabel('Assistant mode')
        .getByRole('button', { name: 'Optimize', exact: true })
        .getAttribute('aria-pressed')) === 'true',
    'optimize mode',
  )
  await page.getByLabel('Find a declaration').fill('')
  await list
    .getByRole('button', { name: 'Focus Demo.first in chat', exact: true })
    .click()
  await until(
    async () =>
      /Demo\.first/.test(
        await page.getByLabel('Focused proof', { exact: true }).innerText(),
      ),
    'one-click declaration focus',
  )
  assert.equal(await composer.inputValue(), 'Keep my custom instructions.')
  await sourceEditor.focus()
  await page.keyboard.press('ArrowRight')
  await until(
    async () => /Demo\.first · lines/.test(await outline.innerText()),
    'explicit declaration focus aligns the visible editor selection',
  )
  result.checks.push(
    'One-click +Chat actions attach and reveal a declaration; Optimize changes task mode while preserving custom message text.',
  )

  await entry('Demo.quoted').click()
  await outline.getByRole('button', { name: 'Ask Lemex', exact: true }).click()
  await until(
    async () => (await searchMode.getAttribute('aria-pressed')) === 'true',
    'Ask Lemex switches from Optimize to Ask & Search for a definition',
  )
  assert.match(
    await page.getByLabel('Focused proof', { exact: true }).innerText(),
    /Demo\.quoted/,
  )
  assert.equal(await composer.inputValue(), 'Keep my custom instructions.')
  result.checks.push(
    'Ask Lemex also opens Ask & Search for definitions and preserves a custom message when switching from Optimize.',
  )

  const heading = outline.getByRole('button', { name: /^Outline/ })
  const splitter = page.getByRole('separator', {
    name: 'Resize files and outline',
    exact: true,
  })
  const originalSplit = Number(await splitter.getAttribute('aria-valuenow'))
  await splitter.focus()
  await page.keyboard.press('ArrowUp')
  await until(
    async () =>
      Number(await splitter.getAttribute('aria-valuenow')) < originalSplit,
    'keyboard files/outline resize',
  )
  await splitter.dblclick()
  await until(
    async () => Number(await splitter.getAttribute('aria-valuenow')) === 45,
    'reset files/outline resize',
  )
  const openFilesHeight = (
    await page.getByRole('region', { name: 'Files', exact: true }).boundingBox()
  ).height
  await heading.click()
  assert.equal(await heading.getAttribute('aria-expanded'), 'false')
  assert.equal(await list.count(), 0)
  assert.equal(await splitter.isVisible(), false)
  assert(
    (
      await page
        .getByRole('region', { name: 'Files', exact: true })
        .boundingBox()
    ).height > openFilesHeight,
  )
  await heading.focus()
  await page.keyboard.press('Enter')
  assert.equal(await heading.getAttribute('aria-expanded'), 'true')
  result.checks.push(
    'Files and Outline resize by keyboard and reset by double click; collapsing Outline gives its space back to Files and reopening works by keyboard.',
  )

  const contrast = async () =>
    list.locator('.proof-outline-kind').evaluateAll((elements) => {
      const luminance = (color) => {
        const values = color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number)
          .map((value) => {
            const channel = value / 255
            return channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4
          })
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]
      }
      return elements.map((element) => {
        const style = getComputedStyle(element)
        const foreground = luminance(style.color),
          background = luminance(style.backgroundColor)
        return {
          kind: element.textContent,
          foreground: style.color,
          background: style.backgroundColor,
          ratio:
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05),
        }
      })
    })
  result.darkContrast = await contrast()
  await page.screenshot({ path: path.join(reportDir, 'outline-dark.png') })
  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  result.lightContrast = await contrast()
  await page.screenshot({ path: path.join(reportDir, 'outline-light.png') })
  assert(result.darkContrast.every((item) => item.ratio >= 4.5))
  assert(
    result.lightContrast.every((item) => item.ratio >= 4.5),
    JSON.stringify(result.lightContrast),
  )
  await page
    .getByRole('button', { name: 'Use dark theme', exact: true })
    .click()
  result.checks.push(
    'Declaration kind badges meet 4.5:1 text contrast in dark and light themes.',
  )

  result.shortHeightLayouts = []
  for (const viewport of [
    { width: 844, height: 390 },
    { width: 1280, height: 550 },
  ]) {
    await page.setViewportSize(viewport)
    const layout = { viewport, controls: [] }
    for (const [label, control] of [
      [
        'Ask Lemex',
        outline.getByRole('button', { name: 'Ask Lemex', exact: true }),
      ],
      [
        'Optimize',
        outline.getByRole('button', { name: 'Optimize', exact: true }),
      ],
      ['First declaration', entry('Demo.first')],
    ]) {
      await control.scrollIntoViewIfNeeded()
      await control.click({ trial: true })
      const hit = await control.evaluate((button) => {
        const bounds = button.getBoundingClientRect()
        const section = button
          .closest('.proof-outline-sidebar')
          .getBoundingClientRect()
        const x = bounds.left + bounds.width / 2,
          y = bounds.top + bounds.height / 2
        const front = document.elementFromPoint(x, y)
        return {
          center: { x, y },
          insideOutline:
            x >= section.left &&
            x <= section.right &&
            y >= section.top &&
            y <= section.bottom,
          controlReceivesPointer: button === front || button.contains(front),
          frontTag: front?.tagName,
          frontClass: front?.className,
          outline: {
            x: section.x,
            y: section.y,
            width: section.width,
            height: section.height,
          },
        }
      })
      layout.controls.push({ label, ...hit })
      assert(
        hit.insideOutline && hit.controlReceivesPointer,
        JSON.stringify({ viewport, label, hit }),
      )
    }
    const resizeMinimum = Number(await splitter.getAttribute('aria-valuemin'))
    const resizeMaximum = Number(await splitter.getAttribute('aria-valuemax'))
    await splitter.focus()
    await page.keyboard.press('Home')
    await until(
      async () =>
        Number(await splitter.getAttribute('aria-valuenow')) === resizeMinimum,
      'short-height outline minimum resize',
    )
    await page.keyboard.press('End')
    await until(
      async () =>
        Number(await splitter.getAttribute('aria-valuenow')) === resizeMaximum,
      'short-height outline maximum resize',
    )
    await splitter.dblclick()
    await heading.click()
    assert.equal(await heading.getAttribute('aria-expanded'), 'false')
    assert.equal(await splitter.isVisible(), false)
    await heading.click()
    assert.equal(await heading.getAttribute('aria-expanded'), 'true')
    await page.screenshot({
      path: path.join(
        reportDir,
        `outline-${viewport.width}x${viewport.height}.png`,
      ),
    })
    result.shortHeightLayouts.push(layout)
  }
  result.checks.push(
    'At 844×390 and 1280×550, scrolling reaches Ask Lemex, Optimize and declarations within Outline; pointer hits do not fall through to Projects, and resize/collapse still work.',
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'Close tools panel', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Open projects and files', exact: true })
    .click()
  await outline.waitFor()
  await until(async () => {
    const box = await outline.boundingBox()
    return box && box.x >= 0 && box.x + box.width <= 391
  }, 'mobile sidebar animation')
  const mobileBox = await outline.boundingBox()
  assert(mobileBox.x >= 0 && mobileBox.x + mobileBox.width <= 391)
  await list
    .getByRole('button', { name: 'Focus Demo.second in chat', exact: true })
    .click()
  await page.getByLabel('Focused proof', { exact: true }).waitFor()
  assert.match(
    await page.getByLabel('Focused proof', { exact: true }).innerText(),
    /Demo\.second/,
  )
  assert(
    !/sidebar-open/.test(await page.locator('.sidebar').getAttribute('class')),
  )
  await page
    .getByRole('button', { name: 'Send', exact: true })
    .click({ trial: true })
  result.checks.push(
    'At 390px the sidebar Outline is reachable; +Chat opens the visible focused composer and closes the sidebar without sending.',
  )
  await page.setViewportSize({ width: 1600, height: 1000 })

  documentSymbols = []
  await sourceEditor.focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('-- fresh unsaved selection')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  await outline.getByRole('button', { name: 'Ask Lemex', exact: true }).click()
  assert.equal(await searchMode.getAttribute('aria-pressed'), 'true')
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
    async () => /Selected lines · line 1/.test(await outline.innerText()),
    'unsaved line reveal',
  )
  assert.match(
    await page.locator('.monaco-editor').innerText(),
    /fresh.unsaved.selection/,
  )
  assert.equal(
    report.requests.filter((request) => request.method === 'POST').length,
    0,
  )
  result.checks.push(
    'Explicit unsaved line selection works without Lean symbols; the chat chip reveals its lines without reload, save, or loss of editor edits.',
  )
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
