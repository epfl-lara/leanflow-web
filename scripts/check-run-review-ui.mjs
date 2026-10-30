#!/usr/bin/env node
// Review and live-edit states with mocked API, Lean, and provider activity.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture } from './lib/chat-browser-fixture.mjs'

const output = new URL('../.runtime/run-review-ui/', import.meta.url)
await fs.mkdir(output, { recursive: true })
const projectId = 'review-project',
  chatId = 'review-chat'
const before = 'theorem target : True := by\n  sorry\n'
const after =
  'private theorem helper : True := by trivial\ntheorem target : True := by\n  exact helper\n'
const change = { path: 'Main.lean', before, after }
const makeRun = (id, fields) => ({
  id,
  projectId,
  chatId,
  mode: 'proofs',
  status: 'completed',
  createdAt: '2026-10-30T09:00:00Z',
  prompt: 'Prove target using a helper lemma.',
  message: 'The candidate proof is complete.',
  changes: [change],
  eventCursor: 0,
  ...fields,
})
const verification = {
  complete: false,
  compiled: false,
  reason: 'Final verification stopped before Lean could check these changes.',
  errors: ['Main.lean changes an existing definition.'],
}
const blocked = makeRun('blocked-review', { liveEdits: false, verification })
const liveBlocked = makeRun('blocked-live', {
  liveEdits: true,
  liveRevision: 1,
  liveChanges: [change],
  verification,
})
const passed = makeRun('passed-review', {
  liveEdits: false,
  verification: {
    complete: true,
    compiled: true,
    kernelChecked: true,
    warnings: ['Unused variable.'],
  },
  toolActivity: [
    {
      id: 'missing-file',
      kind: 'read',
      label: 'Read a file',
      status: 'failed',
      output: 'File not found.',
    },
  ],
})
const livePassed = makeRun('passed-live', {
  liveEdits: true,
  liveRevision: 1,
  liveChanges: [change],
  verification: { complete: true, compiled: true, kernelChecked: true },
})
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { available: true, revision: 'fixture' },
  },
  projects: [
    {
      id: projectId,
      name: 'Run review fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.35.0-rc4',
    },
  ],
  files: { [projectId]: { 'Main.lean': after } },
  chats: [{ id: chatId, projectId, title: 'Proof review' }],
  runs: [blocked, liveBlocked, passed, livePassed],
})
const { page, state, report, browser } = fixture
const turn = (run) => page.locator(`[data-run-id="${run.id}"]`)
const dialog = page.getByRole('dialog')
state.onApply = ({ run, respond }) => {
  assert.equal(run.verification.complete, true)
  run.status = 'applied'
  return respond(run)
}
state.onUndo = ({ run, respond }) => {
  run.liveUndone = true
  run.liveRevision++
  return respond(run)
}
try {
  await fixture.ready()
  await turn(blocked).getByRole('button', { name: 'Review changes 1' }).click()
  await dialog
    .getByText(/cannot be applied because the final Lean check did not pass/)
    .waitFor()
  assert.equal(
    await dialog
      .getByRole('button', { name: 'Apply changes', exact: true })
      .count(),
    0,
  )
  assert.equal(
    await dialog.getByRole('button', { name: 'Continue in chat' }).isEnabled(),
    true,
  )
  await dialog.getByRole('button', { name: 'Continue in chat' }).click()
  const prompt = page.locator('#assistant-prompt')
  assert.match(await prompt.inputValue(), /address the final LeanFlow check/)
  assert.match(
    await prompt.inputValue(),
    /Main.lean changes an existing definition/,
  )
  assert.equal(
    await prompt.evaluate((element) => element === document.activeElement),
    true,
  )
  assert.equal(
    report.requests.filter((request) => request.method === 'POST').length,
    0,
    'Continuing prepares a draft without sending it',
  )
  report.checks.push(
    'A failed final check explains why Apply is unavailable and offers a usable continuation',
  )

  await prompt.fill('Keep my existing follow-up.')
  await turn(blocked).getByRole('button', { name: 'Review changes 1' }).click()
  await dialog.getByRole('button', { name: 'Continue in chat' }).click()
  assert.equal(await prompt.inputValue(), 'Keep my existing follow-up.')
  report.checks.push('Continuing preserves an existing draft')

  await turn(liveBlocked).getByRole('button', { name: 'View edits 1' }).click()
  await dialog.getByText(/edits are already saved in your project/).waitFor()
  assert.equal(
    await dialog
      .getByRole('button', { name: 'Apply changes', exact: true })
      .count(),
    0,
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await turn(liveBlocked)
    .getByRole('button', { name: 'Undo agent edits' })
    .click()
  await turn(liveBlocked).getByText('Edits undone', { exact: true }).waitFor()
  assert.equal(await turn(liveBlocked).locator('.turn-outcome').count(), 0)
  await turn(liveBlocked).getByRole('button', { name: 'View edits 1' }).click()
  await dialog.getByText(/These edits were undone/).waitFor()
  assert.equal(
    await dialog.getByRole('button', { name: 'Continue in chat' }).count(),
    0,
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  report.checks.push(
    'Saved live edits explain their state and retain a working Undo action',
  )

  await turn(passed).getByRole('button', { name: 'Review changes 1' }).click()
  assert.equal(
    await dialog
      .getByRole('button', { name: 'Apply changes', exact: true })
      .isEnabled(),
    true,
  )
  await dialog.getByText('Warnings', { exact: true }).click()
  await dialog.getByText(/Unused variable/).waitFor()
  await dialog
    .getByRole('button', { name: 'Apply changes', exact: true })
    .click()
  await turn(passed).getByText('Applied', { exact: true }).waitFor()
  await turn(passed).getByText('Attempt failed', { exact: true }).waitFor()
  await turn(passed).locator('.tool-step summary').click()
  await turn(passed)
    .getByText(/no approval is requested/)
    .waitFor()
  assert.match(
    await turn(passed).locator('.turn-outcome').innerText(),
    /Final Lean check passed/,
  )
  assert.doesNotMatch(
    await turn(passed).innerText(),
    /Needs attention|checks need attention/,
  )
  report.checks.push(
    'Compiler warnings permit applying a verified candidate; an earlier failed attempt does not become a final warning',
  )

  await turn(livePassed).getByRole('button', { name: 'View edits 1' }).click()
  assert.equal(
    await dialog
      .getByRole('button', { name: /Apply changes|Continue in chat/ })
      .count(),
    0,
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await turn(livePassed)
    .getByText('Checks & run details', { exact: true })
    .click()
  assert.doesNotMatch(
    await turn(livePassed).innerText(),
    /Edits are saved live; final Lean verification is independent|need attention/,
  )
  await page.screenshot({
    path: new URL('review.png', output).pathname,
    fullPage: true,
  })
  report.checks.push(
    'Successful live edits have no pending approval or recurring live-edit help message',
  )
  fixture.assertClean()
  console.log(JSON.stringify({ checks: report.checks }, null, 2))
} catch (error) {
  await page.screenshot({
    path: new URL('failure.png', output).pathname,
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    new URL('report.json', output),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
