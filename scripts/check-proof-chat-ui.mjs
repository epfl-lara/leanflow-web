#!/usr/bin/env node
// Proof-focus UI and draft races with mocked Lean, projects and provider APIs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(root, '.runtime/proof-chat-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'proof-chat-fixture'
const source =
  'theorem first : True := by\n  trivial\n\ntheorem second : True := by\n  trivial\n'
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
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
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: { [projectId]: { 'Main.lean': source } },
  chats: [
    { id: 'alpha', projectId, title: 'Alpha' },
    { id: 'beta', projectId, title: 'Beta' },
  ],
  runs: [],
  documentSymbols: [
    {
      name: 'first',
      kind: 12,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 9 },
      },
    },
    {
      name: 'second',
      kind: 12,
      range: {
        start: { line: 3, character: 0 },
        end: { line: 4, character: 9 },
      },
    },
  ],
})
const { page, browser, state, report, emit } = fixture
const composer = page.getByLabel('Message Lemex')
const target = page.getByLabel('Focused proof', { exact: true })
const operations = []
const selectedSource = (proof) =>
  state.files[projectId][proof.path]
    .split('\n')
    .slice(proof.startLine - 1, proof.endLine)
    .join('\n')
await page.route(`**/api/projects/${projectId}/file?*`, (route) => {
  if (route.request().method() !== 'PUT') return route.fallback()
  const body = route.request().postDataJSON()
  operations.push('save')
  state.files[projectId]['Main.lean'] = body.content
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      content: body.content,
      hash: createHash('sha256').update(body.content).digest('hex'),
    }),
  })
})
async function chooseChat(id) {
  await page.getByLabel('Select chat').selectOption(id)
  await until(
    async () =>
      (await page.getByLabel('Select chat').inputValue()) === id &&
      !(await page.locator('.chat-picker[aria-busy="true"]').count()),
    `chat ${id}`,
  )
}
async function focus(name, mode = 'proofs') {
  await page.getByRole('button', { name: 'Outline', exact: true }).click()
  await page
    .getByRole('list', { name: 'Declarations in this file' })
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
  await page
    .locator('.proof-focus-actions')
    .getByRole('button', {
      name: mode === 'optimize' ? 'Optimize' : 'Ask Lemex',
      exact: true,
    })
    .click()
  await until(
    async () =>
      (await target.innerText()).includes(name) &&
      (await page
        .locator('.mode-tabs button[aria-pressed="true"]')
        .innerText()) === (mode === 'optimize' ? 'Optimize' : 'Proofs'),
    `focused ${name}`,
  )
}
let created
state.onCreateRun = ({ chat, body, respond }) => {
  operations.push('run')
  assert(body.proofTarget, 'Focused run omitted its proof target')
  if (body.proofTarget.source !== selectedSource(body.proofTarget))
    return respond(
      { error: 'Selected proof changed. Select it again before sending.' },
      409,
    )
  created = {
    id: 'focused-run',
    projectId,
    chatId: chat.id,
    status: 'running',
    mode: body.mode,
    prompt: body.prompt,
    proofTarget: body.proofTarget,
    message: 'Working on the selected proof.',
    eventCursor: 1,
    followups: [],
    liveEdits: false,
    createdAt: '2026-10-13T12:00:00Z',
  }
  state.runs.push(created)
  return respond(created, 202)
}

try {
  await fixture.ready()
  await composer.fill('Use a shorter derivation.')
  await focus('second', 'optimize')
  assert.equal(await composer.inputValue(), 'Use a shorter derivation.')
  assert.equal(
    await page.locator('.mode-tabs button[aria-pressed="true"]').innerText(),
    'Optimize',
  )
  assert((await target.innerText()).includes('Main.lean:4–5'))
  assert.equal(
    report.requests.filter((item) => item.method === 'POST').length,
    0,
    'Focusing a proof started an agent',
  )
  await chooseChat('beta')
  assert.equal(await target.count(), 0)
  await focus('first')
  assert((await composer.inputValue()).includes('Complete or repair'))
  await focus('first', 'optimize')
  assert.equal(
    await composer.inputValue(),
    'Optimize this proof while preserving its statement.',
  )
  await page
    .getByRole('button', { name: 'Clear proof target', exact: true })
    .click()
  assert.equal(await target.count(), 0)
  await chooseChat('alpha')
  assert((await target.innerText()).includes('second'))
  await page.reload()
  await until(
    async () =>
      (await composer.inputValue()) === 'Use a shorter derivation.' &&
      (await target.count()) === 1,
    'focused draft after reload',
  )
  report.checks.push(
    'Outline focus chooses mode without sending, preserves written prompts, and persists a removable target separately in each chat',
  )

  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  await page.keyboard.insertText(' -- revised proof')
  await until(
    () => page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
    'dirty focused proof',
  )
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(
    async () =>
      (await page.getByRole('alert').allTextContents())
        .join('')
        .includes('Selected proof changed'),
    'stale proof rejection',
  )
  assert.deepEqual(operations.slice(-2), ['save', 'run'])
  assert.equal(await composer.inputValue(), 'Use a shorter derivation.')
  assert((await target.innerText()).includes('second'))
  report.checks.push(
    'Focused sends save the editor first; a stale proof rejection preserves both target and user draft',
  )

  await focus('second', 'optimize')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(
    async () =>
      !!created &&
      (await composer.inputValue()) === '' &&
      (await target.count()) === 0,
    'focused run sent',
  )
  assert.equal(created.mode, 'optimize')
  assert.equal(created.proofTarget.name, 'second')
  assert(created.proofTarget.source.includes('-- revised proof'))
  const turn = page.locator('[data-run-id="focused-run"]')
  assert(
    (await turn.locator('.message-proof-target').innerText()).includes(
      'second · Main.lean:4–5',
    ),
  )
  report.checks.push(
    'Re-focusing captures current source; successful send clears the draft target while the sent message keeps its proof label',
  )

  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.insertText(' -- live guidance')
  await focus('first')
  await composer.fill('Please work on this lemma next.')
  const beforeDirtyGuidance = operations.length
  await page.getByRole('button', { name: 'Send update', exact: true }).click()
  await until(
    async () =>
      (await page.getByRole('alert').allTextContents())
        .join('')
        .includes('Stop the run or discard your unsaved edits'),
    'focused guidance rejects dirty editor locally',
  )
  assert.equal(
    operations.length,
    beforeDirtyGuidance,
    'Dirty focused guidance saved files or reached the run',
  )
  assert.equal(await composer.inputValue(), 'Please work on this lemma next.')
  assert((await target.innerText()).includes('first'))
  // Explicitly discard the fixture's unsaved edit by reloading; persisted chat
  // target/text remain, and re-focusing captures the saved source again.
  page.once('dialog', (dialog) => dialog.accept())
  await page.reload()
  await until(
    async () =>
      (await composer.inputValue()) === 'Please work on this lemma next.',
    'focused draft remains after discarding unsaved editor changes',
  )
  await focus('first')
  let receipt
  state.onMessage = async ({ run, body, respond }) => {
    operations.push('followup')
    assert.equal(body.proofTarget.name, 'first')
    assert.equal(body.proofTarget.source, selectedSource(body.proofTarget))
    receipt = {
      id: body.id,
      text: body.text,
      proofTarget: body.proofTarget,
      status: 'pending',
      createdAt: '2026-10-13T12:01:00Z',
      messageOffset: run.message.length,
    }
    await emit(run, 'followup', receipt)
    return respond(structuredClone(run))
  }
  await page.getByRole('button', { name: 'Send update', exact: true }).click()
  await until(
    async () =>
      !!receipt &&
      (await target.count()) === 0 &&
      (await composer.inputValue()) === '',
    'focused queued guidance',
  )
  assert.equal(operations.length, beforeDirtyGuidance + 1)
  assert.equal(operations.at(-1), 'followup')
  const followup = page.locator(`[data-followup-id="${receipt.id}"]`)
  assert(
    (await followup.locator('.message-proof-target').innerText()).includes(
      'first · Main.lean:1–2',
    ),
  )
  await emit(created, 'followup', {
    ...receipt,
    status: 'failed',
    error: 'Stopped before delivery.',
  })
  await until(
    async () =>
      (await composer.inputValue()) === 'Please work on this lemma next.' &&
      (await target.count()) === 1,
    'failed guidance restores target and text',
  )
  assert((await target.innerText()).includes('first'))
  report.checks.push(
    'Dirty focused guidance is blocked without saving or contacting the run; clean guidance includes its exact target and label and restores both target and text after failed delivery',
  )
  await page.setViewportSize({ width: 390, height: 550 })
  for (const control of [
    page.getByRole('button', { name: 'Send update', exact: true }),
    page.getByRole('button', { name: 'Stop', exact: true }),
    page.getByRole('button', { name: 'Clear proof target', exact: true }),
  ]) {
    await control.scrollIntoViewIfNeeded()
    await control.click({ trial: true })
    const bounds = await control.boundingBox()
    assert(
      bounds.y >= 0 && bounds.y + bounds.height <= 551,
      'Focused chat control is outside the small viewport',
    )
  }
  report.checks.push(
    'Focused chat keeps Stop, Send update and Clear target reachable at 390×550',
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.screenshot({
    path: path.join(reportDir, 'focused-guidance.png'),
    fullPage: true,
  })
  fixture.assertClean()
  report.passed = true
  console.log(
    `PASS: ${report.checks.length} proof focus chat checks; all APIs mocked`,
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
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
