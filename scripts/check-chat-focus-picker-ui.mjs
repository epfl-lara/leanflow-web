#!/usr/bin/env node
// Explicit focused proof controls; all project, Lean and provider APIs are mocked.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const projectId = 'chat-focus-picker-fixture'
const source =
  'import Init\n\ndef count : Nat := 1\n\ntheorem first : True := by\n  trivial\n\ntheorem second : True := by\n  trivial\n'
const symbols = [
  {
    name: 'count',
    kind: 12,
    range: {
      start: { line: 2, character: 0 },
      end: { line: 2, character: 20 },
    },
  },
  {
    name: 'first',
    kind: 12,
    range: { start: { line: 4, character: 0 }, end: { line: 5, character: 9 } },
  },
  {
    name: 'second',
    kind: 12,
    range: { start: { line: 7, character: 0 }, end: { line: 8, character: 9 } },
  },
]
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'focus-picker-owner', name: 'Fixture' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Focus picker',
      status: 'ready',
      toolchain: 'fixture',
    },
  ],
  files: { [projectId]: { 'Main.lean': source } },
  chats: [
    { id: 'alpha', projectId, title: 'Alpha' },
    { id: 'beta', projectId, title: 'Beta' },
  ],
  runs: [],
  documentSymbols: symbols,
})
const { page, state, browser, report } = fixture
const target = page.getByLabel('Focused proof', { exact: true })
const composer = page.getByLabel('Message Lemex')
const menu = page.getByRole('dialog', {
  name: 'Choose a proof or lines',
  exact: true,
})
const resultDir = path.resolve('.runtime/chat-focus-picker-ui')
await fs.mkdir(resultDir, { recursive: true })
async function openFocus() {
  await page
    .getByRole('button', { name: 'Focus proof / lines', exact: true })
    .click()
  await menu.waitFor()
}
async function chooseChat(id) {
  await page.getByLabel('Select chat').selectOption(id)
  await until(
    () =>
      page
        .getByRole('button', { name: 'Send', exact: true })
        .isEnabled()
        .then(() =>
          page
            .locator('.chat-picker[aria-busy="true"]')
            .count()
            .then((count) => !count),
        ),
    `chat ${id}`,
  )
}
let sent
state.onCreateRun = ({ chat, body, respond }) => {
  sent = structuredClone(body)
  return respond(
    {
      id: 'picker-sent',
      chatId: chat.id,
      projectId,
      mode: body.mode,
      prompt: body.prompt,
      proofTarget: body.proofTarget,
      status: 'completed',
      message: 'Fixture only.',
      createdAt: '2026-10-13T12:00:00Z',
    },
    202,
  )
}
try {
  await fixture.ready()
  await until(
    () =>
      page
        .locator('.chat-picker[aria-busy="true"]')
        .count()
        .then((count) => !count),
    'initial chat loaded',
  )
  // The composer picker works with the explorer closed and needs no editor toolbar.
  await page.setViewportSize({ width: 700, height: 1000 })
  const closeSidebar = page.getByRole('button', {
    name: 'Close sidebar',
    exact: true,
  })
  if (await closeSidebar.isVisible()) await closeSidebar.click()
  await composer.fill('Please use existing lemmas.')
  await openFocus()
  await menu.getByLabel('Find a proof to focus').fill('second')
  const choice = menu
    .getByRole('list', { name: 'Proof targets in this file' })
    .getByRole('button')
  await until(
    () => choice.count().then((count) => count === 1),
    'named proof filtered',
  )
  assert.match(await choice.innerText(), /theorem/)
  await choice.click()
  await until(
    () => target.innerText().then((text) => text.includes('second')),
    'named target attached',
  )
  assert.match(await target.innerText(), /Focused on/)
  assert.match(await target.innerText(), /Main\.lean:8–9/)
  assert.equal(await composer.inputValue(), 'Please use existing lemmas.')
  assert.equal(
    report.requests.filter((entry) => ['POST', 'PUT'].includes(entry.method))
      .length,
    0,
  )
  report.checks.push(
    'Choose a kind-labelled theorem from the chat composer with the explorer closed; target is visible, custom prompt survives, and no save or send happens.',
  )

  await openFocus()
  await menu.getByLabel('Find a proof to focus').fill('')
  assert.match(await menu.getByRole('list').innerText(), /def.*count/s)
  await menu.getByLabel('Lines', { exact: true }).fill('9-8')
  await menu.getByRole('button', { name: 'Use lines', exact: true }).click()
  assert.match(
    await menu.getByRole('alert').innerText(),
    /line number or range/,
  )
  await menu.getByLabel('Lines', { exact: true }).fill('2-900')
  await menu.getByRole('button', { name: 'Use lines', exact: true }).click()
  assert.match(await menu.getByRole('alert').innerText(), /file has .* lines/)
  await menu.getByLabel('Lines', { exact: true }).fill('5–6')
  await menu.getByLabel('Lines', { exact: true }).press('Enter')
  await until(
    () => target.innerText().then((text) => text.includes('Main.lean:5–6')),
    'manual line target',
  )
  assert.equal(await menu.count(), 0)
  report.checks.push(
    'Manual line ranges attach live source, Enter does not submit the chat, and reversed/out-of-file ranges are rejected without replacing the target.',
  )

  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentStart)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press(editorShortcuts.lineStart)
  await page.keyboard.press(editorShortcuts.selectLineEnd)
  await openFocus()
  const current = menu.getByRole('button', {
    name: /Use editor selection or current proof/,
  })
  assert.match(await current.innerText(), /count|Selected lines/)
  await current.click()
  await until(
    () => target.innerText().then((text) => text.includes('Main.lean:3')),
    'editor line selection attached',
  )
  report.checks.push(
    'A keyboard editor selection attaches from the composer without losing the saved editor selection.',
  )

  await chooseChat('beta')
  assert.equal(await target.count(), 0)
  await composer.fill('Beta instructions.')
  await openFocus()
  await menu.getByLabel('Lines', { exact: true }).fill('8-9')
  await menu.getByRole('button', { name: 'Use lines', exact: true }).click()
  await until(
    () => target.innerText().then((text) => text.includes('Main.lean:8–9')),
    'beta target',
  )
  await chooseChat('alpha')
  assert.match(await target.innerText(), /Main\.lean:3/)
  assert.equal(await composer.inputValue(), 'Please use existing lemmas.')
  await page
    .getByRole('button', { name: 'Clear proof target', exact: true })
    .click()
  assert.equal(await target.count(), 0)
  await chooseChat('beta')
  assert.match(await target.innerText(), /Main\.lean:8–9/)
  assert.equal(await composer.inputValue(), 'Beta instructions.')
  report.checks.push(
    'Targets and instructions stay with their chat; clearing one chat does not remove another chat’s target.',
  )

  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await until(() => !!sent, 'mock focused send')
  assert.equal(sent.proofTarget.path, 'Main.lean')
  assert.equal(sent.proofTarget.startLine, 8)
  assert.equal(sent.proofTarget.endLine, 9)
  assert.equal(
    sent.proofTarget.source,
    source.split('\n').slice(7, 9).join('\n'),
  )
  await until(
    () => target.count().then((count) => count === 0),
    'sent target cleared',
  )
  assert.match(
    await page.locator('.message-proof-target').innerText(),
    /second.*Main\.lean:8–9/,
  )
  report.checks.push(
    'Send carries exact selected source and range; the sent message keeps its visible focus label.',
  )

  await page.setViewportSize({ width: 390, height: 550 })
  await openFocus()
  const bounds = await menu.boundingBox()
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 391)
  assert(
    bounds.y >= 0 && bounds.y + bounds.height <= 551,
    'Focus menu must fit vertically in the viewport',
  )
  await menu.getByLabel('Lines', { exact: true }).scrollIntoViewIfNeeded()
  await menu.getByLabel('Lines', { exact: true }).fill('5-6')
  await menu
    .getByRole('button', { name: 'Use lines', exact: true })
    .click({ trial: true })
  await menu.getByLabel('Lines', { exact: true }).press('Escape')
  assert.equal(await menu.count(), 0)
  assert.equal(
    await page
      .getByRole('button', { name: 'Focus proof / lines', exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  )
  report.checks.push(
    'Focus menu is usable at 390×550; Escape dismisses it and restores keyboard focus.',
  )
  await page.setViewportSize({ width: 844, height: 390 })
  const options = page.locator('.chat-options')
  const optionsToggle = options.locator('summary')
  for (const expanded of [false, true]) {
    const alreadyExpanded = (await options.getAttribute('open')) !== null
    if (alreadyExpanded !== expanded) await optionsToggle.click()
    const trigger = page.getByRole('button', {
      name: 'Focus proof / lines',
      exact: true,
    })
    await trigger.scrollIntoViewIfNeeded()
    const before = await page
      .locator('.chat-workbench')
      .evaluate((node) => node.scrollTop)
    const transcriptBefore = await page
      .locator('.assistant-conversation')
      .evaluate((node) => node.scrollTop)
    await openFocus()
    assert.equal(
      await menu.evaluate((node) => node.parentElement === document.body),
      true,
    )
    const popupBounds = await menu.boundingBox()
    assert(popupBounds.x >= 0 && popupBounds.x + popupBounds.width <= 845)
    assert(popupBounds.y >= 0 && popupBounds.y + popupBounds.height <= 391)
    for (const visible of [
      menu.locator('.chat-focus-heading'),
      menu.getByLabel('Find a proof to focus'),
    ]) {
      assert.equal(
        await visible.evaluate((node) => {
          const box = node.getBoundingClientRect()
          const hit = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          )
          return hit === node || node.contains(hit)
        }),
        true,
        `Menu heading/search is clipped with Options ${expanded ? 'open' : 'closed'}`,
      )
    }
    await menu.getByLabel('Find a proof to focus').click({ trial: true })
    assert.equal(
      await page.locator('.chat-workbench').evaluate((node) => node.scrollTop),
      before,
      'Opening focus menu moved the chat viewport',
    )
    assert.equal(
      await page
        .locator('.assistant-conversation')
        .evaluate((node) => node.scrollTop),
      transcriptBefore,
      'Opening focus menu moved the transcript',
    )
    await menu.getByLabel('Lines', { exact: true }).scrollIntoViewIfNeeded()
    await menu.getByLabel('Lines', { exact: true }).fill('5-6')
    await menu
      .getByRole('button', { name: 'Use lines', exact: true })
      .click({ trial: true })
    await menu.getByLabel('Lines', { exact: true }).press('Escape')
    assert.equal(await menu.count(), 0)
    assert.equal(
      await page
        .locator('.assistant-conversation')
        .evaluate((node) => node.scrollTop),
      transcriptBefore,
      'Scrolling focus menu moved the transcript',
    )
  }
  report.checks.push(
    'At 844×390 with Options open and closed, the portal menu fits the viewport, heading/search receive pointer input, Use lines is reachable by scrolling the menu, and the transcript stays still.',
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.screenshot({
    path: path.join(resultDir, 'focused-composer.png'),
    fullPage: true,
  })
  fixture.assertClean()
  report.passed = true
  console.log(
    `PASS: ${report.checks.length} focused composer checks; APIs mocked`,
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || String(error)
  report.pageText = await page
    .locator('body')
    .innerText()
    .catch(() => '')
  await page
    .screenshot({ path: path.join(resultDir, 'failure.png'), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(resultDir, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
