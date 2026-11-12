#!/usr/bin/env node
// Isolated browser check: requests, Lean, and providers are all fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(root, '.runtime/ask-search-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'ask-search-project',
  chatId = 'ask-search-chat'
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
      name: 'Ask & Search fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: chatId, projectId, title: 'Open-ended chat' }],
  runs: [],
})
const { page, state, report, browser } = fixture
await page.addInitScript(() => {
  const key = 'lemex-chat-options:fixture-owner:ask-search-project'
  if (!localStorage.getItem(key))
    localStorage.setItem(key, JSON.stringify({ liveEdits: true }))
})
state.onCreateRun = ({ body, respond }) => {
  const fileTask = body.prompt.includes('Notes.md')
  const changes = fileTask
    ? [
        {
          path: 'Notes.md',
          before: state.files[projectId]['Notes.md'] ?? null,
          after: body.liveEdits ? '# Updated study notes\n' : '# Study notes\n',
        },
      ]
    : []
  const run = {
    id: `ask-run-${state.runs.length}`,
    projectId,
    chatId,
    mode: body.mode,
    model: body.model,
    status: 'completed',
    prompt: body.prompt,
    message: fileTask
      ? body.liveEdits
        ? 'Saved Notes.md as requested.'
        : 'Prepared Notes.md for review.'
      : 'Here is a simple study schedule.',
    createdAt: '2026-10-14T12:00:00Z',
    eventCursor: 0,
    liveEdits: body.liveEdits,
    followups: [],
    changes,
    ...(body.liveEdits
      ? { liveChanges: changes, liveRevision: changes.length ? 1 : 0 }
      : {}),
    verification: {
      kind: fileTask ? 'workspace' : 'chat',
      complete: true,
      reason: fileTask
        ? 'No Lean source changes to check.'
        : 'Task completed without changing project files.',
    },
  }
  if (body.liveEdits && fileTask)
    state.files[projectId]['Notes.md'] = changes[0].after
  state.runs.push(run)
  return respond(run, 201)
}
state.onUndo = ({ run, respond }) => {
  for (const change of run.liveChanges) {
    if (change.before === null) delete state.files[projectId][change.path]
    else state.files[projectId][change.path] = change.before
  }
  run.liveUndone = true
  run.liveRevision++
  return respond(run)
}

try {
  await fixture.ready()
  assert.deepEqual(await page.locator('.mode-tabs button').allTextContents(), [
    'Ask & Search',
    'Proofs',
    'Formalize',
    'Optimize',
  ])
  await page.getByRole('button', { name: 'Ask & Search', exact: true }).click()
  const composer = page.getByLabel('Message Lemex')
  assert.equal(
    await composer.getAttribute('placeholder'),
    'Ask a question or describe a task for your project…',
  )
  await page
    .getByRole('button', { name: 'Organize project notes', exact: true })
    .waitFor()
  await page.locator('.chat-options summary').click()
  assert.equal(
    await page.getByLabel('Edit files live', { exact: true }).isEnabled(),
    true,
  )
  assert.equal(
    await page.getByLabel('Edit files live', { exact: true }).isChecked(),
    true,
    'Ask & Search starts with live editing enabled',
  )
  await page.getByRole('button', { name: 'Proofs', exact: true }).click()
  assert.equal(
    await page.getByLabel('Edit files live', { exact: true }).isChecked(),
    true,
    'Switching modes preserves the live-edit preference',
  )
  await page.getByRole('button', { name: 'Ask & Search', exact: true }).click()
  await composer.fill('Help me plan a study schedule.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page
    .getByText('Here is a simple study schedule.', { exact: true })
    .waitFor()
  assert.equal(state.runs[0].liveEdits, true)
  assert.equal(state.runs[0].mode, 'search')
  assert.equal(
    (await page.locator('.conversation-turn').innerText()).includes('Verified'),
    false,
  )
  await page.getByLabel('Edit files live', { exact: true }).uncheck()
  await composer.fill('Create Notes.md with study notes.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page
    .getByText('Prepared Notes.md for review.', { exact: true })
    .waitFor()
  await page.getByText('Ready to review', { exact: true }).waitFor()
  assert.equal('Notes.md' in state.files[projectId], false)
  await page.getByRole('button', { name: /^Review changes/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByText('Project file review', { exact: true }).waitFor()
  await dialog.getByText('Notes.md', { exact: true }).waitFor()
  assert.equal(
    await dialog
      .getByRole('button', { name: 'Apply changes', exact: true })
      .isEnabled(),
    true,
  )
  assert.equal(
    (await dialog.innerText()).includes('Lean verification passed'),
    false,
  )
  await page.screenshot({
    path: path.join(reportDir, 'review-desktop.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
    'Review fits a narrow screen without horizontal overflow',
  )
  await dialog
    .getByRole('button', { name: 'Apply changes', exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({
    path: path.join(reportDir, 'review-narrow.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.route('**/api/runs/ask-run-1/apply', async (route) => {
    state.files[projectId]['Notes.md'] = '# Study notes\n'
    state.runs[1].status = 'applied'
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(state.runs[1]),
    })
  })
  await dialog
    .getByRole('button', { name: 'Apply changes', exact: true })
    .click()
  await until(() => state.runs[1].status === 'applied', 'applied file task')
  await dialog.waitFor({ state: 'hidden' })
  await page.reload()
  await page
    .getByText('Here is a simple study schedule.', { exact: true })
    .waitFor()
  assert.equal(
    (await page.locator('.conversation-turn').first().innerText()).includes(
      'Verified',
    ),
    false,
    'Reload preserves the conversation result kind',
  )
  assert.equal(state.files[projectId]['Notes.md'], '# Study notes\n')
  await page.locator('.chat-options summary').click()
  const liveChoice = page.getByLabel('Edit files live', { exact: true })
  assert.equal(await liveChoice.isChecked(), false)
  await liveChoice.check()
  await page.getByRole('button', { name: 'Proofs', exact: true }).click()
  assert.equal(await liveChoice.isChecked(), true)
  await liveChoice.uncheck()
  await page.getByRole('button', { name: 'Ask & Search', exact: true }).click()
  assert.equal(
    await liveChoice.isChecked(),
    true,
    'Ask & Search has its own live-edit preference',
  )
  await page.reload()
  await composer.waitFor()
  await page.locator('.chat-options summary').click()
  assert.equal(
    await liveChoice.isChecked(),
    true,
    'The saved live-edit choice survives reload',
  )
  await composer.fill('Update Notes.md with more study notes.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page
    .getByText('Saved Notes.md as requested.', { exact: true })
    .waitFor()
  assert.equal(state.runs[2].liveEdits, true)
  assert.equal(state.files[projectId]['Notes.md'], '# Updated study notes\n')
  const liveTurn = page.locator('[data-run-id="ask-run-2"]')
  await liveTurn.getByRole('button', { name: /^View edits/ }).click()
  await dialog.getByText('Notes.md', { exact: true }).waitFor()
  assert.equal(
    await dialog
      .getByRole('button', { name: 'Apply changes', exact: true })
      .count(),
    0,
  )
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await liveTurn
    .getByRole('button', { name: 'Undo agent edits', exact: true })
    .click()
  await until(() => state.runs[2].liveUndone, 'undone live text edits')
  assert.equal(state.files[projectId]['Notes.md'], '# Study notes\n')
  await liveChoice.uncheck()
  await page.getByRole('button', { name: 'Proofs', exact: true }).click()
  assert.equal(
    await liveChoice.isChecked(),
    false,
    'The other mode preference stays unchanged',
  )
  await page.getByRole('button', { name: 'Ask & Search', exact: true }).click()
  await page.reload()
  await composer.waitFor()
  await page.locator('.chat-options summary').click()
  assert.equal(
    await liveChoice.isChecked(),
    false,
    'An explicit review choice survives reload despite the live-edit default',
  )
  await page.setViewportSize({ width: 1280, height: 800 })
  for (const tab of await page.locator('.mode-tabs button').all()) {
    const box = await tab.boundingBox()
    assert(box && box.x >= 0 && box.x + box.width <= 1281)
  }
  await page.screenshot({
    path: path.join(reportDir, 'ask-search.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await composer.scrollIntoViewIfNeeded()
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    true,
    'Ask & Search controls fit a narrow screen',
  )
  await page.screenshot({
    path: path.join(reportDir, 'ask-search-narrow.png'),
    fullPage: true,
  })
  fixture.assertClean()
  report.passed = true
  console.log(
    'PASS: Ask & Search defaults to live edits, supports review/apply and live undo, and preserves separate mode preferences and explicit opt-out across reloads; all backends mocked',
  )
} catch (error) {
  report.passed = false
  report.failure = error.stack || error.message
  await page
    .screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
