#!/usr/bin/env node
// Makes two real provider requests in a newly created test project. Verifies
// browser-visible live edits, exposed reasoning, unlimited default, and Undo.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium } from '@playwright/test'
const root = new URL('../', import.meta.url).pathname
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const dataDir = process.env.STUDIO_DATA_DIR || root + '.data'
const reportDir = root + '.runtime/live-agent'
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
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Timed out: ' + label)
}
const project = await api('/api/projects', {
  name: 'Live editing verification',
  preset: 'lean',
})
await until(async () => {
  const p = await api('/api/projects/' + project.id)
  if (p.status === 'preparing') return false
  assert.equal(p.status, 'ready', p.error)
  return p
}, 'project preparation')
const endpoint = `/api/projects/${project.id}/file?path=Main.lean`
const initial = await api(endpoint)
const broken =
  'import Lean\n\ntheorem addition_commutes (a b : Nat) : a + b = b + a := by\n  exact Nat.add_assoc a b 0\n'
await api(endpoint, { content: broken, expectedHash: initial.hash }, 'PUT')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [],
  updates = [],
  nativeSockets = [],
  statuses = []
await page.addInitScript((id) => {
  localStorage.setItem('lemex-project', id)
  localStorage.setItem('lemex-theme', 'dark')
}, project.id)
page.on('pageerror', (error) => errors.push(error.stack))
page.on('websocket', (socket) => {
  if (socket.url().includes('/websocket/')) nativeSockets.push(socket.url())
})
let runId
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
  assert.equal(
    await page.getByLabel('Time limit (optional)').inputValue(),
    'unlimited',
  )
  assert.equal(
    await page.getByRole('checkbox', { name: /Edit files live/ }).isChecked(),
    true,
  )
  await page
    .getByLabel('Instructions for Lemex')
    .fill(
      'Repair the proof in Main.lean, preserving its exact theorem statement and imports. Inspect the diagnostics and goal with the Lean tools before editing, and verify the repaired proof after editing. Explain the fix briefly. For our later chat, remember that I call this task the Aubergine case.',
    )
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/runs'),
  )
  await page.getByRole('button', { name: 'Run Lemex', exact: true }).click()
  const job = await (await started).json()
  runId = job.id
  assert.equal(job.maxSeconds, null)
  assert.equal(job.liveEdits, true)
  console.log('Started unlimited live-edit run', runId)
  let liveSeen = false
  const finished = await until(async () => {
    const current = await api('/api/runs/' + runId)
    if (statuses.at(-1) !== current.status) {
      statuses.push(current.status)
      console.log('Status', current.status)
    }
    const source = await api(endpoint)
    if (source.content !== broken && !liveSeen) {
      const editor = await page.locator('.view-lines').innerText()
      updates.push({ status: current.status, content: source.content, editor })
      if (
        editor.includes('Nat.add_comm') &&
        ['running', 'verifying'].includes(current.status)
      )
        liveSeen = true
    }
    if (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        current.status,
      )
    )
      return current
    return false
  }, 'live Lemex completion')
  assert.equal(finished.status, 'completed', finished.error)
  assert.equal(
    finished.verification?.complete,
    true,
    JSON.stringify(finished.verification),
  )
  assert.equal(finished.verification?.kernelChecked, true)
  assert(
    liveSeen,
    'Expected saved source and open editor to update before completion',
  )
  assert(
    finished.reasoning || finished.reasoningSummary,
    'This provider run did not expose a reasoning trace',
  )
  await page.locator('.reasoning-trace').waitFor({ timeout: 10000 })
  await page.locator('.reasoning-trace summary').click()
  await page.screenshot({
    path: reportDir + '/completed-with-reasoning.png',
    fullPage: true,
  })
  assert.equal(
    nativeSockets.length,
    1,
    'Live updates restarted the Lean connection',
  )
  assert.equal((await api(endpoint)).content.includes('Nat.add_comm'), true)
  // A second real turn checks conversation continuation; a new chat resets it.
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await page
    .getByLabel('Instructions for Lemex')
    .fill(
      'What informal nickname did I give our earlier proof task? Reply in one sentence. Do not edit any project files.',
    )
  const continuedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/runs'),
  )
  await page.getByRole('button', { name: 'Run Lemex', exact: true }).click()
  const continued = await (await continuedResponse).json()
  assert.equal(continued.chatId, job.chatId)
  const continuation = await until(async () => {
    const value = await api('/api/runs/' + continued.id)
    return ['completed', 'failed', 'cancelled'].includes(value.status)
      ? value
      : false
  }, 'continued chat reply')
  assert.equal(continuation.status, 'completed', continuation.error)
  assert.match(continuation.message, /Aubergine/i)
  const chat = await api('/api/chats/' + job.chatId)
  assert.equal(chat.runs.length, 2)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await until(
    async () =>
      (await page.getByLabel('Select chat').inputValue()) !== job.chatId,
    'new chat ID',
  )
  const emptyChatId = await page.getByLabel('Select chat').inputValue()
  assert(emptyChatId)
  assert.equal((await api('/api/chats/' + emptyChatId)).runs.length, 0)
  await page.locator('.assistant-starters').waitFor()
  await page.screenshot({
    path: reportDir + '/new-chat-reset.png',
    fullPage: true,
  })
  await page.getByLabel('Select chat').selectOption(job.chatId)
  await page.getByLabel('Assistant history').selectOption(runId)
  await page
    .getByRole('button', { name: 'Undo agent edits', exact: true })
    .click()
  await until(
    async () => (await api(endpoint)).content === broken,
    'Undo original source',
  )
  const undone = await api('/api/runs/' + runId)
  assert.equal(undone.liveUndone, true)
  await until(
    async () =>
      (await page.locator('.view-lines').innerText()).includes('Nat.add_assoc'),
    'Undo visible in editor',
  )
  assert.equal(nativeSockets.length, 1)
  assert.equal(errors.length, 0, JSON.stringify(errors))
  await fs.writeFile(
    reportDir + '/result.json',
    JSON.stringify(
      {
        projectId: project.id,
        runId,
        statuses,
        liveSeen,
        updates,
        final: finished,
        continuation: {
          id: continuation.id,
          chatId: continuation.chatId,
          message: continuation.message,
        },
        newChatId: emptyChatId,
        undone: { liveUndone: undone.liveUndone, status: undone.status },
        sockets: nativeSockets.length,
        errors,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: Until done default, real reasoning, saved live edits visible before completion, kernel verification, chat continuation/reset, browser Undo, one Lean connection',
  )
} catch (error) {
  if (runId) await api('/api/runs/' + runId + '/stop', {}).catch(() => {})
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
        updates,
        errors,
        failure: error.stack,
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  await browser.close()
}
