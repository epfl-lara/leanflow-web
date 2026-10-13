#!/usr/bin/env node
// Exercise long reasoning traces without providers, Lean, or user projects.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(root, '.runtime/reasoning-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'reasoning-ui-fixture',
  chatId = 'reasoning-chat'
const reasoning = Array.from(
  { length: 160 },
  (_, index) =>
    `Reasoning paragraph ${index}. Inspecting declarations and checking the next proof step.\n\n`,
).join('')
const historical = {
  id: 'historical-reasoning',
  projectId,
  chatId,
  status: 'completed',
  mode: 'repair',
  createdAt: '2026-10-13T08:00:00Z',
  prompt: 'Explain the earlier proof.',
  message: 'The earlier proof is complete.',
  reasoning,
}
const active = {
  ...historical,
  id: 'live-reasoning',
  status: 'running',
  createdAt: '2026-10-13T09:00:00Z',
  prompt: 'Continue checking the proof.',
  message: 'The current proof check continues.',
  reasoningSummary: 'Checking the current proof.',
  eventCursor: 1,
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
      name: 'Reasoning fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: {
    [projectId]: {
      'Main.lean': 'import Lean\n\nexample : True := by trivial\n',
    },
  },
  chats: [{ id: chatId, projectId, title: 'Reasoning controls' }],
  runs: [historical, active],
})
const { page, browser, report, emit } = fixture
const conversation = page.getByRole('region', {
  name: 'Conversation',
  exact: true,
})
const traceFor = (run) =>
  page.locator(`[data-run-id="${run.id}"] .reasoning-trace`)
async function visibleToggle(trace) {
  const bounds = await conversation.boundingBox()
  const toggle = await trace.locator('summary').boundingBox()
  assert(
    toggle &&
      bounds &&
      toggle.y >= bounds.y - 1 &&
      toggle.y + toggle.height <= bounds.y + bounds.height + 1,
    'The collapse control must stay inside the conversation viewport',
  )
  return toggle
}
async function collapsed(trace) {
  await until(
    async () =>
      (await trace.getAttribute('open')) === null &&
      (await trace.locator('.reasoning-content').count()) === 0,
    'collapsed trace body',
  )
  assert(
    await trace
      .locator('summary')
      .evaluate((element) => element === document.activeElement),
    'Collapsing must return keyboard focus to the trace toggle',
  )
  await visibleToggle(trace)
}
async function exercise(run, label) {
  const trace = traceFor(run),
    toggle = trace.locator('summary')
  await toggle.click()
  await trace.locator('.reasoning-content').waitFor()
  // Read far enough that the original header would have scrolled away.
  await conversation.evaluate((element, id) => {
    const trace = element.querySelector(
      `[data-run-id="${id}"] .reasoning-trace`,
    )
    element.scrollTop +=
      trace.getBoundingClientRect().top -
      element.getBoundingClientRect().top +
      1400
  }, run.id)
  await until(async () => {
    const bounds = await conversation.boundingBox(),
      box = await toggle.boundingBox(),
      traceBounds = await trace.boundingBox()
    return (
      box &&
      bounds &&
      traceBounds &&
      traceBounds.y < bounds.y - 1000 &&
      box.y >= bounds.y &&
      box.y + box.height <= bounds.y + bounds.height
    )
  }, 'sticky reasoning toggle while reading')
  if (run === active) {
    await emit(
      active,
      'reasoning',
      '\n\nSTREAMED_REASONING: the next step is ready.',
    )
    await until(
      async () => (await trace.textContent()).includes('STREAMED_REASONING'),
      'live reasoning update',
    )
  }
  const box = await visibleToggle(trace)
  // Click at the visible position: Playwright must not scroll the header back.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await collapsed(trace)
  await toggle.press('Enter')
  await trace.locator('.reasoning-content').waitFor()
  const bottom = trace.getByRole('button', {
    name: 'Hide reasoning trace',
    exact: true,
  })
  await bottom.scrollIntoViewIfNeeded()
  await bottom.focus()
  await bottom.press('Enter')
  await collapsed(trace)
  if (run === active) {
    await emit(active, 'reasoning', '\n\nCOLLAPSED_STREAM_UPDATE')
    await emit(active, 'message', '\n\nThe next checked result is ready.')
    await until(
      async () =>
        (
          await page.locator(`[data-run-id="${run.id}"]`).textContent()
        ).includes('The next checked result'),
      'message after collapse',
    )
    assert.equal(
      await trace.locator('.reasoning-content').count(),
      0,
      'Streaming must not reopen a collapsed trace',
    )
    assert.equal(await trace.getAttribute('open'), null)
  }
  report.checks.push(
    `${label}: sticky toggle, keyboard reopening, bottom collapse, focus and viewport restoration`,
  )
}
try {
  await fixture.ready()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'live fixture stream',
  )
  assert.equal(
    await traceFor(historical).locator('.reasoning-content').count(),
    0,
  )
  const historicalReads = () =>
    report.requests.filter(
      (request) => request.endpoint === `/api/runs/${historical.id}`,
    ).length
  assert.equal(historicalReads(), 0, 'Historical reasoning must load lazily')
  await exercise(historical, 'Completed trace at desktop size')
  assert.equal(historicalReads(), 1, 'Reopening must reuse loaded reasoning')
  await exercise(active, 'Live trace at desktop size')
  await page.setViewportSize({ width: 1366, height: 768 })
  await exercise(active, 'Live trace at laptop size')
  await page.getByLabel('Message Lemex').fill('Continue with the next lemma.')
  assert.equal(
    await page.getByLabel('Message Lemex').inputValue(),
    'Continue with the next lemma.',
  )
  await page.screenshot({
    path: path.join(reportDir, 'collapsed-laptop.png'),
    fullPage: true,
  })
  fixture.assertClean()
  console.log(JSON.stringify({ checks: report.checks }, null, 2))
} catch (error) {
  await page.screenshot({
    path: path.join(reportDir, 'failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
