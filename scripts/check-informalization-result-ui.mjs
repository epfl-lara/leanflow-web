#!/usr/bin/env node
// Render recorded source checks, including older reports, with fixture APIs.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

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
    changes: [
      { path: 'draft.tex', before: null, after: 'Candidate text to revise' },
    ],
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
    },
  },
  runs: [history, paper, failedDraft, incomplete],
})
const { page, browser } = fixture
const turn = (run) => page.locator(`[data-run-id="${run.id}"]`)
const card = (run) =>
  turn(run).getByRole('region', { name: 'Informalization checks' })
try {
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
  await dialog
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
  await dialog.getByText(/Candidate text to revise/).waitFor()
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
  fixture.assertClean()
  console.log(
    'PASS: historical and named source failures, 550px and 390px layout, source navigation, and multi-file paper review.',
  )
} finally {
  await browser.close()
}
