#!/usr/bin/env node
// Serve the built client separately; all project, compiler and terminal traffic is mocked.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { fixturePdf } from './lib/pdf-fixture.mjs'
import {
  chatBrowserFixture,
  sleep,
  until,
} from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/workspace-switch-ui')
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
const ids = { a: 'workspace-a', b: 'workspace-scratch', c: 'workspace-c' }
const names = { a: 'Paper Alpha', b: 'Scratch Beta', c: 'Paper Gamma' }
const marker = { a: 'ALPHA_ONLY', b: 'SCRATCH_ONLY', c: 'GAMMA_ONLY' }
const hash = (content) => createHash('sha256').update(content).digest('hex')
const projectFiles = (key) => ({
  'Main.lean': `-- ${marker[key]} Lean\nexample : True := by trivial\n`,
  ...(key === 'b'
    ? {
        'lean-toolchain': 'leanprover/lean4:v4.35.0-rc4\n',
        'lakefile.toml': 'name = "scratch_fixture"\n',
        'lake-manifest.json': '{"version":"1.2.0","packages":[]}\n',
        '.gitignore': '.lake/\n',
      }
    : {}),
  ...(key === 'b'
    ? {}
    : {
        'main.tex': `\\documentclass{article}\n\\begin{document}\n${marker[key]} document.\n\\end{document}\n`,
        [`${key}-only.md`]: `# ${marker[key]}\n`,
      }),
  ...(key === 'c'
    ? {
        'README.md':
          '# GAMMA_ONLY notes\n\n## Reading files\n\n[Lean source](Main.lean) · [TeX source](main.tex) · [PDF file](paper.pdf)\n',
        'paper.pdf': 'Fixture PDF file',
      }
    : {}),
})
const held = new Map()
const releaseAll = () => {
  for (const release of held.values()) release()
  held.clear()
}
const hold = async (key) => {
  await new Promise((resolve) => held.set(key, resolve))
  held.delete(key)
}
let fixture
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    // Use the full browser so screenshots exercise Chromium's native PDF viewer.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : { channel: 'chromium' },
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [
        {
          id: 'mathlib',
          name: 'Mathlib',
          ready: true,
          toolchain: 'leanprover/lean4:v4.35.0-rc4',
        },
      ],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
    },
    projects: Object.entries(ids).map(([key, id]) => ({
      id,
      name: names[key],
      status: 'ready',
      ...(key === 'b' ? { kind: 'single-file' } : { kind: 'project' }),
    })),
    files: Object.fromEntries(
      Object.entries(ids).map(([key, id]) => [id, projectFiles(key)]),
    ),
    chats: Object.entries(ids).map(([key, projectId]) => ({
      id: `chat-${key}`,
      projectId,
      title: `${names[key]} discussion`,
    })),
    runs: [],
  })
  const { page, state, report } = fixture
  const traffic = []
  const writes = []
  const terminals = []
  Object.assign(report, { traffic, writes, terminals })
  let delayListing = null
  let delayRead = null
  let delayWrite = null
  let delayPdf = null
  let delayStatus = null
  let rejectNextSave = false
  let creationCount = 0
  await page.route('**/api/playground', (route) =>
    route.fulfill({ json: { state: 'ready' } }),
  )
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    assert.equal(route.request().postDataJSON().kind, 'single-file')
    const number = ++creationCount
    await hold(`creation:${number}`)
    const project = {
      id: `new-playground-${number}`,
      name: `Created playground ${number}`,
      kind: 'single-file',
      preset: 'mathlib',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.35.0-rc4',
    }
    state.projects.push(project)
    state.files[project.id] = {
      'Main.lean': `import Mathlib\n-- CREATED_${number}\n`,
    }
    return route.fulfill({ status: 201, json: project })
  })
  const completed = Object.fromEntries(
    ['a', 'c'].map((key) => {
      const projectId = ids[key]
      const id = `built-${key}`
      return [
        projectId,
        {
          id,
          projectId,
          rootFile: 'main.tex',
          engine: 'pdflatex',
          status: 'completed',
          sourceRevision: `source-${key}`,
          workspaceRevision: `source-${key}`,
          createdAt: '2026-10-16T00:00:00Z',
          updatedAt: '2026-10-16T00:00:00Z',
          diagnostics: [],
          log: `${marker[key]} compilation`,
          pdf: {
            url: `/api/projects/${projectId}/tex/builds/${id}/pdf`,
            revision: id,
            filename: `${key}.pdf`,
          },
        },
      ]
    }),
  )
  await page.addInitScript(() => {
    if (window !== window.top) return
    window.__workspaceBlobSources = {}
    const createObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (blob) => {
      const value = createObjectURL(blob)
      void blob.text().then((text) => {
        window.__workspaceBlobSources[value] = text
      })
      return value
    }
  })
  await page.route('**/api/projects/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const match = /^\/api\/projects\/([^/]+)(.*)$/.exec(url.pathname)
    if (!match) return route.fallback()
    const [, projectId, suffix] = match
    const method = request.method()
    const filename = url.searchParams.get('path')
    traffic.push({ projectId, suffix, method, path: filename })
    if (suffix === '/files' && method === 'GET' && delayListing === projectId) {
      delayListing = null
      const listing = Object.entries(state.files[projectId]).map(
        ([path, content]) => ({ path, size: content.length }),
      )
      await hold(`listing:${projectId}`)
      return route.fulfill({ json: listing })
    }
    if (suffix === '/file' && method === 'GET' && delayRead === projectId) {
      delayRead = null
      const content = state.files[projectId][filename]
      await hold(`read:${projectId}`)
      return route.fulfill({ json: { content, hash: hash(content) } })
    }
    if (suffix === '/file' && method === 'PUT') {
      const input = request.postDataJSON()
      const previous = state.files[projectId][filename]
      assert.equal(
        input.expectedHash,
        previous === undefined ? null : hash(previous),
      )
      if (rejectNextSave) {
        rejectNextSave = false
        return route.fulfill({
          status: 409,
          json: {
            error:
              'The saved file changed. Reload it before saving your edits.',
          },
        })
      }
      writes.push({ projectId, path: filename, ...input })
      if (delayWrite === projectId) {
        delayWrite = null
        await hold(`write:${projectId}`)
      }
      state.files[projectId][filename] = input.content
      return route.fulfill({
        json: {
          content: input.content,
          hash: hash(input.content),
          requiresPreparation: false,
        },
      })
    }
    if (suffix === '/convert' && method === 'POST') {
      const project = state.projects.find((entry) => entry.id === projectId)
      project.kind = 'project'
      return route.fulfill({ json: project })
    }
    if (suffix === '/file-preview') {
      assert.equal(filename, 'paper.pdf')
      assert.equal(projectId, ids.c)
      return route.fulfill({
        contentType: 'application/pdf',
        body: fixturePdf(),
      })
    }
    if (suffix.startsWith('/tex')) {
      if (suffix.endsWith('/pdf')) {
        if (delayPdf === projectId) {
          delayPdf = null
          await hold(`pdf:${projectId}`)
        }
        const key = projectId === ids.a ? 'a' : 'c'
        return route.fulfill({
          contentType: 'application/pdf',
          body: Buffer.concat([
            fixturePdf(),
            Buffer.from(`\n% ${marker[key]}\n`),
          ]),
        })
      }
      if (method === 'POST') {
        const input = request.postDataJSON()
        assert.equal(input.rootFile, 'main.tex')
        assert(Object.hasOwn(state.files[projectId], input.rootFile))
        return route.fulfill({ status: 202, json: completed[projectId] })
      }
      const status = {
        available: true,
        engines: ['pdflatex'],
        workspaceRevision: completed[projectId]?.workspaceRevision || 'scratch',
        build: completed[projectId] || null,
        activeBuild: null,
        lastSuccessful: completed[projectId] || null,
      }
      if (delayStatus === projectId) {
        delayStatus = null
        await hold(`status:${projectId}`)
      }
      return route.fulfill({ json: status })
    }
    if (suffix === '/terminal/stop')
      return route.fulfill({ json: { stopped: true } })
    return route.fallback()
  })
  await page.routeWebSocket('**/websocket/terminal/**', (socket) => {
    const projectId = new URL(socket.url()).pathname.split('/').at(-1)
    terminals.push(projectId)
    const showFiles = () =>
      socket.send(
        Buffer.from(
          `\r\nWorkspace: ${projectId}\r\n/workspace $ ls\r\n${Object.keys(state.files[projectId]).join('\r\n')}\r\n/workspace $ `,
        ),
      )
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.type === 'input' && message.data.includes('\r')) showFiles()
    })
    showFiles()
  })
  const panel = page.getByRole('region', {
    name: 'LaTeX PDF workspace',
    exact: true,
  })
  const select = (key) =>
    page
      .locator('.project-item')
      .and(page.getByTitle(names[key], { exact: true }))
  const fileButton = (filename) =>
    page.locator('.file-item').and(page.getByTitle(filename, { exact: true }))
  const editorText = async () =>
    (await page.locator('.monaco-editor').first().innerText()).replaceAll(
      '\u00a0',
      ' ',
    )
  const save = page.getByRole('button', { name: 'Save', exact: true })
  const waitFile = async (filename, contentMarker) => {
    await until(
      async () =>
        (await page.locator('.file-tab').innerText()).includes(filename) &&
        !(await page.locator('.file-toolbar .spinner').count()) &&
        (await editorText()).includes(contentMarker),
      `open ${filename} from ${contentMarker}`,
    )
    await page.locator('.editor-loading').waitFor({ state: 'hidden' })
    assert.equal(
      await page.locator('.monaco-editor').count(),
      1,
      'Only the selected workspace may keep a visible editor',
    )
  }
  const open = async (filename, contentMarker) => {
    await fileButton(filename).click()
    await waitFile(filename, contentMarker)
  }
  const switchTo = async (key, filename = 'Main.lean') => {
    await select(key).click()
    await waitFile(filename, marker[key])
    assert.equal(await select(key).getAttribute('aria-current'), 'page')
    assert(
      (await page.locator('.workspace-title').innerText()).includes(names[key]),
    )
  }
  const append = async (text) => {
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(text)
    await until(() => save.isEnabled(), 'dirty editor')
  }
  const terminal = page.getByRole('region', {
    name: 'Project terminal',
    exact: true,
  })
  const terminalText = () =>
    terminal.locator('.xterm-accessibility-tree').innerText()
  const openTerminal = async (key) => {
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await terminal.getByText('Connected', { exact: true }).waitFor()
    await until(
      async () => (await terminalText()).includes(`Workspace: ${ids[key]}`),
      'matching terminal workspace',
    )
    assert.equal(terminals.at(-1), ids[key])
  }

  const waitPdfRendered = async (iframe) => {
    await until(async () => {
      const element = await iframe.elementHandle()
      const documentFrame = await element?.contentFrame()
      if (!documentFrame) return false
      const descendants = (frame) => [
        frame,
        ...frame.childFrames().flatMap(descendants),
      ]
      for (const frame of descendants(documentFrame)) {
        if (!frame.url().startsWith('chrome-extension://')) continue
        const loaded = await frame
          .evaluate(
            () =>
              document.querySelector('pdf-viewer')?.loadState_ === 'success',
          )
          .catch(() => false)
        if (loaded) return true
      }
      return false
    }, 'native PDF document rendered')
  }

  await fixture.ready()
  await open('main.tex', marker.a)
  await panel.waitFor()
  await panel.locator('iframe[title="PDF preview"]').waitFor()
  await append('\n% ALPHA_UNSAVED\n')
  await select('b').click()
  const unsaved = page.getByRole('dialog', {
    name: 'Save your changes?',
    exact: true,
  })
  await unsaved.waitFor()
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert((await editorText()).includes('ALPHA_UNSAVED'))
  assert.equal(await select('a').getAttribute('aria-current'), 'page')
  await select('b').click()
  await unsaved
    .getByRole('button', { name: 'Discard edits', exact: true })
    .click()
  await waitFile('Main.lean', marker.b)
  assert.equal(await panel.count(), 0)
  assert.equal(await page.locator('iframe[title="PDF preview"]').count(), 0)
  assert.equal(
    await page.getByRole('region', { name: 'Files', exact: true }).count(),
    0,
  )
  await openTerminal('b')
  assert(!(await terminalText()).includes('main.tex'))
  assert(!(await terminalText()).includes(marker.a))
  report.checks.push(
    'Switching from a dirty TeX source to a playground prompts before leaving; cancellation keeps edits, discard opens the correct Lean file and terminal without a TeX split.',
  )

  state.files[ids.b]['companion.tex'] =
    '\\documentclass{article}\n\\begin{document}SCRATCH_ONLY companion.\\end{document}\n'
  await page.getByRole('region', { name: 'Files', exact: true }).waitFor()
  await page
    .getByText('This playground has additional files.', { exact: false })
    .waitFor()
  assert.equal(
    await page.getByRole('button', { name: 'New folder', exact: true }).count(),
    0,
  )
  assert.equal(
    state.projects.find((entry) => entry.id === ids.b).kind,
    'single-file',
  )
  await open('companion.tex', marker.b)
  await page.getByLabel('Project terminal input').focus()
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await until(
    async () => (await terminalText()).includes('companion.tex'),
    'additional playground file in terminal',
  )
  report.checks.push(
    'Playground setup files keep the simple view; an additional TeX file reveals its file browser and conversion guidance while remaining in the same terminal workspace.',
  )

  await terminal
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Convert to project', exact: true })
    .click()
  await page.getByRole('region', { name: 'Files', exact: true }).waitFor()
  await page
    .getByText('This playground has additional files.', { exact: false })
    .waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'New file', exact: true }).click()
  const create = page.getByRole('dialog', {
    name: 'Create a file',
    exact: true,
  })
  await create.getByLabel('File name', { exact: true }).fill('test.tex')
  assert(
    (await create.locator('.entry-path-preview').innerText()).includes(
      `${names.b} / test.tex`,
    ),
  )
  delayWrite = ids.b
  await create.getByRole('button', { name: 'Create file', exact: true }).click()
  await until(() => held.has(`write:${ids.b}`), 'pending new TeX file')
  assert(
    await select('a').isDisabled(),
    'Project changes stay disabled while creating a file',
  )
  held.get(`write:${ids.b}`)()
  await create.waitFor({ state: 'hidden' })
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes('test.tex'),
    'created TeX file opens',
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await append(
    '\\documentclass{article}\n\\begin{document}SCRATCH_ONLY NEW_TEX\\end{document}\n',
  )
  delayWrite = ids.b
  await save.click()
  await until(() => held.has(`write:${ids.b}`), 'pending TeX source save')
  assert(
    await select('c').isDisabled(),
    'Project changes stay disabled while saving',
  )
  held.get(`write:${ids.b}`)()
  await until(() => save.isDisabled(), 'TeX source saved')
  const options = panel.getByRole('button', {
    name: 'PDF options',
    exact: true,
  })
  if (await options.count()) await options.click()
  await panel.getByLabel('LaTeX root document').selectOption('test.tex')
  if (await options.count()) await options.click()
  await openTerminal('b')
  await until(
    async () => (await terminalText()).includes('test.tex'),
    'new TeX file visible in same terminal workspace',
  )
  assert.equal(state.files[ids.a]['test.tex'], undefined)
  assert.equal(state.files[ids.c]['test.tex'], undefined)
  assert(state.files[ids.b]['test.tex'].includes('SCRATCH_ONLY NEW_TEX'))
  assert(writes.every((entry) => entry.projectId === ids.b))
  report.checks.push(
    'A converted playground keeps its workspace ID; new TeX files and saves target that project, remain visible to its terminal, and guard project changes while writes are pending.',
  )

  await terminal
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  delayPdf = ids.a
  await switchTo('a', 'main.tex')
  await until(() => held.has(`pdf:${ids.a}`), 'old project PDF request')
  await switchTo('c')
  await open('main.tex', marker.c)
  await panel.locator('iframe[title="PDF preview"]').waitFor()
  held.get(`pdf:${ids.a}`)()
  await sleep(150)
  await until(async () => {
    const source = await panel
      .locator('iframe[title="PDF preview"]')
      .getAttribute('src')
    return page.evaluate(
      (url) =>
        window.__workspaceBlobSources[url.split('#')[0]]?.includes(
          'GAMMA_ONLY',
        ),
      source,
    )
  }, 'current project PDF after old response')
  assert(!(await editorText()).includes(marker.a))
  await panel.getByRole('button', { name: 'Build PDF', exact: true }).click()
  await until(
    () =>
      traffic.some(
        (entry) =>
          entry.projectId === ids.c &&
          entry.suffix === '/tex/build' &&
          entry.method === 'POST',
      ),
    'build uses current project',
  )
  report.checks.push(
    'Projects with identically named TeX sources keep distinct editor content and build IDs; a delayed PDF response from the previous project cannot replace the current preview.',
  )

  delayStatus = ids.a
  await switchTo('a', 'main.tex')
  await until(() => held.has(`status:${ids.a}`), 'old project compiler status')
  await switchTo('b', 'test.tex')
  held.get(`status:${ids.a}`)()
  await sleep(150)
  assert.equal(
    await panel.getByLabel('LaTeX root document').inputValue(),
    'test.tex',
  )
  assert.equal(await panel.locator('iframe[title="PDF preview"]').count(), 0)
  assert(!(await panel.innerText()).includes('ALPHA_ONLY'))
  assert((await editorText()).includes(marker.b))
  report.checks.push(
    'A delayed compiler status from another project cannot populate the current project’s PDF panel or root document.',
  )
  delayRead = ids.b
  await openTerminal('b')
  await until(() => held.has(`read:${ids.b}`), 'old terminal source refresh')
  await switchTo('c', 'main.tex')
  held.get(`read:${ids.b}`)()
  await sleep(150)
  assert.equal(await terminal.count(), 0)
  assert((await editorText()).includes(marker.c))
  assert(!(await editorText()).includes(marker.b))
  report.checks.push(
    'A source refresh started by the previous terminal cannot replace the next project’s editor or retain its terminal panel.',
  )

  delayListing = ids.a
  await select('a').click()
  await until(() => held.has(`listing:${ids.a}`), 'old project file listing')
  await switchTo('b', 'test.tex')
  assert.equal(await fileButton('a-only.md').count(), 0)
  await switchTo('c', 'main.tex')
  held.get(`listing:${ids.a}`)()
  await sleep(250)
  assert.equal(await fileButton('a-only.md').count(), 0)
  assert.equal(await fileButton('test.tex').count(), 0)
  assert.equal(await fileButton('c-only.md').count(), 1)
  assert((await editorText()).includes(marker.c))
  assert.equal(
    await panel.getByLabel('LaTeX root document').inputValue(),
    'main.tex',
  )
  await openTerminal('c')
  assert(!(await terminalText()).includes('test.tex'))
  assert((await terminalText()).includes('c-only.md'))
  await terminal
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  report.checks.push(
    'Rapid TeX/project/playground switches ignore late file listings, retain the selected project’s root and source, and connect the terminal only to the selected workspace.',
  )

  delayRead = ids.a
  await select('a').click()
  await until(() => held.has(`read:${ids.a}`), 'pending project source read')
  assert(
    await select('c').isDisabled(),
    'Project changes stay disabled while opening source',
  )
  held.get(`read:${ids.a}`)()
  await waitFile('main.tex', marker.a)
  await switchTo('c', 'main.tex')
  assert(!(await editorText()).includes(marker.a))
  assert.equal(await save.isDisabled(), true)
  report.checks.push(
    'An in-flight source read cannot carry a same-named buffer into another project; the following project opens its own saved source and hash.',
  )

  delayListing = ids.a
  await select('a').click()
  await until(() => held.has(`listing:${ids.a}`), 'first visit listing')
  await switchTo('b', 'test.tex')
  state.files[ids.a]['a-new.md'] = '# Added while the old listing waited\n'
  await switchTo('a', 'main.tex')
  assert.equal(await fileButton('a-new.md').count(), 1)
  held.get(`listing:${ids.a}`)()
  await sleep(250)
  assert.equal(
    await fileButton('a-new.md').count(),
    1,
    'A response from an earlier visit cannot replace the new visit’s listing',
  )
  assert((await editorText()).includes(marker.a))
  report.checks.push(
    'Returning to the same project starts a new visit: an earlier listing cannot hide files added before the return.',
  )

  await switchTo('c', 'main.tex')
  await panel.locator('iframe[title="PDF preview"]').waitFor()
  const pdfBounds = await panel
    .locator('iframe[title="PDF preview"]')
    .boundingBox()
  const texBounds = await panel.boundingBox()
  await waitPdfRendered(panel.locator('iframe[title="PDF preview"]'))
  assert(
    pdfBounds.height > texBounds.height * 0.8,
    'The compact PDF controls leave most panel height for reading',
  )
  await page.screenshot({
    path: path.join(output, 'multi-file-tex-desktop.png'),
    fullPage: true,
  })
  for (const width of [1140, 1100]) {
    await page.setViewportSize({ width, height: 900 })
    await until(
      async () =>
        (
          await page.locator('.file-reading-workspace').getAttribute('class')
        ).includes('tex-stacked'),
      'narrow center workspace stacks source and PDF',
    )
    assert.equal(
      await page
        .getByRole('separator', {
          name: 'Resize LaTeX source and PDF',
          exact: true,
        })
        .getAttribute('aria-orientation'),
      'horizontal',
    )
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    )
    await page.screenshot({
      path: path.join(output, `multi-file-tex-assistant-stacked-${width}.png`),
      fullPage: true,
    })
  }
  await page.getByRole('button', { name: 'Lemex', exact: true }).click()
  await page.setViewportSize({ width: 960, height: 900 })
  assert(await panel.isVisible())
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  )
  await page.screenshot({
    path: path.join(output, 'multi-file-tex-narrow.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await open('README.md', marker.c)
  assert.equal(await panel.isVisible(), false)
  await page
    .getByRole('button', { name: 'Preview Markdown', exact: true })
    .click()
  const markdown = page.getByRole('region', {
    name: 'Markdown preview',
    exact: true,
  })
  await markdown
    .getByRole('heading', { name: 'GAMMA_ONLY notes', exact: true })
    .waitFor()
  await page.screenshot({
    path: path.join(output, 'multi-file-markdown-preview.png'),
    fullPage: true,
  })
  await markdown.getByRole('link', { name: 'PDF file', exact: true }).click()
  await until(
    async () =>
      (await page.locator('.file-tab').innerText()).includes('paper.pdf'),
    'linked PDF file',
  )
  const projectPdf = page.locator('.file-reading-workspace > .pdf-file-viewer')
  await projectPdf.locator('iframe[title="PDF preview"]').waitFor()
  await waitPdfRendered(projectPdf.locator('iframe[title="PDF preview"]'))
  assert.equal(await page.locator('.monaco-editor:visible').count(), 0)
  assert.equal(await panel.isVisible(), false)
  await page.screenshot({
    path: path.join(output, 'multi-file-project-pdf.png'),
    fullPage: true,
  })
  await open('Main.lean', marker.c)
  await until(
    () => page.locator('.infoview-pane').isVisible(),
    'Lean goals after document reading',
  )
  assert.equal(await projectPdf.count(), 0)
  assert.equal(await panel.isVisible(), false)
  await page.screenshot({
    path: path.join(output, 'multi-file-lean-return.png'),
    fullPage: true,
  })
  await open('main.tex', marker.c)
  await panel.locator('iframe[title="PDF preview"]').waitFor()
  assert.equal(await page.locator('.monaco-editor').count(), 1)
  assert.equal(await save.isDisabled(), true)
  report.checks.push(
    'Mixed Lean, TeX, Markdown and PDF navigation preserves one editor and correct readers/goals; compact PDFs leave reading space in desktop and narrow layouts without horizontal overflow.',
  )
  await switchTo('a', 'main.tex')

  await append('\n% SAVE_CONFLICT_DRAFT\n')
  await select('c').click()
  await unsaved.waitFor()
  rejectNextSave = true
  await unsaved
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click()
  await unsaved
    .getByRole('alert')
    .filter({
      hasText: 'The saved file changed. Reload it before saving your edits.',
    })
    .waitFor()
  await page.screenshot({
    path: path.join(output, 'save-conflict-dialog.png'),
    fullPage: true,
  })
  assert.equal(await select('a').getAttribute('aria-current'), 'page')
  assert((await editorText()).includes('SAVE_CONFLICT_DRAFT'))
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  await save.click()
  await until(() => save.isDisabled(), 'draft saved after conflict retry')
  report.checks.push(
    'A save conflict is visible inside the navigation dialog, keeps the current project and draft, and permits cancellation and retry.',
  )

  const startHeldPlayground = async (number) => {
    await page
      .getByRole('button', { name: 'New playground', exact: true })
      .click()
    await until(
      () => held.has(`creation:${number}`),
      'pending playground creation',
    )
  }
  await startHeldPlayground(1)
  await append('\n% EDIT_DURING_CREATION\n')
  held.get('creation:1')()
  await unsaved.waitFor()
  assert.equal(await select('a').getAttribute('aria-current'), 'page')
  assert((await editorText()).includes('EDIT_DURING_CREATION'))
  await unsaved.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await select('a').getAttribute('aria-current'), 'page')
  assert((await editorText()).includes('EDIT_DURING_CREATION'))
  await save.click()
  await until(
    () => save.isDisabled(),
    'source saved after cancelling created playground',
  )
  report.checks.push(
    'Edits made while a playground is being created trigger the normal unsaved-work prompt when the response arrives; cancelling preserves the original workspace and draft.',
  )

  await startHeldPlayground(2)
  await switchTo('c', 'main.tex')
  await append('\n% OTHER_PROJECT_DURING_CREATION\n')
  held.get('creation:2')()
  await until(() => !held.has('creation:2'), 'old creation response released')
  await until(
    () =>
      page
        .getByRole('button', { name: 'New playground', exact: true })
        .isEnabled(),
    'creation request finished',
  )
  await sleep(150)
  assert.equal(await select('c').getAttribute('aria-current'), 'page')
  assert((await editorText()).includes('OTHER_PROJECT_DURING_CREATION'))
  assert.equal(await unsaved.count(), 0)
  await save.click()
  await until(() => save.isDisabled(), 'new project draft saved')
  report.checks.push(
    'A playground creation response from an earlier project does not select itself, open a navigation prompt, or discard the current project’s newer edits.',
  )

  await startHeldPlayground(3)
  await page.getByRole('button', { name: 'Upload', exact: true }).click()
  const upload = page.getByRole('dialog', {
    name: 'Add local files',
    exact: true,
  })
  await upload.waitFor()
  await upload
    .getByLabel('Upload source files', { exact: true })
    .setInputFiles({
      name: 'keep-picker.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Keep this selection\n'),
    })
  await upload.getByText('keep-picker.md', { exact: true }).waitFor()
  held.get('creation:3')()
  await until(
    () => state.projects.some((project) => project.id === 'new-playground-3'),
    'created playground response while uploading',
  )
  await sleep(200)
  assert(await upload.isVisible())
  assert(await upload.getByText('keep-picker.md', { exact: true }).isVisible())
  assert.equal(await select('c').getAttribute('aria-current'), 'page')
  assert((await editorText()).includes(marker.c))
  assert.equal(
    traffic.filter(
      (entry) => entry.suffix === '/upload' && entry.method === 'POST',
    ).length,
    0,
  )
  report.checks.push(
    'A playground creation response preserves an open upload dialog, its selected files and the current project, without rebinding or uploading to another workspace.',
  )
  await upload.getByRole('button', { name: 'Cancel', exact: true }).click()

  const waitCreated = async (number) => {
    await until(
      () =>
        state.projects.some(
          (project) => project.id === `new-playground-${number}`,
        ),
      'created playground response',
    )
    await sleep(150)
  }
  await startHeldPlayground(4)
  await openTerminal('c')
  held.get('creation:4')()
  await waitCreated(4)
  assert.equal(await select('c').getAttribute('aria-current'), 'page')
  assert(await terminal.isVisible())
  assert((await terminalText()).includes(`Workspace: ${ids.c}`))
  await terminal.getByText('Connected', { exact: true }).waitFor()
  await terminal
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  report.checks.push(
    'A playground creation response preserves a terminal opened while waiting, its connection and the selected workspace.',
  )

  await startHeldPlayground(5)
  await page.getByRole('button', { name: /^Source control/ }).click()
  const sourceControl = page.getByRole('dialog', {
    name: 'Source control',
    exact: true,
  })
  await sourceControl
    .getByLabel('Commit message', { exact: true })
    .fill('Keep this unsubmitted commit message')
  held.get('creation:5')()
  await waitCreated(5)
  assert(await sourceControl.isVisible())
  assert.equal(
    await sourceControl
      .getByLabel('Commit message', { exact: true })
      .inputValue(),
    'Keep this unsubmitted commit message',
  )
  assert.equal(await select('c').getAttribute('aria-current'), 'page')
  await sourceControl
    .getByRole('button', { name: 'Close dialog', exact: true })
    .click()
  report.checks.push(
    'A playground creation response preserves an open source-control dialog and its unsubmitted commit message.',
  )

  await startHeldPlayground(6)
  await append('\n% SAVE_DURING_CREATION\n')
  delayWrite = ids.c
  await save.click()
  await until(
    () => held.has(`write:${ids.c}`),
    'save active when creation finishes',
  )
  held.get('creation:6')()
  await waitCreated(6)
  assert.equal(await select('c').getAttribute('aria-current'), 'page')
  assert((await editorText()).includes('SAVE_DURING_CREATION'))
  assert(held.has(`write:${ids.c}`))
  assert(!state.files[ids.c]['main.tex'].includes('SAVE_DURING_CREATION'))
  held.get(`write:${ids.c}`)()
  await until(() => save.isDisabled(), 'original in-flight save completes')
  assert(state.files[ids.c]['main.tex'].includes('SAVE_DURING_CREATION'))
  report.checks.push(
    'A creation response during a source save leaves that workspace selected and lets the original hash-checked save finish in the correct project.',
  )

  const beforeSaveHash = hash(state.files[ids.c]['main.tex'])
  await startHeldPlayground(7)
  await append('\n% SAVE_AND_OPEN_CREATED\n')
  held.get('creation:7')()
  await unsaved.waitFor()
  assert((await unsaved.innerText()).includes('Created playground 7'))
  await unsaved
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click()
  await waitFile('Main.lean', 'CREATED_7')
  assert.equal(
    await page
      .getByTitle('Created playground 7', { exact: true })
      .getAttribute('aria-current'),
    'page',
  )
  assert(state.files[ids.c]['main.tex'].includes('SAVE_AND_OPEN_CREATED'))
  assert.equal(writes.at(-1).projectId, ids.c)
  assert.equal(writes.at(-1).expectedHash, beforeSaveHash)
  assert(
    !state.files['new-playground-7']['Main.lean'].includes(
      'SAVE_AND_OPEN_CREATED',
    ),
  )
  report.checks.push(
    'Save & continue names the created destination, saves the old project with its original expected hash, and then opens the new playground.',
  )

  const savedSeventh = state.files['new-playground-7']['Main.lean']
  await startHeldPlayground(8)
  await append('\n-- DISCARD_AND_OPEN_CREATED\n')
  held.get('creation:8')()
  await unsaved.waitFor()
  assert((await unsaved.innerText()).includes('Created playground 8'))
  await unsaved
    .getByRole('button', { name: 'Discard edits', exact: true })
    .click()
  await waitFile('Main.lean', 'CREATED_8')
  assert.equal(state.files['new-playground-7']['Main.lean'], savedSeventh)
  assert(!writes.some((entry) => entry.projectId === 'new-playground-7'))
  assert.equal(
    await page
      .getByTitle('Created playground 8', { exact: true })
      .getAttribute('aria-current'),
    'page',
  )
  report.checks.push(
    'Discard edits opens the named created playground while preserving the previous playground’s saved source and issuing no save for the discarded draft.',
  )
  fixture.assertClean()
  report.passed = true
  report.traffic = traffic
  report.writes = writes
  report.terminals = terminals
  await page.screenshot({
    path: path.join(output, 'workspace-switch-desktop.png'),
    fullPage: true,
  })
  console.log(JSON.stringify({ passed: true, checks: report.checks }))
} catch (error) {
  if (fixture) {
    fixture.report.failure = error.stack
    fixture.report.visibleEditors = await fixture.page
      .locator('.monaco-editor')
      .allInnerTexts()
    fixture.report.selectedWorkspace = await fixture.page
      .locator('.workspace-title')
      .allInnerTexts()
    fixture.report.pdfSources = await fixture.page
      .locator('iframe[title="PDF preview"]')
      .evaluateAll((frames) => frames.map((frame) => frame.getAttribute('src')))
    fixture.report.pdfBlobSources = await fixture.page.evaluate(
      () => window.__workspaceBlobSources,
    )
    fixture.report.editorContainers = await fixture.page
      .locator('.monaco-editor')
      .evaluateAll((editors) =>
        editors.map((editor) => {
          const ancestors = []
          let current = editor
          for (let depth = 0; current && depth < 7; depth++) {
            const bounds = current.getBoundingClientRect()
            ancestors.push({
              tag: current.tagName,
              class: current.className,
              bounds: {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
              },
            })
            current = current.parentElement
          }
          return ancestors
        }),
      )
    fixture.report.workspaceRoots = await fixture.page
      .locator('.lean-workspace')
      .count()
    fixture.report.editorHosts = await fixture.page
      .locator('.monaco-host')
      .count()
    await fixture.page.screenshot({
      path: path.join(output, 'failure.png'),
      fullPage: true,
    })
  }
  throw error
} finally {
  releaseAll()
  if (fixture) {
    await fs.writeFile(
      path.join(output, 'result.json'),
      JSON.stringify(fixture.report, null, 2) + '\n',
    )
    await fixture.browser.close()
  }
  await new Promise((resolve) => server.close(resolve))
}
