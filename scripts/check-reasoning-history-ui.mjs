#!/usr/bin/env node
// Restore trimmed reasoning through mocked owned history, without live projects.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chatBrowserFixture,
  runTranscript,
  until,
} from './lib/chat-browser-fixture.mjs'
import { reasoningBlocksFromEvents } from '../shared/reasoning-timeline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(root, '.runtime/reasoning-history-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'reasoning-history-fixture',
  chatId = 'reasoning-history-chat'
const earlier =
  'EARLY_STEP: Check the original lemma.\n\n' +
  'x'.repeat(250001) +
  '\n\nEARLY_END: The original check passed.'
const latest = 'LATEST_STEP: Check the next lemma.\n\n' + 'y'.repeat(250001)
const events = [
  { seq: 1, type: 'reasoning', data: { text: earlier } },
  { seq: 2, type: 'message', data: { text: 'The first lemma checks.' } },
  { seq: 3, type: 'reasoning', data: { text: latest } },
  { seq: 4, type: 'message', data: { text: '\n\nThe final lemma checks.' } },
]
const historical = {
  id: 'trimmed-reasoning',
  projectId,
  chatId,
  status: 'completed',
  mode: 'repair',
  createdAt: '2026-10-16T08:00:00Z',
  prompt: 'Check both lemmas.',
  message: 'The first lemma checks.\n\nThe final lemma checks.',
  reasoning: latest.slice(-250000),
  reasoningBaseOffset: earlier.length + latest.length - 250000,
  reasoningTruncated: true,
  reasoningBlocks: reasoningBlocksFromEvents(events),
  reasoningHistoryAvailable: true,
  eventCursor: 4,
}
let liveText = 'LIVE_BEGIN: Inspect the remaining goal.'
const active = {
  id: 'growing-reasoning',
  projectId,
  chatId,
  status: 'running',
  mode: 'repair',
  createdAt: '2026-10-16T09:00:00Z',
  prompt: 'Continue checking.',
  message: '',
  reasoning: liveText,
  reasoningBlocks: reasoningBlocksFromEvents([
    { seq: 10, type: 'reasoning', data: { text: liveText } },
  ]),
  reasoningHistoryAvailable: true,
  eventCursor: 10,
}
const chat = { id: chatId, projectId, title: 'Saved reasoning' }
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
      name: 'Reasoning history fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: {
    [projectId]: {
      'Main.lean': 'import Lean\n\nexample : True := by trivial\n',
    },
  },
  chats: [chat],
  runs: [historical, active],
})
const { page, browser, report } = fixture
const reads = []
let failNext = true
await page.route(`**/api/chats/${chatId}`, (route) =>
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      chat,
      runs: [historical, active].map((run) => ({
        ...runTranscript(run),
        reasoningHistoryAvailable: true,
      })),
    }),
  }),
)
await page.route('**/api/runs/*/reasoning/**', (route) => {
  const url = new URL(route.request().url()),
    offset = Number(url.searchParams.get('offset') || 0)
  reads.push(url.pathname + url.search)
  if (failNext) {
    failNext = false
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Could not load this step. Try opening the trace again.',
      }),
    })
  }
  const isLive = url.pathname.includes(`/${active.id}/`)
  assert(url.pathname.endsWith(isLive ? '/reasoning-10' : '/reasoning-1'))
  const body = isLive ? liveText : earlier
  return route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      reasoning: body.slice(offset, offset + 250000),
      reasoningSummary: '',
      nextOffset: offset + 250000 < body.length ? offset + 250000 : null,
    }),
  })
})
try {
  await fixture.ready()
  const traces = page.locator(
    `[data-run-id="${historical.id}"] .reasoning-trace`,
  )
  assert.equal(await traces.count(), 2)
  assert.equal(reads.length, 0, 'Collapsed historical bodies must stay lazy')
  const first = traces.first()
  await first.locator('summary').click()
  await until(
    async () => (await first.innerText()).includes('Could not load this step'),
    'actionable history error',
  )
  await first.getByRole('button', { name: 'Hide reasoning trace' }).click()
  await first.locator('summary').click()
  await first.locator('.reasoning-content').waitFor()
  assert.match(await first.innerText(), /EARLY_STEP/)
  assert.doesNotMatch(
    await first.innerText(),
    /LATEST_STEP|Earlier reasoning output was trimmed/,
  )
  assert.equal(await traces.last().locator('.reasoning-content').count(), 0)
  await first.getByRole('button', { name: 'Load more reasoning' }).click()
  await until(
    async () => (await first.innerText()).includes('EARLY_END'),
    'remaining reasoning page',
  )
  assert.equal(
    await first.getByRole('button', { name: 'Load more reasoning' }).count(),
    0,
  )
  assert.equal(reads.length, 3)
  assert.match(reads[2], /offset=250000$/)
  await first.getByRole('button', { name: 'Hide reasoning trace' }).click()
  await first.locator('summary').click()
  await first.locator('.reasoning-content').waitFor()
  assert.equal(reads.length, 3, 'Reopening reuses the loaded step')
  await page.reload()
  await page.locator('.monaco-editor').waitFor()
  await until(
    async () => (await traces.count()) === 2,
    'reasoning positions after reload',
  )
  assert.equal(await page.locator('.reasoning-content').count(), 0)
  await first.locator('summary').click()
  await first.locator('.reasoning-content').waitFor()
  assert.match(await first.innerText(), /EARLY_STEP/)
  assert.equal(reads.length, 4)
  await first.getByRole('button', { name: 'Hide reasoning trace' }).click()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'active reasoning stream',
  )
  const live = page.locator(`[data-run-id="${active.id}"] .reasoning-trace`)
  await live.locator('summary').click()
  await until(() => reads.length === 5, 'saved live prefix')
  const delta =
    '\n\n' + 'z'.repeat(500001) + '\n\nLIVE_END: The check completed.'
  liveText += delta
  active.reasoningBaseOffset = liveText.length - 250000
  await fixture.emit(active, 'reasoning', {
    text: delta,
    baseOffset: active.reasoningBaseOffset,
    truncated: true,
  })
  await live.getByRole('button', { name: 'Load more reasoning' }).waitFor()
  for (let page = 0; page < 3; page++)
    await live.getByRole('button', { name: 'Load more reasoning' }).click()
  await until(
    async () => (await live.innerText()).includes('LIVE_END'),
    'growing step history gap',
  )
  assert.match(await live.innerText(), /LIVE_BEGIN/)
  assert.equal(
    await live.getByRole('button', { name: 'Load more reasoning' }).count(),
    0,
  )
  assert.equal(
    (await live.locator('.reasoning-content').innerText()).split('LIVE_END')
      .length,
    2,
    'Live tails must not duplicate saved output',
  )
  await page.screenshot({ path: path.join(reportDir, 'earlier-reasoning.png') })
  fixture.assertClean()
  report.checks.push(
    'Earlier steps remain in order after tail trimming and reload; bodies load lazily, retry failures, paginate, and cache while mounted; growing active steps recover gaps without duplicating live tails',
  )
  await fs.writeFile(
    path.join(reportDir, 'report.json'),
    JSON.stringify({ ...report, reasoningReads: reads }, null, 2),
  )
  console.log(
    JSON.stringify({ ok: true, checks: report.checks, reportDir }, null, 2),
  )
} finally {
  await browser.close()
}
