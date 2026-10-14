#!/usr/bin/env node
// Mock backend traffic and terminal bytes; never touch a real user project.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const id = 'terminal-ui-fixture'
const source = 'example : True := by\n  trivial\n'
const f = await chatBrowserFixture({
  session: {
    user: { id: 'fixture', name: 'Fixture' },
    models: [],
    templates: [],
    runtime: { ready: true },
  },
  projects: [
    { id, name: 'Terminal fixture', status: 'ready' },
    { id: 'other-terminal-project', name: 'Other fixture', status: 'ready' },
  ],
  files: {
    [id]: { 'Main.lean': source },
    'other-terminal-project': { 'Main.lean': source },
  },
  chats: [{ id: 'fixture-chat', projectId: id, title: 'Fixture', runCount: 0 }],
  runs: [],
})
const directory = path.resolve('.runtime/terminal-ui')
await fs.mkdir(directory, { recursive: true })
const messages = []
const sockets = []
let closed = 0
let expectedHash
await f.page.routeWebSocket('**/websocket/terminal/**', (socket) => {
  sockets.push(socket)
  socket.onClose(() => {
    closed++
  })
  socket.onMessage((raw) => messages.push(JSON.parse(String(raw))))
  socket.send(Buffer.from('\x1b[32mTerminal ready α\x1b[0m\r\n/workspace $ '))
})
await f.page.route(`**/api/projects/${id}/file?path=Main.lean`, (route) => {
  if (route.request().method() !== 'PUT') return route.fallback()
  expectedHash = route.request().postDataJSON().expectedHash
  return route.fulfill({
    status: 409,
    json: {
      error: 'The saved file changed. Reload it before saving your edits.',
    },
  })
})
try {
  await f.ready()
  await f.page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const panel = f.page.getByRole('region', {
    name: 'Project terminal',
    exact: true,
  })
  await panel.getByText('Connected', { exact: true }).waitFor()
  await until(
    async () =>
      (await panel.locator('.xterm-accessibility-tree').innerText()).includes(
        'Terminal ready α',
      ),
    'rendered terminal output',
  )
  const input = f.page.getByLabel('Project terminal input')
  await input.focus()
  await f.page.keyboard.type('lake build')
  await f.page.keyboard.press('Enter')
  await f.page.keyboard.press('Control+c')
  await until(
    () =>
      messages
        .filter((message) => message.type === 'input')
        .map((message) => message.data)
        .join('')
        .includes('lake build\r\x03'),
    'terminal input and Ctrl+C',
  )
  assert(
    messages.some((message) => message.type === 'ack' && message.bytes > 0),
  )
  assert(
    messages.some(
      (message) =>
        message.type === 'resize' && message.cols > 0 && message.rows > 0,
    ),
  )
  const previousSize = messages
    .filter((message) => message.type === 'resize')
    .at(-1)
  await f.page
    .getByRole('separator', { name: 'Resize terminal', exact: true })
    .focus()
  await f.page.keyboard.press('ArrowUp')
  await f.page.keyboard.press('ArrowUp')
  await until(
    () =>
      messages.filter((message) => message.type === 'resize').at(-1).rows >
      previousSize.rows,
    'PTY resize',
  )
  f.report.checks.push(
    'Terminal renders ANSI and Unicode output, sends commands and Ctrl+C, acknowledges output, and resizes.',
  )

  const divider = f.page.getByRole('separator', {
    name: 'Resize terminal',
    exact: true,
  })
  const boundary = await divider.boundingBox()
  const terminalBounds = await panel.boundingBox()
  assert(boundary && terminalBounds && boundary.height >= 10)
  assert(
    Math.abs(boundary.y + boundary.height - terminalBounds.y) < 2,
    'Divider sits at the top of the terminal',
  )
  await f.page.mouse.move(
    boundary.x + boundary.width / 2,
    boundary.y + boundary.height / 2,
  )
  await f.page.mouse.down()
  await f.page.mouse.move(boundary.x + boundary.width / 2, boundary.y - 24)
  await f.page.mouse.up()
  await until(
    async () => (await panel.boundingBox()).height > terminalBounds.height + 10,
    'visible terminal divider drag',
  )
  await f.page.screenshot({ path: path.join(directory, 'terminal-dark.png') })
  await f.page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  await until(
    async () => (await panel.getAttribute('class')).includes('light'),
    'light terminal theme',
  )
  await f.page.screenshot({ path: path.join(directory, 'terminal-light.png') })
  const lightPanel = await panel.boundingBox()
  await f.page.screenshot({
    path: path.join(directory, 'terminal-detail-light.png'),
    clip: {
      x: lightPanel.x,
      y: lightPanel.y - 35,
      width: lightPanel.width,
      height: 185,
    },
  })
  await f.page.getByRole('button', { name: 'Lemex', exact: true }).click()
  await f.page.setViewportSize({ width: 580, height: 850 })
  const narrow = await panel.boundingBox()
  const closeBounds = await panel
    .getByRole('button', { name: 'Close terminal', exact: true })
    .boundingBox()
  assert(
    narrow &&
      closeBounds &&
      closeBounds.x + closeBounds.width <= narrow.x + narrow.width,
    'Close control remains within the narrow panel',
  )
  await panel
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click({ trial: true })
  await f.page.screenshot({ path: path.join(directory, 'terminal-narrow.png') })
  await f.page.setViewportSize({ width: 1600, height: 1000 })
  await f.page
    .getByRole('button', { name: 'Use dark theme', exact: true })
    .click()
  f.report.checks.push(
    'The terminal has a visible, draggable boundary in both themes and labelled controls that fit narrow layouts.',
  )

  f.state.files[id]['Main.lean'] = source + '-- saved from the terminal\n'
  await until(
    async () =>
      (await f.page.locator('.monaco-editor').innerText())
        .replaceAll('\u00a0', ' ')
        .includes('saved from the terminal'),
    'clean editor refresh',
  )
  await f.page.locator('.monaco-editor textarea').focus()
  await f.page.keyboard.press('Control+End')
  await f.page.keyboard.insertText('-- unsaved editor work\n')
  f.state.files[id]['Main.lean'] = source + '-- another terminal write\n'
  await f.page
    .getByText('The saved file changed outside this editor.', { exact: false })
    .waitFor()
  assert(
    (await f.page.locator('.monaco-editor').innerText())
      .replaceAll('\u00a0', ' ')
      .includes('unsaved editor work'),
  )
  assert(
    !(await f.page.locator('.monaco-editor').innerText())
      .replaceAll('\u00a0', ' ')
      .includes('another terminal write'),
  )
  await f.page.getByRole('button', { name: 'Save', exact: true }).click()
  await until(() => expectedHash !== undefined, 'save conflict request')
  assert.equal(
    expectedHash,
    createHash('sha256')
      .update(source + '-- saved from the terminal\n')
      .digest('hex'),
  )
  await f.page
    .getByText('The saved file changed. Reload it before saving your edits.', {
      exact: true,
    })
    .waitFor()
  assert(
    (await f.page.locator('.monaco-editor').innerText())
      .replaceAll('\u00a0', ' ')
      .includes('unsaved editor work'),
  )
  f.report.checks.push(
    'Saved writes refresh clean editors; unsaved text and expected-hash conflicts survive terminal writes.',
  )

  await f.page.getByRole('button', { name: 'Lemex', exact: true }).click()
  assert(
    await panel.isVisible(),
    'assistant remains usable beside the terminal',
  )
  sockets.at(-1).send(
    JSON.stringify({
      type: 'error',
      message: 'Fixture worker unavailable. Try again.',
    }),
  )
  sockets.at(-1).close({ code: 1011, reason: 'Fixture failure' })
  await panel
    .getByText('Fixture worker unavailable. Try again.', { exact: true })
    .waitFor()
  const connectionsBeforeReconnect = sockets.length
  await panel
    .getByRole('button', { name: 'Reconnect terminal', exact: true })
    .click()
  await until(
    () => sockets.length > connectionsBeforeReconnect,
    'new shell connection',
  )
  await panel.getByText('Connected', { exact: true }).waitFor()
  await f.page.screenshot({ path: path.join(directory, 'terminal.png') })
  const closedBeforeButton = closed
  await f.page
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  await until(() => closed > closedBeforeButton, 'closed terminal connections')
  assert.equal(await panel.count(), 0)
  f.report.checks.push(
    'Assistant controls stay responsive; connection errors, reconnect, and close work.',
  )

  await f.page.getByRole('button', { name: 'Terminal', exact: true }).click()
  await panel.getByText('Connected', { exact: true }).waitFor()
  const closedBeforeSwitch = closed
  // Discard unsaved text through the existing navigation dialog.
  await f.page
    .getByRole('button', { name: /Other fixture/ })
    .first()
    .click()
  await f.page.getByRole('button', { name: /Discard/ }).click()
  await until(
    () => closed > closedBeforeSwitch,
    'workspace switch stops terminal',
  )
  assert.equal(await panel.count(), 0)
  f.report.checks.push('Switching workspaces disconnects the old terminal.')
  f.assertClean()
  console.log(
    JSON.stringify({ passed: true, checks: f.report.checks }, null, 2),
  )
} finally {
  await f.page.screenshot({ path: path.join(directory, 'latest.png') })
  await fs.writeFile(
    path.join(directory, 'editor.txt'),
    await f.page
      .locator('.monaco-editor')
      .innerText()
      .catch(() => 'Editor closed'),
  )
  await fs.writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(f.report, null, 2) + '\n',
  )
  await f.browser.close()
}
