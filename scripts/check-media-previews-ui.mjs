#!/usr/bin/env node
// Actual media validation/sanitization and browser views with isolated files/APIs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { readMediaPreview, sendMediaPreview } from '../server/media-preview.mjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/media-previews-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const base = `http://127.0.0.1:${server.address().port}`
const projectId = 'media-project',
  otherProject = 'other-media-project'
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="420"><rect width="900" height="420" rx="20" fill="#e7edff"/><circle cx="180" cy="200" r="120" fill="#3158bd"/><text x="360" y="220" font-family="sans-serif" font-size="48" fill="#17346b">Project diagram</text><script>parent.__mediaScript=true</script><image href="https://media-preview.invalid/svg.png" width="1" height="1"/></svg>`
const html = `<!doctype html><html><head><link rel="stylesheet" href="./theme.css"><style>@import 'https://media-preview.invalid/external.css';</style><meta http-equiv="refresh" content="0;url=https://media-preview.invalid/refresh"></head><body onload="parent.__mediaScript=true"><h1>Project HTML preview</h1><p>Local styles and local images render here.</p><img src="./wide.png" alt="Local project figure" width="280"><script>parent.__mediaScript=true;fetch('https://media-preview.invalid/script')</script><iframe src="https://media-preview.invalid/frame"></iframe><form action="https://media-preview.invalid/form"><button>Submit</button></form><a href="javascript:parent.__mediaScript=true">Unsafe link</a><img src="https://media-preview.invalid/tracker.png" alt="External image blocked"></body></html>`
const sources = {
  'Main.lean': 'example : True := by trivial\n',
  'wide.png': 'PNG fixture',
  'photo.jpg': 'JPEG fixture',
  'photo.jpeg': 'JPEG fixture',
  'animation.gif': 'GIF fixture',
  'photo.webp': 'WebP fixture',
  'bitmap.bmp': 'BMP fixture',
  'icon.ico': 'ICO fixture',
  'diagram.svg': svg,
  'document.html': html,
  'theme.css':
    'body{font-family:system-ui,sans-serif;margin:20px} h1{color:rgb(18,52,86)}',
  'retry.png': 'PNG fixture',
  'delayed.png': 'PNG fixture',
}
const binary = new Map()
const report = { passed: false, checks: [], remoteRequests: 0 }
const requests = []
let fixture
let delayedResolve,
  delayedPromise,
  delayNext = false
let saveResolve
let failNext = true

function bmpFixture() {
  const bytes = Buffer.alloc(70)
  bytes.write('BM')
  bytes.writeUInt32LE(70, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(2, 18)
  bytes.writeInt32LE(2, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(16, 34)
  Buffer.from([
    20, 80, 220, 220, 80, 20, 0, 0, 220, 220, 220, 30, 180, 80, 0, 0,
  ]).copy(bytes, 54)
  return bytes
}
function icoFixture(png) {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = 32
  header[7] = 32
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}
const image = () =>
  fixture.page.getByRole('region', { name: 'Image preview', exact: true })
async function select(filename) {
  await fixture.page.locator(`.file-item[title="${filename}"]`).click()
  await until(
    async () =>
      (
        await fixture.page.locator('.file-tab').getAttribute('aria-label')
      ).includes(filename),
    `selected ${filename}`,
  )
}
async function loadedImage(filename) {
  await select(filename)
  const rendered = image().getByRole('img')
  await until(
    () => rendered.evaluate((node) => node.complete && node.naturalWidth > 0),
    `${filename} decodes`,
  )
  return rendered
}
async function capture(name) {
  await fixture.page.screenshot({
    path: path.join(output, `${name}.png`),
    fullPage: true,
  })
}

try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'fixture-owner', name: 'Media fixture' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [
      { id: projectId, name: 'Media preview fixture', status: 'ready' },
      { id: otherProject, name: 'Other image project', status: 'ready' },
    ],
    files: {
      [projectId]: sources,
      [otherProject]: {
        'Main.lean': 'example : 1 = 1 := rfl\n',
        'other.svg': svg.replace('Project diagram', 'Other project'),
      },
    },
    chats: [
      { id: 'media-chat', projectId, title: 'Media fixture' },
      {
        id: 'other-media-chat',
        projectId: otherProject,
        title: 'Other fixture',
      },
    ],
    runs: [],
  })
  const { page, state } = fixture
  const encodings = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 420
    canvas.height = 200
    const context = canvas.getContext('2d')
    context.fillStyle = '#f4e8da'
    context.fillRect(0, 0, 420, 200)
    context.fillStyle = '#825a2d'
    context.fillRect(30, 30, 120, 120)
    const data = Object.fromEntries(
      ['png', 'jpeg', 'webp'].map((type) => [
        type,
        canvas.toDataURL(`image/${type}`).split(',')[1],
      ]),
    )
    canvas.width = 32
    canvas.height = 32
    context.fillStyle = '#3158bd'
    context.fillRect(0, 0, 32, 32)
    return { ...data, icon: canvas.toDataURL('image/png').split(',')[1] }
  })
  binary.set('wide.png', Buffer.from(encodings.png, 'base64'))
  binary.set('photo.jpg', Buffer.from(encodings.jpeg, 'base64'))
  binary.set('photo.jpeg', binary.get('photo.jpg'))
  binary.set('photo.webp', Buffer.from(encodings.webp, 'base64'))
  binary.set(
    'animation.gif',
    Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64',
    ),
  )
  binary.set('bitmap.bmp', bmpFixture())
  binary.set('icon.ico', icoFixture(Buffer.from(encodings.icon, 'base64')))
  binary.set('retry.png', binary.get('wide.png'))
  binary.set('delayed.png', binary.get('wide.png'))
  const workspaces = {
    get(id, actor) {
      assert.equal(actor, 'fixture-owner')
      assert([projectId, otherProject].includes(id))
      return { id }
    },
    async readDownloadFile(id, actor, name, { byteLimit }) {
      this.get(id, actor)
      const value = state.files[id][name]
      if (value === undefined)
        throw Object.assign(new Error('File not found.'), { status: 404 })
      const content =
        id === projectId && binary.has(name)
          ? binary.get(name)
          : Buffer.from(value)
      if (content.length > byteLimit)
        throw Object.assign(new Error('File exceeds limit.'), { status: 413 })
      return { path: name, content }
    },
  }
  await page.addInitScript(() => {
    window.__mediaScript = false
  })
  await page.route('https://media-preview.invalid/**', async (route) => {
    report.remoteRequests++
    return route.abort('blockedbyclient')
  })
  await page.route('**/api/projects/*/file-preview?*', async (route) => {
    const url = new URL(route.request().url()),
      id = url.pathname.split('/')[3],
      name = url.searchParams.get('path')
    assert.equal(
      route.request().headers()['x-leanflow-user'] ||
        url.searchParams.get('expectedUserId'),
      'fixture-owner',
    )
    requests.push({ id, path: name })
    if (name === 'retry.png' && failNext) {
      failNext = false
      return route.fulfill({
        status: 503,
        json: { error: 'Preview temporarily unavailable. Retry the image.' },
      })
    }
    if (name === 'delayed.png' && delayNext) {
      delayNext = false
      await delayedPromise
    }
    try {
      const preview = await readMediaPreview(
        workspaces,
        id,
        'fixture-owner',
        name,
      )
      const headers = {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }
      let body
      sendMediaPreview(
        {
          setHeader(name, value) {
            headers[name] = value
          },
          send(content) {
            body = content
          },
        },
        preview,
      )
      return route.fulfill({ body, headers })
    } catch (error) {
      return route.fulfill({
        status: error.status || 500,
        json: { error: error.message },
      })
    }
  })
  await page.route(`**/api/projects/${projectId}/download?*`, async (route) => {
    const url = new URL(route.request().url())
    assert.equal(route.request().headers()['x-leanflow-user'], 'fixture-owner')
    assert.equal(url.searchParams.get('path'), 'diagram.svg')
    return route.fulfill({
      contentType: 'image/svg+xml',
      body: svg,
      headers: { 'Content-Disposition': 'attachment; filename="diagram.svg"' },
    })
  })
  await fixture.ready()
  for (const filename of [
    'wide.png',
    'photo.jpg',
    'photo.jpeg',
    'animation.gif',
    'photo.webp',
    'bitmap.bmp',
    'icon.ico',
    'diagram.svg',
  ])
    await loadedImage(filename)
  report.checks.push(
    'PNG, JPEG, GIF, WebP, BMP, ICO and SVG files pass actual media validation and decode in the image viewer.',
  )

  await image().getByText('900 × 420', { exact: true }).waitFor()
  await image()
    .getByRole('button', { name: 'Actual size', exact: true })
    .click()
  assert.equal(
    await image()
      .getByRole('button', { name: 'Fit image', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    await image().locator('.image-file-canvas.actual-size').count(),
    1,
  )
  await image().getByRole('button', { name: 'Fit image', exact: true }).click()
  const beforeReload = requests.length
  await image()
    .getByRole('button', { name: 'Reload image', exact: true })
    .click()
  await until(
    () => requests.length > beforeReload,
    'reload fetches fresh image',
  )
  await until(
    () =>
      image()
        .getByRole('img')
        .evaluate((node) => node.complete && node.naturalWidth === 900),
    'reloaded SVG decodes',
  )
  await image()
    .getByRole('button', { name: 'Download image', exact: true })
    .waitFor()
  const downloadReady = page.waitForEvent('download')
  await image()
    .getByRole('button', { name: 'Download image', exact: true })
    .click()
  const download = await downloadReady
  assert.equal(download.suggestedFilename(), 'diagram.svg')
  assert.deepEqual(await fs.readFile(await download.path()), Buffer.from(svg))
  report.checks.push(
    'Image dimensions, fit/actual-size controls, fresh reload and download action remain usable.',
  )

  await select('retry.png')
  await image()
    .getByRole('alert')
    .getByText('Preview temporarily unavailable. Retry the image.', {
      exact: true,
    })
    .waitFor()
  await image()
    .getByRole('button', { name: 'Retry image', exact: true })
    .click()
  await until(
    () =>
      image()
        .getByRole('img')
        .evaluate((node) => node.complete && node.naturalWidth === 420),
    'retry displays image',
  )
  report.checks.push(
    'A failed preview explains the error and can retry successfully without reopening the file.',
  )

  await select('document.html')
  const frame = page.frameLocator('iframe[title="HTML preview"]')
  await frame
    .getByRole('heading', { name: 'Project HTML preview', exact: true })
    .waitFor()
  assert.equal(
    await frame
      .getByRole('heading')
      .evaluate((node) => getComputedStyle(node).color),
    'rgb(18, 52, 86)',
  )
  await until(
    () =>
      frame
        .getByRole('img', { name: 'Local project figure', exact: true })
        .evaluate((node) => node.complete && node.naturalWidth === 420),
    'HTML embedded image decodes',
  )
  assert.equal(
    await page.locator('iframe[title="HTML preview"]').getAttribute('sandbox'),
    '',
  )
  assert.equal(
    await frame
      .locator(
        'script,iframe,form,meta[http-equiv="refresh"],[onload],[onclick]',
      )
      .count(),
    0,
  )
  assert.equal(await page.evaluate(() => window.__mediaScript), false)
  assert.equal(report.remoteRequests, 0)
  await capture('html-dark-desktop')
  report.checks.push(
    'HTML renders local CSS and embedded project images inside an opaque sandbox; scripts, handlers, forms, refresh and external resources stay inactive.',
  )

  await page.getByRole('button', { name: 'Edit HTML', exact: true }).click()
  const editor = page.locator('.monaco-editor textarea').first()
  await editor.waitFor()
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await page
    .getByText('Joining live editing…', { exact: true })
    .waitFor({ state: 'hidden' })
  const changed = html.replace('Project HTML preview', 'Saved HTML change')
  let saveEntered = false
  const saveGate = new Promise((resolve) => {
    saveResolve = resolve
  })
  state.onSave = async ({ save }) => {
    saveEntered = true
    await saveGate
    return save()
  }
  await editor.focus()
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base })
  await page.evaluate(
    (content) => navigator.clipboard.writeText(content),
    changed,
  )
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+v')
  const previewReadsBefore = requests.filter(
    (entry) => entry.path === 'document.html',
  ).length
  await page.getByRole('button', { name: 'Preview HTML', exact: true }).click()
  await until(() => saveEntered, 'HTML save entered before preview')
  assert.equal(
    requests.filter((entry) => entry.path === 'document.html').length,
    previewReadsBefore,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Saving…', exact: true })
      .first()
      .isDisabled(),
    true,
  )
  saveResolve()
  state.onSave = null
  await frame
    .getByRole('heading', { name: 'Saved HTML change', exact: true })
    .waitFor()
  assert.equal(state.files[projectId]['document.html'], changed)
  report.checks.push(
    'Switching edited HTML back to preview waits for durable saving and renders the newly saved source.',
  )

  await loadedImage('diagram.svg')
  await page.getByRole('button', { name: 'Edit SVG', exact: true }).click()
  await editor.waitFor()
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await until(
    async () =>
      (await page.locator('.monaco-editor .view-lines').innerText()).includes(
        'Project',
      ),
    'SVG source replaces the prior editor model',
  )
  await page.getByRole('button', { name: 'Preview SVG', exact: true }).click()
  await image().getByRole('img').waitFor()
  report.checks.push(
    'SVG supports both source editing and image preview without sending binary data through the text editor.',
  )

  for (const theme of ['dark', 'light']) {
    const button = page.getByRole('button', {
      name: theme === 'light' ? 'Use light theme' : 'Use dark theme',
      exact: true,
    })
    if (await button.count()) await button.click()
    await capture(`image-${theme}-desktop`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  const closeAssistant = page.getByRole('button', {
    name: 'Close tools panel',
    exact: true,
  })
  if (await closeAssistant.isVisible()) await closeAssistant.click()
  const rendered = image().getByRole('img')
  await rendered.scrollIntoViewIfNeeded()
  assert(
    await rendered.evaluate(
      (node) => node.getBoundingClientRect().width <= window.innerWidth,
    ),
  )
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  )
  await capture('image-light-narrow')
  await page.setViewportSize({ width: 1600, height: 1000 })
  report.checks.push(
    'Image previews remain bounded in dark/light themes and narrow layouts.',
  )

  delayedPromise = new Promise((resolve) => {
    delayedResolve = resolve
  })
  delayNext = true
  const readsBeforeDelay = requests.length
  await select('delayed.png')
  await until(
    () => requests.length > readsBeforeDelay,
    'delayed image fetch starts',
  )
  await page
    .locator('.project-item')
    .filter({ hasText: 'Other image project' })
    .click()
  await until(
    async () =>
      !(await page.locator('.file-tab').getAttribute('aria-label')).includes(
        'delayed.png',
      ),
    'project switch clears old selected file',
  )
  delayedResolve()
  assert.equal(await image().count(), 0)
  await loadedImage('other.svg')
  assert.equal(
    await page.getByRole('img', { name: 'delayed.png', exact: true }).count(),
    0,
  )
  report.checks.push(
    'A late image response from the previous project cannot revive its preview after switching projects.',
  )

  fixture.assertClean()
  assert.equal(report.remoteRequests, 0)
  report.passed = true
} catch (error) {
  report.failure = error.stack || String(error)
  if (fixture) await capture('failure').catch(() => {})
  throw error
} finally {
  delayedResolve?.()
  saveResolve?.()
  if (fixture) await fixture.browser.close()
  await new Promise((resolve) => server.close(resolve))
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report))
