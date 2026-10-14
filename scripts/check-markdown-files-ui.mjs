#!/usr/bin/env node
// File reading, editing, and native scrollbar checks use isolated APIs and Lean.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chatBrowserFixture,
  runReceipt,
  until,
} from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.runtime/markdown-files-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'markdown-files-project'
const markdown = [
  '# Fixture title',
  '',
  'Plain reading paragraph.',
  '',
  '## Fixture subtitle',
  '',
  '- List item with **strong words** and *emphasis*.',
  '[Documentation](https://example.com/documentation)',
  '[Guide file](./Guide.markdown)',
  '[PDF file](./Paper.PDF)',
  '[Missing file](../Outside.md)',
  '',
  '```lean',
  '# Fenced heading',
  '$literal_math$ stays in code.',
  '```',
  '',
  'Inline math: $x^2 + y^2$.',
  '',
  '$$',
  '\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',
  '$$',
  '',
  '<img src="https://fixture.invalid/raw.png" onerror="window.__markdownUnsafe = true">',
  '<script>window.__markdownUnsafe = true</script>',
  '',
  '![Fixture image](https://fixture.invalid/image.png)',
  '[Unsafe link](javascript:alert%28%27unsafe%27%29)',
  '',
].join('\n')
const sources = {
  'Main.lean': 'example : True := by trivial\n',
  'README.md': markdown,
  'Notes.MD': markdown,
  'Guide.markdown': markdown,
  'Reference.MARKDOWN': markdown,
  'Large.md':
    '# Large document\n' +
    ('A readable source paragraph. '.repeat(3) + '\n').repeat(7000),
  'Paper.PDF': '%PDF-1.4\n',
  'Delayed.pdf': '%PDF-1.4\n',
  ...Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [
      `ZFixture${String(i).padStart(3, '0')}.lean`,
      '-- Scrollbar fixture\n',
    ]),
  ),
}
const fixture = await chatBrowserFixture({
  launchOptions: {
    channel: 'chromium',
    ignoreDefaultArgs: ['--hide-scrollbars'],
  },
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [{ id: 'fixture', name: 'Fixture' }],
    defaultModel: 'fixture',
    runtime: { ready: true },
    lemex: { available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'File reading fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: { [projectId]: sources },
  chats: [{ id: 'markdown-files-chat', projectId, title: 'Fixture chat' }],
  runs: [],
})
const { page, state, report, browser } = fixture
const save = page.getByRole('button', { name: 'Save', exact: true })
const editor = () => page.locator('.monaco-editor textarea').first()
const preview = page.getByRole('region', { name: 'Markdown preview' })
const writes = []
const fileReads = []
const remoteRequests = []
const pdfRequests = []
const uploads = []
const terminalSockets = []
let terminalStops = 0
let failPdf = false
let releaseDelayed
let delayedFinished = false
const delayedResponse = new Promise((resolve) => {
  releaseDelayed = resolve
})
const hash = (content) => createHash('sha256').update(content).digest('hex')
const fileButton = (file) =>
  page.locator('.file-item').and(page.getByTitle(file, { exact: true }))
function fixturePdf() {
  const stream = 'BT /F1 14 Tf 72 720 Td (Fixture PDF) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let document = '%PDF-1.4\n%\x80\x81\x82\x83\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, 'latin1'))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(document, 'latin1')
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1))
    document += `${String(offset).padStart(10, '0')} 00000 n \n`
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(document, 'latin1')
}
const pdf = fixturePdf()
await page.route('**/api/projects/*/terminal/stop', async (route) => {
  terminalStops++
  await route.fulfill({ json: { stopped: true } })
})
await page.routeWebSocket('**/websocket/terminal/**', (socket) => {
  terminalSockets.push(socket)
  socket.onMessage(() => {})
  socket.send(Buffer.from('Isolated terminal ready\r\n/workspace $ '))
})
await page.context().addCookies([
  {
    name: 'lemex_web',
    value: 'fixture-only-session',
    url: process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090',
  },
])
await page.addInitScript(() => {
  if (window !== window.top) return
  const create = URL.createObjectURL.bind(URL)
  const revoke = URL.revokeObjectURL.bind(URL)
  window.__filePreviewUrls = { created: [], revoked: [] }
  URL.createObjectURL = (blob) => {
    const url = create(blob)
    window.__filePreviewUrls.created.push({ url, type: blob.type })
    return url
  }
  URL.revokeObjectURL = (url) => {
    window.__filePreviewUrls.revoked.push(url)
    return revoke(url)
  }
})
await page.route('**/api/projects/*/file-preview?*', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  const file = url.searchParams.get('path')
  assert.match(request.headers().cookie || '', /lemex_web=fixture-only-session/)
  assert.equal(url.searchParams.has('token'), false)
  pdfRequests.push(file)
  if (file === 'Delayed.pdf') {
    await delayedResponse
    try {
      await route.fulfill({ contentType: 'application/pdf', body: pdf })
    } catch {
      // Navigation can abort an intercepted response before it is released.
    } finally {
      delayedFinished = true
    }
    return
  }
  if (failPdf)
    return route.fulfill({
      status: 404,
      json: { error: 'Fixture PDF unavailable. Retry after restoring it.' },
    })
  await route.fulfill({ contentType: 'application/pdf', body: pdf })
})
await page.route('**/api/projects/*/upload', async (route) => {
  const input = route.request().postDataJSON()
  uploads.push(input)
  for (const file of input.files)
    state.files[projectId][file.path] = file.content
  await route.fulfill({
    json: {
      applied: input.files.length,
      files: input.files.map((file) => ({ path: file.path })),
    },
  })
})
await page.route('https://fixture.invalid/**', async (route) => {
  remoteRequests.push(route.request().url())
  await route.abort('blockedbyclient')
})
await page.route('**/api/projects/*/file?*', async (route) => {
  const request = route.request()
  const url = new URL(request.url())
  const file = url.searchParams.get('path')
  if (request.method() !== 'PUT') {
    if (request.method() === 'GET') fileReads.push(file)
    return route.fallback()
  }
  const input = request.postDataJSON()
  assert.equal(input.expectedHash, hash(state.files[projectId][file]))
  state.files[projectId][file] = input.content
  writes.push({ path: file, ...input })
  await route.fulfill({
    json: {
      content: input.content,
      hash: hash(input.content),
      requiresPreparation: false,
    },
  })
})

async function openFile(file) {
  await fileButton(file).click()
  await until(
    async () =>
      (await page.locator('.file-toolbar .file-tab').innerText()).includes(
        file,
      ) && !(await page.locator('.file-toolbar .spinner').count()),
    `${file} opened`,
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
}

async function tokenStyle(text) {
  return page.locator('.monaco-editor .view-lines').evaluate((lines, text) => {
    const token = [...lines.querySelectorAll('.view-line span')].find(
      (element) =>
        !element.querySelector('span') &&
        element.textContent.replaceAll('\u00a0', ' ').includes(text),
    )
    if (!token) return null
    const style = getComputedStyle(token)
    return {
      color: style.color,
      weight: style.fontWeight,
      italic: style.fontStyle,
      decoration: style.textDecorationLine,
    }
  }, text)
}

async function highlighting(theme, previousBody) {
  await until(async () => {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      return false
    const body = await tokenStyle('Plain reading paragraph.')
    const title = await tokenStyle('Fixture title')
    const subtitle = await tokenStyle('Fixture subtitle')
    return (
      body &&
      title &&
      subtitle &&
      JSON.stringify(body) !== JSON.stringify(title) &&
      JSON.stringify(body) !== JSON.stringify(subtitle) &&
      (!previousBody || body.color !== previousBody.color)
    )
  }, `${theme} Markdown heading styles`)
  const styles = {
    theme,
    body: await tokenStyle('Plain reading paragraph.'),
    title: await tokenStyle('Fixture title'),
    subtitle: await tokenStyle('Fixture subtitle'),
    fencedHeading: await tokenStyle('Fenced heading'),
  }
  assert(styles.fencedHeading, 'The fenced Markdown fixture is visible')
  assert.notDeepEqual(
    styles.fencedHeading,
    styles.title,
    'A heading marker inside a code fence must use code styling',
  )
  report.highlighting ??= []
  report.highlighting.push(styles)
  return styles
}

async function sidebarWidth() {
  return page
    .locator('.sidebar')
    .evaluate((element) => element.getBoundingClientRect().width)
}

async function nativeScrollbar() {
  const list = page.locator('.sidebar-files-section .file-list')
  const geometry = await list.evaluate((element) => {
    element.scrollTop = 0
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const border = parseFloat(style.borderRightWidth)
    const gutter = element.offsetWidth - element.clientWidth - border
    const samples = []
    const sampleYs = [
      ...[0.1, 0.5, 0.9].map((fraction) => box.top + box.height * fraction),
      ...[0.5, 1.5, 2.5, 3.5].map((offset) => box.bottom - offset),
    ]
    for (let dx = 0.5; dx < gutter; dx++)
      for (const y of sampleYs) {
        const x = box.right - border - dx
        const target = document.elementFromPoint(x, y)
        samples.push({
          x,
          y,
          resizing: !!target?.closest('.resize-handle'),
          target: target?.className,
          handle: target?.closest('.resize-handle')?.getAttribute('aria-label'),
        })
      }
    return {
      sidebar: document
        .querySelector('.sidebar')
        .getBoundingClientRect()
        .toJSON(),
      separator: document
        .querySelector('.sidebar-resize-handle')
        .getBoundingClientRect()
        .toJSON(),
      padding: getComputedStyle(document.querySelector('.sidebar'))
        .paddingRight,
      border: getComputedStyle(document.querySelector('.sidebar'))
        .borderRightWidth,
      list: box.toJSON(),
      x: box.right - border - gutter / 2,
      // Chromium's native scrollbar starts with an arrow button as tall as
      // the gutter; the minimum thumb begins immediately below it.
      y: box.top + gutter + 8,
      height: box.height,
      gutter,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      samples,
    }
  })
  report.scrollbar = geometry
  assert(geometry.scrollHeight > geometry.clientHeight * 3)
  assert(geometry.gutter >= 5, 'Chromium must render a native scrollbar gutter')
  assert(geometry.samples.length >= geometry.gutter * 2)
  assert(
    geometry.samples.every((sample) => !sample.resizing),
    'No part of the scrollbar gutter can activate a resize handle',
  )
  const before = await sidebarWidth()
  await page.evaluate(() => {
    window.__fileScrollbarResized = false
    const observer = new MutationObserver(() => {
      if (document.body.classList.contains('panel-resizing'))
        window.__fileScrollbarResized = true
    })
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    })
    window.__fileScrollbarObserver = observer
  })
  await page.mouse.move(geometry.x, geometry.y)
  await page.mouse.down()
  assert.equal(await page.locator('body.panel-resizing').count(), 0)
  await page.mouse.move(
    geometry.x,
    geometry.y + Math.min(140, geometry.height / 2),
    { steps: 15 },
  )
  await page.mouse.up()
  await until(
    () => list.evaluate((element) => element.scrollTop > 100),
    'native file scrollbar drag',
  )
  assert.equal(await sidebarWidth(), before)
  assert.equal(
    await page.evaluate(() => {
      window.__fileScrollbarObserver.disconnect()
      return window.__fileScrollbarResized
    }),
    false,
  )
  report.checks.push(
    'Every native scrollbar gutter pixel is outside resize handles; dragging scrolls files without resizing the sidebar',
  )
}

async function resizeSidebar() {
  const separator = page.getByRole('separator', {
    name: 'Resize file sidebar',
    exact: true,
  })
  const before = await sidebarWidth()
  const box = await separator.boundingBox()
  assert(box)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  assert.equal(await page.locator('body.panel-resizing').count(), 1)
  await page.mouse.move(x + 70, y, { steps: 10 })
  await page.mouse.up()
  await until(
    async () => (await sidebarWidth()) >= before + 60,
    'sidebar separator drag',
  )
  assert.equal(await page.locator('body.panel-resizing').count(), 0)
  const dragged = await sidebarWidth()
  await separator.focus()
  await page.keyboard.press('ArrowRight')
  await until(
    async () => Math.abs((await sidebarWidth()) - dragged - 10) < 1,
    'keyboard sidebar resize',
  )
  const resized = await sidebarWidth()
  assert.equal(
    Number(
      await page.evaluate(() => localStorage.getItem('lemex-layout-sidebar')),
    ),
    resized,
  )
  await page.reload()
  await page.locator('.monaco-editor').waitFor({ timeout: 60000 })
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  assert(Math.abs((await sidebarWidth()) - resized) < 1)
  report.checks.push(
    'The separate sidebar resize rail still supports mouse and keyboard resizing and restores its saved width after reload',
  )
}

async function markdownFailure() {
  const id = 'markdown-failure-project'
  const fallback = await chatBrowserFixture({
    session: state.session,
    projects: [{ id, name: 'Markdown failure fixture', status: 'ready' }],
    files: {
      [id]: { 'Main.lean': sources['Main.lean'], 'Notes.md': markdown },
    },
    chats: [
      { id: 'markdown-failure-chat', projectId: id, title: 'Fixture chat' },
    ],
    runs: [],
  })
  const blocked = []
  await fallback.page.route('**/assets/index-*.js', async (route) => {
    const response = await route.fetch()
    const prefix = (await response.text()).slice(0, 512)
    if (/name:\s*["']markdown["']/.test(prefix)) {
      blocked.push(route.request().url())
      return route.abort('blockedbyclient')
    }
    return route.fulfill({ response })
  })
  try {
    await fallback.ready()
    assert(blocked.length, 'The Markdown extension module must be blocked')
    const field = fallback.page.locator('.monaco-editor textarea').first()
    await field.focus()
    await fallback.page.keyboard.press('Control+End')
    await fallback.page.keyboard.insertText('-- Lean stays editable\n')
    const fallbackSave = fallback.page.getByRole('button', {
      name: 'Save',
      exact: true,
    })
    await until(
      () => fallbackSave.isEnabled(),
      'Lean editable after Markdown load failure',
    )
    await fallback.page
      .locator('.file-item')
      .and(fallback.page.getByTitle('Notes.md', { exact: true }))
      .click()
    await fallback.page
      .getByRole('dialog', { name: 'Save your changes?' })
      .getByRole('button', { name: 'Discard edits', exact: true })
      .click()
    const notice = fallback.page
      .getByRole('status')
      .filter({ hasText: 'Markdown highlighting could not load' })
    await notice.waitFor()
    assert(
      (await notice.innerText()).includes(
        'Your file is still editable. Reload the page to try again.',
      ),
    )
    await fallback.page.locator('.editor-loading').waitFor({ state: 'hidden' })
    await field.focus()
    await fallback.page.keyboard.press('Control+End')
    await fallback.page.keyboard.insertText(
      'Markdown fallback stays editable.\n',
    )
    await until(
      () => fallbackSave.isEnabled(),
      'Markdown editable without extension',
    )
    assert(
      (await fallback.page.locator('.monaco-editor .view-lines').innerText())
        .replaceAll('\u00a0', ' ')
        .includes('Markdown fallback stays editable.'),
    )
    assert.equal(await fallback.page.locator('.editor-failure').count(), 0)
    assert(
      (await fallback.page.locator('.statusbar').innerText()).includes(
        'Lean connected',
      ),
    )
    fallback.assertClean()
    report.markdownFailure = { blocked, ...fallback.report }
    report.checks.push(
      'A failed Markdown extension load leaves Lean connected and editable, and Markdown remains editable with an actionable nonfatal notice',
    )
  } finally {
    await fallback.browser.close()
  }
}

try {
  await fixture.ready()
  await nativeScrollbar()
  await resizeSidebar()
  for (const file of [
    'README.md',
    'Notes.MD',
    'Guide.markdown',
    'Reference.MARKDOWN',
  ]) {
    await openFile(file)
    await highlighting('dark')
  }
  await openFile('README.md')
  const dark = await highlighting('dark')
  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  await highlighting('light', dark.body)
  await page.screenshot({ path: path.join(output, 'markdown-light.png') })
  await page
    .getByRole('button', { name: 'Use dark theme', exact: true })
    .click()
  await highlighting('dark')
  report.checks.push(
    'All .md/.markdown extension variants highlight titles and subtitles in the ready-project editor, with correct fenced-code styling in both themes',
  )

  const marker = 'Draft survives Markdown preview.\n'
  await editor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(marker)
  await until(() => save.isEnabled(), 'Markdown draft')
  await page
    .getByRole('button', { name: 'Preview Markdown', exact: true })
    .click()
  await preview.waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Edit Markdown', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  assert.equal(
    await preview.getByRole('heading', { level: 1 }).innerText(),
    'Fixture title',
  )
  assert.equal(
    await preview.getByRole('heading', { level: 2 }).innerText(),
    'Fixture subtitle',
  )
  assert.equal(await preview.locator('.katex').count(), 2)
  assert.equal(await preview.locator('.katex-error').count(), 0)
  assert(
    (await preview.locator('pre code').innerText()).includes('$literal_math$'),
  )
  assert.equal(await preview.locator('img, script, iframe').count(), 0)
  assert.equal(await page.evaluate(() => !!window.__markdownUnsafe), false)
  assert.equal(remoteRequests.length, 0)
  const links = await preview
    .locator('a')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('href')),
    )
  assert(links.includes('https://fixture.invalid/image.png'))
  assert(links.every((href) => !/^javascript:/i.test(href || '')))
  assert((await preview.innerText()).includes(marker.trim()))
  assert.equal(await save.isEnabled(), true)
  await page.screenshot({ path: path.join(output, 'markdown-preview.png') })
  const draftNavigation = page.getByRole('dialog', {
    name: 'Save your changes?',
  })
  const readingUrl = page.url()
  for (const name of ['Guide file', 'PDF file']) {
    await preview.getByRole('link', { name, exact: true }).click()
    await draftNavigation.waitFor()
    await draftNavigation
      .getByRole('button', { name: 'Cancel', exact: true })
      .click()
    assert((await preview.innerText()).includes(marker.trim()))
    assert.equal(await save.isEnabled(), true)
    assert.equal(page.url(), readingUrl)
  }
  await preview.getByRole('link', { name: 'Missing file', exact: true }).click()
  await preview.getByRole('alert').waitFor()
  assert(
    (await preview.getByRole('alert').innerText()).includes(
      'This linked file is not in the project',
    ),
  )
  assert.equal(page.url(), readingUrl)
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
  await preview.waitFor({ state: 'hidden' })
  await until(() => tokenStyle(marker.trim()), 'restored Markdown draft')
  assert.equal(await save.isEnabled(), true)
  await save.click()
  await until(() => save.isDisabled(), 'Markdown save')
  assert.equal(state.files[projectId]['README.md'], markdown + marker)
  assert.equal(writes.length, 1)
  report.checks.push(
    'Markdown preview renders headings and LaTeX math safely, keeps code literal and remote images as links, and preserves unsaved edits across preview toggles and Save',
  )

  const secondMarker = 'Second draft stays during navigation.\n'
  await editor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(secondMarker)
  await until(() => save.isEnabled(), 'second Markdown draft')
  await fileButton('Main.lean').click()
  const unsaved = page.getByRole('dialog', { name: 'Save your changes?' })
  await unsaved.waitFor()
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  await until(
    () => tokenStyle(secondMarker.trim()),
    'draft after canceled navigation',
  )
  assert.equal(await save.isEnabled(), true)
  await fileButton('Main.lean').click()
  await unsaved.waitFor()
  await unsaved
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click()
  await until(
    async () =>
      (await page.locator('.file-toolbar .file-tab').innerText()).includes(
        'Main.lean',
      ),
    'Lean file after saving Markdown',
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  assert.equal(
    state.files[projectId]['README.md'],
    markdown + marker + secondMarker,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Preview Markdown', exact: true })
      .count(),
    0,
  )
  assert.equal(
    await page
      .getByRole('button', { name: 'Check Project', exact: true })
      .isEnabled(),
    true,
  )
  assert.equal(
    await page
      .getByRole('region', { name: 'Lean goals and diagnostics' })
      .isVisible(),
    true,
  )
  report.checks.push(
    'Markdown navigation keeps the existing unsaved-edit dialog and conflict-aware saving, then returns to the Lean editor with checks and goals available',
  )

  await openFile('README.md')
  await page
    .getByRole('button', { name: 'Preview Markdown', exact: true })
    .click()
  await preview.getByRole('link', { name: 'Guide file', exact: true }).click()
  await until(
    async () =>
      (await page.locator('.file-toolbar .file-tab').innerText()).includes(
        'Guide.markdown',
      ),
    'relative Markdown file link',
  )
  await openFile('README.md')
  await page
    .getByRole('button', { name: 'Preview Markdown', exact: true })
    .click()
  await preview.getByRole('link', { name: 'PDF file', exact: true }).click()
  await until(
    async () =>
      (await page.locator('.file-toolbar .file-tab').innerText()).includes(
        'Paper.PDF',
      ),
    'relative PDF file link',
  )
  assert.equal(page.url(), readingUrl)
  report.checks.push(
    'Relative Markdown and PDF links open listed project files inside the app, preserve unsaved navigation checks, and show an actionable message for unavailable files',
  )
  const pdfViewer = page.getByRole('region', { name: 'PDF document' })
  const pdfFrame = pdfViewer.locator('iframe[title="PDF preview"]')
  await pdfFrame.waitFor()
  report.pdfBounds = await pdfFrame.boundingBox()
  assert(
    report.pdfBounds &&
      report.pdfBounds.width > 200 &&
      report.pdfBounds.height > 300,
  )
  let pdfUrl = await pdfFrame.getAttribute('src')
  assert.match(pdfUrl, /^blob:/)
  assert.equal(await save.isDisabled(), true)
  assert.equal(await page.locator('.monaco-editor').isVisible(), false)
  assert.equal(fileReads.filter((file) => /\.pdf$/i.test(file)).length, 0)
  assert.equal(
    await pdfViewer
      .getByRole('link', { name: 'Open PDF in new tab', exact: true })
      .getAttribute('rel'),
    'noopener noreferrer',
  )
  const newTabUrl = new URL(
    await pdfViewer
      .getByRole('link', { name: 'Open PDF in new tab', exact: true })
      .getAttribute('href'),
    page.url(),
  )
  assert.equal(newTabUrl.origin, new URL(page.url()).origin)
  assert.equal(newTabUrl.pathname, `/api/projects/${projectId}/file-preview`)
  assert.equal(newTabUrl.searchParams.get('path'), 'Paper.PDF')
  assert.equal(newTabUrl.searchParams.has('token'), false)
  report.checks.push(
    'The PDF new-tab link uses the authenticated same-origin preview endpoint so it remains valid independently of the in-app blob URL',
  )

  const filePolls = () =>
    report.requests.filter(
      (request) =>
        request.method === 'GET' &&
        request.endpoint === `/api/projects/${projectId}/files`,
    ).length
  const pollsBeforeTerminal = filePolls()
  const pdfReadsBeforeTerminal = pdfRequests.length
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const terminal = page.getByRole('region', {
    name: 'Project terminal',
    exact: true,
  })
  await terminal.getByText('Connected', { exact: true }).waitFor()
  await until(
    () => filePolls() >= pollsBeforeTerminal + 3,
    'two terminal file polling intervals',
    10000,
  )
  assert.equal(pdfRequests.length, pdfReadsBeforeTerminal)
  assert.equal(await pdfFrame.getAttribute('src'), pdfUrl)
  assert.equal(
    await page.evaluate(
      (url) => window.__filePreviewUrls.revoked.includes(url),
      pdfUrl,
    ),
    false,
  )
  await pdfViewer
    .getByRole('button', { name: 'Reload PDF', exact: true })
    .click()
  await until(async () => {
    const frameUrl = await pdfFrame.getAttribute('src').catch(() => null)
    return !!frameUrl && frameUrl !== pdfUrl
  }, 'explicit PDF reload')
  assert.equal(pdfRequests.length, pdfReadsBeforeTerminal + 1)
  assert.equal(
    await page.evaluate(
      (url) => window.__filePreviewUrls.revoked.includes(url),
      pdfUrl,
    ),
    true,
  )
  pdfUrl = await pdfFrame.getAttribute('src')
  const pollsBeforeReloadCheck = filePolls()
  await until(
    () => filePolls() >= pollsBeforeReloadCheck + 2,
    'stable PDF after explicit reload during terminal polling',
    10000,
  )
  assert.equal(pdfRequests.length, pdfReadsBeforeTerminal + 1)
  assert.equal(await pdfFrame.getAttribute('src'), pdfUrl)
  assert.equal(
    await page.evaluate(
      (url) => window.__filePreviewUrls.revoked.includes(url),
      pdfUrl,
    ),
    false,
  )
  await terminal
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  await terminal.waitFor({ state: 'hidden' })
  assert.equal(terminalStops, 1)
  report.terminal = {
    connections: terminalSockets.length,
    filePolls: filePolls() - pollsBeforeTerminal,
  }
  report.checks.push(
    'Terminal file polling preserves the active PDF URL and avoids refetching; Reload PDF refreshes once and remains stable through later polls',
  )
  const downloadEvent = page.waitForEvent('download')
  await pdfViewer
    .getByRole('link', { name: 'Download PDF', exact: true })
    .click()
  const download = await downloadEvent
  assert.equal(download.suggestedFilename(), 'Paper.PDF')
  assert.deepEqual(await fs.readFile(await download.path()), pdf)
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(output, 'pdf-preview.png') })
  await openFile('Main.lean')
  await until(
    () =>
      page.evaluate(
        (url) => window.__filePreviewUrls.revoked.includes(url),
        pdfUrl,
      ),
    'PDF object URL revoked after navigation',
  )
  report.checks.push(
    'PDFs open read-only from authenticated binary responses, download without byte changes, and revoke their temporary URL when closed',
  )

  const readsBeforeRetry = pdfRequests.filter(
    (file) => file === 'Paper.PDF',
  ).length
  failPdf = true
  await openFile('Paper.PDF')
  await pdfViewer.getByRole('alert').waitFor()
  assert(
    (await pdfViewer.getByRole('alert').innerText()).includes(
      'Fixture PDF unavailable',
    ),
  )
  assert.equal(await pdfFrame.count(), 0)
  failPdf = false
  await pdfViewer
    .getByRole('button', { name: 'Retry PDF', exact: true })
    .click()
  await pdfFrame.waitFor()
  assert.match(await pdfFrame.getAttribute('src'), /^blob:/)
  assert.equal(
    pdfRequests.filter((file) => file === 'Paper.PDF').length,
    readsBeforeRetry + 2,
  )
  report.checks.push(
    'PDF failures show an actionable error, and Retry PDF loads the same document successfully',
  )

  await openFile('Delayed.pdf')
  await pdfViewer.getByRole('status').waitFor()
  await until(() => pdfRequests.includes('Delayed.pdf'), 'delayed PDF request')
  const createdBefore = await page.evaluate(
    () =>
      window.__filePreviewUrls.created.filter(
        (entry) => entry.type === 'application/pdf',
      ).length,
  )
  await openFile('Main.lean')
  releaseDelayed()
  await until(() => delayedFinished, 'released canceled PDF response')
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  assert.equal(await pdfViewer.count(), 0)
  assert.equal(
    await page.evaluate(
      () =>
        window.__filePreviewUrls.created.filter(
          (entry) => entry.type === 'application/pdf',
        ).length,
    ),
    createdBefore,
  )
  assert.equal(await page.locator('.monaco-editor').isVisible(), true)
  report.checks.push(
    'Leaving a loading PDF cancels the read and a late response cannot replace the current Lean editor or leak an object URL',
  )

  await page.getByRole('button', { name: 'Upload', exact: true }).click()
  const upload = page.getByRole('dialog', { name: 'Add local files' })
  const uploadText = 'Text stays UTF-8: café and α.\n'
  await upload
    .getByLabel('Upload source files', { exact: true })
    .setInputFiles([
      {
        name: 'Uploaded.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(uploadText),
      },
      { name: 'Uploaded.PDF', mimeType: 'application/pdf', buffer: pdf },
    ])
  await upload.getByText('2 files ready', { exact: true }).waitFor()
  await upload.getByRole('button', { name: 'Add files', exact: true }).click()
  await upload.waitFor({ state: 'hidden' })
  assert.equal(uploads.length, 1)
  assert.deepEqual(
    uploads[0].files.find((file) => file.path === 'Uploaded.md'),
    {
      path: 'Uploaded.md',
      content: uploadText,
    },
  )
  const uploadedPdf = uploads[0].files.find(
    (file) => file.path === 'Uploaded.PDF',
  )
  assert.equal(uploadedPdf.encoding, 'base64')
  assert.deepEqual(Buffer.from(uploadedPdf.content, 'base64'), pdf)
  assert.equal(
    state.files[projectId]['Main.lean'],
    'example : True := by trivial\n',
  )
  report.checks.push(
    'Mixed Markdown/PDF uploads preserve UTF-8 text and binary PDF bytes while keeping the existing project sources',
  )

  const followups = []
  const fixtureRun = {
    id: 'reading-large-active-run',
    kind: 'chat',
    projectId,
    chatId: state.chats[0].id,
    file: 'Main.lean',
    mode: 'fix',
    model: 'fixture',
    status: 'running',
    prompt: 'Isolated run for responsive follow-up checks.',
    message: '',
    reasoning: '',
    reasoningSummary: '',
    reasoningBlocks: [],
    log: '',
    followups,
    liveEdits: false,
    createdAt: '2026-10-14T12:00:00Z',
    updatedAt: '2026-10-14T12:00:00Z',
  }
  state.runs.push(fixtureRun)
  state.onMessage = ({ run, body, respond }) => {
    run.followups.push({
      id: body.id,
      text: body.text,
      status: 'queued',
      createdAt: '2026-10-14T12:01:00Z',
    })
    return respond(runReceipt(run), 202)
  }
  const sendUpdate = page.getByRole('button', {
    name: 'Send update',
    exact: true,
  })
  await sendUpdate.waitFor({ timeout: 10000 })
  await openFile('Large.md')
  await page
    .getByRole('button', { name: 'Preview Markdown', exact: true })
    .click()
  await preview.getByRole('status').waitFor()
  assert((await preview.innerText()).includes('512 KiB preview limit'))
  assert.equal(await preview.locator('h1, p, .katex').count(), 0)
  const composer = page.getByRole('textbox', {
    name: 'Message Lemex',
    exact: true,
  })
  await composer.fill(
    'This update stays responsive while reading a large Markdown file.',
  )
  await until(
    () => sendUpdate.isEnabled(),
    'follow-up while large preview is capped',
  )
  await sendUpdate.click()
  await until(
    () =>
      followups.length === 1 &&
      composer.inputValue().then((value) => value === ''),
    'accepted follow-up beside large Markdown preview',
  )
  assert.equal(
    followups[0].text,
    'This update stays responsive while reading a large Markdown file.',
  )
  await page.getByRole('button', { name: 'Edit Markdown', exact: true }).click()
  await until(
    () => tokenStyle('Large document'),
    'large Markdown source stays readable',
  )
  await editor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('Large source stays editable.\n')
  await until(() => save.isEnabled(), 'large Markdown source stays editable')
  await fixture.emit(fixtureRun, 'status', { status: 'completed' })
  report.checks.push(
    'Markdown over 512 KiB shows a bounded preview notice, keeps the source readable and editable, and still accepts follow-ups beside the document',
  )

  await markdownFailure()

  fixture.assertClean()
  report.ok = true
} catch (error) {
  report.failure = error.stack || error.message
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally {
  report.writes = writes
  report.fileReads = fileReads
  report.remoteRequests = remoteRequests
  report.pdfRequests = pdfRequests
  report.uploads = uploads
  releaseDelayed()
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
}
console.log(
  JSON.stringify({ ok: report.ok, checks: report.checks, output }, null, 2),
)
