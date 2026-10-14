#!/usr/bin/env node
// Serve the client on STUDIO_TEST_URL. All API and Lean traffic uses fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const reportDir = fileURLToPath(
  new URL('../.runtime/help-tips-ui/', import.meta.url),
)
await fs.mkdir(reportDir, { recursive: true })
const projectId = 'help-tips-fixture'
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'help-tips-user', name: 'Fixture' },
    templates: [],
    models: [
      {
        id: 'fixture-model',
        name: 'Fixture model',
        defaultReasoningEffort: 'high',
        reasoningEfforts: [{ id: 'high' }, { id: 'low' }],
      },
    ],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Help tips fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
      repository: { url: 'https://github.com/fixture/project.git' },
    },
  ],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: 'help-chat', projectId, title: 'Help', runCount: 1 }],
  runs: [
    {
      id: 'help-run',
      projectId,
      chatId: 'help-chat',
      kind: 'agent',
      mode: 'optimize',
      status: 'completed',
      createdAt: '2026-10-14T00:00:00Z',
      prompt: 'Shorten this proof.',
      message: 'The proof is verified.',
      optimization: {
        baseline: { available: true, proofTokens: 8, totalHeartbeatsRaw: 2000 },
        candidate: {
          available: true,
          proofTokens: 6,
          totalHeartbeatsRaw: 1000,
        },
      },
    },
  ],
})
const { page, report } = fixture
const help = (label) =>
  page.getByRole('button', { name: `About ${label}`, exact: true })
const tooltip = page.getByRole('tooltip')
async function visibleHelp() {
  await tooltip.waitFor()
  await until(
    () =>
      tooltip
        .locator('.help-tooltip')
        .evaluate((element) => getComputedStyle(element).opacity === '1'),
    'help appearance transition',
  )
}
async function dismissHelp() {
  await page.mouse.move(0, 0)
  await page.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'hidden' })
}
async function assertFits() {
  const bounds = await tooltip.boundingBox()
  const viewport = page.viewportSize()
  assert(bounds, 'Tooltip must be visible')
  assert(
    bounds.x >= 0 && bounds.y >= 0,
    'Tooltip must fit above and to the left',
  )
  assert(
    bounds.x + bounds.width <= viewport.width,
    'Tooltip must fit horizontally',
  )
  assert(
    bounds.y + bounds.height <= viewport.height,
    'Tooltip must fit vertically',
  )
}

try {
  await fixture.ready()
  await help('Playgrounds').hover()
  await visibleHelp()
  assert.equal(
    await tooltip
      .locator('.help-tooltip')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(24, 29, 39)',
  )
  await dismissHelp()
  await page.locator('.chat-options > summary').click()
  await page.locator('.turn-details > summary').click()
  await help('Heartbeats').waitFor()
  const topics = [
    ['Playgrounds', /single Lean file with Mathlib/],
    ['Projects', /multiple files/],
    ['Goals', /local assumptions/],
    ['Lemex', /review its changes in chat/],
    ['Terminal', /run commands and inspect their output/],
    ['Refresh setup', /reuse valid compiled caches/],
    ['Publish', /pull request or merge request/],
    ['Assistant modes', /preserving its statement/],
    ['Reasoning effort', /next run/],
    ['Edit files live', /review changes before applying/],
    ['Proof tokens', /size of the proof text/],
    ['Heartbeats', /do not measure seconds or model usage/],
  ]
  for (const [label, text] of topics) {
    await help(label).hover()
    await visibleHelp()
    assert.match(await tooltip.innerText(), text)
    const id = await tooltip.getAttribute('id')
    assert.equal(await help(label).getAttribute('aria-describedby'), id)
    await assertFits()
    // Users can move onto the explanation to read it without it disappearing.
    await tooltip.hover()
    assert.equal(await tooltip.isVisible(), true)
    await dismissHelp()
  }
  report.checks.push(
    'All twelve help topics appear on hover, stay readable under the pointer, and fit the desktop viewport',
  )

  const toolbar = page.locator('.workbench-header')
  const toolbarLabels = [
    'Goals',
    'Lemex',
    'Terminal',
    'Refresh setup',
    'Publish',
  ]
  for (const label of toolbarLabels) {
    const group = toolbar.getByRole('group', { name: label, exact: true })
    const action = group.getByRole('button', { name: label, exact: true })
    await action.waitFor()
    assert.equal(await group.getByRole('button').count(), 2)
    await group
      .getByRole('button', { name: `About ${label}`, exact: true })
      .click()
    await visibleHelp()
    assert.equal(await tooltip.locator('strong').innerText(), label)
    if (await action.getAttribute('aria-pressed')) {
      const before = await action.getAttribute('aria-pressed')
      await help(label).click()
      await tooltip.waitFor({ state: 'hidden' })
      assert.equal(await action.getAttribute('aria-pressed'), before)
    } else await dismissHelp()
  }
  const goals = toolbar.getByRole('button', { name: 'Goals', exact: true })
  const selectedBefore = await goals.getAttribute('aria-pressed')
  await goals.click()
  assert.notEqual(await goals.getAttribute('aria-pressed'), selectedBefore)
  await goals.click()
  assert.equal(await goals.getAttribute('aria-pressed'), selectedBefore)
  await toolbar.getByRole('button', { name: 'Terminal', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert.equal(
    await help('Terminal').evaluate(
      (element) => element === document.activeElement,
    ),
    true,
  )
  await visibleHelp()
  await dismissHelp()
  report.checks.push(
    'Each toolbar action and help button share a named group and matching help title; help preserves panel choices, closes on a second click, and opens on keyboard focus',
  )

  const playgrounds = page.locator('details[aria-label="Playgrounds"]')
  await help('Playgrounds').click()
  await tooltip.waitFor()
  assert.equal(await playgrounds.evaluate((element) => element.open), true)
  await dismissHelp()
  await playgrounds.locator('summary').click()
  assert.equal(await playgrounds.evaluate((element) => element.open), false)
  await help('Playgrounds').click()
  await tooltip.waitFor()
  assert.equal(await playgrounds.evaluate((element) => element.open), false)
  await dismissHelp()
  await playgrounds.locator('summary').click()
  report.checks.push(
    'Clicking help preserves both open and collapsed sections; the section summary still toggles normally',
  )

  const liveEdits = page.getByRole('checkbox', {
    name: 'Edit files live',
    exact: true,
  })
  const beforeLive = await liveEdits.isChecked()
  const effort = page.getByRole('combobox', {
    name: 'Reasoning effort',
    exact: true,
  })
  const beforeEffort = await effort.inputValue()
  const modelBounds = await page
    .getByRole('combobox', { name: 'Model', exact: true })
    .boundingBox()
  const effortBounds = await effort.boundingBox()
  assert.equal(
    modelBounds.y,
    effortBounds.y,
    'Model and reasoning controls must stay aligned',
  )
  await help('Edit files live').click()
  await tooltip.waitFor()
  assert.equal(await liveEdits.isChecked(), beforeLive)
  await dismissHelp()
  await help('Reasoning effort').click()
  await tooltip.waitFor()
  assert.equal(await effort.inputValue(), beforeEffort)
  await dismissHelp()
  await page.getByLabel('Message Lemex').focus()
  await page.keyboard.press('Tab')
  await help('Projects').focus()
  await tooltip.waitFor()
  await page.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'hidden' })
  assert.equal(
    await help('Projects').evaluate(
      (element) => element === document.activeElement,
    ),
    true,
  )
  await page.getByLabel('Message Lemex').focus()
  await help('Projects').hover()
  await tooltip.waitFor()
  await page.mouse.move(0, 0)
  await tooltip.waitFor({ state: 'hidden' })
  report.checks.push(
    'Help leaves live-edit and reasoning choices unchanged, opens with keyboard focus, and dismisses with Escape or pointer leave',
  )

  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  await help('Projects').hover()
  await visibleHelp()
  assert.equal(
    await tooltip
      .locator('.help-tooltip')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    'rgb(255, 255, 255)',
  )
  await assertFits()
  await page.screenshot({
    path: path.join(reportDir, 'help-desktop.png'),
    fullPage: true,
  })
  await dismissHelp()
  await help('Refresh setup').hover()
  await visibleHelp()
  await page.screenshot({ path: path.join(reportDir, 'toolbar-desktop.png') })
  await dismissHelp()
  report.checks.push('Help follows the light and dark themes')

  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'Open projects and files', exact: true })
    .click()
  await until(
    () =>
      page
        .locator('.sidebar')
        .evaluate(
          (element) =>
            getComputedStyle(element).transform === 'matrix(1, 0, 0, 1, 0, 0)',
        ),
    'mobile sidebar appearance transition',
  )
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  const bounds = await help('Playgrounds').boundingBox()
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
    ],
  })
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  await visibleHelp()
  await assertFits()
  assert.equal(await playgrounds.evaluate((element) => element.open), true)
  await page.screenshot({
    path: path.join(reportDir, 'help-mobile.png'),
    fullPage: true,
  })
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 120, y: 30 }],
  })
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  await tooltip.waitFor({ state: 'hidden' })
  await cdp.detach()
  await page
    .getByRole('button', { name: 'Close project sidebar', exact: true })
    .click({ position: { x: 375, y: 420 } })
  for (const width of [390, 320, 720, 900]) {
    await page.setViewportSize({ width, height: 844 })
    for (const label of toolbarLabels) {
      const group = toolbar.getByRole('group', { name: label, exact: true })
      const bounds = await group.boundingBox()
      assert(
        bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
        `${label} must fit the ${width}px toolbar`,
      )
      await help(label).click()
      await visibleHelp()
      await assertFits()
      await dismissHelp()
    }
    const headerBounds = await toolbar.boundingBox()
    const searchBounds = await page.locator('.workspace-search').boundingBox()
    assert(
      searchBounds.y + searchBounds.height <=
        headerBounds.y + headerBounds.height,
      'Search remains inside the wrapping header',
    )
    const assistantBounds = await page.locator('.tools-panel').boundingBox()
    assert(
      Math.abs(assistantBounds.y - headerBounds.y - headerBounds.height) < 1,
      'The assistant starts below the full header after wrapping',
    )
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await help('Refresh setup').click()
  await visibleHelp()
  await page.screenshot({ path: path.join(reportDir, 'toolbar-mobile.png') })
  await dismissHelp()
  report.checks.push(
    'Every toolbar action and explanation fits at 320, 390, 720 and 900 pixels; wrapping keeps search contained and the assistant below the header',
  )
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  )
  report.checks.push(
    'A touch tap opens persistent help on a narrow screen; tapping outside dismisses it without collapsing the section or overflowing the viewport',
  )

  assert.equal(
    report.requests.some((request) => request.method !== 'GET'),
    false,
  )
  fixture.assertClean()
  report.passed = true
} catch (error) {
  report.failure = error.stack
  await page.screenshot({
    path: path.join(reportDir, 'failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await fixture.browser.close()
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks }))
