#!/usr/bin/env node
// Uses a separate local HTTP server and mocked projects/chat; no provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import express from 'express'
import { LeanBooks, installBookRoutes } from '../server/lean-books.mjs'
import { LEAN_BOOKS } from '../shared/lean-books.mjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-books-ui-'))
const reportDir = path.resolve('.runtime/books-feature/ui')
await fs.mkdir(reportDir, { recursive: true })
const realBooks = process.env.STUDIO_TEST_BOOKS_DIR
if (!realBooks)
  for (const book of LEAN_BOOKS) {
    const directory = path.join(root, book.id)
    await fs.mkdir(path.join(directory, 'Tactics'), { recursive: true })
    const document = (title, body) =>
      `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="${title === 'Tactics' ? '../' : ''}book.css"></head><body><main><h1>${title}</h1>${body}</main></body></html>`
    await fs.writeFile(
      path.join(directory, 'index.html'),
      document(
        book.title,
        '<a href="Tactics/">Tactics chapter</a><p>Start here.</p>',
      ),
    )
    await fs.writeFile(
      path.join(directory, 'Tactics/index.html'),
      document(
        'Tactics',
        '<p id="passage">Induction proves recursive propositions.</p><a href="../">Home</a>',
      ),
    )
    await fs.writeFile(
      path.join(directory, 'book.css'),
      'body { padding: 24px; font: 16px/1.6 system-ui; background: white; color: #222b3d } a { color: #335cce }',
    )
    await fs.writeFile(
      path.join(directory, 'home.txt'),
      `${book.title}\nStart here`,
    )
    await fs.writeFile(
      path.join(directory, 'tactics.txt'),
      'Tactics\nInduction proves recursive propositions.',
    )
    await fs.writeFile(
      path.join(directory, 'manifest.json'),
      JSON.stringify({
        leanVersion: '4.34.1',
        pages: [
          { title: book.title, path: '', textPath: 'home.txt' },
          { title: 'Tactics', path: 'Tactics/', textPath: 'tactics.txt' },
        ],
      }),
    )
  }
const app = express()
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  next()
})
installBookRoutes(app, new LeanBooks(realBooks || root))
app.use(
  express.static(
    path.resolve(
      process.env.STUDIO_TEST_CLIENT_DIR || '.runtime/books-feature/client',
    ),
  ),
)
app.use((error, _req, res, _next) =>
  res.status(error.status || 500).json({ error: error.message }),
)
const server = http.createServer(app)
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const projectId = 'docs-fixture'
const fixture = await chatBrowserFixture({
  base: `http://127.0.0.1:${server.address().port}`,
  session: {
    user: { id: 'docs-user', name: 'Fixture' },
    templates: [],
    models: [
      {
        id: 'fixture-model',
        name: 'Fixture model',
        defaultReasoningEffort: 'high',
        reasoningEfforts: [{ id: 'high' }],
      },
    ],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { configured: false },
  },
  projects: [
    {
      id: projectId,
      name: 'Documentation fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: 'docs-chat', projectId, title: 'Docs', runCount: 1 }],
  runs: [
    {
      id: 'docs-run',
      chatId: 'docs-chat',
      projectId,
      mode: 'search',
      status: 'completed',
      createdAt: '2026-10-14T00:00:00Z',
      prompt: 'Explain induction',
      message: '[Read the reference](/api/books/reference/content/)',
    },
  ],
})
const { page, report } = fixture
const bookFailures = []
page.on('response', (response) => {
  if (response.url().includes('/api/books') && response.status() >= 400)
    bookFailures.push({ url: response.url(), status: response.status() })
})
const bookConsole = []
page.on('console', (message) => {
  if (message.type() === 'error') bookConsole.push(message.text())
})
await page.route(/\/api\/books(?:\/|$|\?)/, (route) => route.continue())
const panel = page.getByRole('region', { name: 'Lean docs' })
const frame = page.frameLocator('iframe[title="Local Lean book"]')
try {
  await fixture.ready()
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n-- Unsaved doc browsing')
  const socketsBefore = report.sockets.length
  const prompt = page.getByRole('textbox', { name: 'Message Lemex' })
  await prompt.fill('Keep my existing draft.')
  await page.getByRole('button', { name: 'Lean docs', exact: true }).click()
  await panel.waitFor()
  await frame.locator('h1:visible').first().waitFor()
  await until(
    () => panel.getByRole('button', { name: 'Ask Lemex' }).isEnabled(),
    'readable chapter',
  )
  assert.equal(await panel.locator('select').inputValue(), 'reference')
  assert.equal(
    await page
      .locator('iframe[title="Local Lean book"]')
      .getAttribute('sandbox'),
    'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  )
  assert.equal(await frame.locator('script').count(), 0)
  assert.equal(
    await frame
      .locator('html')
      .evaluate((element) => getComputedStyle(element).colorScheme),
    'light',
    'Book pages retain readable text on their white reading canvas in a dark workspace',
  )
  assert.equal(
    await frame
      .locator('body')
      .evaluate((element) =>
        Array.from(element.ownerDocument.styleSheets).some(
          (sheet) =>
            sheet.href?.endsWith('/book.css') && sheet.cssRules.length > 0,
        ),
      ),
    true,
    'The downloaded book stylesheet must load',
  )
  if (!realBooks) {
    await frame.getByRole('link', { name: 'Tactics chapter' }).click()
    await frame.getByRole('heading', { name: 'Tactics', exact: true }).waitFor()
    await frame.locator('#passage').evaluate((element) => {
      const range = element.ownerDocument.createRange()
      range.selectNodeContents(element)
      const selection = element.ownerDocument.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
    })
    await panel.getByRole('button', { name: 'Ask Lemex' }).click()
    await until(
      async () => (await prompt.inputValue()).includes('Selected passage:'),
      'selected passage in draft',
    )
    const draft = await prompt.inputValue()
    assert.match(draft, /^Keep my existing draft\./)
    assert.match(
      draft,
      /Local chapter: \/api\/books\/reference\/content\/Tactics\//,
    )
    assert.match(draft, /Induction proves recursive propositions/)
    assert.equal(
      report.requests.filter(
        (request) =>
          request.method === 'POST' &&
          /\/runs|\/messages/.test(request.endpoint),
      ).length,
      0,
    )
    await panel.getByRole('button', { name: 'Contents', exact: true }).click()
    await frame
      .getByRole('heading', { name: 'Lean Language Reference', exact: true })
      .waitFor()
    await panel
      .getByRole('searchbox', { name: 'Search this book' })
      .fill('induction')
    await panel.getByRole('button', { name: 'Search', exact: true }).click()
    await panel.getByRole('button', { name: /Tactics Induction/ }).waitFor()
    await panel.getByRole('button', { name: /Tactics Induction/ }).click()
    await frame.getByRole('heading', { name: 'Tactics', exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Close Lean docs' }).click()
    await page.getByRole('button', { name: 'Lean docs', exact: true }).click()
    await frame.getByRole('heading', { name: 'Tactics', exact: true }).waitFor()
    assert.equal(await prompt.inputValue(), draft)
    report.checks.push(
      'Local navigation, contents, chapter search, selection sharing, draft preservation, and close/reopen without sending a run',
    )
  }
  for (const book of LEAN_BOOKS) {
    await panel.locator('select').selectOption(book.id)
    await frame.locator('h1:visible').first().waitFor()
    await until(
      () => panel.getByRole('button', { name: 'Ask Lemex' }).isEnabled(),
      `${book.title} loading`,
    )
    assert.equal(await panel.locator('select').inputValue(), book.id)
  }
  await panel.getByRole('button', { name: 'Expand', exact: true }).click()
  assert.equal(await panel.getAttribute('class'), 'books-panel expanded')
  await panel.getByRole('button', { name: 'Split view', exact: true }).click()
  await page.screenshot({
    path: path.join(
      reportDir,
      realBooks ? 'real-books-desktop.png' : 'books-desktop.png',
    ),
  })
  await panel.getByRole('button', { name: 'Close Lean docs' }).click()
  await page.getByRole('link', { name: 'Read the reference' }).click()
  await panel.waitFor()
  await until(
    async () => (await panel.locator('select').inputValue()) === 'reference',
    'Lemex citation opens the reader',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .locator('.tools-header')
    .getByRole('button', { name: 'Close tools panel' })
    .click()
  await panel.waitFor()
  const bounds = await panel.boundingBox()
  assert(
    bounds.x >= 0 && bounds.x + bounds.width <= 391,
    'Reader must fit the mobile viewport',
  )
  assert(bounds.y + bounds.height <= 844, 'Reader must fit vertically')
  await page.screenshot({
    path: path.join(
      reportDir,
      realBooks ? 'real-books-mobile.png' : 'books-mobile.png',
    ),
  })
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  assert.match(
    await page.locator('.monaco-editor .view-lines').innerText(),
    /Unsaved.*doc.*browsing/,
  )
  assert.equal(
    report.sockets.length,
    socketsBefore,
    'Opening documentation must preserve the connected Lean editor',
  )
  report.checks.push(
    'All three books, expanded reading, embedded Lemex citations, mobile containment, and keyboard dismissal',
  )
  fixture.state.projects = []
  await page.reload()
  await page.locator('.welcome-state').waitFor()
  await page.getByRole('button', { name: 'Lean docs', exact: true }).click()
  await panel.waitFor()
  await frame.locator('h1:visible').first().waitFor()
  assert.equal(
    await panel.getByRole('button', { name: 'Ask Lemex' }).isDisabled(),
    true,
  )
  report.checks.push(
    'Unsaved editor contents and its Lean connection survive reading; documentation also works without an open project or model',
  )
  fixture.assertClean()
  assert.deepEqual(bookFailures, [], JSON.stringify(bookFailures))
  // Playwright injects the fixture's init script into frames too. The reader
  // intentionally refuses it, confirming that page scripts cannot run.
  const unexpectedConsole = bookConsole.filter(
    (message) =>
      !message.startsWith('Blocked script execution in ') ||
      !message.includes('/api/books/'),
  )
  assert.deepEqual(unexpectedConsole, [], JSON.stringify(unexpectedConsole))
  console.log(JSON.stringify(report.checks, null, 2))
} finally {
  await fs.writeFile(
    path.join(
      reportDir,
      realBooks ? 'real-book-loading.json' : 'fixture-book-loading.json',
    ),
    JSON.stringify({ bookFailures, bookConsole }, null, 2),
  )
  await fixture.browser.close()
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(root, { recursive: true, force: true })
}
