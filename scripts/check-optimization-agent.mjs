#!/usr/bin/env node
// One real provider request in a newly created fixture. The five-minute deadline
// belongs to this QA harness; the application request explicitly has no limit.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium } from '@playwright/test'

const root = new URL('../', import.meta.url).pathname
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const dataDir = process.env.STUDIO_DATA_DIR || root + '.data'
const reportDir = root + '.runtime/optimization-agent'
await fs.mkdir(reportDir, { recursive: true })
const token = (await fs.readFile(dataDir + '/auth/owner.token', 'utf8')).trim()
async function api(
  endpoint,
  body,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.json()
  assert(response.ok, `${response.status}: ${value.error}`)
  return value
}
async function until(check, label, timeout = 300000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Timed out: ' + label)
}

const session = await api('/api/session')
// Reopen only this harness's recorded fixture after a browser assertion failure,
// without submitting another provider turn or rewriting the saved candidate.
const prior = process.argv.includes('--resume')
  ? JSON.parse(await fs.readFile(reportDir + '/failure.json', 'utf8'))
  : null
const resumed = prior?.runId ? await api('/api/runs/' + prior.runId) : null
if (prior) {
  assert(resumed && resumed.status === 'completed')
  assert.equal(resumed.projectId, prior.projectId)
  assert.equal(resumed.mode, 'optimize')
}
const project = resumed
  ? await api('/api/projects/' + resumed.projectId)
  : await api('/api/projects', {
      name: 'Optimization agent verification',
      preset: 'lean',
    })
assert.equal(project.name, 'Optimization agent verification')
await until(async () => {
  const value = await api('/api/projects/' + project.id)
  if (value.status === 'preparing') return false
  assert.equal(value.status, 'ready', value.error)
  return value
}, 'project preparation')
const endpoint = `/api/projects/${project.id}/file?path=Main.lean`
const initial = await api(endpoint)
const statement = 'theorem addition_commutes (a b : Nat) : a + b = b + a :='
const original = `import Lean\n\n${statement} by\n  have h : a + b = b + a := Nat.add_comm a b\n  exact h\n`
if (!resumed)
  await api(endpoint, { content: original, expectedHash: initial.hash }, 'PUT')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 } })
const errors = [],
  statuses = prior?.statuses || [],
  observations = prior?.observations || []
page.on('pageerror', (error) => errors.push(error.stack))
await page.addInitScript(
  ({ id, chatId }) => {
    localStorage.setItem('lemex-project', id)
    if (chatId) localStorage.setItem('lemex-chat-' + id, chatId)
    localStorage.setItem('lemex-theme', 'dark')
    localStorage.setItem('lemex-layout-assistant', '600')
  },
  { id: project.id, chatId: resumed?.chatId },
)
let runId, finished
try {
  await page.goto(base)
  await page.getByLabel('Access token').fill(token)
  await page
    .getByRole('button', { name: 'Open workspace', exact: true })
    .click()
  await page.locator('.monaco-editor').waitFor({ timeout: 60000 })
  await page
    .locator('.editor-loading')
    .waitFor({ state: 'hidden', timeout: 60000 })
  await page.getByRole('button', { name: 'Optimize', exact: true }).click()
  await page.locator('.chat-options > summary').click()
  assert.equal(
    await page.getByLabel('Model', { exact: true }).inputValue(),
    session.defaultModel,
  )
  assert.equal(await page.getByLabel('Time limit (optional)').count(), 0)
  assert.equal(
    await page.getByRole('checkbox', { name: /Edit files live/ }).isChecked(),
    true,
  )
  let job = resumed
  if (!job) {
    await page
      .getByLabel('Message Lemex')
      .fill(
        'Optimize the proof body of addition_commutes in Main.lean. Preserve its exact theorem statement and imports. Replace the verbose have/ exact sequence with the shorter proof body `by\n  exact Nat.add_comm a b`. Check the resulting proof with Lean. This is a small focused change; do not change any other file. Report the result briefly. The final independent measurements will report both proof tokens and heartbeats honestly, including any heartbeat regression.',
      )
    const started = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/runs'),
    )
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    job = await (await started).json()
  }
  runId = job.id
  assert.equal(job.mode, 'optimize')
  assert.equal(job.model, session.defaultModel)
  assert.equal(job.maxSeconds, null)
  assert.equal(job.liveEdits, true)
  console.log(
    resumed
      ? 'Rechecking completed optimization run'
      : 'Started unlimited optimization run',
    runId,
  )
  finished = await until(async () => {
    const value = await api('/api/runs/' + runId)
    if (statuses.at(-1) !== value.status) {
      statuses.push(value.status)
      console.log('Status', value.status)
    }
    const observation = {
      status: value.status,
      baseline: !!value.optimization?.baseline,
      candidate: !!value.optimization?.candidate,
      kernelChecked: value.verification?.kernelChecked === true,
    }
    if (JSON.stringify(observations.at(-1)) !== JSON.stringify(observation))
      observations.push(observation)
    return ['completed', 'failed', 'cancelled', 'interrupted'].includes(
      value.status,
    )
      ? value
      : false
  }, 'optimized proof completion')
  assert.equal(finished.status, 'completed', finished.error)
  assert.equal(
    finished.verification?.compiled,
    true,
    JSON.stringify(finished.verification),
  )
  assert.equal(
    finished.verification?.complete,
    true,
    JSON.stringify(finished.verification),
  )
  assert.equal(finished.verification?.kernelChecked, true)
  const { baseline, candidate, reductions } = finished.optimization || {}
  for (const measurement of [baseline, candidate]) {
    assert.equal(measurement?.available, true, measurement?.reason)
    assert.equal(measurement?.compiled, true)
    assert(measurement.proofTokens > 0)
    assert(measurement.totalHeartbeatsRaw > 0)
    assert.match(measurement.method, /lean-sync-command-heartbeats/)
  }
  assert(
    candidate.proofTokens < baseline.proofTokens,
    'Expected fewer proof-body tokens',
  )
  assert.equal(
    reductions.proofTokens,
    baseline.proofTokens - candidate.proofTokens,
  )
  assert.equal(
    reductions.heartbeatsRaw,
    baseline.totalHeartbeatsRaw - candidate.totalHeartbeatsRaw,
  )
  assert.equal(
    reductions.heartbeatsPercent,
    ((baseline.totalHeartbeatsRaw - candidate.totalHeartbeatsRaw) /
      baseline.totalHeartbeatsRaw) *
      100,
  )
  const log = finished.log || ''
  const auditStart = log.indexOf(
    'Checking the candidate independently with Lean',
  )
  const measuredStart = log.indexOf(
    'Measuring the independently verified optimized proof',
  )
  assert(auditStart >= 0 && measuredStart > auditStart)
  const auditedOutput = log.slice(auditStart, measuredStart)
  assert.match(
    auditedOutput,
    /"kernelChecked"\s*:\s*true/,
    'Candidate measurement must follow the successful kernel audit output',
  )
  assert.match(auditedOutput, /"complete"\s*:\s*true/)
  const saved = await api(endpoint)
  assert(
    saved.content.includes(statement),
    'The theorem statement must be preserved',
  )
  assert.match(saved.content, /by\s+exact Nat\.add_comm a b\s*$/)
  assert(!saved.content.includes('have h'))
  await until(
    async () =>
      (await page.locator('.view-lines').innerText())
        .replaceAll('\u00a0', ' ')
        .includes('exact Nat.add_comm'),
    'saved candidate visible in editor',
    15000,
  )
  const turn = page.locator(`.conversation-turn[data-run-id="${runId}"]`)
  await turn.locator('.turn-details > summary').click()
  const panel = turn.locator('.optimization-summary')
  await panel.waitFor({ timeout: 15000 })
  await until(
    async () =>
      (await panel.innerText()).includes(String(candidate.proofTokens)),
    'candidate metrics rendered',
    15000,
  )
  const row = (label) =>
    panel.locator('tbody tr').filter({
      has: page.getByRole('rowheader', { name: label, exact: true }),
    })
  assert.deepEqual(await row('Proof tokens').locator('td').allTextContents(), [
    String(baseline.proofTokens),
    String(candidate.proofTokens),
    `${reductions.proofTokensPercent.toFixed(1)}%`,
  ])
  const renderedHeartbeats = (value) =>
    (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })
  assert.deepEqual(await row('Heartbeats').locator('td').allTextContents(), [
    renderedHeartbeats(baseline.totalHeartbeatsRaw),
    renderedHeartbeats(candidate.totalHeartbeatsRaw),
    `${reductions.heartbeatsPercent.toFixed(1)}%`,
  ])
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: reportDir + '/verified-optimization.png',
    fullPage: true,
  })
  assert.equal(errors.length, 0, JSON.stringify(errors))
  await fs.writeFile(
    reportDir + '/result.json',
    JSON.stringify(
      {
        projectId: project.id,
        runId,
        model: job.model,
        maxSeconds: job.maxSeconds,
        liveEdits: job.liveEdits,
        recheckedAfterHarnessFix: !!resumed,
        statuses,
        observations,
        savedSource: saved.content,
        verification: finished.verification,
        optimization: finished.optimization,
        uiMetrics: await panel.innerText(),
        candidateMeasuredAfterKernelAudit: true,
        heartbeatRegression: reductions.heartbeatsRaw < 0,
        errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: One Optimize request, unchanged theorem statement, saved live candidate, complete kernel audit before candidate measurements, genuine before/after costs and signed reductions rendered',
  )
  console.log(
    JSON.stringify({
      projectId: project.id,
      runId,
      tokens: [baseline.proofTokens, candidate.proofTokens],
      heartbeatsRaw: [
        baseline.totalHeartbeatsRaw,
        candidate.totalHeartbeatsRaw,
      ],
      reductions,
    }),
  )
} catch (error) {
  if (
    runId &&
    !['completed', 'failed', 'cancelled', 'interrupted'].includes(
      finished?.status,
    )
  )
    await api('/api/runs/' + runId + '/stop', {}).catch(() => {})
  await page
    .screenshot({ path: reportDir + '/failure.png', fullPage: true })
    .catch(() => {})
  await fs.writeFile(
    reportDir + '/failure.json',
    JSON.stringify(
      {
        projectId: project.id,
        runId,
        statuses,
        observations,
        errors,
        failure: error.stack,
        verification: finished?.verification,
        optimization: finished?.optimization,
        log: finished?.log,
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  await browser.close()
}
