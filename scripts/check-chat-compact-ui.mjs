#!/usr/bin/env node
// Browser layout regression with mocked chats, files, Lean, and providers.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportDir = path.join(root, '.runtime/chat-compact-ui')
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'compact-ui-project'
const chatId = 'compact-ui-chat'
const active = {
  id: 'compact-ui-run',
  projectId,
  chatId,
  status: 'running',
  mode: 'repair',
  createdAt: '2026-10-13T09:00:00Z',
  prompt: 'Prove the example.',
  message: Array.from(
    { length: 35 },
    (_, i) => `Progress ${i}: checking a useful lemma.\n\n`,
  ).join(''),
  progress: { label: 'Checking Main.lean', detail: 'Inspecting diagnostics' },
  eventCursor: 1,
  followups: [],
  liveEdits: false,
}
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [
      {
        id: 'fixture-model',
        name: 'Fixture model',
        reasoningEfforts: [{ id: 'low' }, { id: 'high' }],
        defaultReasoningEffort: 'low',
      },
    ],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Compact UI fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: {
    [projectId]: Object.fromEntries(
      [
        'Main.lean',
        ...Array.from(
          { length: 12 },
          (_, i) => `Proof${String(i).padStart(2, '0')}.lean`,
        ),
      ].map((name) => [name, 'example : True := by trivial\n']),
    ),
  },
  chats: [
    { id: chatId, projectId, title: 'A proof conversation', runCount: 1 },
  ],
  runs: [active],
})
const { page, browser, report } = fixture
const composer = page.getByLabel('Message Lemex')
const send = page.getByRole('button', { name: 'Send update', exact: true })
const stop = page.getByRole('button', { name: 'Stop', exact: true })
async function reachable(control) {
  await control.scrollIntoViewIfNeeded()
  await control.click({ trial: true })
  const box = await control.boundingBox()
  assert(
    box && box.y >= 0 && box.y + box.height <= page.viewportSize().height + 1,
    `Control is outside viewport: ${JSON.stringify(box)}`,
  )
}
try {
  await fixture.ready()
  await composer.waitFor()
  await composer.fill('Keep checking the proof.')
  for (const viewport of [
    { width: 390, height: 550 },
    { width: 844, height: 390 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport)
    for (const open of [false, true]) {
      await page.locator('.chat-options').evaluate((element, value) => {
        element.open = value
      }, open)
      await reachable(send)
      await page.screenshot({
        path: path.join(
          reportDir,
          `${viewport.width}x${viewport.height}-${open ? 'options' : 'collapsed'}-send.png`,
        ),
      })
      await reachable(stop)
      const region = await page
        .getByRole('region', { name: 'Conversation', exact: true })
        .boundingBox()
      assert(region.height >= Math.min(200, viewport.height * 0.3) - 1)
    }
    report.checks.push(
      `${viewport.width}x${viewport.height}: Stop and Send remain reachable with options open or closed`,
    )
  }
  await page.setViewportSize({ width: 390, height: 550 })
  await page.getByRole('button', { name: 'Rename chat', exact: true }).click()
  await reachable(send)
  await reachable(stop)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  report.checks.push(
    'Small viewport remains usable while renaming and options are both expanded',
  )

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.chat-options').evaluate((element) => {
    element.open = false
  })
  await composer.fill('@Proof')
  for (let i = 0; i < 7; i++) await composer.press('ArrowDown')
  const list = page.getByRole('listbox', { name: 'Project files', exact: true })
  async function selectedVisible() {
    return list.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      const option = element
        .querySelector('[aria-selected="true"]')
        .getBoundingClientRect()
      return option.top >= bounds.top - 1 && option.bottom <= bounds.bottom + 1
    })
  }
  await until(selectedVisible, 'last keyboard file result fully visible')
  assert(
    (await list.getByRole('option', { selected: true }).innerText()).includes(
      'Proof07.lean',
    ),
  )
  await page.screenshot({
    path: path.join(reportDir, 'mention-last-result.png'),
  })
  await composer.press('Enter')
  assert.equal(await composer.inputValue(), '@Proof07.lean ')
  await composer.fill('@Proof')
  await composer.press('ArrowUp')
  await until(selectedVisible, 'wrapped file result fully visible')
  await composer.press('ArrowDown')
  await until(selectedVisible, 'first keyboard file result fully visible again')
  report.checks.push(
    'Arrow keys scroll the file suggestion list in both directions and Enter attaches the selected file',
  )
  const desktop = await page.locator('.chat-workbench').evaluate((element) => ({
    height: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }))
  assert(desktop.scrollHeight <= desktop.height + 1, JSON.stringify(desktop))
  assert.equal(desktop.scrollTop, 0)
  report.checks.push(
    'Normal desktop chat keeps its existing fixed controls without an extra outer scrollbar',
  )
  assert.equal(
    report.requests.filter(
      (request) => !['GET', 'HEAD'].includes(request.method),
    ).length,
    0,
  )
  fixture.assertClean()
  report.passed = true
  console.log(
    `PASS: ${report.checks.length} compact chat and file mention checks; all APIs mocked`,
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
  await page
    .screenshot({ path: path.join(reportDir, 'failure.png'), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
