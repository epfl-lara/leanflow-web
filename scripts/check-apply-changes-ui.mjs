#!/usr/bin/env node
// Apply review flows use isolated API, file, Lean, and provider fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/apply-changes-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`
const projectId = 'apply-project'
const chatId = 'review-chat'
const original = '-- original\nexample : True := by trivial\n'
const accepted = '-- accepted review\nexample : True := by trivial\n'
const candidate = (id, after) => ({
  id,
  projectId,
  chatId,
  kind: 'agent',
  mode: 'search',
  status: 'completed',
  createdAt: '2026-11-12T10:00:00Z',
  prompt: 'Update my project notes.',
  message: 'Prepared the requested edits.',
  liveEdits: false,
  changes: [{ path: 'Main.lean', before: original, after }],
  verification: { kind: 'search', complete: true, editsAllowed: true },
  eventCursor: 0,
})
const successful = candidate('successful-review', accepted)
const retry = candidate('retry-review', accepted + '-- retry succeeded\n')
retry.changes[0].before = accepted
const stale = candidate('stale-review', '-- stale candidate\n')
const other = {
  id: 'other-chat-run',
  projectId,
  chatId: 'other-chat',
  kind: 'agent',
  mode: 'search',
  status: 'running',
  createdAt: '2026-11-12T10:01:00Z',
  prompt: 'Search for a useful lemma.',
  message: 'Still searching.',
  liveEdits: true,
  eventCursor: 0,
}
let fixture
const requests = []
let attempts = 0
let releaseApply
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { available: true, revision: 'fixture' },
    },
    projects: [
      { id: projectId, name: 'Apply review fixture', status: 'ready' },
    ],
    files: { [projectId]: { 'Main.lean': original } },
    chats: [
      { id: chatId, projectId, title: 'Review requested edits' },
      { id: 'other-chat', projectId, title: 'Unrelated search' },
    ],
    runs: [successful, retry, stale, other],
  })
  const { page, state, report } = fixture
  const turn = (run) => page.locator(`[data-run-id="${run.id}"]`)
  const dialog = page.getByRole('dialog')
  const apply = () =>
    dialog.getByRole('button', { name: 'Apply changes', exact: true })
  const open = async (run) => {
    await turn(run)
      .getByRole('button', { name: 'Review changes 1', exact: true })
      .click()
    await dialog.waitFor({ state: 'visible' })
  }
  state.onApply = async ({ run, respond }) => {
    requests.push(run.id)
    if (run.id === successful.id) {
      await new Promise((resolve) => {
        releaseApply = resolve
      })
    } else if (run.id === retry.id && attempts++ === 0) {
      return respond(
        { error: 'The server is temporarily unavailable. Try applying again.' },
        503,
      )
    } else if (run.id === stale.id) {
      return respond(
        {
          error:
            'Project changed during the assistant run: Main.lean. Start a new run from the current project.',
        },
        409,
      )
    }
    state.files[projectId]['Main.lean'] = run.changes[0].after
    run.status = 'applied'
    return respond(run)
  }
  await fixture.ready()
  await open(successful)
  assert(
    await apply().isEnabled(),
    'another active chat must not disable reviewed edits',
  )
  assert.equal(await dialog.getByText(/Wait for the running task/).count(), 0)
  await apply().click()
  await until(() => !!releaseApply, 'apply request admitted')
  assert(
    await dialog
      .getByRole('button', { name: 'Applying…', exact: true })
      .isDisabled(),
  )
  assert(
    await dialog
      .getByRole('button', { name: 'Close', exact: true })
      .isDisabled(),
  )
  assert.deepEqual(requests, [successful.id])
  releaseApply()
  await dialog.waitFor({ state: 'hidden' })
  await turn(successful).getByText('Applied', { exact: true }).waitFor()
  await until(
    async () =>
      (await page.locator('.monaco-editor .view-lines').innerText())
        .replace(/\u00a0/g, ' ')
        .includes('accepted review'),
    'applied content refreshed in editor',
  )
  assert.equal(other.status, 'running')
  report.checks.push(
    'A finished review applies while another chat runs, prevents duplicate submissions, and refreshes the visible file.',
  )

  await open(retry)
  await apply().click()
  await dialog
    .getByRole('alert')
    .getByText(/temporarily unavailable/)
    .waitFor()
  assert.equal(retry.status, 'completed')
  assert.equal(state.files[projectId]['Main.lean'], accepted)
  assert(await apply().isEnabled())
  await apply().click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(state.files[projectId]['Main.lean'], retry.changes[0].after)
  report.checks.push(
    'A failed apply preserves the candidate and saved files, shows an actionable error, and can be retried.',
  )

  await open(stale)
  await apply().click()
  await dialog
    .getByRole('alert')
    .getByText(/Start a new run from the current project/)
    .waitFor()
  assert.equal(stale.status, 'completed')
  assert.equal(state.files[projectId]['Main.lean'], retry.changes[0].after)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  report.checks.push(
    'A saved-file conflict stays visible and cannot overwrite newer edits.',
  )

  const activeHere = { ...other, id: 'same-chat-run', chatId }
  state.runs.push(activeHere)
  await page.reload()
  await page.getByLabel('Message Lemex').waitFor()
  await open(stale)
  assert(await apply().isDisabled())
  await dialog.getByText(/Wait for the running task in this chat/).waitFor()
  const count = requests.length
  await page.screenshot({
    path: path.join(output, 'apply-paused-in-chat.png'),
    fullPage: true,
  })
  assert.equal(requests.length, count)
  report.checks.push(
    'Apply remains paused for a running task in the reviewed chat.',
  )

  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  activeHere.status = 'cancelled'
  await page.reload()
  await page.locator('.monaco-editor textarea').first().waitFor()
  let releaseSave
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve
  })
  state.onSave = async ({ save }) => {
    await saveGate
    return save()
  }
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('-- KEEP_MY_UNSAVED_EDIT\n')
  await open(stale)
  await dialog
    .getByText('Apply is paused for your unsaved edits', { exact: true })
    .waitFor()
  assert(await apply().isDisabled())
  releaseSave()
  await until(
    () => state.files[projectId]['Main.lean'].includes('KEEP_MY_UNSAVED_EDIT'),
    'typing is durably saved',
  )
  await until(
    async () => apply().isEnabled(),
    'apply resumes after successful autosave',
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(requests.length, count)
  report.checks.push(
    'Unsaved typing pauses Apply until its save finishes, then the action recovers without discarding the draft.',
  )
  fixture.assertClean()
  report.passed = true
} catch (error) {
  if (fixture) {
    fixture.report.failure = error.stack || String(error)
    await fixture.page
      .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      .catch(() => {})
  }
  throw error
} finally {
  releaseApply?.()
  if (fixture) {
    await fixture.browser.close()
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
  }
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  JSON.stringify({
    passed: fixture.report.passed,
    checks: fixture.report.checks,
  }),
)
