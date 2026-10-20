#!/usr/bin/env node
// Every API, Lean connection and tool result is an isolated fixture.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {
  chatBrowserFixture,
  sleep,
  until,
} from './lib/chat-browser-fixture.mjs'

const output = new URL('../.runtime/chat-readability-ui/', import.meta.url)
await fs.mkdir(output, { recursive: true })
const projectId = 'readable-project',
  chatId = 'readable-chat'
const code =
  '-- Exact source, including Unicode: ∀ n, n = n\n' +
  Array.from(
    { length: 25 },
    (_, i) => `example (n : Nat) : n = n := by rfl -- ${i}`,
  ).join('\n') +
  '\n'
const historical = {
  id: 'historical-tools',
  projectId,
  chatId,
  status: 'completed',
  mode: 'proofs',
  createdAt: '2026-10-20T08:00:00Z',
  prompt: 'Explain reflexivity.',
  message: `Use [the supporting lemma](Proofs/Helper.lean#L3).\n\n\`\`\`lean\n${code}\`\`\`\n\nThe result follows from reflexivity.`,
  toolActivity: [
    {
      id: 'old-check',
      kind: 'check',
      label: 'Check a proof',
      detail: 'helper',
      status: 'completed',
      checkResult: 'passed',
      messageOffset: 0,
      afterFollowups: 0,
      input: 'theorem helper : True := by\n  trivial\n',
      inputLanguage: 'lean',
      inputLabel: 'Candidate declaration',
      output: 'Accepted candidate.',
      path: 'Proofs/Helper.lean',
      line: 3,
    },
  ],
  verification: { complete: true, compiled: true, kernelChecked: true },
  eventCursor: 1,
}
const active = {
  id: 'live-tools',
  projectId,
  chatId,
  status: 'running',
  mode: 'proofs',
  createdAt: '2026-10-20T09:00:00Z',
  prompt: 'Find a shorter proof.',
  message: 'I am checking the candidate.',
  eventCursor: 2,
  toolActivity: Array.from({ length: 6 }, (_, index) => ({
    id: `step-${index}`,
    kind: index === 5 ? 'check' : 'read',
    label: `Fixture work step ${index}`,
    detail: index === 5 ? 'Main.lean' : 'Proofs/Helper.lean',
    status: index === 1 ? 'failed' : index === 5 ? 'running' : 'completed',
    messageOffset: 28,
    afterFollowups: 0,
    input: `request ${index}`,
    output: index === 5 ? undefined : `result ${index}`,
  })),
}
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
      name: 'Readable chat fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.35.0-rc4',
    },
  ],
  files: {
    [projectId]: {
      'Main.lean': 'example : True := by trivial\n',
      'Proofs/Helper.lean':
        '-- Supporting lemma\n\ntheorem helper : True := by trivial\n',
    },
  },
  chats: [{ id: chatId, projectId, title: 'Reflexivity proof' }],
  runs: [historical, active],
})
const { page, browser, report, emit } = fixture
const turn = (run) => page.locator(`[data-run-id="${run.id}"]`)
const step = (index) =>
  turn(active)
    .locator('.tool-step')
    .filter({
      has: page.locator('summary strong', {
        hasText: `Fixture work step ${index}`,
      }),
    })
try {
  await fixture.ready()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'live fixture stream',
  )
  assert.equal(
    await turn(active).locator('.tool-step').count(),
    4,
    'Keep latest steps, active calls and the latest failure visible',
  )
  await step(1).getByText('Needs attention', { exact: true }).waitFor()
  await step(5).getByText('Running', { exact: true }).waitFor()
  assert.equal(await turn(active).locator('.turn-details[open]').count(), 0)
  assert.equal(await turn(active).locator('.turn-outcome').count(), 0)
  await turn(active)
    .getByRole('button', { name: 'Show 2 earlier', exact: true })
    .click()
  assert.equal(await turn(active).locator('.tool-step').count(), 6)
  await step(5).locator('summary').click()
  await step(5)
    .getByText('Waiting for the tool result…', { exact: true })
    .waitFor()
  const completed = {
    ...active.toolActivity[5],
    status: 'completed',
    checkResult: 'passed',
    output: 'Candidate accepted by the tool.',
    durationMs: 1250,
  }
  await emit(active, 'tool-step', completed)
  await step(5).getByText('Check passed', { exact: true }).waitFor()
  assert.notEqual(
    await step(5).getAttribute('open'),
    null,
    'A streamed result must preserve an expanded step',
  )
  await step(5)
    .getByText('This is an intermediate tool check.', { exact: false })
    .waitFor()
  assert.equal(await turn(active).locator('.turn-outcome.passed').count(), 0)
  report.checks.push(
    'Visible work steps preserve running calls and failures; streamed results stay expanded and do not imply final verification',
  )

  const old = turn(historical)
  const oldReads = () =>
    report.requests.filter(
      (request) => request.endpoint === `/api/runs/${historical.id}`,
    ).length
  assert.equal(
    oldReads(),
    0,
    'Saved activity summaries must not fetch full history eagerly',
  )
  await old.locator('.tool-step > summary').click()
  await old.getByRole('heading', { name: 'Candidate declaration' }).waitFor()
  assert.equal(oldReads(), 1)
  assert.equal(
    await old.locator('.tool-step pre').first().textContent(),
    historical.toolActivity[0].input,
  )
  await old.locator('.tool-step > summary').press('Enter')
  await old.locator('.tool-step > summary').press('Enter')
  await old.getByRole('heading', { name: 'Candidate declaration' }).waitFor()
  assert.equal(oldReads(), 1, 'Reopening uses the loaded preview')
  assert.equal(await old.locator('.turn-details[open]').count(), 0)
  report.checks.push(
    'Saved step details load only on request, show Lean source and reuse the loaded preview',
  )

  const block = old.locator('.assistant-message .code-block')
  assert.equal(await block.locator('pre code').textContent(), code)
  assert((await block.locator('.syntax-keyword').count()) > 0)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await block.getByRole('button', { name: 'Copy code', exact: true }).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code)
  await block.getByRole('button', { name: 'Wrap', exact: true }).click()
  assert.equal(
    await block
      .getByRole('button', { name: 'Wrap', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  await block
    .getByRole('button', { name: 'Expand all 26 lines', exact: true })
    .click()
  assert.equal(
    await block.locator('pre').getAttribute('class'),
    'code-expanded',
  )
  await block
    .getByRole('button', { name: 'Collapse code', exact: true })
    .click()
  await old.getByRole('button', { name: 'Copy reply', exact: true }).click()
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    historical.message,
  )
  // Clipboard denials must be visible and recoverable, without unhandled errors.
  await page.evaluate(() => {
    window.__fixtureWriteText = navigator.clipboard.writeText.bind(
      navigator.clipboard,
    )
    navigator.clipboard.writeText = async () => {
      throw new Error('Clipboard denied')
    }
  })
  await block.getByRole('button', { name: /Copy code|Copied/ }).click()
  await block.getByText('Select text to copy', { exact: true }).waitFor()
  await page.evaluate(() => {
    navigator.clipboard.writeText = window.__fixtureWriteText
  })
  await old.getByRole('link', { name: 'the supporting lemma' }).click()
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes('Helper.lean'),
    'file citation navigation',
  )
  assert(
    report.requests.some(
      (request) => request.endpoint === `/api/projects/${projectId}/file`,
    ),
  )
  report.checks.push(
    'Lean code preserves exact copy text, highlights safely, wraps and expands; reply copying and project file links work',
  )

  await emit(active, 'tool-step', {
    id: 'unfinished',
    kind: 'check',
    label: 'Last proof check',
    status: 'running',
    messageOffset: active.message.length,
    afterFollowups: 0,
    input: 'example : True := by trivial',
  })
  await emit(active, 'status', { status: 'cancelled' })
  await turn(active).getByText('No result recorded', { exact: true }).waitFor()
  assert.equal(await turn(active).locator('.turn-outcome.passed').count(), 0)
  await old.getByText('Final Lean check passed', { exact: true }).waitFor()
  report.checks.push(
    'Stopping an unfinished tool reports a missing result; only independent final verification receives the final check badge',
  )

  for (const [width, height] of [
    [1600, 1000],
    [1366, 768],
    [390, 650],
  ]) {
    await page.setViewportSize({ width, height })
    await block.scrollIntoViewIfNeeded()
    await block
      .getByRole('button', { name: 'Wrap', exact: true })
      .click({ trial: true })
    const bounds = await block.boundingBox()
    assert(
      bounds &&
        bounds.width <= width &&
        bounds.x >= -1 &&
        bounds.x + bounds.width <= width + 1,
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    )
    await page.screenshot({
      path: new URL(`dark-${width}.png`, output).pathname,
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  await old.locator('.tool-step > summary').scrollIntoViewIfNeeded()
  await page.screenshot({
    path: new URL('light-desktop.png', output).pathname,
    fullPage: true,
  })
  report.checks.push(
    'Code and work steps remain usable without page overflow on desktop, laptop and phone, in dark and light themes',
  )
  await page.reload()
  await old.locator('.tool-step > summary').click()
  await old.getByRole('heading', { name: 'Candidate declaration' }).waitFor()
  assert.equal(
    await old.locator('.tool-step pre').first().textContent(),
    historical.toolActivity[0].input,
  )
  await sleep(100)
  fixture.assertClean()
  console.log(
    `PASS: ${report.checks.length} chat readability checks; all backends mocked`,
  )
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
