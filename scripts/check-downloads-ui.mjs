#!/usr/bin/env node
// Downloads use disposable browser fixtures, never real projects or providers.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import JSZip from 'jszip'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(new URL('../', import.meta.url).pathname)
const output = path.join(root, '.runtime/downloads-ui')
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
const projectId = 'download-fixture'
const playgroundId = 'download-playground'
const main = 'example : True := by trivial\n'
const notePath = 'Notes/π note.txt'
const dependency = '.lake/packages/Fixture/Example.lean'
const binary = Buffer.from([0, 255, 1, 128, 13, 10])
const sources = {
  'Main.lean': main,
  [notePath]: 'Download a Unicode filename.\n',
  'image.bin': 'Binary fixture',
  [dependency]: '-- Read-only library source\n',
}
const streamingRun = {
  id: 'download-stream-fixture',
  projectId,
  chatId: 'download-chat',
  status: 'running',
  mode: 'ask',
  prompt: 'Fixture progress',
  message: 'Fixture progress\n'.repeat(60),
  createdAt: '2026-10-16T04:00:00Z',
}
const downloads = []
let failNextDownload = false
let expireNextDownload = false
let fixture
try {
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    viewport: { width: 1500, height: 1100 },
    session: {
      user: { id: 'download-owner', name: 'Download fixture' },
      templates: [
        { id: 'mathlib', name: 'Mathlib', ready: true, playgroundReady: true },
      ],
      models: [],
      runtime: { ready: true },
    },
    projects: [
      { id: projectId, name: 'Download project', status: 'ready' },
      {
        id: playgroundId,
        kind: 'single-file',
        name: 'Named playground',
        status: 'ready',
      },
      {
        id: 'preparing-download-fixture',
        name: 'Preparing project',
        status: 'preparing',
        protected: true,
      },
    ],
    files: {
      [projectId]: sources,
      [playgroundId]: { 'Main.lean': '-- Saved playground\n' },
      'preparing-download-fixture': { 'Main.lean': '-- Preparing\n' },
    },
    chats: [
      { id: 'download-chat', projectId, title: 'Download fixture' },
      {
        id: 'playground-chat',
        projectId: playgroundId,
        title: 'Playground fixture',
      },
    ],
    runs: [streamingRun],
  })
  const { page, state, report } = fixture
  await page.route('**/api/projects/*/download**', async (route) => {
    assert.equal(route.request().method(), 'GET')
    const url = new URL(route.request().url())
    const id = url.pathname.split('/')[3]
    const filename = url.searchParams.get('path')
    downloads.push({ projectId: id, path: filename })
    if (expireNextDownload) {
      expireNextDownload = false
      return route.fulfill({
        status: 401,
        json: { error: 'Sign in to download this project.' },
      })
    }
    if (failNextDownload) {
      failNextDownload = false
      return route.fulfill({
        status: 413,
        json: {
          error:
            'This archive is too large. Download individual files instead.',
        },
      })
    }
    if (filename) {
      const content =
        filename === 'image.bin'
          ? binary
          : Buffer.from(state.files[id][filename])
      return route.fulfill({
        contentType: 'application/octet-stream',
        headers: {
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename.split('/').at(-1))}`,
        },
        body: content,
      })
    }
    const zip = new JSZip()
    for (const [filename, content] of Object.entries(state.files[id])) {
      if (filename.startsWith('.lake/')) continue
      zip.file(filename, filename === 'image.bin' ? binary : content)
    }
    return route.fulfill({
      contentType: 'application/zip',
      headers: {
        'Content-Disposition':
          "attachment; filename*=UTF-8''Download%20project.zip",
      },
      body: await zip.generateAsync({ type: 'nodebuffer' }),
    })
  })
  const tree = page.locator('.file-list')
  const file = (filename) =>
    tree.locator('.file-item').and(page.getByTitle(filename, { exact: true }))
  const project = (name) =>
    page.locator('.project-item').and(page.getByTitle(name, { exact: true }))
  const menu = page.getByRole('menu')
  async function save(action, filename) {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      action(),
    ])
    assert.equal(download.suggestedFilename(), filename)
    assert.equal(await download.failure(), null)
    const destination = path.join(output, filename)
    await download.saveAs(destination)
    return fs.readFile(destination)
  }
  async function chooseDownload(label) {
    await menu.getByRole('menuitem', { name: label, exact: true }).click()
  }
  await fixture.ready()
  await tree.getByRole('button', { name: 'Notes', exact: true }).click()
  await file(notePath).click({ button: 'right' })
  assert.equal(await menu.getAttribute('aria-label'), `Actions for ${notePath}`)
  assert.equal(await file('Main.lean').getAttribute('aria-current'), 'true')
  assert.equal(
    (
      await save(() => chooseDownload('Download file'), 'π note.txt')
    ).toString(),
    sources[notePath],
  )
  assert.deepEqual(downloads.at(-1), { projectId, path: notePath })

  const fileActions = page.getByRole('button', {
    name: 'Actions for file image.bin',
    exact: true,
  })
  await file('image.bin').hover()
  await fileActions.click()
  await until(
    () =>
      menu
        .getByRole('menuitem', { name: 'Download file' })
        .evaluate((element) => element === document.activeElement),
    'regular menu click focus',
  )
  await fixture.emit(streamingRun, 'message', {
    text: '\nStreaming update\n'.repeat(100),
  })
  await page.locator('.assistant-panel').dispatchEvent('scroll')
  assert.equal(await menu.isVisible(), true)
  assert.equal(
    await menu
      .getByRole('menuitem', { name: 'Download file' })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await page.keyboard.press('Escape')
  assert.equal(
    await fileActions.evaluate((element) => element === document.activeElement),
    true,
  )

  await file('image.bin').focus()
  await page.keyboard.press('Shift+F10')
  await until(
    () =>
      menu
        .getByRole('menuitem', { name: 'Download file' })
        .evaluate((element) => element === document.activeElement),
    'keyboard menu focus',
  )
  await page.keyboard.press('ArrowDown')
  assert.equal(
    await menu
      .getByRole('menuitem', { name: 'Move to trash' })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await page.keyboard.press('Escape')
  assert.equal(await menu.count(), 0)
  assert.equal(
    await file('image.bin').evaluate(
      (element) => element === document.activeElement,
    ),
    true,
  )
  await page.keyboard.press('Shift+F10')
  assert.deepEqual(
    await save(() => chooseDownload('Download file'), 'image.bin'),
    binary,
  )
  await file('image.bin').click({ button: 'right' })
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  assert.equal(await menu.count(), 0)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await project('Preparing project').focus()
  await page.keyboard.press('Shift+F10')
  assert.equal(await menu.getByRole('menuitem').count(), 1)
  assert.equal(await menu.getByRole('menuitem').isDisabled(), true)
  assert.equal(
    await menu.evaluate((element) => element === document.activeElement),
    true,
  )
  await page.keyboard.press('Escape')
  assert.equal(
    await project('Preparing project').evaluate(
      (element) => element === document.activeElement,
    ),
    true,
  )
  report.checks.push(
    'Right-click preserves selection; saved Unicode and binary files download exactly; keyboard navigation, Escape focus restoration (including disabled-only menus), and outside dismissal work.',
  )

  await tree.locator('.dependency-toggle').click()
  await file(dependency).click({ button: 'right' })
  assert.equal(await menu.getByRole('menuitem').count(), 1)
  assert.equal(
    (
      await save(() => chooseDownload('Download file'), 'Example.lean')
    ).toString(),
    sources[dependency],
  )
  report.checks.push(
    'Read-only dependency files can be downloaded without offering a trash action.',
  )

  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+End')
  const marker = '\n-- Unsaved download fixture\n'
  await page.keyboard.insertText(marker)
  await tree.getByLabel('Unsaved changes').waitFor()
  const requestsBeforeDirty = downloads.length
  await file('Main.lean').click({ button: 'right' })
  assert.equal(
    (await save(() => chooseDownload('Download file'), 'Main.lean')).toString(),
    main + marker,
  )
  assert.equal(downloads.length, requestsBeforeDirty)
  assert.equal(state.files[projectId]['Main.lean'], main)

  await project('Download project').click({ button: 'right' })
  await menu
    .getByText('Saved files only. Save edits first.', { exact: true })
    .waitFor()
  const zipBuffer = await save(
    () => chooseDownload('Download project ZIP'),
    'Download project.zip',
  )
  const zip = await JSZip.loadAsync(zipBuffer)
  assert.equal(await zip.file('Main.lean').async('string'), main)
  assert.deepEqual(await zip.file('image.bin').async('nodebuffer'), binary)
  assert.equal(zip.file(dependency), null)
  await page.locator('.project-root-label').click()
  await save(
    () => chooseDownload('Download project ZIP'),
    'Download project.zip',
  )
  report.checks.push(
    'A dirty editor file downloads its current buffer without saving; project and root-row ZIP downloads use the saved project snapshot.',
  )

  await project('Named playground').click({ button: 'right' })
  assert.equal(
    (
      await save(
        () => chooseDownload('Download .lean file'),
        'Named playground.lean',
      )
    ).toString(),
    '-- Saved playground\n',
  )
  assert.equal(await file('Main.lean').getAttribute('aria-current'), 'true')
  report.checks.push(
    'A playground downloads as a named .lean file without switching away from an edited project.',
  )

  failNextDownload = true
  await project('Download project').click({ button: 'right' })
  await chooseDownload('Download project ZIP')
  await page
    .getByRole('alert')
    .filter({
      hasText: 'This archive is too large. Download individual files instead.',
    })
    .waitFor()
  assert.equal(state.files[projectId]['Main.lean'], main)
  assert.equal(await tree.getByLabel('Unsaved changes').count(), 1)
  report.checks.push(
    'Download errors appear in the existing workspace alert and preserve unsaved work.',
  )

  await page.setViewportSize({ width: 390, height: 844 })
  const touch = await page.context().newCDPSession(page)
  await touch.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 1,
  })
  assert.equal(
    await page.evaluate(() => matchMedia('(hover: none)').matches),
    true,
  )
  await page.getByRole('button', { name: 'Open projects and files' }).click()
  const projectActions = page.getByRole('button', {
    name: 'Actions for project Download project',
    exact: true,
  })
  await projectActions.scrollIntoViewIfNeeded()
  const actionBounds = await projectActions.boundingBox()
  assert(actionBounds)
  assert.equal(
    await projectActions.evaluate(
      (element) => getComputedStyle(element).opacity,
    ),
    '1',
  )
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      {
        x: actionBounds.x + actionBounds.width / 2,
        y: actionBounds.y + actionBounds.height / 2,
      },
    ],
  })
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  await menu.waitFor()
  let bounds = await menu.boundingBox()
  assert(
    bounds &&
      bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= 390 &&
      bounds.y + bounds.height <= 844,
  )
  await page.screenshot({ path: path.join(output, 'context-menu-mobile.png') })
  await page.keyboard.press('Escape')
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await touch.detach()
  await page.setViewportSize({ width: 1500, height: 1100 })
  const box = await page.locator('.project-root-label').boundingBox()
  assert(box)
  await page.locator('.project-root-label').click({ button: 'right' })
  await page
    .locator('.project-root-label')
    .dispatchEvent('contextmenu', { clientX: 1498, clientY: 1098 })
  bounds = await menu.boundingBox()
  assert(
    bounds &&
      bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= 1500 &&
      bounds.y + bounds.height <= 1100,
  )
  await page.screenshot({ path: path.join(output, 'context-menu-edge.png') })
  report.checks.push(
    'Context menus remain inside desktop and mobile viewports, including clicks at the lower-right edge.',
  )
  report.checks.push(
    'File, project-root and touch project controls open menus with a regular click or tap; streaming updates and unrelated scrolling preserve menu focus; ZIP menus explain that only saved files are included.',
  )
  await page.keyboard.press('Escape')
  expireNextDownload = true
  await project('Download project').click({ button: 'right' })
  await chooseDownload('Download project ZIP')
  await page.getByRole('dialog', { name: 'Sign in to continue' }).waitFor()
  assert.equal(await tree.getByLabel('Unsaved changes').count(), 1)
  assert.equal(state.files[projectId]['Main.lean'], main)
  report.checks.push(
    'An expired session during download opens the existing sign-in recovery dialog and retains the dirty editor buffer.',
  )
  state.files[playgroundId]['Extra.lean'] = '-- Additional playground source\n'
  await page.evaluate(
    (id) => localStorage.setItem('lemex-project', id),
    playgroundId,
  )
  await fixture.ready()
  await page.locator('.project-root-label').click({ button: 'right' })
  const playgroundArchive = await JSZip.loadAsync(
    await save(
      () => chooseDownload('Download project ZIP'),
      'Download project.zip',
    ),
  )
  assert.equal(
    await playgroundArchive.file('Extra.lean').async('string'),
    state.files[playgroundId]['Extra.lean'],
  )
  assert.deepEqual(downloads.at(-1), { projectId: playgroundId, path: null })
  report.checks.push(
    'A playground with additional files downloads a ZIP from its visible project root.',
  )
  assert(
    report.requests.every((request) => request.method === 'GET'),
    'Download checks must not write project files or call an agent',
  )
  fixture.assertClean()
  report.downloads = downloads
  report.ok = true
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log('Download browser checks passed.')
} catch (error) {
  if (fixture) {
    fixture.report.ok = false
    fixture.report.failure = error.stack || error.message
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(fixture.report, null, 2),
    )
    await fixture.page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {})
  }
  throw error
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
