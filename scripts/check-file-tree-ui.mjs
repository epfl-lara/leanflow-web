#!/usr/bin/env node
// Check rendered tree geometry with isolated files; never access user projects.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/file-tree-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(path.resolve('client/dist')))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
let fixture
try {
  const projectId = 'file-tree-fixture'
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    viewport: { width: 1500, height: 1200 },
    session: {
      user: { id: 'tree-owner', name: 'Tree fixture' },
      templates: [],
      models: [],
      runtime: { ready: true },
    },
    projects: [{ id: projectId, name: 'Nested files', status: 'ready' }],
    files: {
      [projectId]: {
        'Main.lean': 'example : True := by trivial\n',
        'literatedocbuild/lakefile.toml': 'name = "docs"\n',
        'literatedocbuild/lean-toolchain': 'leanprover/lean4:v4.34.1\n',
        'literatedocbuild/verso-split-definitions.js': '// Fixture\n',
        'literatedocbuild/scripts/build.sh': '# Fixture\n',
        'literatedocbuild/scripts/generated/output.txt': 'Fixture\n',
        'scripts/build-literate-docs.sh': '# Fixture\n',
        '.lake/packages/Fixture/Library.lean': '-- Fixture dependency\n',
      },
    },
    chats: [{ id: 'tree-chat', projectId, title: 'Tree fixture' }],
    runs: [],
  })
  const { page, report } = fixture
  await page.route('**/api/projects/*/folders', (route) =>
    route.fulfill({
      json: [
        'literatedocbuild',
        'literatedocbuild/scripts',
        'literatedocbuild/scripts/empty',
        'literatedocbuild/scripts/generated',
        'scripts',
      ],
    }),
  )
  const tree = page.locator('.file-list')
  const file = (filename) =>
    tree.locator('.file-item').and(page.getByTitle(filename, { exact: true }))
  const folder = (filename) =>
    tree
      .locator('.folder-toggle')
      .and(page.getByTitle(filename, { exact: true }))
  const textX = async (item, selector) => {
    const bounds = await item.locator(selector).boundingBox()
    assert(bounds)
    return bounds.x
  }
  const fileX = (filename) => textX(file(filename), '.file-basename')
  const folderX = (filename) => textX(folder(filename), 'span')
  const aligned = (a, b, label) => assert(Math.abs(a - b) < 1, label)
  async function checkHierarchy() {
    const root = await folderX('literatedocbuild')
    const inner = await folderX('literatedocbuild/scripts')
    const deeper = await folderX('literatedocbuild/scripts/generated')
    aligned(await fileX('Main.lean'), root, 'Root file and folder labels align')
    aligned(
      await fileX('literatedocbuild/verso-split-definitions.js'),
      inner,
      'File and folder labels at the same nested level align',
    )
    aligned(
      await fileX('literatedocbuild/scripts/build.sh'),
      deeper,
      'Deeper file and folder labels align',
    )
    assert(inner >= root + 12, 'Each folder level has a visible indent')
    assert(deeper >= inner + 12, 'Deeper folders keep their indent')
    assert(
      (await fileX('literatedocbuild/scripts/generated/output.txt')) >=
        deeper + 12,
      'Inner files are visibly indented beyond their parent folder label',
    )
    return { root, inner, deeper }
  }

  await fixture.ready()
  for (const name of [
    'literatedocbuild',
    'literatedocbuild/scripts',
    'literatedocbuild/scripts/empty',
    'literatedocbuild/scripts/generated',
    'scripts',
  ])
    await folder(name).click()
  report.geometry = await checkHierarchy()
  const emptyTextX = await tree.locator('.empty-folder').evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return range.getBoundingClientRect().x
  })
  assert(
    emptyTextX >= (await folderX('literatedocbuild/scripts/empty')) + 12,
    'Empty folder messages are indented beyond their parent folder',
  )
  report.checks.push(
    'Root siblings and nested file/folder labels align; each child level is visibly indented, including three levels of inner files.',
  )
  await file('literatedocbuild/verso-split-definitions.js').click()
  await until(
    async () =>
      (await file('literatedocbuild/verso-split-definitions.js').getAttribute(
        'aria-current',
      )) === 'true',
    'nested file selected',
  )
  await file('literatedocbuild/scripts/build.sh').hover()
  await checkHierarchy()
  await page.screenshot({ path: path.join(output, 'nested-dark.png') })
  await folder('literatedocbuild/scripts').click()
  assert.equal(await file('literatedocbuild/scripts/build.sh').count(), 0)
  assert(await file('literatedocbuild/verso-split-definitions.js').isVisible())
  await folder('literatedocbuild/scripts').click()
  await checkHierarchy()
  await folder('scripts').click()
  assert.equal(await file('scripts/build-literate-docs.sh').count(), 0)
  assert(await file('literatedocbuild/scripts/build.sh').isVisible())
  await folder('scripts').click()
  report.checks.push(
    'Selection and hover retain alignment; collapsing one folder hides only its descendants, including same-named sibling folders.',
  )
  await page.getByLabel('Filter files', { exact: true }).fill('output.txt')
  assert(
    await file('literatedocbuild/scripts/generated/output.txt').isVisible(),
  )
  const filteredParent = await folderX('literatedocbuild/scripts/generated')
  assert(
    (await fileX('literatedocbuild/scripts/generated/output.txt')) >=
      filteredParent + 12,
    'Filtered files retain the full nested hierarchy',
  )
  await page.getByLabel('Filter files', { exact: true }).fill('')
  await checkHierarchy()
  await tree.getByRole('button', { name: 'Dependencies 1' }).click()
  const dependency = file('.lake/packages/Fixture/Library.lean')
  assert(await dependency.isVisible())
  assert.equal(
    await dependency.locator('..').locator('.file-delete').count(),
    0,
    'Dependency files keep their read-only controls',
  )
  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  await page.screenshot({ path: path.join(output, 'nested-light.png') })
  await page.evaluate((id) => {
    localStorage.setItem('lemex-layout-sidebar', '180')
    localStorage.setItem(`lemex-file-${id}`, 'Main.lean')
  }, projectId)
  await fixture.ready()
  for (const name of [
    'literatedocbuild',
    'literatedocbuild/scripts',
    'literatedocbuild/scripts/empty',
    'literatedocbuild/scripts/generated',
  ]) {
    if ((await folder(name).getAttribute('aria-expanded')) !== 'true')
      await folder(name).click()
  }
  await checkHierarchy()
  const bounds = await tree.boundingBox()
  assert(bounds)
  for (const filename of [
    'Main.lean',
    'literatedocbuild/verso-split-definitions.js',
    'literatedocbuild/scripts/generated/output.txt',
  ]) {
    const button = file(filename)
    const row = await button.boundingBox()
    const label = await button.locator('.file-basename').boundingBox()
    const icon = await button.locator('svg').boundingBox()
    assert(row && label && icon)
    assert(label.width > 0, `Narrow tree keeps ${filename} label visible`)
    assert(icon.width >= 14, 'File icons do not shrink in a narrow tree')
    assert(
      row.x + row.width <= bounds.x + bounds.width + 1,
      'Nested file controls remain inside the narrow tree',
    )
    assert.equal(await button.getAttribute('title'), filename)
  }
  await page.screenshot({ path: path.join(output, 'nested-narrow.png') })
  report.checks.push(
    'Filtering preserves ancestor indentation; long paths truncate with full-path tooltips and intact icons in the minimum-width sidebar.',
  )
  assert(
    report.requests.every((request) => request.method === 'GET'),
    'Tree checks must not write files or change projects',
  )
  fixture.assertClean()
  report.ok = true
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log('Nested file tree browser checks passed.')
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
