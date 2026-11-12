#!/usr/bin/env node
// Isolated terminal connections and API traffic; no worker or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/terminal-opening-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
let fixture, releaseStop
try {
  const id = 'terminal-opening-project'
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: {
        id: 'terminal-opening-user',
        name: 'Terminal reviewer',
        role: 'user',
      },
      templates: [],
      models: [],
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [{ id, name: 'Terminal opening project', status: 'ready' }],
    files: { [id]: { 'Main.lean': 'example : True := by trivial\n' } },
    chats: [
      { id: 'terminal-opening-chat', projectId: id, title: 'Fixture chat' },
    ],
    runs: [],
  })
  const { page } = fixture
  const openings = []
  const stops = []
  let holdStop = true
  await page.routeWebSocket('**/websocket/terminal/**', (socket) => {
    assert.equal(
      new URL(socket.url()).searchParams.get('expectedUserId'),
      'terminal-opening-user',
    )
    const openingId = new URL(socket.url()).searchParams.get('openingId')
    openings.push({ openingId, socket })
    socket.send(Buffer.from('Private shell ready\r\n/workspace $ '))
    socket.onMessage(() => {})
  })
  await page.route('**/api/projects/*/terminal/stop', async (route) => {
    assert.equal(
      route.request().headers()['x-leanflow-user'],
      'terminal-opening-user',
    )
    const body = route.request().postDataJSON()
    if (holdStop) {
      holdStop = false
      await new Promise((resolve) => {
        releaseStop = resolve
      })
    }
    // Preserve the server's legacy empty-body behavior in the fixture, so a
    // client regression to an unscoped stop interrupts a replacement shell.
    for (const opening of openings)
      if (!body.openingId || opening.openingId === body.openingId)
        opening.socket.close({ code: 1000, reason: 'Terminal stopped' })
    stops.push(body)
    return route.fulfill({ json: { stopped: true } })
  })
  await fixture.ready()
  const terminal = page.getByRole('button', { name: 'Terminal', exact: true })
  const panel = page.getByRole('region', {
    name: 'Project terminal',
    exact: true,
  })
  await terminal.click()
  await panel.getByText('Connected', { exact: true }).waitFor()
  const first = openings.at(-1)
  await panel
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  await until(() => !!releaseStop, 'old terminal stop held')
  assert.equal(await panel.count(), 0)
  await terminal.click()
  await panel.getByText('Connected', { exact: true }).waitFor()
  const replacement = openings.at(-1)
  assert.match(
    first.openingId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  assert.match(
    replacement.openingId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  assert.notEqual(replacement.openingId, first.openingId)
  releaseStop()
  releaseStop = null
  await until(() => stops.length === 1, 'old terminal stop completed')
  assert.deepEqual(stops[0], { openingId: first.openingId })
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  assert.equal(
    await panel.locator('.terminal-status').getAttribute('data-connected'),
    'true',
  )

  await page.evaluate(() =>
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
    }),
  )
  replacement.socket.close({ code: 1011, reason: 'Fixture disconnect' })
  await panel
    .getByRole('button', { name: 'Reconnect terminal', exact: true })
    .click()
  await panel.getByText('Connected', { exact: true }).waitFor()
  const reconnected = openings.at(-1)
  assert.notEqual(reconnected.openingId, replacement.openingId)
  assert.match(
    reconnected.openingId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  await panel
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  await until(() => stops.length === 2, 'reconnected terminal stop completed')
  assert.deepEqual(stops[1], { openingId: reconnected.openingId })
  assert.equal(await panel.count(), 0)
  fixture.assertClean()
  const result = {
    passed: true,
    checks: [
      'A delayed close stops only its original terminal opening and leaves a replacement shell connected.',
      'Reconnect creates a fresh UUID even without native randomUUID support, and Close sends that identity to the server.',
    ],
  }
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  releaseStop?.()
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
