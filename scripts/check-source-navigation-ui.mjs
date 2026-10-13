#!/usr/bin/env node
// All projects, Lean definition responses and source reads use isolated fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.runtime/source-navigation-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'source-navigation-project'
const main =
  'def localValue : Nat := 1\n#check localValue\n#check Nat.pos_of_neZero\n'
const fixture = await chatBrowserFixture({
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

  await definition(location(coreUri, 82))
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
    'F12 opens installed Lean sources at the reported position in a scrollable read-only view without saving the draft',
  )

  await definition(location('file:///workspace/Other.lean', 2))
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
    'F12 across project files uses the unsaved-edit prompt and opens the target position',
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
  fixture.assertClean()
  report.ok = true
  await page.screenshot({ path: path.join(output, 'navigation.png') })
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
}
console.log(
  JSON.stringify({ ok: report.ok, checks: report.checks, output }, null, 2),
)
