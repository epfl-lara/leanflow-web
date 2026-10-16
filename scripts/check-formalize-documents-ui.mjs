#!/usr/bin/env node
// Serve the built client in isolation; all APIs, Lean and providers use fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

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
        'Main.lean': 'example : True := by trivial\n',
        'paper.tex': '\\begin{theorem}True.\\end{theorem}\n',
        'Paper.PDF': '%PDF-1.7\n',
        'notes.txt': 'Theorem: True. Proof: trivial.\n',
        'notes.md': '# Theorem\n\nTrue. Proof: trivial.\n',
        'notes.rst': 'Theorem\n=======\n\nTrue. Proof: trivial.\n',
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
  await page.route('**/api/projects/*/file-preview?*', (route) =>
    route.fulfill({
      status: 415,
      json: { error: 'Fixture PDF preview is unavailable.' },
    }),
  )
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
    await composer.fill('Work on this proof.')
    assert.equal(await send.isDisabled(), true)
    await note
      .getByRole('button', {
        name: 'Use Ask & Search for LaTeX editing and compilation',
        exact: true,
      })
      .waitFor()
    await page
      .getByText('Select a writable Lean file to begin.', { exact: true })
      .waitFor()
  }
  report.checks.push(
    'Proofs and Optimize retain the LaTeX editing link and require a writable Lean target.',
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
  await page.getByLabel('Select files', { exact: true }).click()
  await page.getByRole('checkbox', { name: 'Paper.PDF', exact: true }).check()
  await page.getByLabel('Filter context files').press('Escape')
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
  fixture.assertClean()
  report.passed = true
  console.log(
    'PASS: document formalization, PDF attachments, and mode-specific LaTeX guidance; all backends mocked',
  )
} finally {
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
