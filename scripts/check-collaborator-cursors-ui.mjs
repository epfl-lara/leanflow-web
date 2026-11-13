#!/usr/bin/env node
// Real Monaco views and document service; no provider calls or user projects.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { ProjectDocuments } from '../server/project-documents.mjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const projectId = 'collaborator-cursors-fixture'
const output = path.resolve('.runtime/collaborator-cursors-ui')
const profiles = {
  alice: { name: 'Alice Example', role: 'admin' },
  bob: { name: 'Bob Example', role: 'editor' },
  viewer: { name: 'Viewer Example', role: 'viewer' },
  'visual-peer-124': {
    name: 'A collaborator with a deliberately very long display name for layout testing',
    role: 'editor',
  },
}
const sources = {
  'Main.lean': '-- first line\n-- second line\nexample : True := by trivial\n',
  'Other.lean': '-- another file\nexample : 1 = 1 := rfl\n',
}
const hash = (content) => createHash('sha256').update(content).digest('hex')
const listeners = new Set()
const browsers = []
const requests = []
const sockets = new Map()
const report = { passed: false, checks: [], visualSamples: [] }
const workspaces = {
  get(_project, actor) {
    return { id: projectId, accessRole: profiles[actor].role }
  },
  requireEditor(project, actor) {
    if (profiles[actor].role === 'viewer')
      throw Object.assign(new Error('This project is read only.'), {
        status: 403,
      })
    return this.get(project, actor)
  },
  subscribeChanges(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  async readFile(_project, _actor, name) {
    return { content: sources[name], hash: hash(sources[name]) }
  },
  async writeFile(project, actor, name, content, expectedHash, options) {
    this.requireEditor(project, actor)
    options?.assertAuthorized?.()
    assert.equal(hash(sources[name]), expectedHash)
    sources[name] = content
    for (const listener of listeners)
      listener({ projectId, kind: 'files', paths: [name] })
    return { content, hash: hash(content) }
  },
}
const documents = new ProjectDocuments({
  workspaces,
  displayName: (actor) => profiles[actor].name,
})
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`

async function browser(actor) {
  const fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: actor, name: profiles[actor].name },
      models: [],
      templates: [],
      runtime: { ready: true },
    },
    projects: [
      {
        id: projectId,
        name: 'Cursor fixture',
        accessRole: profiles[actor].role,
        status: 'ready',
      },
    ],
    files: { [projectId]: sources },
    chats: [{ id: `${actor}-chat`, projectId, title: 'Fixture' }],
    runs: [],
  })
  browsers.push(fixture)
  fixture.state.files[projectId] = sources
  await fixture.page.routeWebSocket(
    '**/websocket/collaboration/**',
    (socket) => {
      const ws = new EventEmitter()
      ws.readyState = 1
      ws.bufferedAmount = 0
      ws.send = (raw) => {
        if (ws.readyState === 1) socket.send(raw)
      }
      ws.close = (code = 1000, reason = '') => {
        if (ws.readyState !== 1) return
        ws.readyState = 3
        socket.close({ code, reason })
        ws.emit('close')
      }
      ws.terminate = () => ws.close()
      ws.ping = () => ws.emit('pong')
      socket.onMessage((raw) => {
        requests.push({ actor, ...JSON.parse(String(raw)) })
        ws.emit('message', Buffer.from(String(raw)))
      })
      socket.onClose(() => {
        if (ws.readyState !== 1) return
        ws.readyState = 3
        ws.emit('close')
      })
      sockets.set(actor, ws)
      documents.connect(ws, projectId, actor)
    },
  )
  await fixture.ready()
  await fixture.page
    .getByText('Joining live editing…', { exact: true })
    .waitFor({ state: 'hidden' })
  return fixture
}

const editor = (fixture) =>
  fixture.page.locator('.monaco-editor textarea').first()
const label = (fixture, actor) =>
  fixture.page
    .locator('.collaborator-cursor-label')
    .filter({ hasText: profiles[actor].name })
const record = (check) => report.checks.push(check)
async function cursor(fixture, ...keys) {
  await editor(fixture).focus()
  for (const key of keys) await fixture.page.keyboard.press(key)
}
async function select(fixture, filename) {
  await fixture.page
    .locator('.file-item')
    .and(fixture.page.getByTitle(filename, { exact: true }))
    .click()
  await until(
    async () =>
      (
        await fixture.page.locator('.file-tab').getAttribute('aria-label')
      ).includes(filename),
    `open ${filename}`,
  )
  await fixture.page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await fixture.page
    .getByText('Joining live editing…', { exact: true })
    .waitFor({ state: 'hidden' })
}
async function color(fixture, actor) {
  let background
  await until(async () => {
    background = await label(fixture, actor).evaluate((element) => {
      if (!element.isConnected || !element.getClientRects().length) return null
      return getComputedStyle(element).backgroundColor
    })
    return (
      background && !['transparent', 'rgba(0, 0, 0, 0)'].includes(background)
    )
  }, `visible assigned color for ${profiles[actor].name}`)
  return background
}

async function capture(fixture, name) {
  await fixture.page.screenshot({
    path: path.join(output, name + '.png'),
    fullPage: true,
  })
}

async function visibleBounds(locator) {
  let bounds
  await until(async () => {
    bounds = await locator.boundingBox()
    return bounds && bounds.width > 0 && bounds.height > 0
  }, 'a rendered collaborator geometry sample')
  return bounds
}

async function captureEditor(fixture, name) {
  const bounds = await fixture.page
    .locator('.monaco-editor')
    .first()
    .boundingBox()
  assert(bounds)
  await fixture.page.screenshot({
    path: path.join(output, name + '.png'),
    clip: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: Math.min(bounds.height, 210),
    },
  })
}

async function contrast(fixture, actor) {
  return label(fixture, actor).evaluate((element) => {
    const luminance = (color) => {
      const channels = color
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number)
      assertColor(channels)
      const linear = channels.map((channel) => {
        const value = channel / 255
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4
      })
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
    }
    function assertColor(channels) {
      if (!channels || channels.length !== 3)
        throw new Error('Expected a rendered RGB color')
    }
    const ratio = (a, b) => {
      const x = luminance(a),
        y = luminance(b)
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
    }
    const style = getComputedStyle(element)
    const editor = element.closest('.monaco-editor')
    const caret = editor?.querySelector(
      '.collaborator-cursor.collaborator-color-60',
    )
    if (!editor || !caret) throw new Error('Expected a yellow fixture cursor')
    return {
      label: ratio(style.color, style.backgroundColor),
      caret: ratio(
        getComputedStyle(caret).borderLeftColor,
        getComputedStyle(editor).backgroundColor,
      ),
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }
  })
}

try {
  await fs.mkdir(output, { recursive: true })
  const alice = await browser('alice')
  const bob = await browser('bob')
  const viewer = await browser('viewer')
  await until(
    () =>
      [...documents.documents.values()].some(
        (document) =>
          document.path === 'Main.lean' && document.clients.size === 3,
      ),
    'three document subscribers',
  )
  await cursor(alice, editorShortcuts.documentStart, 'ArrowRight', 'ArrowRight')
  await cursor(bob, editorShortcuts.documentStart, 'ArrowDown', 'ArrowRight')
  await label(alice, 'bob').waitFor({ state: 'visible' })
  await label(bob, 'alice').waitFor({ state: 'visible' })
  await label(viewer, 'alice').waitFor({ state: 'visible' })
  await label(viewer, 'bob').waitFor({ state: 'visible' })
  assert((await alice.page.locator('.collaborator-cursor').count()) > 0)
  assert.equal(await label(alice, 'alice').count(), 0)
  const aliceColor = await color(viewer, 'alice')
  const bobColor = await color(viewer, 'bob')
  assert.notEqual(aliceColor, bobColor, 'collaborators have distinct colors')
  assert.equal(
    await color(bob, 'alice'),
    aliceColor,
    'the same account has the same color in every browser',
  )
  record(
    'Editors and viewers see named, colored collaborator carets; account colors are consistent across browsers.',
  )

  const before = await visibleBounds(label(alice, 'bob'))
  report.movementBaseline = before
  await cursor(bob, 'ArrowDown', 'ArrowRight', 'ArrowRight')
  await until(async () => {
    const after = await label(alice, 'bob').boundingBox()
    return (
      after &&
      before &&
      (Math.abs(after.y - before.y) > 2 || Math.abs(after.x - before.x) > 2)
    )
  }, 'collaborator caret movement')
  await cursor(bob, editorShortcuts.lineStart, editorShortcuts.selectLineEnd)
  await alice.page
    .locator('.collaborator-selection')
    .first()
    .waitFor({ state: 'visible' })
  record(
    'Remote cursor movement and selected text appear without editing the file.',
  )

  await cursor(bob, editorShortcuts.documentStart, 'ArrowDown', 'ArrowRight')
  await label(viewer, 'bob').waitFor({ state: 'visible' })
  // A peer stays at the same text while someone else inserts a preceding line.
  // Its marker must move once with that text, including in a third-party view.
  await until(
    () =>
      requests.some(
        (request) =>
          request.actor === 'bob' &&
          request.type === 'presence' &&
          request.head === '-- first line\n'.length + 1,
      ),
    'stationary peer publishes its cursor',
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  const beforeInsertion = await visibleBounds(label(viewer, 'bob'))
  const line = await visibleBounds(
    viewer.page.locator('.monaco-editor .view-line').first(),
  )
  assert(beforeInsertion && line)
  await cursor(alice, editorShortcuts.documentStart)
  await alice.page.keyboard.insertText('-- INSERTED_BEFORE_CURSOR\n')
  await until(async () => {
    const after = await label(viewer, 'bob').boundingBox()
    return after && Math.abs(after.y - beforeInsertion.y - line.height) < 2
  }, 'stationary cursor tracks exactly one inserted line')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const afterInsertion = await visibleBounds(label(viewer, 'bob'))
  assert(afterInsertion)
  assert(
    Math.abs(afterInsertion.y - beforeInsertion.y - line.height) < 2,
    'the settled cursor position must not apply the same text movement twice',
  )
  record(
    'A stationary collaborator cursor follows its text exactly once when another editor inserts a preceding line.',
  )

  await cursor(viewer, editorShortcuts.documentStart, 'ArrowRight')
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert(
    !requests.some(
      (request) =>
        request.actor === 'viewer' &&
        request.type === 'presence' &&
        request.path !== null,
    ),
    'viewers never advertise an editing cursor',
  )
  record(
    'Read-only viewers receive presence without publishing editing cursors.',
  )

  await cursor(bob, editorShortcuts.documentEnd)
  await bob.page.keyboard.insertText('-- SHARED_CURSOR_EDIT\n')
  await until(
    () => sources['Main.lean'].includes('SHARED_CURSOR_EDIT'),
    'collaborative edit saved',
  )
  await until(
    async () =>
      (
        await alice.page.locator('.monaco-editor .view-lines').innerText()
      ).includes('SHARED_CURSOR_EDIT'),
    'collaborative edit received',
  )
  await label(alice, 'bob').waitFor({ state: 'visible' })
  record(
    'Typing still saves and synchronizes while collaborator cursors are displayed.',
  )

  await select(bob, 'Other.lean')
  await label(alice, 'bob').waitFor({ state: 'hidden' })
  await select(bob, 'Main.lean')
  await cursor(bob, editorShortcuts.documentStart, 'ArrowRight')
  await label(alice, 'bob').waitFor({ state: 'visible' })
  assert.equal(
    await color(alice, 'bob'),
    bobColor,
    'reopening a file preserves account color',
  )
  record(
    'Changing files removes the old cursor; reopening restores the same collaborator color.',
  )

  const yellow = await browser('visual-peer-124')
  await cursor(
    bob,
    editorShortcuts.documentStart,
    'ArrowDown',
    'ArrowDown',
    'ArrowRight',
  )
  await cursor(yellow, editorShortcuts.documentStart)
  await label(viewer, 'visual-peer-124').waitFor({ state: 'visible' })
  const firstLine = await visibleBounds(
    viewer.page.locator('.monaco-editor .view-line').first(),
  )
  const firstLabel = await visibleBounds(label(viewer, 'visual-peer-124'))
  assert(firstLine && firstLabel)
  await capture(viewer, 'cursors-first-line')
  assert(
    firstLabel.y + firstLabel.height <= firstLine.y + 1,
    'first-line names fit in the editor top padding',
  )

  for (const theme of ['dark', 'light']) {
    if (theme === 'light')
      await viewer.page
        .getByRole('button', { name: 'Use light theme', exact: true })
        .click()
    await until(
      () =>
        viewer.page
          .locator('html')
          .getAttribute('data-theme')
          .then((value) => value === theme),
      theme + ' theme',
    )
    const sample = await contrast(viewer, 'visual-peer-124')
    report.visualSamples.push({ theme, ...sample })
    for (const actor of ['alice', 'bob', 'visual-peer-124']) {
      const text = await contrast(viewer, actor)
      assert(
        text.label >= 4.5,
        `${theme} ${actor} label text has readable contrast: ${text.label}`,
      )
    }
    assert(
      sample.caret >= 3,
      `${theme} carets contrast with the editor: ${sample.caret}`,
    )
    assert(sample.width <= 181, 'long collaborator labels stay bounded')
    await capture(viewer, `cursors-${theme}-desktop`)
    await captureEditor(viewer, `cursors-${theme}-detail`)
    await viewer.page.setViewportSize({ width: 390, height: 844 })
    await viewer.page
      .getByRole('button', { name: 'Close tools panel', exact: true })
      .click()
    await label(viewer, 'visual-peer-124').waitFor({ state: 'visible' })
    await capture(viewer, `cursors-${theme}-narrow`)
    assert.equal(
      await viewer.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
      'narrow collaboration view does not overflow the page',
    )
    await viewer.page.setViewportSize({ width: 1600, height: 1000 })
    await viewer.page
      .getByRole('button', { name: 'Lemex', exact: true })
      .click()
  }
  record(
    'Long collaborator names and colored carets remain readable in light/dark themes and fit narrow viewports; first-line labels stay above the source.',
  )

  await cursor(
    bob,
    editorShortcuts.documentStart,
    'ArrowDown',
    'ArrowDown',
    editorShortcuts.lineEnd,
    'Shift+ArrowUp',
    'Shift+ArrowUp',
  )
  await until(
    () =>
      viewer.page
        .locator('.collaborator-selection')
        .count()
        .then((count) => count >= 2),
    'reverse multiline selection',
  )
  await capture(viewer, 'cursors-multiline-selection')
  record('Reverse selections highlight every selected source line.')

  await cursor(yellow, editorShortcuts.documentEnd)
  await yellow.page.keyboard.insertText(
    Array.from({ length: 100 }, (_, index) => `-- SCROLL_LINE_${index}\n`).join(
      '',
    ),
  )
  await until(
    () => sources['Main.lean'].includes('SCROLL_LINE_99'),
    'long source saved',
  )
  const firstVisibleLine = () =>
    viewer.page
      .locator('.monaco-editor')
      .first()
      .evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return [...element.querySelectorAll('.line-numbers')]
          .filter((line) => {
            const row = line.getBoundingClientRect()
            return row.top >= bounds.top && row.bottom <= bounds.bottom
          })
          .map((line) => Number(line.textContent))
          .filter((line) => Number.isSafeInteger(line) && line > 0)
          .sort((a, b) => a - b)[0]
      })
  const beforePeerScroll = await firstVisibleLine()
  await cursor(bob, editorShortcuts.documentEnd)
  await label(viewer, 'bob').waitFor({ state: 'hidden' })
  assert.equal(
    await firstVisibleLine(),
    beforePeerScroll,
    'an offscreen peer cursor never scrolls the reader',
  )
  // Monaco maintains its own scroll position rather than native scrollTop.
  // Navigate the read-only reader to the end using the same keyboard input
  // users use; compare visible line numbers to check viewport preservation.
  await cursor(viewer, editorShortcuts.documentEnd)
  await label(viewer, 'bob').waitFor({ state: 'visible' })
  const assertSeparateNames = async () => {
    const bobName = await visibleBounds(label(viewer, 'bob'))
    const otherName = await visibleBounds(label(viewer, 'visual-peer-124'))
    const intersectionWidth =
      Math.min(bobName.x + bobName.width, otherName.x + otherName.width) -
      Math.max(bobName.x, otherName.x)
    const intersectionHeight =
      Math.min(bobName.y + bobName.height, otherName.y + otherName.height) -
      Math.max(bobName.y, otherName.y)
    assert(
      intersectionWidth <= 0 || intersectionHeight <= 0,
      'people at the same cursor position have separate visible names',
    )
  }
  await assertSeparateNames()
  await capture(viewer, 'cursors-scrolled')
  await viewer.page.setViewportSize({ width: 390, height: 844 })
  await viewer.page
    .getByRole('button', { name: 'Close tools panel', exact: true })
    .click()
  await cursor(viewer, editorShortcuts.documentEnd)
  await label(viewer, 'bob').waitFor({ state: 'visible' })
  await assertSeparateNames()
  assert.equal(
    await viewer.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  )
  await capture(viewer, 'cursors-shared-position-narrow')
  await viewer.page.setViewportSize({ width: 1600, height: 1000 })
  await viewer.page.getByRole('button', { name: 'Lemex', exact: true }).click()
  await cursor(viewer, editorShortcuts.documentEnd)
  record(
    'Collaborators at exactly the same text position keep separate visible names on desktop and narrow screens.',
  )
  const scrolled = await firstVisibleLine()
  assert(scrolled > beforePeerScroll, 'the reader controls source scrolling')
  await cursor(bob, editorShortcuts.documentStart)
  await label(viewer, 'bob').waitFor({ state: 'hidden' })
  assert.equal(
    await firstVisibleLine(),
    scrolled,
    'remote cursor navigation preserves the reader’s chosen scroll position',
  )
  record(
    'Offscreen collaborator movement preserves local scroll; scrolling reveals the remote cursor at its actual text position.',
  )

  await alice.page.screenshot({
    path: path.join(output, 'collaborator-cursors.png'),
    fullPage: true,
  })
  // Closing a browser does not notify Playwright's intercepted socket route.
  // Deliver the network close through the same server adapter used above.
  sockets.get('bob').close(1000, 'Fixture browser disconnected')
  await bob.browser.close()
  await label(alice, 'bob').waitFor({ state: 'hidden' })
  record('Disconnected collaborators disappear from the editor.')
  for (const fixture of browsers) fixture.assertClean()
  report.passed = true
} catch (error) {
  report.failure = error.stack || String(error)
  report.presenceDiagnostics = requests
    .filter((request) => request.type === 'presence')
    .slice(-12)
  if (browsers.length) {
    await capture(browsers[0], 'failure-cursors')
    if (browsers[2]) await capture(browsers[2], 'failure-viewer-cursors')
    report.labelDiagnostics = await browsers[0].page
      .locator('.collaborator-cursor-label')
      .evaluateAll((elements) =>
        elements.map((element) => ({
          text: element.textContent,
          bounds: element.getBoundingClientRect().toJSON(),
          parent: element.parentElement.outerHTML,
        })),
      )
  }
  throw error
} finally {
  for (const fixture of browsers) await fixture.browser.close()
  await documents.close()
  await new Promise((resolve) => server.close(resolve))
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report))
