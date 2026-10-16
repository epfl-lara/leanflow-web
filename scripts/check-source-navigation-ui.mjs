#!/usr/bin/env node
// All projects, Lean definition responses and source reads use isolated fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.runtime/source-navigation-ui')
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
const projectId = 'source-navigation-project'
const main =
  'def localValue : Nat := 1\n#check localValue\n#check Nat.pos_of_neZero\n'
const fixture = await chatBrowserFixture({
  base: `http://127.0.0.1:${server.address().port}`,
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [{ id: 'fixture', name: 'Fixture' }],
    defaultModel: 'fixture',
    runtime: { ready: true },
    lemex: { available: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Navigation fixture',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: {
    [projectId]: {
      'Main.lean': main,
      'Other.lean': 'def otherValue : Nat := 2\n#check otherValue\n',
    },
  },
  chats: [{ id: 'source-navigation-chat', projectId, title: 'Fixture chat' }],
  runs: [],
  definitionLocations: [],
})
const { page, state, report, browser } = fixture
const signature = 'theorem pos_of_neZero (n : Nat) [NeZero n] : 0 < n'
const source =
  Array.from({ length: 80 }, (_, i) => `-- line ${i + 1}`).join('\n') +
  `\nnamespace Nat\n${signature} := by trivial\nend Nat\n`
const coreUri =
  'file:///opt/lean-toolchains/leanprover--lean4---v4.34.1/src/lean/Init/Data/Nat/Basic.lean'
let sourceError = false
await page.route('**/api/projects/*/library-source', async (route) => {
  const body = route.request().postDataJSON()
  report.requests.push({ method: 'POST', endpoint: '/library-source', body })
  return route.fulfill({
    status: sourceError ? 404 : 200,
    contentType: 'application/json',
    body: JSON.stringify(
      sourceError
        ? {
            error:
              'This module is not installed in the project. Use Open source to view the indexed version.',
          }
        : {
            module: 'Init.Data.Nat.Basic',
            path: 'Lean library/Init/Data/Nat/Basic.lean',
            content: source,
            toolchain: 'leanprover/lean4:v4.34.1',
            readOnly: true,
            line: body.line || 82,
            endLine: body.endLine || 82,
          },
    ),
  })
})
await page.route('**/api/search', (route) =>
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      source: { name: 'LeanExplore', version: 'Fixture index' },
      results: [
        {
          name: 'Nat.pos_of_neZero',
          module: 'Init.Data.Nat.Basic',
          signature,
          url: 'https://github.com/leanprover/lean4/blob/v4.32.0/src/Init/Data/Nat/Basic.lean#L334-L334',
        },
      ],
    }),
  }),
)

const save = page.getByRole('button', { name: 'Save', exact: true })
const editor = () => page.locator('.monaco-editor textarea').first()
function location(uri, line) {
  return [
    {
      uri,
      range: {
        start: { line: line - 1, character: 0 },
        end: { line: line - 1, character: 12 },
      },
    },
  ]
}
async function definition(locations) {
  state.definitionLocations = locations
  const previous = report.requests.filter((r) => r.method === 'LSP').length
  await editor().focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('F12')
  await until(
    () => report.requests.filter((r) => r.method === 'LSP').length > previous,
    'Lean definition request',
  )
}

async function identifierPoint(name = 'localValue') {
  const line = page
    .locator('.monaco-editor .view-lines .view-line')
    .filter({ hasText: '#check' })
    .filter({ hasText: name })
    .first()
  await line.waitFor()
  return line.evaluate((element, name) => {
    const start = element.textContent.indexOf(name)
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let offset = 0,
      found = false
    while (walker.nextNode()) {
      const node = walker.currentNode
      const end = offset + node.textContent.length
      if (!found && start >= offset && start < end) {
        range.setStart(node, start - offset)
        found = true
      }
      if (found && start + name.length <= end) {
        range.setEnd(node, start + name.length - offset)
        const box = range.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      offset = end
    }
    throw new Error('Identifier text is not visible')
  }, name)
}

async function altDefinition(
  locations,
  name = 'localValue',
  previewAvailable = true,
) {
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await editor().focus()
  state.definitionLocations = locations
  const previous = report.requests.filter((r) => r.method === 'LSP').length
  const point = await identifierPoint(name)
  await page.mouse.move(0, 0)
  await page.keyboard.down('Alt')
  try {
    await page.mouse.move(point.x, point.y)
    await until(
      () => report.requests.filter((r) => r.method === 'LSP').length > previous,
      'Alt-hover requests a Lean definition',
    )
    if (locations.length && previewAvailable)
      await page.locator('.goto-definition-link').waitFor()
    await page.mouse.click(point.x, point.y)
  } finally {
    await page.keyboard.up('Alt')
  }
}

try {
  await fixture.ready()
  // Navigate within the current file while a draft is present.
  await editor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('-- unsaved navigation marker\n')
  await until(() => save.isEnabled(), 'unsaved editor')
  await definition(location('file:///workspace/Main.lean', 1))
  await until(
    () =>
      page
        .locator('.line-numbers.active-line-number')
        .innerText()
        .then((text) => text.trim() === '1'),
    'same-file position',
  )
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await save.isEnabled(), true)
  report.checks.push(
    'F12 within a project file jumps to the definition and preserves unsaved edits',
  )

  const plainPoint = await identifierPoint()
  const beforeClick = report.requests.filter((r) => r.method === 'LSP').length
  await page.mouse.click(plainPoint.x, plainPoint.y)
  await until(
    async () =>
      (
        await page.locator('.line-numbers.active-line-number').innerText()
      ).trim() === '2',
    'ordinary click positions the cursor',
  )
  await page.waitForTimeout(150)
  assert.equal(
    report.requests.filter((r) => r.method === 'LSP').length,
    beforeClick,
  )
  await altDefinition(location('file:///workspace/Main.lean', 1))
  await until(
    async () =>
      (
        await page.locator('.line-numbers.active-line-number').innerText()
      ).trim() === '1',
    'Alt-click same-file definition position',
  )
  assert.equal(await save.isEnabled(), true)
  assert.match(
    await page.locator('.view-lines').innerText(),
    /unsaved\s+navigation\s+marker/,
  )
  report.checks.push(
    'Alt-click jumps within the file without editing or saving; an ordinary click only positions the cursor',
  )

  await altDefinition([], 'localValue')
  await page.waitForTimeout(150)
  assert.equal(
    (await page.locator('.line-numbers.active-line-number').innerText()).trim(),
    '2',
  )
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.locator('.cursors-layer .cursor').count(), 1)
  report.checks.push(
    'Alt-click on a name without a definition leaves the file unchanged and does not add a cursor',
  )

  const cursorPoint = await identifierPoint()
  await page.keyboard.press('Control+Home')
  await page.keyboard.down('Control')
  try {
    await page.mouse.click(cursorPoint.x, cursorPoint.y)
  } finally {
    await page.keyboard.up('Control')
  }
  await until(
    async () => (await page.locator('.cursors-layer .cursor').count()) === 2,
    'Ctrl-click adds a second cursor',
  )
  await page.keyboard.press('Escape')
  report.checks.push(
    'Ctrl-click keeps multi-cursor editing available with the swapped native modifier',
  )

  await altDefinition(location(coreUri, 82))
  const dialog = page.getByRole('dialog', { name: 'Init.Data.Nat.Basic' })
  await dialog.waitFor()
  const viewer = dialog.getByRole('textbox', { name: 'Library source' })
  assert.equal(await viewer.inputValue(), source)
  const selection = await viewer.evaluate((element) => ({
    readOnly: element.readOnly,
    scrollTop: element.scrollTop,
    selected: element.value.slice(element.selectionStart, element.selectionEnd),
  }))
  assert.equal(selection.readOnly, true)
  assert(selection.scrollTop > 0)
  assert(selection.selected.startsWith(signature))
  await page.screenshot({ path: path.join(output, 'source-view.png') })
  await viewer.focus()
  await page.keyboard.insertText('should not edit')
  assert.equal(await viewer.inputValue(), source)
  assert.equal(await save.isEnabled(), true)
  assert.equal(
    report.requests.filter(
      (r) => r.endpoint.endsWith('/file') && r.method === 'PUT',
    ).length,
    0,
  )
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  report.checks.push(
    'Alt-click opens installed Lean sources at the reported position in a scrollable read-only view without saving the draft',
  )

  await definition(location(coreUri, 82))
  await dialog.waitFor()
  assert.equal(await viewer.inputValue(), source)
  assert.equal(await save.isEnabled(), true)
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  report.checks.push(
    'F12 still opens library definitions without saving the current draft',
  )

  state.definitionLocations = location('file:///workspace/Main.lean', 1)
  const menuPoint = await identifierPoint()
  await page.mouse.click(menuPoint.x, menuPoint.y, { button: 'right' })
  await page.getByRole('menuitem', { name: /^Go to Definition/ }).hover()
  await page.keyboard.press('Enter')
  await until(
    async () =>
      (
        await page.locator('.line-numbers.active-line-number').innerText()
      ).trim() === '1',
    'context-menu Go to Definition',
  )
  assert.equal(await save.isEnabled(), true)
  report.checks.push(
    'Right-click Go to Definition still uses native navigation and preserves the draft',
  )

  await altDefinition(location('file:///workspace/Other.lean', 2))
  const unsaved = page.getByRole('dialog', { name: 'Save your changes?' })
  await unsaved.waitFor()
  await unsaved.getByRole('button', { name: 'Discard edits' }).click()
  await until(
    () =>
      page
        .locator('.file-toolbar')
        .innerText()
        .then((text) => text.includes('Other.lean')),
    'other project file',
  )
  await until(
    () =>
      page
        .locator('.line-numbers.active-line-number')
        .innerText()
        .then((text) => text.trim() === '2'),
    'other-file position',
  )
  report.checks.push(
    'Alt-click across project files uses the unsaved-edit prompt and opens the target position',
  )

  await altDefinition(location('file:///workspace/Other.lean', 1), 'otherValue')
  await until(
    async () =>
      (
        await page.locator('.line-numbers.active-line-number').innerText()
      ).trim() === '1',
    'Alt-click still works after switching files',
  )
  report.checks.push(
    'The newly opened editor keeps Alt-click definition navigation enabled',
  )

  const searchTab = page.getByRole('tab', { name: 'Search', exact: true })
  if (await searchTab.count()) await searchTab.click()
  await page.locator('#declaration-query').fill('not zero means positive')
  await page
    .getByRole('button', { name: 'Search declarations', exact: true })
    .click()
  await page.getByRole('button', { name: 'Open locally' }).click()
  await dialog.waitFor()
  assert.equal(await viewer.inputValue(), source)
  assert.deepEqual(
    report.requests.filter((r) => r.endpoint === '/library-source').at(-1).body,
    { module: 'Init.Data.Nat.Basic', signature },
  )
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  sourceError = true
  await page.getByRole('button', { name: 'Open locally' }).click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'This module is not installed' })
    .waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  assert.equal(await page.locator('.search-result').count(), 1)
  report.checks.push(
    'Search opens the actual module locally and keeps results usable after an unavailable-source error',
  )
  await page.getByRole('button', { name: 'Close search results' }).click()
  await altDefinition(location(coreUri, 82), 'otherValue', false)
  await page
    .getByRole('alert')
    .filter({ hasText: 'This module is not installed' })
    .waitFor()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  report.checks.push(
    'An unavailable Alt-hover preview still allows clicking through to the actionable library-source error without crashing the editor',
  )
  fixture.assertClean()
  report.ok = true
  await page.screenshot({ path: path.join(output, 'navigation.png') })
} catch (error) {
  report.failure = error.stack || String(error)
  report.pageText = await page.locator('body').innerText()
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
console.log(
  JSON.stringify({ ok: report.ok, checks: report.checks, output }, null, 2),
)
