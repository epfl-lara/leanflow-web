#!/usr/bin/env node
// Read-only browser QA against an existing project. No provider calls or source
// edits are permitted; only this fresh browser context's layout/theme are saved.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { maskLean } from '../server/verification.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const dataDir = process.env.STUDIO_DATA_DIR || path.join(root, '.data')
const token = (await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')).trim()
const reportDir = path.join(root, '.runtime/layout')
await fs.mkdir(reportDir, { recursive: true })
async function api(endpoint) {
  const response = await fetch(base + endpoint, { headers: { Authorization: `Bearer ${token}` } })
  const result = await response.json()
  assert(response.ok, `${response.status}: ${result.error || endpoint}`)
  return result
}
const candidates = (await api('/api/projects')).filter(project => project.status === 'ready' && (!process.env.STUDIO_LAYOUT_PROJECT || project.id === process.env.STUDIO_LAYOUT_PROJECT))
assert(candidates.length, 'Provide STUDIO_LAYOUT_PROJECT for an existing ready proof project')
const fixtureOrder = candidates.sort((a, b) => {
  const score = project => /browser|clean|basic/i.test(project.name) ? 0 : /batteries/i.test(project.name + (project.repository || '')) ? 1 : 2
  return score(a) - score(b)
})
let fixture
for (const project of fixtureOrder) {
  const entries = (await api(`/api/projects/${project.id}/files`)).filter(file => file.path.endsWith('.lean') && file.path !== 'lakefile.lean' && !file.path.startsWith('.lake/'))
  entries.sort((a, b) => Number(b.path === 'Main.lean') - Number(a.path === 'Main.lean'))
  for (const entry of entries.slice(0, 50)) {
    const endpoint = `/api/projects/${project.id}/file?path=${encodeURIComponent(entry.path)}`
    const file = await api(endpoint)
    const lines = maskLean(file.content).split('\n')
    const tactic = lines.findIndex((line, index) => /^\s+(?:exact|rfl|simp(?:_all)?|rw|intro|apply|constructor)\b/.test(line) && lines.slice(Math.max(0, index - 12), index).some(before => /\bby\b/.test(before)))
    if (tactic >= 0) {
      fixture = { project, file: { ...file, path: entry.path }, endpoint, line: tactic + 1, column: lines[tactic].search(/\S/) + 1 }
      break
    }
  }
  if (fixture) break
}
assert(fixture, 'No existing source file with a tactic goal found; choose a clean proof fixture')
const runHost = promisify(execFile)
async function leanWorkers() {
  const docker = process.env.STUDIO_DOCKER || 'docker'
  const listed = await runHost(docker, ['ps', '--filter', 'label=lemex-web.scope=server', '--format', '{{.ID}}'])
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean)
  if (!ids.length) return []
  const { stdout } = await runHost(docker, ['inspect', ...ids])
  const projectRoot = await fs.realpath(path.join(dataDir, 'projects', fixture.project.id))
  return JSON.parse(stdout).filter(worker =>
    worker.Config.Cmd?.join(' ') === 'lake serve --' &&
    worker.Mounts.some(mount => mount.Destination === '/workspace' && mount.Source === projectRoot),
  ).map(worker => worker.Id)
}
const existingWorkers = new Set(await leanWorkers())
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [], consoleErrors = [], failedResponses = [], mutations = [], sockets = [], measurements = []
await page.addInitScript(({ id, file }) => {
  localStorage.setItem('lemex-project', id)
  localStorage.setItem(`lemex-file-${id}`, file)
  if (!localStorage.getItem('lemex-theme')) localStorage.setItem('lemex-theme', 'dark')
}, { id: fixture.project.id, file: fixture.file.path })
await page.route('**/api/**', async route => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  if (!['GET', 'HEAD'].includes(request.method()) && !(request.method() === 'POST' && endpoint === '/api/login')) {
    mutations.push({ method: request.method(), endpoint })
    await route.abort('blockedbyclient')
  } else await route.continue()
})
page.on('pageerror', error => errors.push(error.stack || error.message))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('response', response => {
  if (response.status() >= 400 && !(response.status() === 401 && new URL(response.url()).pathname === '/api/session')) failedResponses.push({ url: response.url(), status: response.status() })
})
page.on('websocket', socket => {
  if (!socket.url().includes('/websocket/')) return
  const record = { url: socket.url(), initialize: [], closed: false }
  sockets.push(record)
  socket.on('close', () => { record.closed = true })
  socket.on('framesent', frame => {
    try {
      const message = JSON.parse(Buffer.isBuffer(frame.payload) ? frame.payload.toString() : frame.payload)
      if (message.method === 'initialize') record.initialize.push({ rootUri: message.params?.rootUri, rootPath: message.params?.rootPath })
    } catch {}
  })
})
const sleep = duration => new Promise(resolve => setTimeout(resolve, duration))
async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(150)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function readyEditor() {
  await page.locator('.monaco-editor').waitFor({ timeout: 60_000 })
  await page.locator('.editor-loading').waitFor({ state: 'hidden', timeout: 60_000 })
  await page.locator('.infoview-host iframe').waitFor({ timeout: 30_000 })
}
async function goalCursor() {
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+g')
  const quickInput = page.locator('.quick-input-widget input')
  if (await quickInput.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) {
    await quickInput.fill(`${fixture.line}:${fixture.column}`)
    await page.keyboard.press('Enter')
  } else {
    // ArrowDown follows visual rows, so persisted narrow panes can make it land
    // after the proof when an earlier source line wraps. Click the visible tactic
    // line instead. Navigation keys and clicks cannot edit the fixture.
    assert(fixture.line < 12, 'Go to Line is unavailable for this larger fixture')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Home')
    const tactic = fixture.file.content.split('\n')[fixture.line - 1].trim()
    const line = page.locator('.monaco-editor .view-line').filter({ hasText: tactic }).first()
    const box = await line.boundingBox()
    assert(box, 'The fixture tactic must be visible')
    await line.click({ position: { x: 2, y: box.height / 2 } })
  }
  await until(async () => (await page.frameLocator('.infoview-host iframe').locator('body').innerText()).includes('⊢'), 'the actual Lean tactic goal', 60_000)
}
async function palette(mode) {
  const outer = await page.locator('.infoview-pane').evaluate(element => getComputedStyle(element).backgroundColor)
  const frame = page.frameLocator('.infoview-host iframe')
  await until(async () => {
    const state = await frame.locator('body').evaluate((body, outerColor) => {
      const rgba = text => {
        const values = text.match(/[\d.]+/g)?.map(Number)
        return values && values.length >= 3 ? [values[0], values[1], values[2], values[3] ?? 1] : [0, 0, 0, 0]
      }
      const blend = (front, back) => [0, 1, 2].map(index => front[index] * front[3] + back[index] * (1 - front[3]))
      const luminance = color => color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      const samples = []
      while (walker.nextNode()) {
        const node = walker.currentNode, element = node.parentElement, text = node.textContent?.trim() || ''
        if (!element || !text || !/⊢|^Nat$|^[ab]$/.test(text) || !element.getClientRects().length) continue
        const ancestors = []
        for (let current = element; current; current = current.parentElement) ancestors.push(current)
        let background = rgba(outerColor).slice(0, 3)
        for (const ancestor of ancestors.reverse()) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background)
        const foreground = blend(rgba(getComputedStyle(element).color), background)
        const bg = luminance(background), fg = luminance(foreground)
        samples.push({ text: text.slice(0, 80), color: getComputedStyle(element).color, background, backgroundLuminance: bg, contrast: (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05) })
      }
      return { bodyColor: getComputedStyle(body).color, bodyBackground: getComputedStyle(body).backgroundColor, samples: samples.slice(0, 40) }
    }, outer)
    const goal = state.samples.find(sample => sample.text.includes('⊢'))
    if (!goal || (mode === 'dark' ? goal.backgroundLuminance >= 0.2 : goal.backgroundLuminance <= 0.6)) return false
    measurements.push({ mode, ...state })
    return true
  }, `${mode} infoview palette`)
  const result = measurements.at(-1)
  assert(result.samples.length, 'No visible goal text was sampled')
  for (const sample of result.samples) assert(sample.contrast >= 4.5, `${mode} infoview text contrast ${sample.contrast.toFixed(2)} is too low for ${sample.text}`)
  return result
}
async function geometry() {
  return page.evaluate(() => {
    const bounds = selector => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`Missing layout pane ${selector}`)
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    return { sidebar: bounds('.sidebar'), assistant: bounds('.tools-panel'), goals: bounds('.infoview-pane'), files: bounds('.sidebar-files-section'), projects: bounds('.sidebar-projects-section') }
  })
}
async function drag(name, axis, delta, pane, dimension) {
  const handle = page.getByRole('separator', { name, exact: true })
  await handle.waitFor()
  assert.equal(await handle.getAttribute('aria-orientation'), axis === 'x' ? 'vertical' : 'horizontal')
  assert.equal(await handle.getAttribute('tabindex'), '0')
  const before = await geometry()
  const box = await handle.boundingBox()
  assert(box && box.width > 0 && box.height > 0, `Resize handle ${name} is hidden`)
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + (axis === 'x' ? delta : 0), y + (axis === 'y' ? delta : 0), { steps: 12 })
  await page.mouse.up()
  await until(async () => Math.abs((await geometry())[pane][dimension] - before[pane][dimension]) >= 30, `dragging ${name}`)
  const after = await geometry()
  return { name, before: before[pane], after: after[pane] }
}
const report = { projectId: fixture.project.id, file: fixture.file.path, tacticPosition: { line: fixture.line, column: fixture.column }, errors, consoleErrors, failedResponses, mutations, sockets, measurements, drags: [] }
try {
  await page.goto(base)
  await page.getByLabel('Access token').fill(token)
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click()
  await readyEditor()
  await goalCursor()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
  await palette('dark')
  await page.screenshot({ path: path.join(reportDir, 'dark-goal.png'), fullPage: true })
  await page.getByRole('button', { name: 'Use light theme', exact: true }).click()
  await palette('light')
  await page.screenshot({ path: path.join(reportDir, 'light-goal.png'), fullPage: true })
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click()
  await palette('dark')
  const order = await page.locator('.sidebar').evaluate(sidebar => {
    const files = sidebar.querySelector('.sidebar-files-section'), projects = sidebar.querySelector('.sidebar-projects-section')
    return !!files && !!projects && Boolean(files.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  assert(order, 'Files must precede Projects in sidebar DOM order')
  report.drags.push(await drag('Resize file sidebar', 'x', 70, 'sidebar', 'width'))
  report.drags.push(await drag('Resize assistant panel', 'x', -70, 'assistant', 'width'))
  report.drags.push(await drag('Resize goals panel', 'x', -50, 'goals', 'width'))
  report.drags.push(await drag('Resize files and projects', 'y', 65, 'files', 'height'))
  await palette('dark')
  const resized = report.resized = await geometry()
  report.savedLayout = await page.evaluate(() => Object.fromEntries(['sidebar', 'assistant', 'goals', 'files'].map(name => [name, localStorage.getItem(`lemex-layout-${name}`)])))
  for (const [name, value] of Object.entries(report.savedLayout)) assert(value !== null && Number.isFinite(Number(value)), `${name} layout size was not persisted`)
  assert.equal(sockets.length, 1, 'Theme toggles or resizing created an extra Lean socket')
  assert.equal(sockets[0].initialize.length, 1, 'Theme toggles or resizing reinitialized the Lean project')
  assert.match(sockets[0].initialize[0].rootUri, /^file:\/\/\/workspace\/?$/)
  const originalWorkers = report.workersBeforeReload = (await leanWorkers()).filter(id => !existingWorkers.has(id))
  assert.equal(originalWorkers.length, 1, 'Expected one actual Lean worker before reload')
  await page.screenshot({ path: path.join(reportDir, 'resized.png'), fullPage: true })
  await page.reload()
  await readyEditor()
  await goalCursor()
  await palette('dark')
  report.reloaded = await geometry()
  for (const [pane, dimension] of [['sidebar', 'width'], ['assistant', 'width'], ['goals', 'width'], ['files', 'height']]) assert(Math.abs(report.reloaded[pane][dimension] - resized[pane][dimension]) <= 3, `${pane} size was not restored on reload`)
  assert.equal(sockets.length, 2, 'Reload must create exactly one additional Lean socket')
  // Playwright can lose the old document's socket close event on navigation.
  // Verify the actual managed server worker was removed and replaced instead.
  await until(async () => {
    report.workersAfterReload = (await leanWorkers()).filter(id => !existingWorkers.has(id))
    return report.workersAfterReload.length === 1 && !report.workersAfterReload.includes(originalWorkers[0])
  }, 'the previous Lean worker to stop after reload')
  assert(sockets.every(socket => socket.initialize.length === 1), 'Lean project reinitialized unexpectedly')
  await page.screenshot({ path: path.join(reportDir, 'reloaded.png'), fullPage: true })
  assert.equal(mutations.length, 0, 'Layout QA attempted a source, project, or assistant mutation')
  assert.equal((await api(fixture.endpoint)).hash, fixture.file.hash, 'The existing source file changed during layout QA')
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.equal(failedResponses.length, 0, JSON.stringify(failedResponses))
  report.passed = true
  console.log('PASS: dark/light goal contrast, Files-first sidebar, four draggable persistent splits, one Lean connection per page load, no source edits or provider requests')
} catch (error) {
  report.passed = false
  report.failure = error.stack || error.message
  await page.screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await fs.writeFile(path.join(reportDir, 'result.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
