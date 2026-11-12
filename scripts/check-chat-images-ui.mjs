#!/usr/bin/env node
// Real Markdown/image rendering with isolated APIs; no user data or model calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/chat-images-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const base = `http://127.0.0.1:${server.address().port}`
const projectId = 'chat-images-project'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlAAAAABJRU5ErkJggg==',
  'base64',
)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="200" viewBox="0 0 420 200"><rect width="420" height="200" rx="16" fill="#e9f0ff"/><path d="M30 150 L120 50 L220 130 L360 30" fill="none" stroke="#3159bb" stroke-width="5"/><text x="30" y="185" font-family="sans-serif" font-size="18" fill="#173269">Project figure</text><script>window.__projectImageScript=true</script><image href="https://chat-images.invalid/from-svg.png" width="1" height="1"/></svg>`
const markdown = '# Image guide\n\n![Document diagram](../plots/diagram.svg)\n'
const imageReply = [
  'Here are the project images:',
  '![Project diagram](plots/diagram.svg)',
  '![Tiny image](/workspace/plots/pixel.png)',
  '[![Linked diagram](plots/diagram.svg)](plots/diagram.svg)',
  '![Missing diagram](plots/missing.png)',
  '![External diagram](https://chat-images.invalid/remote.png)',
  '![Other project](/api/projects/another/file-preview?path=secret.png)',
  '<img src="https://chat-images.invalid/raw.png" onerror="window.__projectImageScript=true">',
].join('\n\n')
let fixture
let remoteRequests = 0
let missingAvailable = false
const mediaRequests = []
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'fixture-owner', name: 'Image fixture' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [
      { id: projectId, name: 'Project image fixture', status: 'ready' },
    ],
    files: {
      [projectId]: {
        'Main.lean': 'example : True := by trivial\n',
        'docs/README.md': markdown,
        'plots/diagram.svg': svg,
        'plots/pixel.png': 'PNG fixture',
        'plots/missing.png': 'PNG fixture',
      },
    },
    chats: [{ id: 'image-chat', projectId, title: 'Project figures' }],
    runs: [
      {
        id: 'image-reply',
        projectId,
        chatId: 'image-chat',
        kind: 'agent',
        mode: 'search',
        status: 'running',
        eventCursor: 0,
        liveEdits: true,
        createdAt: '2026-11-13T00:00:00Z',
        prompt: 'Show the project figures.',
        message: imageReply,
      },
    ],
  })
  const { page, report } = fixture
  await page.addInitScript(() => {
    window.__projectImageScript = false
  })
  await page.route('https://chat-images.invalid/**', async (route) => {
    remoteRequests++
    return route.abort('blockedbyclient')
  })
  await page.route(
    `**/api/projects/${projectId}/file-preview?*`,
    async (route) => {
      const url = new URL(route.request().url())
      assert.equal(
        url.searchParams.get('expectedUserId') ||
          route.request().headers()['x-leanflow-user'],
        'fixture-owner',
      )
      const name = url.searchParams.get('path')
      mediaRequests.push(name)
      if (name === 'plots/missing.png' && !missingAvailable)
        return route.fulfill({
          status: 404,
          json: { error: 'Image is not available yet.' },
        })
      if (name === 'plots/diagram.svg')
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: svg,
          headers: {
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cache-Control': 'no-store',
          },
        })
      assert(['plots/pixel.png', 'plots/missing.png'].includes(name))
      return route.fulfill({
        contentType: 'image/png',
        body: png,
        headers: { 'Cache-Control': 'no-store' },
      })
    },
  )
  await fixture.ready()
  await until(
    () => page.evaluate(() => window.__chatFixture.connected('image-reply')),
    'image reply stream connected',
  )
  const reply = page.locator('[data-run-id="image-reply"] .message-body')
  const diagram = reply.getByRole('img', {
    name: 'Project diagram',
    exact: true,
  })
  await diagram.scrollIntoViewIfNeeded()
  await until(
    () =>
      diagram.evaluate((image) => image.complete && image.naturalWidth === 420),
    'SVG rendered in chat',
  )
  await diagram.evaluate((node) => {
    node.dataset.imageIdentity = 'retained-project-image'
  })
  await fixture.emit(fixture.state.runs[0], 'message', {
    text: '\n\nAdditional streamed explanation.',
  })
  await reply
    .getByText('Additional streamed explanation.', { exact: true })
    .waitFor()
  assert.equal(
    await diagram.getAttribute('data-image-identity'),
    'retained-project-image',
    'streaming preserves the existing image node',
  )
  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  assert.equal(
    await diagram.getAttribute('data-image-identity'),
    'retained-project-image',
    'parent UI updates preserve the image node',
  )
  await page
    .getByRole('button', { name: 'Use dark theme', exact: true })
    .click()
  await fixture.emit(fixture.state.runs[0], 'status', { status: 'completed' })
  await until(
    () => diagram.evaluate((node) => !node.closest('.streaming-text')),
    'image reply finishes streaming',
  )
  assert.equal(
    await diagram.getAttribute('data-image-identity'),
    'retained-project-image',
    'completion preserves the decoded image node',
  )
  report.checks.push(
    'Streaming and parent UI updates retain decoded image nodes rather than restarting downloads.',
  )
  const raster = reply.getByRole('img', { name: 'Tiny image', exact: true })
  await raster.scrollIntoViewIfNeeded()
  await until(
    () => raster.evaluate((image) => image.complete && image.naturalWidth > 0),
    'PNG rendered in chat',
  )
  assert.equal(
    await reply.locator('a img').count(),
    1,
    'linked Markdown image retains one normal link',
  )
  assert.equal(await reply.locator('a button').count(), 0)
  report.checks.push(
    'Project SVG and PNG images render inline from account-bound URLs; linked images keep valid keyboard controls.',
  )

  const missing = reply
    .locator('.markdown-project-image')
    .filter({ hasText: 'Missing diagram' })
  await missing.scrollIntoViewIfNeeded()
  await missing
    .getByRole('button', { name: 'Retry image', exact: true })
    .waitFor()
  missingAvailable = true
  await missing
    .getByRole('button', { name: 'Retry image', exact: true })
    .click()
  await until(
    () =>
      missing
        .locator('img')
        .evaluate((image) => image.complete && image.naturalWidth > 0),
    'missing image retries successfully',
  )
  assert.equal(
    await missing
      .getByRole('button', { name: 'Retry image', exact: true })
      .count(),
    0,
  )
  report.checks.push(
    'A failed image has a usable retry and open-file action; retry can display an image created later.',
  )

  await reply
    .getByRole('button', { name: 'Open image plots/diagram.svg', exact: true })
    .first()
    .click()
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes(
        'plots/diagram.svg',
      ),
    'chat image opens project file',
  )
  report.checks.push(
    'Opening a chat image selects the corresponding project file.',
  )
  const docsFolder = page.locator('.folder-toggle[title="docs"]')
  if ((await docsFolder.getAttribute('aria-expanded')) !== 'true')
    await docsFolder.click()
  await page.locator('.file-item[title="docs/README.md"]').click()
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes('docs/README.md'),
    'Markdown file opens',
  )
  const previewMarkdown = page.getByRole('button', {
    name: 'Preview Markdown',
    exact: true,
  })
  await previewMarkdown.waitFor()
  await previewMarkdown.click()
  const document = page.getByRole('region', {
    name: 'Markdown preview',
    exact: true,
  })
  await document.waitFor()
  const documentImage = document.getByRole('img', {
    name: 'Document diagram',
    exact: true,
  })
  await until(
    () =>
      documentImage.evaluate(
        (image) => image.complete && image.naturalWidth === 420,
      ),
    'document relative image rendered',
  )
  report.checks.push(
    'Markdown document images resolve relative paths within the current project.',
  )

  assert.equal(remoteRequests, 0)
  assert.equal(await page.evaluate(() => window.__projectImageScript), false)
  assert.equal(
    await reply.locator('img[src*="another"],script,iframe,[onerror]').count(),
    0,
  )
  assert(
    mediaRequests.every((name) =>
      ['plots/diagram.svg', 'plots/pixel.png', 'plots/missing.png'].includes(
        name,
      ),
    ),
  )
  await reply
    .getByRole('link', { name: 'Image: External diagram', exact: true })
    .waitFor()
  report.checks.push(
    'External/raw/other-project image URLs never load automatically; project SVG images cannot execute scripts or fetch external resources.',
  )

  await diagram.scrollIntoViewIfNeeded()
  await page.screenshot({
    path: path.join(output, 'chat-images-desktop.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await diagram.scrollIntoViewIfNeeded()
  assert(
    await diagram.evaluate(
      (image) => image.getBoundingClientRect().width <= window.innerWidth,
    ),
  )
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  )
  await page.screenshot({
    path: path.join(output, 'chat-images-narrow.png'),
    fullPage: true,
  })
  report.checks.push(
    'Inline images remain bounded and readable on a narrow viewport.',
  )
  fixture.assertClean()
  report.remoteRequests = remoteRequests
  report.passed = true
} catch (error) {
  if (fixture) {
    fixture.report.passed = false
    fixture.report.failure = error.stack || String(error)
    await fixture.page
      .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      .catch(() => {})
  }
  throw error
} finally {
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  JSON.stringify({
    passed: fixture.report.passed,
    checks: fixture.report.checks,
    remoteRequests,
  }),
)
