#!/usr/bin/env node
// Isolated sidebar controls and geometry: no user projects, Lean or providers.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/sidebar-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(
  express.static(path.resolve(process.env.STUDIO_TEST_DIST || 'client/dist')),
)
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
let fixture
try {
  const projectId = 'sidebar-project'
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    viewport: { width: 1440, height: 950 },
    session: {
      user: { id: 'sidebar-owner', name: 'Sidebar fixture' },
      templates: [{ id: 'mathlib', name: 'Mathlib', ready: true }],
      models: [],
      runtime: { ready: true },
    },
    projects: [{ id: projectId, name: 'Sidebar project', status: 'ready' }],
    files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
    chats: [{ id: 'sidebar-chat', projectId, title: 'Sidebar fixture' }],
    runs: [],
  })
  const { page, report } = fixture
  const creations = []
  await page.route('**/api/playground', (route) =>
    route.fulfill({ json: { state: 'ready' } }),
  )
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    creations.push(route.request().postDataJSON())
    return route.fulfill({
      status: 503,
      json: { error: 'Fixture creation received.' },
    })
  })
  await page.route('**/api/projects/*/git', (route) =>
    route.fulfill({
      json: {
        repository: true,
        branch: 'feature/long-branch-name-for-narrow-sidebar',
        changes: Array.from({ length: 13 }, (_, index) => ({
          status: ' M',
          path: `File${index}.lean`,
        })),
      },
    }),
  )
  await fixture.ready()
  const sections = page.locator('.workspace-lists')
  const playgrounds = sections.locator('[aria-label="Playgrounds"]')
  const projects = sections.locator('[aria-label="Projects"]')
  const createProject = projects.getByRole('button', {
    name: 'Import or create project',
    exact: true,
  })
  const newPlayground = playgrounds.getByRole('button', {
    name: 'New playground',
    exact: true,
  })
  const upload = playgrounds.getByRole('button', {
    name: 'Open .lean file',
    exact: true,
  })
  for (const button of [createProject, newPlayground, upload]) {
    await button.waitFor()
    assert.equal((await button.innerText()).trim(), '')
    assert(await button.isEnabled())
  }
  assert.equal(
    await page.locator('.sidebar-projects-section > .import-button').count(),
    0,
  )
  for (const section of [playgrounds, projects]) {
    const toggle = section.locator('.sidebar-section-toggle')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
  }
  assert(await createProject.isVisible())
  assert(await newPlayground.isVisible())
  assert(await upload.isVisible())
  await createProject.click()
  const projectDialog = page.getByRole('dialog', {
    name: 'Open a Lean project',
  })
  await projectDialog.waitFor()
  await page.keyboard.press('Escape')
  await projectDialog.waitFor({ state: 'hidden' })
  await newPlayground.click()
  await until(() => creations.length > 0, 'blank playground request')
  assert.deepEqual(creations.shift(), { kind: 'single-file' })
  const chooser = page.waitForEvent('filechooser')
  await upload.click()
  await (
    await chooser
  ).setFiles({
    name: 'Uploaded.lean',
    mimeType: 'text/plain',
    buffer: Buffer.from('-- Local Lean upload\n'),
  })
  await until(() => creations.length > 0, 'uploaded playground request')
  await page.getByText('Fixture creation received.', { exact: true }).waitFor()
  assert.deepEqual(creations.shift(), {
    kind: 'single-file',
    file: { path: 'Uploaded.lean', content: '-- Local Lean upload\n' },
  })
  report.checks.push(
    'Section plus and Lean upload controls work while their lists are collapsed.',
  )

  const git = page.locator('.git-sidebar')
  const gitButton = git.getByRole('button', { name: /^Source control,/ })
  await gitButton.waitFor()
  for (const width of [300, 180]) {
    await page.evaluate(
      (value) => localStorage.setItem('lemex-layout-sidebar', String(value)),
      width,
    )
    await fixture.ready()
    const row = await git.boundingBox()
    const source = await gitButton.boundingBox()
    const refresh = await git
      .getByRole('button', { name: 'Refresh Git status' })
      .boundingBox()
    assert(row && source && refresh)
    assert(row.height <= 45, 'Git fits on one compact row')
    assert(
      Math.abs(source.y + source.height / 2 - refresh.y - refresh.height / 2) <=
        1,
    )
    assert(
      source.x + source.width <= refresh.x + 1,
      'Source control and refresh do not overlap',
    )
    for (const section of [playgrounds, projects]) {
      const bounds = await section.boundingBox()
      assert(bounds)
      const actions = await section
        .locator('.sidebar-section-actions')
        .boundingBox()
      assert(actions)
      assert(actions.x + actions.width <= bounds.x + bounds.width + 1)
    }
    await page.screenshot({ path: path.join(output, `sidebar-${width}.png`) })
  }
  report.checks.push(
    'Git branch, source control count, refresh and section actions fit the minimum sidebar width.',
  )
  fixture.assertClean()
  report.ok = true
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log('Compact sidebar browser checks passed.')
} catch (error) {
  await fixture?.page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
