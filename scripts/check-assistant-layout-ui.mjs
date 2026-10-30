#!/usr/bin/env node
// Assistant controls use fixture files, chats and Lean; no provider requests.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const projectId = 'assistant-layout-fixture'
const fixture = await chatBrowserFixture({
  viewport: { width: 1920, height: 1080 },
  session: {
    user: { id: 'fixture-owner', name: 'Fixture' },
    templates: [],
    models: [{ id: 'fixture', name: 'Fixture' }],
    runtime: { ready: true },
  },
  projects: [{ id: projectId, name: 'Assistant layout', status: 'ready' }],
  files: {
    [projectId]: {
      'Main.lean': 'example : True := by trivial\n',
      'Extra.lean': 'example : True := by trivial\n',
      ...Object.fromEntries(
        Array.from({ length: 18 }, (_, index) => [
          `Proof${index}.lean`,
          'example : True := by trivial\n',
        ]),
      ),
    },
  },
  chats: [{ id: 'layout-chat', projectId, title: 'Assistant layout' }],
  runs: [],
})
const { page, browser, report, state, emit } = fixture
const output = path.resolve('.runtime/assistant-layout-ui')
await fs.mkdir(output, { recursive: true })
const picker = page.locator('.file-context-picker')
const trigger = page.getByLabel('Select files', { exact: true })
const filter = page.getByLabel('Filter context files', { exact: true })
const popup = page.locator('.file-context-popover')
const composer = page.getByLabel('Message Lemex', { exact: true })
const assistant = page.getByRole('complementary', {
  name: 'Lemex assistant',
  exact: true,
})
const resize = page.getByRole('separator', {
  name: 'Resize assistant panel',
  exact: true,
})

async function openPicker() {
  await trigger.click()
  await filter.waitFor()
}
async function closedPicker() {
  await until(
    () => picker.evaluate((node) => !node.open),
    'file picker dismissed',
  )
  await until(
    () => popup.isVisible().then((visible) => !visible),
    'file picker contents dismissed',
  )
  assert.equal(await popup.isVisible(), false)
}
async function width() {
  return (await assistant.boundingBox()).width
}
async function dragToWidth(next) {
  const before = await width()
  const box = await resize.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    box.x + box.width / 2 - (next - before),
    box.y + box.height / 2,
    { steps: 12 },
  )
  await page.mouse.up()
  await until(
    async () => Math.abs((await width()) - next) <= 2,
    `assistant width ${next}`,
  )
}

try {
  await fixture.ready()
  await composer.fill('Explain the current file.')
  await openPicker()
  await filter.fill('Extra')
  await page.getByRole('checkbox', { name: 'Extra.lean', exact: true }).check()
  assert.equal(await popup.isVisible(), true)
  // Selecting a match moves it to another section and can leave focus on body.
  await page.keyboard.press('Escape')
  await closedPicker()
  assert.equal(
    await trigger.evaluate((node) => node === document.activeElement),
    true,
  )
  assert.equal(await composer.inputValue(), 'Explain the current file.')
  assert.equal(await page.locator('.file-context-chip').count(), 1)
  await openPicker()
  await filter.fill('Main')
  await filter.press('Escape')
  await closedPicker()
  report.checks.push(
    'Escape closes the picker after selecting a file or filtering, restores focus, and preserves the message and attachment.',
  )

  for (const outside of [
    page.locator('.file-context-chip-name'),
    page.locator('.composer-footer > span'),
    page.locator('.file-item[title="Main.lean"]'),
  ]) {
    await openPicker()
    await outside.click()
    await closedPicker()
  }
  const frame = page.locator('.infoview-host iframe')
  await frame.waitFor()
  await frame.evaluate((node) => {
    const button = node.contentDocument.createElement('button')
    button.textContent = 'Fixture goals'
    button.style.cssText = 'position:fixed;top:12px;left:12px;z-index:9999'
    node.contentDocument.body.append(button)
  })
  await openPicker()
  await frame
    .contentFrame()
    .getByRole('button', { name: 'Fixture goals' })
    .click()
  await closedPicker()
  await openPicker()
  await trigger.click()
  await closedPicker()
  assert.equal(await page.locator('.file-context-chip').count(), 1)
  await page
    .getByRole('button', { name: 'Remove Extra.lean from context' })
    .click()
  report.checks.push(
    'Clicks on attachments, the composer footer, the editor area, Lean’s frame, or the trigger dismiss the picker without clearing attachments.',
  )

  await dragToWidth(960)
  await page.screenshot({ path: path.join(output, 'half-window.png') })
  await dragToWidth(1200)
  await page.reload()
  await page.locator('.monaco-editor').waitFor()
  await until(
    async () => Math.abs((await width()) - 1200) <= 2,
    'saved wide size',
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await until(async () => (await width()) < 1000, 'width fits smaller screen')
  const editorBounds = await page.locator('.workbench').boundingBox()
  assert(editorBounds.width >= 280)
  assert(editorBounds.x + editorBounds.width <= 1281)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await until(
    async () => Math.abs((await width()) - 1200) <= 2,
    'wide size restored',
  )
  await resize.focus()
  await resize.press('Home')
  await until(async () => Math.abs((await width()) - 280) <= 2, 'minimum width')
  await resize.press('End')
  assert((await width()) > 1200)
  await resize.dblclick()
  await until(async () => Math.abs((await width()) - 368) <= 2, 'default width')
  await dragToWidth(960)
  report.checks.push(
    'The assistant can fill half or more of a 1920px window, remembers widths above 640px, fits smaller screens, and supports keyboard resizing and reset.',
  )

  await composer.fill('Keep this draft while the editor is hidden.')
  const socketsBefore = report.sockets.length
  const editor = await page.locator('.monaco-editor').first().elementHandle()
  await page.getByRole('button', { name: 'Hide editor', exact: true }).click()
  await until(
    async () => (await width()) > 1600,
    'assistant fills editor space',
  )
  assert.equal(await page.locator('.workbench').isVisible(), false)
  assert.equal(await page.locator('.workbench').getAttribute('inert'), '')
  assert.equal(await resize.count(), 0)
  await page.screenshot({ path: path.join(output, 'editor-hidden.png') })
  await page.getByRole('button', { name: 'Show editor', exact: true }).click()
  assert(Math.abs((await width()) - 960) <= 2)
  assert.equal(await editor.evaluate((node) => node.isConnected), true)
  assert.equal(report.sockets.length, socketsBefore)
  await page.getByRole('button', { name: 'Hide editor', exact: true }).click()
  await page.locator('.file-item[title="Extra.lean"]').click()
  await page
    .getByLabel('Current file included automatically: Extra.lean', {
      exact: true,
    })
    .waitFor()
  await page.getByRole('button', { name: 'Show editor', exact: true }).click()
  assert(Math.abs((await width()) - 960) <= 2)
  assert.equal(report.sockets.length, socketsBefore)
  assert.equal(
    await composer.inputValue(),
    'Keep this draft while the editor is hidden.',
  )
  report.checks.push(
    'Hide/Show editor fills the available space and restores the split without remounting the editor, reconnecting Lean, losing the chat draft, or changing automatic file context.',
  )

  await page.getByRole('button', { name: 'Hide editor', exact: true }).click()
  await page
    .getByRole('button', { name: 'Close tools panel', exact: true })
    .click()
  assert.equal(await page.locator('.workbench').isVisible(), true)
  await page.getByRole('button', { name: 'Lemex', exact: true }).click()
  await page.getByRole('button', { name: 'Show editor', exact: true }).waitFor()
  for (const viewport of [
    { width: 900, height: 650 },
    { width: 390, height: 550 },
  ]) {
    await page.setViewportSize(viewport)
    await until(async () => {
      const bounds = await assistant.boundingBox()
      return bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1
    }, 'expanded assistant fits viewport')
    await page.getByRole('button', { name: 'Show editor', exact: true }).click()
    assert.equal(await page.locator('.workbench').isVisible(), true)
    await page.getByRole('button', { name: 'Hide editor', exact: true }).click()
  }
  report.checks.push(
    'Closing Lemex restores the editor; expanded mode fits tablet and phone screens and can always be exited.',
  )

  await page.getByRole('button', { name: 'Show editor', exact: true }).click()
  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width: 1920, height: 1080 })
    if (theme === 'light')
      await page
        .getByRole('button', { name: 'Use light theme', exact: true })
        .click()
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 844, height: 390 },
      { width: 390, height: 550 },
    ]) {
      await page.setViewportSize(viewport)
      for (const expanded of [false, true]) {
        await page.locator('.chat-options').evaluate((node, value) => {
          node.open = value
        }, expanded)
        await trigger.scrollIntoViewIfNeeded()
        const before = await page
          .locator('.chat-workbench')
          .evaluate((node) => node.scrollTop)
        await openPicker()
        await filter.fill('')
        assert.equal(
          await popup.evaluate((node) => node.parentElement === document.body),
          true,
        )
        const bounds = await popup.boundingBox()
        assert(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1)
        assert(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1)
        await filter.click({ trial: true })
        assert.equal(
          await page
            .locator('.chat-workbench')
            .evaluate((node) => node.scrollTop),
          before,
        )
        await filter.fill('Main')
        await page
          .getByRole('checkbox', { name: 'Main.lean', exact: true })
          .check()
        await page.keyboard.press('Escape')
        await closedPicker()
        await page
          .getByRole('button', {
            name: 'Remove Main.lean from context',
            exact: true,
          })
          .click()
      }
    }
  }
  report.checks.push(
    'In dark and light themes at desktop, laptop, phone and landscape sizes, the picker fits the viewport, search and checkboxes receive input, opening preserves scroll position, and dismissal preserves attachments.',
  )

  const active = {
    id: 'layout-active-run',
    chatId: 'layout-chat',
    projectId,
    mode: 'proofs',
    status: 'running',
    prompt: 'Keep working on the proof.',
    message: Array.from(
      { length: 40 },
      (_, index) => `Proof progress ${index}.\n\n`,
    ).join(''),
    createdAt: '2026-10-30T12:00:00Z',
    eventCursor: 0,
    followups: [],
  }
  state.runs.push(active)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await fixture.ready()
  await until(
    () => page.evaluate((id) => window.__chatFixture.connected(id), active.id),
    'active layout stream',
  )
  await composer.fill('Keep this follow-up while I read the earlier output.')
  await page.getByRole('button', { name: 'Hide editor', exact: true }).click()
  const conversation = page.getByRole('region', {
    name: 'Conversation',
    exact: true,
  })
  await conversation.hover()
  await page.mouse.wheel(0, -10000)
  await until(
    () => conversation.evaluate((node) => node.scrollTop < 10),
    'earlier output',
  )
  await emit(active, 'message', 'More progress while the editor is hidden.\n\n')
  await until(
    () =>
      conversation
        .innerText()
        .then((text) =>
          text.includes('More progress while the editor is hidden.'),
        ),
    'new output in the expanded assistant',
  )
  assert((await conversation.evaluate((node) => node.scrollTop)) < 10)
  await page
    .getByRole('button', { name: 'Send update', exact: true })
    .click({ trial: true })
  await page
    .getByRole('button', { name: 'Stop', exact: true })
    .click({ trial: true })
  await page.getByRole('button', { name: 'Show editor', exact: true }).click()
  assert.equal(
    await composer.inputValue(),
    'Keep this follow-up while I read the earlier output.',
  )
  assert.equal(await page.locator('.workbench').isVisible(), true)
  report.checks.push(
    'During an active stream, hiding and restoring the editor keeps earlier output still, retains a typed follow-up, and leaves Send update and Stop reachable.',
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
    `PASS: ${report.checks.length} assistant layout and picker checks; all APIs mocked`,
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
}
