#!/usr/bin/env node
// Render recorded source checks, including older reports, with fixture APIs.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { fixturePdf } from './lib/pdf-fixture.mjs'

const output = new URL(
  '../.runtime/informalization-result-ui/',
  import.meta.url,
)
const projectId = 'result-project'
const chatId = 'result-chat'
const checked = Array.from({ length: 9 }, (_, index) => ({
  name: 'proof' + (index + 1),
  path: 'Main.lean',
  startLine: index + 1,
  endLine: index + 1,
  status: 'checked',
  type: 'True',
  axioms: [],
}))
const absentLines =
  'Lean found a theorem without source lines. Select a named theorem with source lines to continue.'
const oldIssue =
  'Lean supplied no source location for 4 theorem declaration(s).'
const missingName =
  'CharacteristicPolynomial.coefficient_recurrence_for_principal_minors'
const sourcePath = 'Problems/Problem1_16.lean'
const emptyPaper = '\\heading{Proof}\n'
const completedPaper = emptyPaper + 'We prove the identity by induction.\n'
function run(id, sources, rest = {}) {
  return {
    projectId,
    chatId,
    id,
    mode: 'informalize',
    status: 'completed',
    createdAt: '2026-11-20T04:00:00Z',
    prompt: 'Explain the theorems in the project.',
    verification: {
      kind: 'workspace',
      complete: false,
      reason: sources.detail,
      informalization: { sources },
    },
    ...rest,
  }
}
const history = run('historical-count', {
  status: 'incomplete',
  entries: checked,
  detail: oldIssue,
})
const incomplete = run('missing-line', {
  status: 'incomplete',
  entries: checked,
  detail: absentLines,
  unlocated: [{ name: missingName, path: sourcePath }],
})
const paper = run(
  'two-file-draft',
  {},
  {
    message:
      'Read [the new chapter](sections/results.tex) or open [the main paper](paper.tex).',
    changes: ['sections/results.tex', 'sections/intro.tex'].map((path) => ({
      path,
      before: null,
      after: 'New chapter text',
    })),
    verification: {
      kind: 'workspace',
      complete: true,
      informalization: {
        sources: { status: 'checked', entries: checked },
        document: {
          path: 'paper.tex',
          paths: ['sections/intro.tex', 'sections/results.tex'],
          buildId: 'paper-build',
        },
      },
    },
  },
)
const failedDraft = run(
  'automatic-draft',
  {},
  {
    liveEdits: true,
    message: 'The [paper](draft.tex) needs a correction.',
    changes: [{ path: 'draft.tex', before: emptyPaper, after: completedPaper }],
    verification: {
      kind: 'workspace',
      complete: false,
      editsAllowed: false,
      reason: 'A chapter is missing from the PDF.',
      informalization: {
        sources: { status: 'checked', entries: checked },
        draft: { path: 'draft.tex' },
      },
    },
  },
)
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture' },
    templates: [],
    models: [{ id: 'fixture', name: 'Fixture' }],
    defaultModel: 'fixture',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    { id: projectId, name: 'Proofs', status: 'ready', toolchain: 'fixture' },
  ],
  chats: [{ id: chatId, projectId, title: 'Proof notes' }],
  files: {
    [projectId]: {
      'Main.lean': 'theorem proof1 : True := by trivial\n',
      [sourcePath]: 'theorem helper : True := by trivial\n',
      'paper.tex': '\\documentclass{article}\n',
      'draft.tex': emptyPaper,
    },
  },
  runs: [history, paper, failedDraft, incomplete],
})
const { page, browser } = fixture
const turn = (run) => page.locator(`[data-run-id="${run.id}"]`)
const card = (run) =>
  turn(run).getByRole('region', { name: 'Informalization checks' })
try {
  const buildBase = `/api/projects/${projectId}/tex/builds/`
  const pdfRequests = []
  const mappingRequests = []
  let stale = false
  await page.route(
    (url) => url.pathname.startsWith(buildBase),
    async (route) => {
      const [id, action] = new URL(route.request().url()).pathname
        .slice(buildBase.length)
        .split('/')
      assert(['paper-build', 'retry-pdf'].includes(id))
      assert.equal(route.request().method(), 'GET')
      if (action === 'pdf') {
        pdfRequests.push(id)
        return route.fulfill({
          contentType: 'application/pdf',
          body: fixturePdf(),
        })
      }
      assert.equal(
        id,
        'retry-pdf',
        'project navigation is restricted to saved papers',
      )
      if (!action)
        return route.fulfill({
          json: {
            id,
            rootFile: 'draft.tex',
            pdf: { filename: 'draft.pdf' },
            syncTexAvailable: true,
          },
        })
      assert.equal(action, 'synctex')
      mappingRequests.push(id)
      if (stale)
        return route.fulfill({
          status: 409,
          json: { error: 'Saved TeX sources changed.' },
        })
      return route.fulfill({
        json: {
          page: 1,
          boxes: [
            {
              path: 'draft.tex',
              line: 2,
              x: 68,
              y: 57,
              width: 125,
              height: 25,
            },
          ],
          links: [
            {
              id: 'source-proof',
              status: 'current',
              source: { path: 'draft.tex', line: 2 },
              target: { path: 'Main.lean', line: 1, declaration: 'proof1' },
            },
          ],
        },
      })
    },
  )
  await page.route(
    (url) => url.pathname === `/api/projects/${projectId}/tex`,
    (route) =>
      route.fulfill({
        json: {
          available: true,
          engines: ['pdflatex'],
          workspaceRevision: null,
          build: null,
          lastSuccessful: null,
        },
      }),
  )
  await fixture.ready()
  await mkdir(output, { recursive: true })
  for (const width of [550, 390]) {
    await page.setViewportSize({ width, height: width === 550 ? 1000 : 750 })
    const saved = card(history)
    await saved.getByText('No document to review', { exact: true }).waitFor()
    assert.equal(await saved.getByText(/could not match 4 theorems/).count(), 1)
    assert(
      !/supplied no source|Document checks need attention/.test(
        await turn(history).innerText(),
      ),
    )
    const current = card(incomplete)
    await current.getByText(missingName, { exact: false }).last().waitFor()
    await current
      .getByRole('button', { name: sourcePath })
      .click({ trial: true })
    assert.equal(
      await current.getByText(absentLines, { exact: true }).count(),
      1,
    )
    const fits = await current.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return (
        bounds.width <= window.innerWidth &&
        [...element.querySelectorAll('li,button,summary')].every((child) => {
          const box = child.getBoundingClientRect()
          return (
            box.x >= bounds.x &&
            box.right <= bounds.right + 1 &&
            child.scrollWidth <= child.clientWidth + 1
          )
        })
      )
    })
    assert(
      fits,
      'Source names and links must fit inside the card at ' + width + 'px',
    )
    await page
      .getByRole('region', { name: 'Conversation', exact: true })
      .evaluate((node) => {
        node.scrollTop = node.scrollHeight
      })
    await page.locator('.jump-to-latest').waitFor({ state: 'hidden' })
    if (width === 550)
      await current.screenshot({
        path: new URL('source-result.png', output).pathname,
      })
  }
  await card(incomplete).getByRole('button', { name: sourcePath }).click()
  await until(
    () =>
      page
        .locator('.file-tab')
        .getAttribute('aria-label')
        .then((s) => s?.includes('Problem1_16.lean')),
    'open source file for a theorem without a known line',
  )
  await card(incomplete)
    .getByText('Lean checked 9 proofs.', { exact: true })
    .click()
  await card(incomplete)
    .getByRole('button', { name: /proof2 · Main.lean:2/ })
    .waitFor()
  await turn(paper).getByRole('link', { name: 'the new chapter' }).click()
  const dialog = page.getByRole('dialog', { name: 'Review document' })
  await dialog.getByText('New chapter text', { exact: false }).first().waitFor()
  await dialog.getByRole('link', { name: 'Open PDF', exact: true }).click()
  const draftPdf = page.getByRole('dialog', { name: 'paper.pdf', exact: true })
  await draftPdf.getByRole('button', { name: 'Reload PDF' }).waitFor()
  assert.deepEqual(pdfRequests, ['paper-build'])
  assert.deepEqual(mappingRequests, [])
  await draftPdf
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  await turn(paper).getByRole('link', { name: 'the main paper' }).click()
  await until(
    () =>
      page
        .locator('.file-tab')
        .getAttribute('aria-label')
        .then((s) => s?.includes('paper.tex')),
    'open unchanged paper root',
  )
  await turn(failedDraft)
    .getByRole('button', { name: /Review document/ })
    .click()
  await dialog
    .getByText('This draft has not been saved to the project.')
    .waitFor()
  await dialog.getByText(/We prove the identity by induction/).waitFor()
  await dialog.getByRole('button', { name: 'Continue in chat' }).waitFor()
  assert.equal(
    await dialog.getByRole('button', { name: 'Apply changes' }).count(),
    0,
  )
  assert.equal(
    await dialog.getByRole('button', { name: 'Open document' }).count(),
    0,
  )
  await dialog
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  assert.equal(
    await turn(failedDraft)
      .getByRole('button', { name: 'Undo agent edits' })
      .count(),
    0,
  )
  let attempts = 0
  fixture.state.onRecheckDocument = ({ run, body, respond }) => {
    assert.equal(run.id, failedDraft.id)
    assert.deepEqual(body, { documentCheckAttempt: 0 })
    attempts++
    Object.assign(run, {
      status: 'verifying',
      documentCheckAttempt: 1,
      eventCursor: 1,
    })
    return respond(run, 202)
  }
  await card(failedDraft)
    .getByRole('button', { name: 'Recheck and save draft' })
    .click()
  await page.waitForFunction(
    (id) => window.__chatFixture.connected(id),
    failedDraft.id,
  )
  const retried = fixture.state.runs.find((run) => run.id === failedDraft.id)
  retried.liveChanges = retried.changes
  retried.liveRevision = 1
  retried.verification = {
    kind: 'workspace',
    complete: true,
    editsAllowed: true,
    informalization: {
      sources: { status: 'checked', entries: checked },
      document: { path: 'draft.tex', buildId: 'retry-pdf' },
    },
  }
  fixture.state.files[projectId]['draft.tex'] = retried.changes[0].after
  await fixture.emit(retried, 'status', { status: 'completed' })
  await card(failedDraft).getByText('Document saved', { exact: true }).waitFor()
  await turn(failedDraft)
    .getByRole('button', { name: 'Undo agent edits' })
    .waitFor()
  const savedPdf = card(failedDraft).getByRole('link', {
    name: 'Open PDF',
    exact: true,
  })
  assert.equal(
    new URL(await savedPdf.getAttribute('href'), page.url()).pathname,
    buildBase + 'retry-pdf/pdf',
  )
  assert.equal(
    await card(failedDraft)
      .getByRole('link', { name: 'Download PDF' })
      .getAttribute('download'),
    'draft.pdf',
  )
  const modifiedClickHandled = await savedPdf.evaluate((link) => {
    let handled
    window.addEventListener(
      'click',
      (event) => {
        handled = event.defaultPrevented
        event.preventDefault()
      },
      { once: true },
    )
    link.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
      }),
    )
    return handled
  })
  assert.equal(
    modifiedClickHandled,
    false,
    'modified click keeps browser link behavior',
  )
  stale = true
  await savedPdf.click()
  const checkedPdf = page.getByRole('dialog', {
    name: 'draft.pdf',
    exact: true,
  })
  await checkedPdf
    .getByText('LaTeX source locations are unavailable for this page.')
    .waitFor()
  assert.equal(
    await checkedPdf
      .getByRole('button', { name: 'Open proof1 in Lean' })
      .count(),
    0,
  )
  await checkedPdf.getByRole('button', { name: 'Close dialog' }).click()
  stale = false
  await savedPdf.click()
  await checkedPdf.getByRole('button', { name: 'Open proof1 in Lean' }).click()
  await checkedPdf.waitFor({ state: 'hidden' })
  await until(
    () =>
      page
        .locator('.file-tab')
        .getAttribute('aria-label')
        .then((s) => s?.includes('Main.lean')),
    'open Lean from the saved chat PDF',
  )
  assert.equal(pdfRequests.at(-1), 'retry-pdf')
  assert.equal(mappingRequests.at(-1), 'retry-pdf')
  await page.reload()
  await page.getByRole('button', { name: 'Lemex', exact: true }).click()
  await card(failedDraft).getByRole('button', { name: 'Open document' }).click()
  await page
    .locator('.monaco-editor .view-line')
    .filter({ hasText: /We\s+prove\s+the\s+identity\s+by\s+induction/ })
    .first()
    .waitFor()
  assert.equal(attempts, 1)
  fixture.assertClean()
  console.log(
    'PASS: source diagnostics, mobile layout, draft recovery, and exact chat PDFs with checked Lean navigation.',
  )
} finally {
  await browser.close()
}
