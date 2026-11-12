#!/usr/bin/env node
// Real SVG response headers and shipped client; all accounts/files are fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { readMediaPreview, sendMediaPreview } from '../server/media-preview.mjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/svg-preview-security-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'svg-security-project'
const actor = 'svg-security-owner'
const sentinelKey = 'svg-security-fixture'
const sentinelValue = 'FAKE_PRIVATE_VALUE_FOR_SECURITY_CHECK'
const attack = `document.documentElement.setAttribute('data-svg-script-ran','yes');try{const value=localStorage.getItem('${sentinelKey}');document.documentElement.setAttribute('data-svg-stolen',value);fetch('/svg-review-exfiltration?value='+encodeURIComponent(value));if(window.opener)window.opener.__svgReviewEscaped=true}catch(error){document.documentElement.setAttribute('data-svg-storage-error',error.name)}`
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" onload="${attack}"><rect width="320" height="160" fill="#3158bd"/><text x="20" y="85" fill="white" font-family="sans-serif">Isolated SVG preview</text><script><![CDATA[${attack}]]></script><image href="/svg-review-resource?image=1" width="1" height="1"/><style>@import url('/svg-review-resource?css=1');</style></svg>`
const files = {
  'Main.lean': 'example : True := by trivial\n',
  'untrusted.svg': svg,
}
const report = {
  passed: false,
  checks: [],
  previewRequests: [],
  unsafeRequests: [],
}
const workspaces = {
  get(id, user) {
    if (id !== projectId || user !== actor)
      throw Object.assign(new Error('Project not found.'), { status: 404 })
    return { id }
  },
  async readDownloadFile(id, user, filename, { byteLimit }) {
    this.get(id, user)
    if (!Object.hasOwn(files, filename))
      throw Object.assign(new Error('File not found.'), { status: 404 })
    const content = Buffer.from(files[filename])
    assert(content.length <= byteLimit)
    return { content, path: filename }
  },
}
const app = express()
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (req.path.startsWith('/svg-review-')) {
    report.unsafeRequests.push(req.originalUrl)
    res.status(204).end()
    return
  }
  next()
})
app.get('/api/projects/:id/file-preview', async (req, res) => {
  const expected = req.get('X-Leanflow-User') || req.query.expectedUserId
  report.previewRequests.push({ expected, path: req.query.path })
  if (expected !== actor) {
    res.status(403).json({ error: 'The workspace account changed.' })
    return
  }
  try {
    sendMediaPreview(
      res,
      await readMediaPreview(workspaces, req.params.id, actor, req.query.path),
    )
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message })
  }
})
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`
let fixture

try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: actor, name: 'SVG security fixture' },
      templates: [],
      models: [],
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'SVG security fixture', status: 'ready' },
    ],
    files: { [projectId]: files },
    chats: [{ id: 'svg-security-chat', projectId, title: 'Fixture' }],
    runs: [],
  })
  const { page } = fixture
  await page.addInitScript(
    ({ key, value }) => {
      localStorage.setItem(key, value)
      window.__svgReviewEscaped = false
    },
    { key: sentinelKey, value: sentinelValue },
  )
  // Leave the actual binary response and its CSP to the isolated HTTP server.
  await page.route('**/api/projects/*/file-preview?*', (route) =>
    route.continue(),
  )
  await fixture.ready()
  await page.locator('.file-item[title="untrusted.svg"]').click()
  const rendered = page
    .getByRole('region', { name: 'Image preview', exact: true })
    .getByRole('img')
  await until(
    () =>
      rendered.evaluate((image) => image.complete && image.naturalWidth > 0),
    'SVG decodes',
  )
  const source = await rendered.getAttribute('src')
  assert(
    source && !source.startsWith('blob:'),
    'SVG previews retain their protected HTTP endpoint',
  )
  const previewUrl = new URL(source, base)
  assert.equal(previewUrl.origin, base)
  assert.equal(previewUrl.pathname, `/api/projects/${projectId}/file-preview`)
  assert.equal(previewUrl.searchParams.get('expectedUserId'), actor)
  report.checks.push(
    'SVG previews use an account-bound HTTP URL instead of an application-origin Blob URL.',
  )

  const opened = await page.context().newPage()
  const response = await opened.goto(previewUrl.href)
  assert.equal(response.status(), 200)
  const headers = response.headers()
  assert.match(headers['content-security-policy'], /(?:^|;)\s*sandbox(?:;|$)/)
  assert.match(headers['content-security-policy'], /default-src 'none'/)
  assert.equal(headers['x-content-type-options'], 'nosniff')
  await opened.waitForLoadState('load')
  const isolated = await opened.evaluate((key) => {
    let storageError = null
    try {
      localStorage.getItem(key)
    } catch (error) {
      storageError = error.name
    }
    return {
      executed: document.documentElement.hasAttribute('data-svg-script-ran'),
      stolen: document.documentElement.getAttribute('data-svg-stolen'),
      storageError,
    }
  }, sentinelKey)
  assert.deepEqual(isolated, {
    executed: false,
    stolen: null,
    storageError: 'SecurityError',
  })
  report.checks.push(
    'Opening the displayed SVG in another tab retains CSP sandboxing: SVG handlers/scripts stay inactive and application storage is inaccessible.',
  )
  await opened.close()

  await page.getByRole('button', { name: 'Reload image', exact: true }).click()
  await until(
    () =>
      rendered.evaluate((image) => image.complete && image.naturalWidth > 0),
    'SVG reload decodes',
  )
  const refreshed = new URL(await rendered.getAttribute('src'), base)
  assert.equal(refreshed.searchParams.get('expectedUserId'), actor)
  assert.equal(refreshed.protocol, 'http:')
  assert.equal(
    await page.evaluate((key) => localStorage.getItem(key), sentinelKey),
    sentinelValue,
  )
  assert.equal(await page.evaluate(() => window.__svgReviewEscaped), false)
  assert.deepEqual(report.unsafeRequests, [])
  assert(report.previewRequests.length >= 3)
  assert(report.previewRequests.every((request) => request.expected === actor))
  report.checks.push(
    'Reload keeps the protected URL and account binding; untrusted SVG resources never request the network or alter the editor page.',
  )
  fixture.assertClean()
  report.passed = true
} catch (error) {
  report.failure = error.stack || String(error)
  await fixture?.page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report))
