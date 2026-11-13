#!/usr/bin/env node
// Real Monaco image zones with isolated HTTP/LSP fixtures and no provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/lean-comment-images-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const projectId = 'comment-images-project'
const otherId = 'other-comment-images-project'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlAAAAABJRU5ErkJggg==',
  'base64',
)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180"><rect width="420" height="180" fill="#e9f0ff"/><path d="M20 150L150 30L260 130L390 40" fill="none" stroke="#3159bb" stroke-width="5"/><script>window.__commentImageScript=true</script><image href="https://comment-images.invalid/embedded.png" width="1" height="1"/></svg>`
const source = [
  '/- ![Inline diagram](figures/diagram.svg) -/',
  '-- [Inline pixel](figures/pixel.png)',
  '/- outer /- ![Missing figure](figures/missing.png) -/ comment -/',
  'def marker : String := "-- ![String image](figures/forbidden.png)"',
  '-- ![Remote image](https://comment-images.invalid/remote.png)',
  '-- ![Escape](../private.svg)',
  '-- ![Other project](/api/projects/another/file-preview?path=secret.png)',
  '-- [Lean source](Second.lean)',
  'example : True := by trivial',
  '',
].join('\n')
let fixture
let missingAvailable = false
let remoteRequests = 0
let diagramWidth = 420
const previews = []
const documents = new Map()
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'fixture-owner', name: 'Comment images fixture' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'Comment image fixture', status: 'ready' },
      { id: otherId, name: 'Other image fixture', status: 'ready' },
    ],
    files: {
      [projectId]: {
        'Main.lean': source,
        'notes/Second.lean':
          '/-- ![Relative pixel](../figures/pixel.png) -/\nexample : True := by trivial\n',
        'figures/diagram.svg': svg,
        'figures/pixel.png': 'PNG fixture',
        'figures/missing.png': 'PNG fixture',
      },
      [otherId]: {
        'Main.lean':
          '/- ![Other project figure](figures/other.svg) -/\nexample : True := by trivial\n',
        'figures/other.svg': svg,
      },
    },
    chats: [
      { id: 'images-chat', projectId, title: 'Comment figures' },
      { id: 'other-images-chat', projectId: otherId, title: 'Other figures' },
    ],
    runs: [],
  })
  const { page, state, report } = fixture
  state.onLeanMessage = (message) => {
    if (message.method === 'textDocument/didOpen')
      documents.set(
        message.params.textDocument.uri,
        message.params.textDocument.text,
      )
    if (message.method === 'textDocument/didChange') {
      const change = message.params.contentChanges.at(-1)
      if (!change.range)
        documents.set(message.params.textDocument.uri, change.text)
    }
  }
  await page.addInitScript(() => {
    window.__commentImageScript = false
  })
  await page.route('https://comment-images.invalid/**', (route) => {
    remoteRequests++
    return route.abort('blockedbyclient')
  })
  await page.route('**/api/projects/*/file-preview?*', (route) => {
    const url = new URL(route.request().url())
    assert.equal(
      url.searchParams.get('expectedUserId') ||
        route.request().headers()['x-leanflow-user'],
      'fixture-owner',
    )
    const project = url.pathname.split('/')[3]
    const file = url.searchParams.get('path')
    previews.push({ project, file })
    assert(
      (project === projectId &&
        [
          'figures/diagram.svg',
          'figures/pixel.png',
          'figures/missing.png',
        ].includes(file)) ||
        (project === otherId && file === 'figures/other.svg'),
      `Unexpected image request: ${project}/${file}`,
    )
    if (file === 'figures/missing.png' && !missingAvailable)
      return route.fulfill({
        status: 404,
        json: { error: 'Figure not created yet.' },
      })
    return route.fulfill({
      contentType: file.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
      body: file.endsWith('.svg')
        ? svg.replace('width="420"', `width="${diagramWidth}"`)
        : png,
      headers: {
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'no-store',
      },
    })
  })
  await fixture.ready()
  const zones = page.locator('.lean-comment-image')
  await until(
    () => zones.count().then((count) => count === 3),
    'three comment image previews',
  )
  const image = (alt) => zones.getByRole('img', { name: alt, exact: true })
  const loaded = async (alt) => {
    const node = image(alt)
    await node.scrollIntoViewIfNeeded()
    await until(
      () => node.evaluate((value) => value.complete && value.naturalWidth > 0),
      `${alt} decoded`,
    )
    return node
  }
  // Browser insertion of a multiline string may create separate undo units
  // for the text and its line break. Walk only those observable edit steps.
  const undoTo = async (expected, label) => {
    for (
      let attempt = 0;
      attempt < 6 && documents.get('file:///workspace/Main.lean') !== expected;
      attempt++
    ) {
      const previous = documents.get('file:///workspace/Main.lean')
      await page.keyboard.press('Control+z')
      await until(
        () => documents.get('file:///workspace/Main.lean') !== previous,
        `${label}: undo step ${attempt + 1}`,
        2500,
      )
    }
    assert.equal(documents.get('file:///workspace/Main.lean'), expected, label)
  }
  const diagram = await loaded('Inline diagram')
  await loaded('Inline pixel')
  assert.equal(documents.get('file:///workspace/Main.lean'), source)
  report.checks.push(
    'SVG and PNG references in line, block and nested Lean comments render without changing source.',
  )

  await diagram.evaluate((node) => {
    node.dataset.imageIdentity = 'original-diagram'
  })
  const diagramTop = () =>
    diagram.evaluate((node) =>
      Number.parseFloat(node.closest('.lean-comment-image').style.top),
    )
  const originalTop = await diagramTop()
  assert(Number.isFinite(originalTop))
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.insertText('-- ANCHOR_SHIFT\n')
  await until(
    () =>
      documents.get('file:///workspace/Main.lean') ===
      '-- ANCHOR_SHIFT\n' + source,
    'normal source edit sent to Lean',
  )
  await until(
    async () => (await diagramTop()) > originalTop,
    'image preview follows its comment to the next line',
  )
  assert.equal(
    await diagram.getAttribute('data-image-identity'),
    'original-diagram',
  )
  await undoTo(source, 'source undo')
  await until(
    async () => (await diagramTop()) === originalTop,
    'image anchor restored by undo',
  )
  assert.equal(
    await diagram.getAttribute('data-image-identity'),
    'original-diagram',
  )
  report.checks.push(
    'Typing above a picture and undo keep the image mounted and preserve normal Lean source edits.',
  )

  await zones
    .getByRole('button', { name: 'Hide image Inline diagram', exact: true })
    .click()
  await zones
    .getByRole('button', { name: 'Show image Inline diagram', exact: true })
    .waitFor()
  assert.equal(await diagram.isVisible(), false)
  await zones
    .getByRole('button', { name: 'Show image Inline diagram', exact: true })
    .click()
  await loaded('Inline diagram')
  const missing = zones.filter({ hasText: 'Missing figure' })
  await missing.scrollIntoViewIfNeeded()
  await missing
    .getByRole('button', { name: 'Retry image', exact: true })
    .waitFor()
  missingAvailable = true
  await missing
    .getByRole('button', { name: 'Retry image', exact: true })
    .click()
  await loaded('Missing figure')
  report.checks.push(
    'Comment images collapse and expand, and a missing figure can be retried after creation.',
  )

  const previousRequests = previews.filter(
    ({ file }) => file === 'figures/diagram.svg',
  ).length
  diagramWidth = 460
  await zones
    .getByRole('button', { name: 'Reload image Inline diagram', exact: true })
    .click()
  await until(
    () =>
      diagram.evaluate((node) => node.complete && node.naturalWidth === 460),
    'reloaded figure displays regenerated SVG',
  )
  assert(
    previews.filter(({ file }) => file === 'figures/diagram.svg').length >
      previousRequests,
  )
  report.checks.push(
    'Reload fetches and displays a regenerated figure without changing its Lean comment.',
  )

  await diagram.evaluate((node) => {
    node.dataset.imageIdentity = 'before-removal'
    node.closest(
      '.lean-comment-image',
    ).parentElement.dataset.commentZoneParent = 'fixture'
  })
  const zoneParent = page.locator('[data-comment-zone-parent="fixture"]')
  assert.equal(await zoneParent.getAttribute('aria-hidden'), null)
  const replacement = ''
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Backspace')
  await until(
    () =>
      documents.get('file:///workspace/Main.lean') === replacement &&
      zones.count().then((count) => count === 0),
    'removing image references removes their previews',
  )
  assert.equal(await zoneParent.getAttribute('aria-hidden'), 'true')
  await undoTo(source, 'undo restores the original source')
  await until(
    () =>
      documents.get('file:///workspace/Main.lean') === source &&
      zones.count().then((count) => count === 3),
    'undo restores source and image references',
  )
  await loaded('Inline diagram')
  assert.equal(await diagram.getAttribute('data-image-identity'), null)
  assert.equal(await zoneParent.getAttribute('aria-hidden'), null)
  report.checks.push(
    'Removing all references disposes the previews and restores Monaco accessibility; undo recreates them from unchanged source.',
  )

  await zones
    .getByRole('button', {
      name: 'Open image figures/diagram.svg',
      exact: true,
    })
    .click()
  await page.locator('.image-file-viewer').waitFor()
  await until(
    () => zones.count().then((count) => count === 0),
    'image zones disposed when leaving source',
  )
  const folder = page.locator('.folder-toggle[title="notes"]')
  if ((await folder.getAttribute('aria-expanded')) !== 'true')
    await folder.click()
  await page.locator('.file-item[title="notes/Second.lean"]').click()
  await loaded('Relative pixel')
  assert.equal(await zones.count(), 1)
  assert.equal(await image('Inline diagram').count(), 0)
  report.checks.push(
    'Opening a figure selects its project file; switching sources removes old previews and resolves images relative to the new file.',
  )

  await page.locator('.project-item[title="Other image fixture"]').click()
  await loaded('Other project figure')
  assert.equal(await zones.count(), 1)
  assert.equal(await image('Relative pixel').count(), 0)
  assert.equal(await image('Inline diagram').count(), 0)
  assert(previews.some(({ project }) => project === otherId))
  assert.equal(remoteRequests, 0)
  assert.equal(await page.evaluate(() => window.__commentImageScript), false)
  report.checks.push(
    'Project switches do not reuse old images; strings, external links, escaping paths and nonimage links never trigger image requests.',
  )

  assert(
    await zones.evaluateAll((nodes) =>
      nodes.every((node) => node.getBoundingClientRect().height <= 250),
    ),
  )
  await page.screenshot({ path: path.join(output, 'comment-images.png') })
  fixture.assertClean()
  report.previews = previews
  report.passed = true
} catch (error) {
  if (fixture) {
    fixture.report.passed = false
    fixture.report.failure = error.stack || String(error)
    await fixture.page
      .screenshot({ path: path.join(output, 'failure.png') })
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
  }),
)
