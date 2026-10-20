#!/usr/bin/env node
// The built client is served in isolation. APIs, compiler jobs and Lean are fixtures.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { isTexInputFile } from '../shared/tex.mjs'
import { fixturePdf } from './lib/pdf-fixture.mjs'
import {
  chatBrowserFixture,
  sleep,
  until,
} from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/tex-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(
  express.static(
    process.env.STUDIO_TEST_DIST || path.join(root, 'client/dist'),
  ),
)
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const projectId = 'tex-ui-project'
const hash = (content) => createHash('sha256').update(content).digest('hex')
const files = {
  'Main.lean': 'example : True := by trivial\n',
  'main.tex':
    '\\documentclass{article}\n\\begin{document}\n\\section{Fixture title}\nPlain document text.\n\\input{chapter}\n\\end{document}\n',
  'chapter.tex': '\\section{Chapter title}\nChapter text.\n',
  'refs.bib':
    '@book{fixture,\n  title = {A bibliography},\n  author = {Fixture}\n}\n',
  'custom.sty': '\\ProvidesPackage{custom}\n\\newcommand{\\fixture}{Fixture}\n',
  'paper/main.tex':
    '\\documentclass{article}\n\\begin{document}Nested paper.\\end{document}\n',
}
let fixture
let build = null
let lastSuccessful = null
const rootBuilds = new Map()
const rootSuccesses = new Map()
const statusRoots = []
let busyAgent = null
let rejectBuilds = 0
let agentOnReject = false
let failStatus = false
let failStatusOnReject = false
let statusAttempts = 0
let buildAttempts = 0
const rootInputs = (rootFile) => {
  const folder = rootFile.slice(0, rootFile.lastIndexOf('/') + 1)
  return Object.fromEntries(
    Object.entries(files).filter(
      ([path]) => path.startsWith(folder) && isTexInputFile(path),
    ),
  )
}
const workspaceRevision = (rootFile) =>
  hash(JSON.stringify(rootInputs(rootFile)))
const active = (job) =>
  job && ['running', 'queued', 'stopping'].includes(job.status)
let workspaceVersion = 0
const builds = []
const writes = []
const uploads = []
let rejectSave = false
let saveBarrier, releaseSave
let heldSaves = 0
let stopped = 0
const pdfRequests = []
const popupPdfRequests = []
const popupErrors = []
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    launchOptions: { channel: 'chromium' },
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'LaTeX reading fixture', status: 'ready' },
    ],
    files: { [projectId]: files },
    chats: [{ id: 'tex-ui-chat', projectId, title: 'TeX checks' }],
    runs: [],
  })
  const { page, report } = fixture
  const base = `http://127.0.0.1:${server.address().port}`
  // The first request of a popup does not pass through page.route. Keep it
  // within this fixture, including any unexpected external destination.
  await page.context().route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    // Chromium's bundled PDF viewer loads local browser resources, not HTTP.
    if (['chrome:', 'chrome-extension:'].includes(url.protocol))
      return route.continue()
    if (url.origin !== base) {
      report.unexpectedRequests.push({
        method: request.method(),
        endpoint: request.url(),
      })
      return route.abort()
    }
    if (
      url.pathname.startsWith(`/api/projects/${projectId}/tex/builds/`) &&
      url.pathname.endsWith('/pdf')
    ) {
      popupPdfRequests.push({
        url: url.href,
        headers: await request.allHeaders(),
      })
      return route.fulfill({
        contentType: 'application/pdf',
        body: fixturePdf(),
      })
    }
    if (url.pathname.startsWith('/api/')) {
      report.unexpectedRequests.push({
        method: request.method(),
        endpoint: url.pathname,
      })
      return route.abort()
    }
    return route.continue()
  })
  await page.route('**/api/projects/*/upload', async (route) => {
    const input = route.request().postDataJSON()
    uploads.push(input)
    for (const file of input.files) files[file.path] = file.content
    workspaceVersion++
    await route.fulfill({
      json: {
        applied: input.files.length,
        files: input.files.map((file) => ({ path: file.path })),
      },
    })
  })
  await page.route('**/api/projects/*/tex**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith('/pdf')) {
      pdfRequests.push(url.pathname)
      return route.fulfill({
        contentType: 'application/pdf',
        body: fixturePdf(),
      })
    }
    if (url.pathname.endsWith('/stop')) {
      stopped++
      const target = url.pathname.includes(`/${busyAgent?.id}/`)
        ? busyAgent
        : build
      target.status = 'cancelled'
      return route.fulfill({ json: target })
    }
    if (request.method() === 'POST') {
      buildAttempts++
      const input = request.postDataJSON()
      assert.equal(input.engine, 'pdflatex')
      assert(Object.hasOwn(files, input.rootFile))
      if (rejectBuilds > 0 || active(busyAgent)) {
        rejectBuilds--
        if (agentOnReject) {
          busyAgent = {
            id: 'hidden-agent-build',
            projectId,
            rootFile: input.rootFile,
            engine: 'pdflatex',
            origin: 'agent',
            status: 'running',
            sourceRevision: 'agent-shadow',
            workspaceRevision: 'agent-shadow',
            diagnostics: [],
            log: 'Lemex candidate compilation.',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          agentOnReject = false
        }
        if (failStatusOnReject) failStatus = true
        return route.fulfill({
          status: 409,
          json: {
            error:
              'Another LaTeX build is using this project. Wait for it to finish or stop it.',
          },
        })
      }
      build = {
        id: `tex-${builds.length + 1}`,
        projectId,
        rootFile: input.rootFile,
        engine: input.engine,
        origin: 'user',
        status: 'running',
        sourceRevision: hash(JSON.stringify(files)),
        workspaceRevision: workspaceRevision(input.rootFile),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        diagnostics: [],
        log: 'Fixture pdfLaTeX compiling saved files.\n',
      }
      builds.push({
        ...build,
        files: structuredClone(rootInputs(input.rootFile)),
        writes: writes.length,
        workspaceVersion,
      })
      rootBuilds.set(input.rootFile, build)
      return route.fulfill({ json: build, status: 202 })
    }
    statusAttempts++
    if (failStatus)
      return route.fulfill({
        status: 503,
        json: { error: 'Fixture status poll unavailable.' },
      })
    const rootFile = url.searchParams.get('rootFile') || 'main.tex'
    statusRoots.push(rootFile)
    return route.fulfill({
      json: {
        available: true,
        engines: ['pdflatex'],
        workspaceRevision: workspaceRevision(rootFile),
        build: rootBuilds.get(rootFile) || null,
        activeBuild: active(busyAgent)
          ? busyAgent
          : active(build)
            ? build
            : null,
        lastSuccessful: rootSuccesses.get(rootFile) || null,
      },
    })
  })
  await page.route('**/api/projects/*/file?*', async (route) => {
    const request = route.request()
    if (request.method() !== 'PUT') return route.fallback()
    const filename = new URL(request.url()).searchParams.get('path')
    const input = request.postDataJSON()
    assert.equal(input.expectedHash, hash(files[filename]))
    if (rejectSave)
      return route.fulfill({
        status: 409,
        json: {
          error: 'Fixture save conflict. Reload the file before building.',
        },
      })
    if (saveBarrier) {
      heldSaves++
      await saveBarrier
    }
    files[filename] = input.content
    workspaceVersion++
    writes.push({ path: filename, content: input.content })
    return route.fulfill({
      json: {
        content: input.content,
        hash: hash(input.content),
        requiresPreparation: false,
      },
    })
  })
  const panel = page.getByRole('region', {
    name: 'LaTeX PDF workspace',
    exact: true,
  })
  const buildButton = panel.getByRole('button', {
    name: 'Build PDF',
    exact: true,
  })
  const optionsButton = panel.getByRole('button', {
    name: 'PDF options',
    exact: true,
  })
  const save = page.getByRole('button', { name: 'Save', exact: true })
  const editor = () => page.locator('.monaco-editor textarea').first()
  const open = async (filename) => {
    const item = page
      .locator('.file-item')
      .and(page.getByTitle(filename, { exact: true }))
    if (!(await item.isVisible())) {
      const folder = filename.split('/').slice(0, -1).join('/')
      if (folder)
        await page
          .getByRole('button', { name: `Expand ${folder}`, exact: true })
          .click()
    }
    await item.click()
    await until(
      async () =>
        (await page.locator('.file-tab').innerText()).includes(filename) &&
        !(await page.locator('.file-toolbar .spinner').count()),
      `open ${filename}`,
    )
    await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  }
  const append = async (text) => {
    await editor().focus()
    await page.keyboard.press(
      process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
    )
    await page.keyboard.insertText(text)
    await until(() => save.isEnabled(), 'edited source buffer')
  }
  const finish = (status, diagnostics = []) => {
    build = {
      ...build,
      status,
      diagnostics,
      updatedAt: new Date().toISOString(),
      ...(status === 'failed'
        ? { error: 'Fixture compiler error. Fix the source and rebuild.' }
        : {}),
    }
    rootBuilds.set(build.rootFile, build)
    if (status === 'completed') {
      build.pdf = {
        url: `/api/projects/${projectId}/tex/builds/${build.id}/pdf`,
        revision: build.id,
        filename: 'main.pdf',
      }
      lastSuccessful = structuredClone(build)
      rootSuccesses.set(build.rootFile, lastSuccessful)
    }
  }
  await fixture.ready()
  await open('main.tex')
  await panel.waitFor()
  await until(() => buildButton.isEnabled(), 'TeX worker availability')
  assert.equal(await optionsButton.getAttribute('aria-expanded'), 'false')
  assert.equal(await panel.getByLabel('LaTeX root document').isVisible(), false)
  await optionsButton.click()
  assert.equal(
    await panel.getByLabel('LaTeX root document').inputValue(),
    'main.tex',
  )
  assert.equal(await panel.getByLabel('Rebuild on save').isChecked(), false)
  assert.equal(await page.locator('.infoview-pane:visible').count(), 0)
  await page.evaluate(() => {
    window.__texEditorRoot = document.querySelector('.lean-workspace')
  })
  await append('\n% Saved before first build.\n')
  await buildButton.click()
  await until(() => builds.length === 1, 'first saved snapshot build')
  assert.equal(builds[0].writes, 1)
  assert(builds[0].files['main.tex'].includes('Saved before first build.'))
  assert.equal(
    await page.evaluate(
      () =>
        window.__texEditorRoot === document.querySelector('.lean-workspace'),
    ),
    true,
  )
  assert.equal(await editor().isEditable(), true)
  const divider = page.getByRole('separator', {
    name: 'Resize LaTeX source and PDF',
    exact: true,
  })
  const before = Number(await divider.getAttribute('aria-valuenow'))
  await divider.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(Number(await divider.getAttribute('aria-valuenow')), before + 2)
  finish('completed', [
    { severity: 'warning', message: 'Fixture warning kept in Options.' },
  ])
  const frame = panel.locator('iframe[title="PDF preview"]')
  await frame.waitFor()
  const firstPdf = await frame.getAttribute('src')
  assert(firstPdf.startsWith('blob:'))
  assert(firstPdf.endsWith('#view=FitH&navpanes=0'))
  await optionsButton.click()
  assert.equal(await optionsButton.getAttribute('aria-expanded'), 'false')
  assert.equal(
    await panel.getByRole('button', { name: 'Reload PDF' }).isVisible(),
    false,
  )
  assert.equal(
    await panel.getByText('Fixture warning kept in Options.').isVisible(),
    false,
  )
  const compactPanel = await panel.boundingBox()
  const compactFrame = await frame.boundingBox()
  assert(
    compactFrame.y - compactPanel.y <= 52,
    'Collapsed controls use one compact row',
  )
  assert(
    compactFrame.height >= compactPanel.height - 52,
    'The PDF receives the remaining panel height',
  )
  await sleep(500)
  await page.screenshot({ path: path.join(output, 'tex-compact.png') })
  await optionsButton.focus()
  await page.keyboard.press('Enter')
  assert.equal(await optionsButton.getAttribute('aria-expanded'), 'true')
  assert.equal(await panel.getByLabel('LaTeX root document').isVisible(), true)
  assert.equal(
    await panel.getByRole('button', { name: 'Reload PDF' }).isVisible(),
    true,
  )
  assert.equal(
    await panel.getByText('Fixture warning kept in Options.').isVisible(),
    true,
  )
  const expandedFrame = await frame.boundingBox()
  assert(
    expandedFrame.height < compactFrame.height - 50,
    'Options collapse restores document space',
  )
  const openPdf = panel.getByRole('link', {
    name: 'Open PDF in new tab',
    exact: true,
  })
  const popupUrl = new URL(await openPdf.getAttribute('href'), page.url())
  assert.equal(popupUrl.origin, base)
  assert.equal(
    popupUrl.pathname,
    `/api/projects/${projectId}/tex/builds/tex-1/pdf`,
  )
  assert.equal(popupUrl.search, '')
  assert.equal(await openPdf.getAttribute('rel'), 'noopener noreferrer')
  await page.context().addCookies([
    {
      name: 'fixture_pdf_session',
      value: 'synthetic-browser-session',
      url: base,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  const mainUrl = page.url()
  const popupPromise = page.waitForEvent('popup')
  await openPdf.click()
  const popup = await popupPromise
  popup.on('pageerror', (error) => popupErrors.push(error.message))
  try {
    await popup.waitForURL(popupUrl.href)
    await popup.waitForLoadState('domcontentloaded')
    await until(async () => {
      for (const pdfFrame of popup.frames()) {
        if (!pdfFrame.url().startsWith('chrome-extension://')) continue
        if (
          await pdfFrame
            .evaluate(
              () =>
                document.querySelector('pdf-viewer')?.loadState_ === 'success',
            )
            .catch(() => false)
        )
          return true
      }
      return false
    }, 'new tab native PDF rendered')
    assert.equal(await popup.evaluate(() => window.opener), null)
    assert.equal(popupPdfRequests.length, 1)
    assert.match(
      popupPdfRequests[0].headers.cookie,
      /fixture_pdf_session=synthetic-browser-session/,
    )
    assert.equal(popupPdfRequests[0].headers.referer, undefined)
    assert.equal(page.url(), mainUrl)
    assert.equal(await frame.getAttribute('src'), firstPdf)
  } finally {
    await popup.close()
    await page.context().clearCookies({ name: 'fixture_pdf_session' })
  }
  assert.equal(await editor().isEditable(), true)
  assert.equal(builds.length, 1)
  assert.equal(writes.length, 1)
  assert.equal(popupErrors.length, 0)
  report.checks.push(
    'Open PDF in new tab renders the same authenticated same-origin document, sends its cookie without exposing a token in the URL, and removes opener/referrer access; closing the new tab preserves the editor, preview and saved source without another build.',
  )
  await page
    .getByRole('button', { name: 'Close tools panel', exact: true })
    .click()
  await page.setViewportSize({ width: 700, height: 900 })
  await sleep(200)
  const narrowPanel = await panel.boundingBox()
  const narrowOptions = await optionsButton.boundingBox()
  assert(narrowOptions.x >= narrowPanel.x)
  assert(
    narrowOptions.x + narrowOptions.width <= narrowPanel.x + narrowPanel.width,
  )
  assert(
    (await frame.boundingBox()).height > 80,
    'Expanded controls leave the PDF usable on narrow screens',
  )
  await optionsButton.click()
  const narrowFrame = await frame.boundingBox()
  assert(
    narrowFrame.y - narrowPanel.y <= 52,
    'Narrow screens also use one collapsed row',
  )
  assert(narrowFrame.height >= narrowPanel.height - 52)
  await page.screenshot({ path: path.join(output, 'tex-compact-narrow.png') })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.getByRole('button', { name: 'Lemex', exact: true }).click()
  await page.setViewportSize({ width: 1001, height: 1000 })
  await until(
    async () =>
      (await divider.getAttribute('aria-orientation')) === 'horizontal',
    'narrow workbench stacks the PDF',
  )
  for (const orientation of ['horizontal', 'vertical', 'horizontal']) {
    if (orientation === 'vertical')
      await page
        .getByRole('button', { name: 'Close tools panel', exact: true })
        .click()
    else if ((await divider.getAttribute('aria-orientation')) === 'vertical')
      await page.getByRole('button', { name: 'Lemex', exact: true }).click()
    await until(
      async () =>
        (await divider.getAttribute('aria-orientation')) === orientation,
      `available-width ${orientation} split`,
    )
    const source = await page.locator('.lean-workspace').boundingBox()
    const preview = await panel.boundingBox()
    if (orientation === 'horizontal') {
      assert(source.y + source.height <= preview.y)
      assert(Math.abs(source.width - preview.width) < 2)
      assert(
        preview.width > 350,
        'A cramped workbench gives the PDF its full width',
      )
    } else assert(source.x + source.width <= preview.x)
    const workspace = await page
      .locator('.file-reading-workspace')
      .boundingBox()
    const handle = await divider.boundingBox()
    const value = Number(await divider.getAttribute('aria-valuenow'))
    const stacked = orientation === 'horizontal'
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + (stacked ? 0 : 30), y + (stacked ? 30 : 0))
    await page.mouse.up()
    const expected =
      value + 3000 / (stacked ? workspace.height : workspace.width)
    assert(
      Math.abs(Number(await divider.getAttribute('aria-valuenow')) - expected) <
        1.1,
      'The divider uses the visible axis and workspace dimensions',
    )
    await divider.dblclick()
  }
  assert.equal(await page.locator('.monaco-editor').count(), 1)
  await page.screenshot({
    path: path.join(output, 'tex-compact-available-width.png'),
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await until(
    async () => (await divider.getAttribute('aria-orientation')) === 'vertical',
    'wide horizontal layout restored',
  )
  await optionsButton.click()
  report.checks.push(
    'At a 1001px viewport the available workbench width stacks source and PDF; closing and reopening the assistant changes layout and divider drag dimensions together without duplicating Monaco.',
  )
  report.checks.push(
    'The PDF opens with one compact control row on wide and narrow screens; keyboard-accessible Options reveal root, automatic builds, logs, warnings, and PDF actions while preserving document space.',
  )
  report.checks.push(
    'Root selection, mounted editable Monaco, save-before-build, hidden Lean goals, accessible split resizing and PDF completion work together.',
  )

  await append('% Unsaved draft stays separate.\n')
  await panel.getByText('PDF may be out of date', { exact: false }).waitFor()
  assert.equal(await frame.getAttribute('src'), firstPdf)
  rejectSave = true
  await buildButton.click()
  await panel
    .getByText('Fixture save conflict. Reload the file before building.', {
      exact: true,
    })
    .waitFor()
  assert.equal(builds.length, 1)
  assert.equal(await save.isEnabled(), true)
  rejectSave = false
  await buildButton.click()
  await until(() => builds.length === 2, 'second saved snapshot build')
  assert.equal(await frame.getAttribute('src'), firstPdf)
  finish('failed', [
    {
      severity: 'error',
      path: 'chapter.tex',
      line: 2,
      message: 'Undefined control sequence.',
    },
  ])
  await optionsButton.click()
  await panel
    .getByRole('button', {
      name: 'chapter.tex:2 · Undefined control sequence.',
      exact: true,
    })
    .waitFor()
  assert.equal(await frame.getAttribute('src'), firstPdf)
  await panel
    .getByRole('button', {
      name: 'chapter.tex:2 · Undefined control sequence.',
      exact: true,
    })
    .click()
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes('chapter.tex'),
    'diagnostic source navigation',
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await until(
    async () =>
      (
        await page.locator('.line-numbers.active-line-number').innerText()
      ).trim() === '2',
    'diagnostic line 2',
  )
  assert.equal(await optionsButton.getAttribute('aria-expanded'), 'false')
  // Clicking another diagnostic for the file already open must navigate in
  // place, even when a redundant source request would be slow. Preserve the
  // editor instance, edits typed immediately afterward, and the undo stack.
  const chapterEditor = await editor().elementHandle()
  const chapterSource = files['chapter.tex']
  let diagnosticReads = 0,
    releaseDiagnosticRead
  const diagnosticRead = new Promise((resolve) => {
    releaseDiagnosticRead = resolve
  })
  const diagnosticRoute = async (route) => {
    if (
      route.request().method() === 'GET' &&
      new URL(route.request().url()).searchParams.get('path') === 'chapter.tex'
    ) {
      diagnosticReads++
      await diagnosticRead
    }
    return route.fallback()
  }
  await page.route('**/api/projects/*/file?*', diagnosticRoute)
  rejectSave = true
  try {
    await optionsButton.click()
    await panel
      .getByRole('button', {
        name: 'chapter.tex:2 · Undefined control sequence.',
        exact: true,
      })
      .click()
    await append('% KEEP_DIAGNOSTIC_DRAFT')
    releaseDiagnosticRead()
    await until(
      async () => !(await page.locator('.file-toolbar .spinner').count()),
      'same-file diagnostic finished without reopening',
    )
    assert.equal(
      diagnosticReads,
      0,
      'A same-file diagnostic must not fetch source again',
    )
    assert(
      await chapterEditor.evaluate(
        (element) =>
          element === document.querySelector('.monaco-editor textarea'),
      ),
      'Diagnostic navigation preserves the mounted editor',
    )
    await until(
      async () =>
        (await page.locator('.monaco-editor .view-lines').innerText()).includes(
          'KEEP_DIAGNOSTIC_DRAFT',
        ),
      'keystrokes after diagnostic navigation preserved',
    )
    const chapterText = async () =>
      (await page.locator('.monaco-editor .view-line').allTextContents())
        .map((line) => line.replaceAll('\u00a0', ' '))
        .join('\n')
        .trimEnd()
    await editor().focus()
    // TeX's comment trigger may split one insertion into multiple undo stops.
    for (
      let step = 0;
      step < 4 && (await chapterText()) !== chapterSource.trimEnd();
      step++
    ) {
      const beforeUndo = await chapterText()
      await page.keyboard.press('ControlOrMeta+z')
      await until(
        async () => (await chapterText()) !== beforeUndo,
        'diagnostic undo step',
      )
    }
    assert.equal(
      await chapterText(),
      chapterSource.trimEnd(),
      'Undo restores the full original source',
    )
    assert.equal(files['chapter.tex'], chapterSource)
  } finally {
    releaseDiagnosticRead()
    await page.unroute('**/api/projects/*/file?*', diagnosticRoute)
    rejectSave = false
  }
  report.checks.push(
    'Repeated diagnostics for the current file jump in place without fetching or rebuilding the editor; immediate edits and undo history are preserved.',
  )
  if ((await optionsButton.getAttribute('aria-expanded')) === 'false')
    await optionsButton.click()
  await panel
    .getByRole('button', { name: 'Show build log', exact: true })
    .click()
  await panel.getByLabel('LaTeX build log').waitFor()
  const readableLog = await panel.getByLabel('LaTeX build log').innerText()
  await panel
    .getByRole('button', { name: 'Hide build log', exact: true })
    .click()
  assert.equal(await panel.getByLabel('LaTeX build log').count(), 0)
  assert.equal(await frame.getAttribute('src'), firstPdf)
  await panel
    .getByRole('button', { name: 'Show build log', exact: true })
    .click()
  assert.equal(
    await panel.getByLabel('LaTeX build log').innerText(),
    readableLog,
  )
  await open('main.tex')
  report.checks.push(
    'Drafts are marked stale; save conflicts prevent compilation, failed builds retain the last PDF, diagnostics navigate to source, and Hide/Show build log preserves both readable logs and the preview.',
  )

  await append('% Auto build remains off.\n')
  await save.click()
  await until(() => writes.length === 3, 'ordinary source save')
  await sleep(800)
  assert.equal(builds.length, 2)
  await panel.getByLabel('Rebuild on save').check()
  await sleep(600)
  assert.equal(builds.length, 2)
  await append('% Trigger automatic build.\n')
  await save.click()
  await until(() => builds.length === 3, 'rebuild after completed save')
  for (const text of ['% Queued first save.\n', '% Queued latest save.\n']) {
    await append(text)
    await save.click()
    await until(
      () => files['main.tex'].includes(text.trim()),
      'save during active build',
    )
  }
  await sleep(700)
  assert.equal(builds.length, 3)
  finish('completed')
  await until(() => builds.length === 4, 'coalesced build after active job')
  assert(builds[3].files['main.tex'].includes('Queued latest save.'))
  const writesBeforeAutosave = writes.length
  saveBarrier = new Promise((resolve) => {
    releaseSave = resolve
  })
  await append('% Newer draft during snapshot compilation.\n')
  finish('completed')
  await until(
    async () =>
      (await frame.getAttribute('src')) !== firstPdf &&
      pdfRequests.some((url) => url.includes('/tex-4/')),
    'latest successful PDF refresh',
  )
  await panel.getByText('PDF may be out of date', { exact: false }).waitFor()
  await until(() => heldSaves === 1, 'automatic source save begins')
  await sleep(700)
  assert.equal(
    builds.length,
    4,
    'Automatic compilation must wait for the source save to succeed',
  )
  assert.equal(writes.length, writesBeforeAutosave)
  assert.equal(heldSaves, 1, 'A pending autosave must not be duplicated')
  assert(
    !files['main.tex'].includes('Newer draft during snapshot compilation.'),
  )
  assert(
    !builds[3].files['main.tex'].includes(
      'Newer draft during snapshot compilation.',
    ),
  )
  saveBarrier = null
  releaseSave()
  releaseSave = null
  await until(
    () => builds.length === 5,
    'one rebuild after successful autosave',
  )
  assert.equal(writes.length, writesBeforeAutosave + 1)
  assert.equal(builds[4].writes, writesBeforeAutosave + 1)
  assert(
    builds[4].files['main.tex'].includes(
      'Newer draft during snapshot compilation.',
    ),
  )
  await sleep(1800)
  assert.equal(
    writes.length,
    writesBeforeAutosave + 1,
    'Clean buffers do not save again',
  )
  assert.equal(
    builds.length,
    5,
    'A completed autosave triggers only one rebuild',
  )
  report.checks.push(
    'Automatic compilation is opt-in, coalesces saves during running builds, keeps drafts separate from completed PDFs, and waits for a successful debounced autosave before exactly one rebuild.',
  )

  await panel.getByLabel('Rebuild on save').uncheck()
  await panel.getByRole('button', { name: 'Stop build', exact: true }).click()
  await until(() => stopped === 1, 'stop request')
  await panel.getByText('Build stopped', { exact: true }).waitFor()
  const finalPdf = await frame.getAttribute('src')
  await buildButton.click()
  await until(() => builds.length === 6, 'fresh snapshot before external edit')
  finish('completed')
  await panel.getByText('PDF from saved snapshot', { exact: false }).waitFor()
  await until(
    () => pdfRequests.some((url) => url.includes('/tex-6/')),
    'fresh saved PDF',
  )
  let savedPdf = await frame.getAttribute('src')
  assert.notEqual(savedPdf, finalPdf)
  workspaceVersion++
  files['chapter.tex'] += '% External agent edit.\n'
  await panel.getByText('PDF may be out of date', { exact: false }).waitFor()
  assert.equal(await frame.getAttribute('src'), savedPdf)
  await panel.getByLabel('Rebuild on save').check()
  await sleep(700)
  assert.equal(
    builds.length,
    6,
    'Enabling rebuild on save does not compile old edits',
  )
  workspaceVersion++
  files['chapter.tex'] += '% Another external saved edit.\n'
  await until(
    () => builds.length === 7,
    'automatic build for external saved input',
  )
  assert(
    builds[6].files['chapter.tex'].includes('Another external saved edit.'),
  )
  workspaceVersion++
  files['chapter.tex'] += '% Queued external save before stopping.\n'
  await panel.getByText('New save queued', { exact: false }).waitFor()
  await panel.getByRole('button', { name: 'Stop build', exact: true }).click()
  await until(() => stopped === 2, 'stop discards queued external rebuild')
  await panel.getByText('Build stopped', { exact: true }).waitFor()
  await sleep(2200)
  assert.equal(
    builds.length,
    7,
    'Stopping discards the pending rebuild until another save',
  )
  workspaceVersion++
  files['chapter.tex'] += '% A new save after stopping.\n'
  await until(
    () => builds.length === 8,
    'new external save after stopped build',
  )
  finish('completed')
  await panel.getByText('PDF from saved snapshot', { exact: false }).waitFor()
  await until(
    () => pdfRequests.some((url) => url.includes('/tex-8/')),
    'external-save PDF refresh',
  )
  savedPdf = await frame.getAttribute('src')
  await sleep(2200)
  assert.equal(
    builds.length,
    8,
    'A captured workspace stamp cannot trigger a rebuild loop',
  )
  await append('% Saved while choosing a different root.\n')
  await save.click()
  await until(
    () => files['main.tex'].includes('Saved while choosing a different root.'),
    'save before changing root',
  )
  await panel.getByLabel('LaTeX root document').selectOption('chapter.tex')
  await panel
    .getByText('The PDF will appear here after a successful build.', {
      exact: true,
    })
    .waitFor()
  await sleep(800)
  assert.equal(
    builds.length,
    8,
    'Changing roots cancels a pending automatic build',
  )
  await panel.getByLabel('LaTeX root document').selectOption('main.tex')
  await frame.waitFor()
  savedPdf = await frame.getAttribute('src')
  for (const filename of ['refs.bib', 'custom.sty']) {
    await open(filename)
    await panel.waitFor()
    assert.equal(
      await panel.getByLabel('LaTeX root document').inputValue(),
      'main.tex',
    )
    assert.equal(await frame.getAttribute('src'), savedPdf)
  }
  await open('Main.lean')
  await panel.waitFor({ state: 'hidden' })
  await open('main.tex')
  await panel.waitFor()
  assert.equal(await frame.getAttribute('src'), savedPdf)
  report.checks.push(
    'Stopping preserves the last successful PDF; external edits mark it stale, bibliography/style files share the selected root, and switching back to Lean leaves its editor usable.',
  )
  report.checks.push(
    'Opt-in automatic builds also follow external saved edits; Stop discards queued saves until a newer save, and observed compiler snapshot stamps never create rebuild loops.',
  )
  await panel.getByLabel('Rebuild on save').uncheck()
  await page.getByRole('button', { name: 'Upload', exact: true }).click()
  const upload = page.getByRole('dialog', { name: 'Add local files' })
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
    'base64',
  )
  const jpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9,
  ])
  await upload
    .getByLabel('Upload source files', { exact: true })
    .setInputFiles([
      { name: 'Figure.PNG', mimeType: 'image/png', buffer: png },
      { name: 'Photo.jpg', mimeType: 'image/jpeg', buffer: jpg },
      {
        name: 'captions.bib',
        mimeType: 'text/plain',
        buffer: Buffer.from('@book{figure, title={Café}}\n'),
      },
    ])
  await upload.getByText('3 files ready', { exact: true }).waitFor()
  await upload.getByRole('button', { name: 'Add files', exact: true }).click()
  await upload.waitFor({ state: 'hidden' })
  assert.equal(uploads.length, 1)
  for (const [filename, bytes] of [
    ['Figure.PNG', png],
    ['Photo.jpg', jpg],
  ]) {
    const item = uploads[0].files.find((file) => file.path === filename)
    assert.equal(item.encoding, 'base64')
    assert.deepEqual(Buffer.from(item.content, 'base64'), bytes)
  }
  assert.deepEqual(
    uploads[0].files.find((file) => file.path === 'captions.bib'),
    { path: 'captions.bib', content: '@book{figure, title={Café}}\n' },
  )
  report.checks.push(
    'Mixed TeX bibliography and PNG/JPEG figure uploads preserve text and binary bytes for the multi-file compiler.',
  )
  await buildButton.click()
  await until(() => builds.length === 9, 'fresh build before Lean-only save')
  finish('completed')
  await panel.getByText('PDF from saved snapshot', { exact: false }).waitFor()
  await panel.getByLabel('Rebuild on save').check()
  await open('Main.lean')
  await append('-- A Lean-only saved edit.\n')
  await save.click()
  await until(
    () => files['Main.lean'].includes('Lean-only saved edit.'),
    'Lean-only save',
  )
  await open('main.tex')
  await panel.getByText('PDF from saved snapshot', { exact: false }).waitFor()
  await sleep(2200)
  assert.equal(
    builds.length,
    9,
    'A Lean-only save cannot trigger a TeX rebuild',
  )
  await panel.getByLabel('LaTeX root document').selectOption('paper/main.tex')
  await until(() => buildButton.isEnabled(), 'nested root selected')
  await buildButton.click()
  await until(() => builds.length === 10, 'nested-root build')
  assert.equal(build.rootFile, 'paper/main.tex')
  finish('completed')
  await panel.getByText('PDF from saved snapshot', { exact: false }).waitFor()
  assert(
    statusRoots.includes('paper/main.tex'),
    'Status requests include the selected root',
  )
  files['captions.bib'] += '% An unrelated project-root edit.\n'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await sleep(1200)
  assert.equal(builds.length, 10)
  await panel.getByText('PDF from saved snapshot', { exact: false }).waitFor()
  report.checks.push(
    'Lean-only saves and inputs outside the selected root folder neither mark its PDF stale nor trigger automatic recompilation; status queries carry the root path.',
  )
  await panel.getByLabel('LaTeX root document').selectOption('chapter.tex')
  busyAgent = {
    ...build,
    id: 'agent-global-build',
    rootFile: 'main.tex',
    origin: 'agent',
    status: 'running',
    pdf: undefined,
  }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await panel.getByText('Lemex is compiling…', { exact: false }).waitFor()
  assert.equal(await buildButton.isDisabled(), true)
  await panel.getByRole('button', { name: 'Stop build', exact: true }).click()
  await until(
    () => stopped === 3,
    'stop visible agent compile with no user build',
  )
  await until(() => buildButton.isEnabled(), 'agent slot released')
  await panel.getByLabel('LaTeX root document').selectOption('main.tex')
  await until(() => buildButton.isEnabled(), 'return to main root')
  const beforeRace = buildAttempts
  rejectBuilds = 1
  agentOnReject = true
  await append('% Saved while an unseen agent claims the compiler.\n')
  await save.click()
  await until(() => buildAttempts === beforeRace + 1, 'busy compiler race')
  await panel.getByText('Lemex is compiling…', { exact: false }).waitFor()
  assert.equal(builds.length, 10)
  busyAgent.status = 'completed'
  await until(
    () => builds.length === 11,
    'retained save builds after agent finishes',
  )
  finish('completed')
  await panel.getByText('PDF from saved snapshot', { exact: false }).waitFor()
  report.checks.push(
    'Active agent compilations are visible and stoppable even without a user build; a saved input rejected by a racing agent is retained and compiled once the slot clears.',
  )
  const beforeExternalRace = buildAttempts
  rejectBuilds = 1
  agentOnReject = true
  files['refs.bib'] +=
    '% Saved externally while an agent claims the compiler.\n'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await until(
    () => buildAttempts === beforeExternalRace + 1,
    'external-save busy race',
  )
  await panel.getByText('Lemex is compiling…', { exact: false }).waitFor()
  busyAgent.status = 'completed'
  await until(
    () => builds.length === 12,
    'external saved fingerprint retained after contention',
  )
  finish('completed')
  await panel.getByText('PDF from saved snapshot', { exact: false }).waitFor()
  report.checks.push(
    'A competing compile also retains external saved-input fingerprints when no local editor save counter changed.',
  )
  const beforePersistent = buildAttempts
  rejectBuilds = Infinity
  failStatusOnReject = true
  await buildButton.click()
  await until(
    () => buildAttempts === beforePersistent + 1,
    'persistent busy rejection',
  )
  await sleep(2200)
  assert.equal(
    buildAttempts,
    beforePersistent + 1,
    'Failed status polling cannot trigger a blind retry',
  )
  const refreshStatus = panel.getByRole('button', {
    name: 'Refresh build status',
    exact: true,
  })
  const beforeFailedRefresh = statusAttempts
  const previousPdf = await frame.getAttribute('src')
  await refreshStatus.click()
  await until(
    () => statusAttempts > beforeFailedRefresh,
    'manual failed status refresh',
  )
  await panel
    .getByText('Fixture status poll unavailable.', { exact: true })
    .waitFor()
  assert.equal(await frame.getAttribute('src'), previousPdf)
  assert.equal(buildAttempts, beforePersistent + 1)
  failStatusOnReject = false
  failStatus = false
  await refreshStatus.click()
  await until(
    () => buildAttempts === beforePersistent + 2,
    'one retry after successful idle poll',
  )
  await sleep(6200)
  assert.equal(
    buildAttempts,
    beforePersistent + 2,
    'Persistent busy responses cannot create an automatic retry loop',
  )
  report.checks.push(
    'Refresh build status shows a failed refresh without discarding the last PDF; a successful manual refresh permits one idle retry, while persistent 409 responses cannot create an automatic retry loop.',
  )
  await page.screenshot({ path: path.join(output, 'tex-workspace.png') })
  fixture.assertClean()
  report.ok = true
} catch (error) {
  if (fixture) {
    fixture.report.failure = error.stack || error.message
    await fixture.page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {})
  }
  throw error
} finally {
  releaseSave?.()
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          ...fixture.report,
          builds,
          writes,
          pdfRequests,
          popupPdfRequests,
          popupErrors,
          uploads,
          statusRoots,
          statusAttempts,
          buildAttempts,
        },
        null,
        2,
      ) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  JSON.stringify({ ok: true, checks: fixture.report.checks, output }, null, 2),
)
