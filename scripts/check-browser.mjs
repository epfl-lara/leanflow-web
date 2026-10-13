#!/usr/bin/env node
// Creates a separate browser fixture unless STUDIO_REVIEW_PROJECT selects the
// isolated candidate created by STUDIO_TEST_REVIEW_ONLY=1 check-application.
import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const root = new URL('../', import.meta.url).pathname
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const token = (
  await fs.readFile(
    (process.env.STUDIO_DATA_DIR || root + '.data') + '/auth/owner.token',
    'utf8',
  )
).trim()
const reportDir = root + '.runtime/browser'
await fs.mkdir(reportDir, { recursive: true })
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
  assert(response.ok, `${response.status} ${value.error}`)
  return value
}
let projectId = process.env.STUDIO_REVIEW_PROJECT
if (!projectId) {
  const project = await api('/api/projects', {
    name: 'Browser verification example',
    preset: 'lean',
  })
  projectId = project.id
  for (let count = 0; count < 60; count++) {
    const value = await api('/api/projects/' + projectId)
    if (value.status !== 'preparing') {
      assert.equal(value.status, 'ready', value.error)
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}
const endpoint = '/api/projects/' + projectId + '/file?path=Main.lean'
const original = await api(endpoint)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [],
  responses = [],
  diagnostics = []
let writes = 0
await page.addInitScript(
  (id) => localStorage.setItem('lemex-project', id),
  projectId,
)
page.on('pageerror', (error) => errors.push(error.stack))
page.on('request', (request) => {
  if (request.method() === 'PUT' && request.url().includes('/file?')) writes++
})
page.on('response', (response) => {
  if (response.status() >= 400)
    responses.push({ url: response.url(), status: response.status() })
})
page.on('websocket', (ws) =>
  ws.on('framereceived', (frame) => {
    try {
      const message = JSON.parse(frame.payload)
      if (message.method === 'textDocument/publishDiagnostics')
        diagnostics.push(message.params)
    } catch {}
  }),
)
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
  await page.screenshot({ path: reportDir + '/desktop.png', fullPage: true })
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n#check DefinitelyMissing\n')
  await page.waitForFunction(
    () => !!document.querySelector('.squiggly-error'),
    undefined,
    { timeout: 30000 },
  )
  assert(
    diagnostics.some((item) => item.diagnostics.some((d) => d.severity === 1)),
    'Live Lean diagnostic did not arrive',
  )
  if (process.env.STUDIO_REVIEW_PROJECT) {
    await page
      .getByRole('button', { name: 'Review changes', exact: true })
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.getByText('Apply is paused for your unsaved edits').waitFor()
    await assert.doesNotReject(async () =>
      assert.equal(
        await dialog
          .getByRole('button', { name: 'Apply changes', exact: true })
          .isEnabled(),
        false,
      ),
    )
    assert.equal(
      (await api(endpoint)).hash,
      original.hash,
      'Review must not autosave dirty source',
    )
    assert.equal(writes, 0)
    await page.screenshot({
      path: reportDir + '/unsaved-review.png',
      fullPage: true,
    })
    await dialog
      .getByRole('button', { name: 'Discard unsaved edits…', exact: true })
      .click()
    await dialog
      .getByRole('button', { name: 'Keep edits', exact: true })
      .click()
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Apply changes', exact: true })
        .isEnabled(),
      false,
    )
    await dialog
      .getByRole('button', { name: 'Discard unsaved edits…', exact: true })
      .click()
    await dialog
      .getByRole('button', { name: 'Discard unsaved edits', exact: true })
      .click()
    await page.waitForFunction(
      () => !document.querySelector('.unsaved-candidate'),
    )
    assert.equal(
      (await api(endpoint)).hash,
      original.hash,
      'Discard must only reset the editor buffer',
    )
    assert.equal(writes, 0)
    await dialog
      .getByRole('button', { name: 'Apply changes', exact: true })
      .click()
    await dialog.waitFor({ state: 'hidden', timeout: 30000 })
    const accepted = await api(endpoint)
    assert.match(accepted.content, /Nat\.add_comm/)
    assert(!accepted.content.includes('DefinitelyMissing'))
    console.log(
      'Dirty Apply pause, keep/discard, no autosave, and successful reviewed acceptance passed',
    )
  } else {
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.dirty-dot'))
    const saved = await api(endpoint)
    assert(saved.content.includes('DefinitelyMissing'))
    await api(
      endpoint,
      { content: original.content, expectedHash: saved.hash },
      'PUT',
    )
    await page.reload()
    await page
      .locator('.editor-loading')
      .waitFor({ state: 'hidden', timeout: 60000 })
  }
  await page
    .getByRole('button', { name: 'Assistant settings', exact: true })
    .click()
  await page.getByRole('dialog').waitFor()
  await page.screenshot({ path: reportDir + '/settings.png', fullPage: true })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.setViewportSize({ width: 430, height: 900 })
  await page.screenshot({ path: reportDir + '/mobile.png', fullPage: true })
  assert.equal(errors.length, 0, JSON.stringify(errors))
  await fs.writeFile(
    reportDir + '/result.json',
    JSON.stringify(
      {
        projectId,
        errors,
        responses,
        diagnostics,
        writes,
        reviewedApply: !!process.env.STUDIO_REVIEW_PROJECT,
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: live Lean diagnostics, editor, settings, desktop/mobile layouts; no browser exceptions',
  )
} finally {
  await browser.close()
}
