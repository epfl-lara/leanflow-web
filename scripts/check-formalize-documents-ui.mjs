#!/usr/bin/env node
// Serve the built client in isolation; all APIs, Lean and providers use fixtures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { fixturePdf } from './lib/pdf-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/formalize-documents-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(
  express.static(
    process.env.STUDIO_TEST_DIST || path.join(root, 'client/dist'),
  ),
)
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const projectId = 'formalize-documents'
let fixture
let releasePaperLinks
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'Document formalization', status: 'ready' },
    ],
    files: {
      [projectId]: {
        'Main.lean':
          '-- Formalized trace theorem\n\ntheorem trace_example : True := by trivial\n',
        'paper.tex':
          '\\section{Trace}\n\\begin{theorem}\\label{thm:trace}True.\\end{theorem}\n',
        'Paper.PDF': '%PDF-1.7\n',
        'Appendix.pdf': '%PDF-1.7\n',
        'leanflow.paper-links.json': '{"version":1,"links":[]}\n',
        'notes.txt': 'Theorem: True. Proof: trivial.\n',
        'notes.md': '# Theorem\n\nTrue. Proof: trivial.\n',
        'notes.rst': 'Theorem\n=======\n\nTrue. Proof: trivial.\n',
        'Other.lean': 'theorem unrelated : True := by trivial\n',
      },
    },
    chats: [{ id: 'formalize-chat', projectId, title: 'Document checks' }],
    runs: [],
  })
  const { page, state, report } = fixture
  await page.route('**/api/projects/*/tex**', (route) =>
    route.fulfill({
      json: {
        available: false,
        engines: [],
        build: null,
        lastSuccessful: null,
      },
    }),
  )
  let pdfAvailable = false
  await page.route('**/api/projects/*/file-preview?*', (route) =>
    pdfAvailable
      ? route.fulfill({ contentType: 'application/pdf', body: fixturePdf() })
      : route.fulfill({
          status: 415,
          json: { error: 'Fixture PDF preview is unavailable.' },
        }),
  )
  const target = { path: 'Main.lean', line: 3, declaration: 'trace_example' }
  let paperLinksAvailable = false
  let paperLinkRequests = 0
  let holdPaperLinks
  const paperLinks = [
    {
      id: 'trace-pdf',
      source: { path: 'Paper.PDF', page: 1, quote: 'Fixture PDF' },
      target,
      status: 'current',
    },
    {
      id: 'trace-tex',
      source: { path: 'paper.tex', line: 2, label: 'thm:trace' },
      target,
      status: 'current',
    },
    {
      id: 'outdated',
      source: { path: 'Paper.PDF', page: 2 },
      target: { ...target, declaration: 'removed_example' },
      status: 'stale',
    },
    {
      id: 'appendix',
      source: { path: 'Appendix.pdf', page: 1 },
      target,
      status: 'current',
    },
  ]
  await page.route('**/api/projects/*/files', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      json: Object.entries(state.files[projectId]).map(([path, content]) => ({
        path,
        size: content.length,
        revision: createHash('sha256').update(content).digest('hex'),
      })),
    })
  })
  await page.route('**/api/projects/*/paper-links?*', async (route) => {
    paperLinkRequests++
    const path = new URL(route.request().url()).searchParams.get('path')
    await holdPaperLinks
    return route.fulfill({
      json: {
        links: !paperLinksAvailable
          ? []
          : paperLinks.filter(
              ({ source, target }) =>
                source.path === path || target.path === path,
            ),
      },
    })
  })
  state.onCreateRun = ({ chat, body, respond }) => {
    const run = {
      ...body,
      id: `formalize-${state.runs.length}`,
      projectId,
      chatId: chat.id,
      status: 'completed',
      message: 'Fixture reply.',
      createdAt: new Date().toISOString(),
      followups: [],
      eventCursor: 0,
      ...(body.prompt === 'No formalization was produced.'
        ? {
            verification: {
              compiled: false,
              complete: false,
              errors: [],
              reason:
                'No Lean formalization was written. There is no Lean output to verify.',
            },
          }
        : {}),
    }
    state.runs.push(run)
    return respond(run, 202)
  }
  await fixture.ready()
  const composer = page.getByLabel('Message Lemex')
  const send = page.getByRole('button', { name: 'Send', exact: true })
  const note = page.locator('.assistant-tex-note')
  const mode = (name) =>
    page
      .locator('.mode-tabs')
      .getByRole('button', { name, exact: true })
      .click()
  const open = async (file) => {
    await page.locator(`.file-item[title="${file}"]`).click()
    await page
      .getByLabel(`Current file included automatically: ${file}`, {
        exact: true,
      })
      .waitFor()
  }
  const submit = async () => {
    const before = state.runs.length
    await send.click()
    await until(() => state.runs.length === before + 1, 'document request')
    await until(
      async () => (await composer.inputValue()) === '',
      'document acknowledgement',
    )
    return state.runs.at(-1)
  }

  await open('paper.tex')
  for (const name of ['Proofs', 'Optimize']) {
    await mode(name)
    await composer.fill('Edit and compile this LaTeX document.')
    assert.equal(await send.isEnabled(), true)
    await note
      .getByText('Lemex can read, edit, and compile your LaTeX document here.')
      .waitFor()
    const request = await submit()
    assert.equal(request.mode, name === 'Optimize' ? 'optimize' : 'proofs')
  }
  report.checks.push(
    'Explicit document requests can be sent in Proofs and Optimize without switching modes or selecting a Lean target.',
  )

  for (const document of [
    'paper.tex',
    'Paper.PDF',
    'notes.txt',
    'notes.md',
    'notes.rst',
  ]) {
    await open(document)
    await mode('Formalize')
    await composer.fill('Formalize the theorem from this document in Lean.')
    assert.equal(await send.isEnabled(), true)
    await page.getByLabel('Lean output: new file', { exact: true }).waitFor()
    assert.equal(await note.locator('button').count(), 0)
    assert.match(
      await note.innerText(),
      /source document to formalize mathematics in Lean/,
    )
    assert.equal(
      (await note.innerText()).includes(
        'Lemex creates paper links as it works.',
      ),
      document === 'paper.tex' || document === 'Paper.PDF',
    )
    const run = await submit()
    assert.equal(run.mode, 'formalize')
    assert.equal(run.currentFile, document)
    assert.equal(
      run.file,
      undefined,
      'Source documents must not become Lean proof targets',
    )
    assert.deepEqual(run.files, [])
    assert(!JSON.stringify(run).includes('%PDF-1.7'))
    if (document === 'paper.tex')
      await page.screenshot({ path: path.join(output, 'formalize-tex.png') })
  }
  report.checks.push(
    'Formalize sends PDF, TeX, TXT, Markdown, and other readable sources without a Lean target or attachments, including when PDF preview is unavailable.',
  )

  await open('Main.lean')
  assert.equal(await note.count(), 0)
  await page.getByLabel('Select context', { exact: true }).click()
  await page.getByRole('checkbox', { name: 'Paper.PDF', exact: true }).check()
  await page.getByLabel('Filter context', { exact: true }).press('Escape')
  await composer.fill('Formalize the attached paper into this Lean file.')
  await page.getByLabel('Lean output: Main.lean', { exact: true }).waitFor()
  assert.match(
    await note.innerText(),
    /source document to formalize mathematics in Lean/,
  )
  const attached = await submit()
  assert.equal(attached.mode, 'formalize')
  assert.equal(attached.file, 'Main.lean')
  assert.equal(attached.currentFile, 'Main.lean')
  assert.deepEqual(attached.files, ['Paper.PDF'])
  await page
    .getByRole('button', { name: 'Remove Paper.PDF from context', exact: true })
    .click()
  report.checks.push(
    'An attached PDF also works with a separate Lean destination and shows formalization guidance.',
  )

  await open('paper.tex')
  await composer.fill('No formalization was produced.')
  await submit()
  await page
    .getByText(
      'No Lean formalization was written. There is no Lean output to verify.',
      { exact: true },
    )
    .waitFor()
  report.checks.push(
    'A Formalize run without Lean output shows the actual reason in the conversation.',
  )
  await mode('Ask & Search')
  await note
    .getByText('Lemex can read, edit, and compile your LaTeX document here.', {
      exact: true,
    })
    .waitFor()

  pdfAvailable = true
  await open('Paper.PDF')
  await page.getByRole('button', { name: 'Paper links', exact: true }).click()
  const linkPanel = page.getByRole('complementary', { name: 'Paper links' })
  await linkPanel
    .getByText('No paper links for this file yet.', { exact: true })
    .waitFor()
  const beforeBackfill = state.runs.length
  await linkPanel.getByRole('button', { name: 'Find links with Lemex' }).click()
  await until(
    async () => (await composer.inputValue()).includes('Find paper links'),
    'link task draft',
  )
  assert.equal(
    state.runs.length,
    beforeBackfill,
    'Preparing a task should not submit it',
  )
  const backfill = await submit()
  assert.equal(backfill.mode, 'search')
  assert.deepEqual(backfill.files, ['Paper.PDF'])
  assert.match(
    backfill.prompt,
    /existing Lean declarations.*Keep the paper and Lean sources unchanged/,
  )
  await page
    .getByRole('button', { name: 'Remove Paper.PDF from context', exact: true })
    .click()
  report.checks.push(
    'Finding links for an existing PDF prepares a scoped Ask & Search task for review before sending.',
  )
  paperLinksAvailable = true
  await linkPanel.getByRole('button', { name: 'Refresh paper links' }).click()
  await linkPanel.getByText('Fixture PDF', { exact: true }).waitFor()
  assert.equal(
    await linkPanel
      .getByRole('button', { name: 'Open Paper.PDF, page 2' })
      .isDisabled(),
    true,
  )
  await linkPanel
    .getByText('This link needs updating.', { exact: true })
    .waitFor()
  const leanLink = linkPanel.getByRole('button', {
    name: 'Open trace_example in Main.lean',
  })
  const refreshListing = async () => {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === `/api/projects/${projectId}/files`,
    )
    await page
      .getByRole('button', { name: 'Refresh files', exact: true })
      .evaluate((button) => button.click())
    await response
  }
  await leanLink.focus()
  const beforeListing = paperLinkRequests
  state.files[projectId]['Other.lean'] +=
    '-- External save in an unrelated file.\n'
  await refreshListing()
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  assert.equal(
    paperLinkRequests,
    beforeListing,
    'An unrelated file revision does not trigger a paper-links lookup',
  )
  assert.equal(
    await leanLink.evaluate((link) => link === document.activeElement),
    true,
  )

  holdPaperLinks = new Promise((resolve) => {
    releasePaperLinks = resolve
  })
  state.files[projectId]['Main.lean'] += '-- External save in a linked file.\n'
  await refreshListing()
  await until(
    () => paperLinkRequests === beforeListing + 1,
    'linked file revision lookup',
  )
  assert.equal(
    await leanLink.evaluate((link) => link === document.activeElement),
    true,
  )
  assert.equal(await leanLink.getAttribute('aria-disabled'), 'true')
  await page.keyboard.press('Enter')
  await page.getByRole('tab', { name: 'Paper.PDF', selected: true }).waitFor()
  releasePaperLinks()
  holdPaperLinks = undefined
  await until(() => leanLink.isEnabled(), 'validated paper links')
  assert.equal(
    await leanLink.evaluate((link) => link === document.activeElement),
    true,
  )
  report.checks.push(
    'Paper links ignore unrelated revisions and retain keyboard focus while temporarily disabling navigation during a related refresh.',
  )

  await leanLink.click()
  await page.getByRole('tab', { name: 'Main.lean', selected: true }).waitFor()
  await page
    .locator('.line-numbers.active-line-number')
    .filter({ hasText: /^3$/ })
    .waitFor()
  await linkPanel
    .getByRole('button', { name: 'Open paper.tex, line 2' })
    .click()
  await page.getByRole('tab', { name: 'paper.tex', selected: true }).waitFor()
  await page
    .locator('.line-numbers.active-line-number')
    .filter({ hasText: /^2$/ })
    .waitFor()
  await linkPanel
    .getByRole('button', { name: 'Open trace_example in Main.lean' })
    .click()
  await linkPanel
    .getByRole('button', { name: 'Open Appendix.pdf, page 1' })
    .click()
  await page.locator('iframe[title="PDF preview"][src$="#page=1"]').waitFor()
  assert.match(
    await page
      .getByRole('link', { name: 'Open PDF in new tab' })
      .getAttribute('href'),
    /#page=1$/,
  )
  await linkPanel
    .getByRole('button', { name: 'Open trace_example in Main.lean' })
    .click()
  await linkPanel
    .getByRole('button', { name: 'Open Paper.PDF, page 1' })
    .click()
  await page.getByRole('button', { name: 'Paper links', exact: true }).click()
  const inlinePdfLink = page.getByRole('button', {
    name: 'Open trace_example in Lean',
    exact: true,
  })
  await inlinePdfLink.waitFor()
  const zoom = page.getByLabel('PDF zoom')
  const pdfSheet = page.locator('.linked-pdf-sheet')
  const fitWidth = await pdfSheet.evaluate((sheet) => sheet.offsetWidth)
  await zoom.selectOption('200')
  await until(
    async () =>
      (await pdfSheet.evaluate((sheet) => sheet.offsetWidth)) > fitWidth,
    'magnified PDF',
  )
  await inlinePdfLink.waitFor()
  await page.getByRole('button', { name: 'Paper links', exact: true }).click()
  await linkPanel.getByRole('button', { name: 'Refresh paper links' }).click()
  await inlinePdfLink.waitFor()
  assert.equal(
    await zoom.inputValue(),
    '200',
    'Refreshing paper links preserves the PDF zoom',
  )
  await page.getByRole('button', { name: 'Paper links', exact: true }).click()
  await zoom.selectOption('fit')
  await until(
    async () =>
      (await pdfSheet.evaluate((sheet) => sheet.offsetWidth)) === fitWidth,
    'fit-width PDF',
  )
  await inlinePdfLink.hover()
  await inlinePdfLink.click()
  await page.getByRole('tab', { name: 'Main.lean', selected: true }).waitFor()
  report.checks.push(
    'Paper links navigate both directions between PDF pages, TeX lines and Lean declarations, and stale links are disabled.',
  )

  await open('paper.tex')
  const paperLinksButton = page.getByRole('button', {
    name: 'Paper links',
    exact: true,
  })
  if ((await paperLinksButton.getAttribute('aria-expanded')) === 'true')
    await paperLinksButton.click()
  const hover = page.locator('.monaco-hover')
  await page.locator('.paper-editor-anchor').first().hover()
  await hover.getByText('trace_example in Main.lean').waitFor()
  await page.locator('.paper-editor-jump').click()
  await page.getByRole('tab', { name: 'Main.lean', selected: true }).waitFor()
  await page.locator('.paper-editor-jump').click()
  await linkPanel
    .getByRole('button', { name: 'Open Appendix.pdf, page 1' })
    .waitFor()
  await paperLinksButton.click()
  await page
    .locator('.paper-editor-anchor', { hasText: 'trace_example' })
    .first()
    .hover()
  await hover.getByText('Paper.PDF, page 1').waitFor()
  await hover.getByText('thm:trace in paper.tex').waitFor()
  await hover.getByRole('link', { name: 'Open LaTeX source' }).click()
  await page.getByRole('tab', { name: 'paper.tex', selected: true }).waitFor()
  report.checks.push(
    'Linked Lean declarations and LaTeX labels show their destinations on hover, jump directly, and offer multiple destinations from one marker.',
  )

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport)
    const closeTools = page.getByRole('button', { name: 'Close tools panel' })
    if (await closeTools.isVisible()) await closeTools.click()
    await page.getByRole('tab', { name: 'Paper.PDF', exact: true }).click()
    await page.getByRole('tab', { name: 'Paper.PDF', selected: true }).waitFor()
    await paperLinksButton.focus()
    await paperLinksButton.press('Enter')
    const drawer = page.getByRole('dialog', { name: 'Paper links' })
    await drawer
      .getByRole('button', { name: 'Open trace_example in Main.lean' })
      .waitFor()
    assert.equal(
      await drawer
        .getByRole('button', { name: 'Close dialog' })
        .evaluate((button) => button === document.activeElement),
      true,
    )
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
    assert.equal(
      await paperLinksButton.evaluate(
        (button) => button === document.activeElement,
      ),
      true,
    )

    await paperLinksButton.press('Enter')
    await drawer
      .getByRole('button', { name: 'Open trace_example in Main.lean' })
      .click()
    await drawer.waitFor({ state: 'hidden' })
    await page.getByRole('tab', { name: 'Main.lean', selected: true }).waitFor()

    await paperLinksButton.click()
    const runsBefore = state.runs.length
    await drawer.getByRole('button', { name: 'Find links with Lemex' }).click()
    await drawer.waitFor({ state: 'hidden' })
    await until(
      async () => (await composer.inputValue()).includes('Find paper links'),
      'mobile link task draft',
    )
    assert.equal(
      await composer.evaluate((input) => input === document.activeElement),
      true,
    )
    assert.equal(state.runs.length, runsBefore)
    await composer.fill('')
    await page
      .getByRole('button', {
        name: 'Remove Main.lean from context',
        exact: true,
      })
      .click()
  }
  report.checks.push(
    'At phone widths, paper links open a keyboard-accessible dialog, return focus on Escape, and dismiss on navigation or when preparing a backfill draft.',
  )

  fixture.assertClean()
  report.passed = true
  console.log(
    'PASS: document formalization, PDF attachments, LaTeX guidance and paper links; all backends mocked',
  )
} finally {
  releasePaperLinks?.()
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
