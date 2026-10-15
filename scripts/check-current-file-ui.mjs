#!/usr/bin/env node
// Serve the built client separately; every API and Lean request uses fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/current-file-ui')
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
const projectId = 'current-file-project'
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
    projects: [{ id: projectId, name: 'Editor context', status: 'ready' }],
    files: {
      [projectId]: {
        'Main.lean': 'example : True := by trivial\n',
        'Notes.md': '# Notes\n\nExplain the open file.\n',
        'Paper.PDF': '%PDF-1.7\n',
      },
    },
    chats: [{ id: 'context-chat', projectId, title: 'Context checks' }],
    runs: [],
  })
  const { page, state, report, emit } = fixture
  let rejectPdfPreview = false
  await page.route('**/api/projects/*/file-preview?*', (route) => {
    if (rejectPdfPreview)
      return route.fulfill({
        status: 415,
        json: { error: 'Fixture PDF preview is unavailable.' },
      })
    return route.fulfill({
      contentType: 'application/pdf',
      body: Buffer.from(
        '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
      ),
    })
  })
  state.onCreateRun = ({ chat, body, respond }) => {
    const run = {
      ...body,
      ...(body.mode === 'search' &&
      body.currentFile &&
      !(body.currentFile in state.files[projectId])
        ? { currentFile: null, file: null }
        : {}),
      id: `context-${state.runs.length}`,
      projectId,
      chatId: chat.id,
      status: body.mode === 'search' ? 'running' : 'completed',
      message: `Fixture ${body.mode} reply.`,
      followups: [],
      eventCursor: 0,
      createdAt: new Date().toISOString(),
    }
    state.runs.push(run)
    return respond(run, 202)
  }
  await fixture.ready()
  await page.locator('.file-item[title="Main.lean"]').click()
  await page
    .getByLabel('Current file included automatically: Main.lean', {
      exact: true,
    })
    .waitFor()
  const composer = page.getByLabel('Message Lemex')
  const requests = (suffix) =>
    report.requests.filter(
      (entry) => entry.method === 'POST' && entry.endpoint.endsWith(suffix),
    )
  for (const [label, mode] of [
    ['Proofs', 'proofs'],
    ['Formalize', 'formalize'],
    ['Optimize', 'optimize'],
    ['Ask & Search', 'search'],
  ]) {
    await page
      .locator('.mode-tabs')
      .getByRole('button', { name: label, exact: true })
      .click()
    await composer.fill(`Inspect the file in ${mode} mode.`)
    const before = requests('/runs').length
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await until(
      () => requests('/runs').length === before + 1,
      `${mode} request`,
    )
    const { body } = requests('/runs').at(-1)
    assert.equal(body.mode, mode)
    assert.equal(body.currentFile, 'Main.lean')
    assert.deepEqual(body.files, [])
    await until(
      async () => (await composer.inputValue()) === '',
      `${mode} acknowledgement`,
    )
  }
  report.checks.push(
    'Proofs, Formalize, Optimize and Search send the open file with no manually attached files.',
  )
  const active = state.runs.at(-1)
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'active stream',
  )
  await page.locator('.file-item[title="Notes.md"]').click()
  await page
    .getByLabel('Current file included automatically: Notes.md', {
      exact: true,
    })
    .waitFor()
  let rejectFirst = true
  state.onMessage = async ({ run, body, respond }) => {
    if (rejectFirst) {
      rejectFirst = false
      return respond(
        { error: 'Fixture connection interrupted. Send again to retry.' },
        503,
      )
    }
    const receipt = {
      ...body,
      ...(body.currentFile && !(body.currentFile in state.files[projectId])
        ? { currentFileUnavailable: true }
        : {}),
      status: 'accepted',
      createdAt: new Date().toISOString(),
      messageOffset: run.message.length,
    }
    await emit(run, 'followup', receipt)
    return respond(structuredClone(run))
  }
  await composer.fill('Explain the file I just opened.')
  const send = page.getByRole('button', { name: 'Send update', exact: true })
  await send.click()
  await page
    .getByText('Fixture connection interrupted. Send again to retry.', {
      exact: true,
    })
    .waitFor()
  const first = requests('/messages').at(-1).body
  assert.equal(first.currentFile, 'Notes.md')
  assert.deepEqual(first.files, [])
  await page.locator('.file-item[title="Main.lean"]').click()
  await page
    .getByLabel('Current file included automatically: Main.lean', {
      exact: true,
    })
    .waitFor()
  await send.click()
  await until(
    async () => (await composer.inputValue()) === '',
    'retried guidance acknowledgement',
  )
  const retried = requests('/messages').at(-1).body
  assert.deepEqual(
    retried,
    first,
    'Retry must preserve the original file and receipt identity after navigation',
  )
  await composer.fill('Now explain the current Main file.')
  await send.click()
  await until(
    async () => (await composer.inputValue()) === '',
    'new current-file guidance acknowledgement',
  )
  const next = requests('/messages').at(-1).body
  assert.equal(next.currentFile, 'Main.lean')
  assert.notEqual(next.id, first.id)
  assert.deepEqual(next.files, [])
  assert.equal(await page.locator('.file-context-chip').count(), 0)
  report.checks.push(
    'Live guidance follows the open editor file; retry after navigation preserves the original message context.',
  )
  await page.locator('.file-item[title="Paper.PDF"]').click()
  await page
    .getByRole('region', { name: 'PDF document', exact: true })
    .waitFor()
  await page
    .getByLabel('Current file included automatically: Paper.PDF', {
      exact: true,
    })
    .waitFor()
  await composer.fill('Which PDF am I viewing?')
  await send.click()
  await until(
    async () => (await composer.inputValue()) === '',
    'PDF guidance acknowledgement',
  )
  const pdfUpdate = requests('/messages').at(-1).body
  assert.equal(pdfUpdate.currentFile, 'Paper.PDF')
  assert.deepEqual(pdfUpdate.files, [])
  await emit(active, 'status', { status: 'completed' })
  await composer.fill('Explain which document is open.')
  const newTask = page.getByRole('button', { name: 'Send', exact: true })
  await newTask.waitFor()
  await newTask.click()
  await until(
    async () => (await composer.inputValue()) === '',
    'PDF search acknowledgement',
  )
  const pdfRun = requests('/runs').at(-1).body
  assert.equal(pdfRun.currentFile, 'Paper.PDF')
  assert.equal(
    pdfRun.file,
    undefined,
    'PDF is editor context, not an editable proof target',
  )
  assert.deepEqual(pdfRun.files, [])
  assert(!JSON.stringify(pdfRun).includes('%PDF-1.7'))
  report.checks.push(
    'PDF viewing supplies its path to new Search tasks and live guidance without adding binary contents or a proof target.',
  )
  rejectPdfPreview = true
  await page.getByRole('button', { name: 'Reload PDF', exact: true }).click()
  await page
    .getByText('Fixture PDF preview is unavailable.', { exact: true })
    .waitFor()
  await composer.fill('Continue while the PDF preview is unavailable.')
  await send.click()
  await until(
    async () => (await composer.inputValue()) === '',
    'guidance beside unavailable PDF preview',
  )
  assert.equal(requests('/messages').at(-1).body.currentFile, 'Paper.PDF')
  delete state.files[projectId]['Paper.PDF']
  await composer.fill('Continue after the open file was deleted.')
  await send.click()
  await until(
    async () => (await composer.inputValue()) === '',
    'guidance beside deleted editor file',
  )
  assert.equal(state.runs.at(-1).followups.at(-1).currentFileUnavailable, true)
  await emit(state.runs.at(-1), 'status', { status: 'completed' })
  await composer.fill('Continue Search with the remaining project.')
  await newTask.waitFor()
  await newTask.click()
  await until(
    async () => (await composer.inputValue()) === '',
    'Search beside deleted editor file',
  )
  assert.equal(state.runs.at(-1).currentFile, null)
  assert.equal(await page.locator('.file-context-chip').count(), 0)
  report.checks.push(
    'Unavailable PDF previews and deleted open files leave Search and live guidance usable without manual context changes.',
  )
  await page.screenshot({ path: path.join(output, 'current-file.png') })
  fixture.assertClean()
  report.passed = true
  console.log(
    'PASS: automatic current file in all workflows, live file switching, and durable retry after navigation; all backends mocked',
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
