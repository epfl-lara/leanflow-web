#!/usr/bin/env node
// Closed fixtures: no repository downloads, credentials or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const id = 'import-environment-fixture'
const templates = [
  {
    id: 'lean',
    name: 'Lean basics',
    toolchain: 'leanprover/lean4:v4.35.0',
    versions: ['v4.35.0', 'v4.34.1'],
    ready: true,
  },
  {
    id: 'mathlib',
    name: 'Mathlib',
    toolchain: 'leanprover/lean4:v4.35.0-rc4',
    ready: true,
  },
  {
    id: 'cslib',
    name: 'CSLib',
    toolchain: 'leanprover/lean4:v4.35.0-rc4',
    ready: true,
  },
  {
    id: 'physlib',
    name: 'Physlib',
    toolchain: 'leanprover/lean4:v4.34.1',
    ready: true,
  },
]
const f = await chatBrowserFixture({
  session: {
    user: { id: 'fixture', name: 'Fixture' },
    templates,
    models: [],
    runtime: { ready: true },
  },
  projects: [{ id: 'existing', name: 'Existing project', status: 'ready' }],
  files: { existing: { 'Main.lean': 'import Lean\n' } },
  chats: [
    {
      id: 'existing-chat',
      projectId: 'existing',
      title: 'Existing chat',
      runCount: 0,
    },
  ],
  runs: [],
})
const reportDir = path.resolve('.runtime/import-environment-ui')
await fs.mkdir(reportDir, { recursive: true })
const requests = []
let project
let failSelection = true
await f.page.route('**/api/projects', async (route) => {
  if (route.request().method() !== 'POST') return route.fallback()
  const input = route.request().postDataJSON()
  project = {
    id,
    name: 'ETL and paper',
    repository: input.repository,
    status: 'preparing',
    importWarning:
      'Only part of this repository could be checked for Lean configuration. Choose a new environment here to add Lean at this project root.',
  }
  f.state.projects.push(project)
  f.state.files[id] = {
    'paper.md': '# Original paper\n',
    'etl.py': 'print("original")\n',
  }
  await route.fulfill({ json: project })
})
await f.page.route(`**/api/projects/${id}/environment`, async (route) => {
  assert.equal(route.request().method(), 'POST')
  requests.push(route.request().postDataJSON())
  if (failSelection)
    return route.fulfill({
      status: 503,
      json: { error: 'Library preparation is busy. Try again.' },
    })
  project.status = 'preparing'
  project.setupPhase = 'preparing-dependencies'
  await route.fulfill({ json: project })
})
const setup = () => f.page.locator('.import-environment-setup')
const checked = () =>
  setup()
    .locator('input[name="libraries"]:checked')
    .evaluateAll((inputs) => inputs.map((input) => input.value))
try {
  await f.page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090')
  await f.page.getByRole('button', { name: 'Main.lean', exact: true }).waitFor()
  await f.page
    .getByRole('button', { name: 'Import or create project', exact: true })
    .first()
    .click()
  await f.page
    .getByLabel('Repository or GitHub / GitLab folder link')
    .fill('https://github.com/example/etl')
  await f.page
    .getByRole('button', { name: 'Import project', exact: true })
    .click()
  await until(() => !!project, 'repository imported')
  project.status = 'needs-setup'
  await setup()
    .getByRole('heading', { name: 'Set up Lean for ETL and paper' })
    .waitFor()
  await setup()
    .getByText(/Only part of this repository could be checked/)
    .waitFor()
  assert.deepEqual(await checked(), ['mathlib'])
  assert.equal(requests.length, 0)
  await setup()
    .getByRole('checkbox', { name: /^CSLib/ })
    .check()
  assert(
    await setup()
      .getByRole('checkbox', { name: /^Physlib/ })
      .isDisabled(),
  )
  await setup()
    .getByText(/with CSLib’s compatible Mathlib revision/)
    .waitFor()
  await setup()
    .getByRole('button', { name: 'Prepare environment', exact: true })
    .click()
  await setup()
    .getByRole('alert')
    .getByText('Library preparation is busy. Try again.')
    .waitFor()
  assert.deepEqual(requests[0], { libraries: ['mathlib', 'cslib'] })
  assert.deepEqual(await checked(), ['mathlib', 'cslib'])
  f.report.checks.push(
    'Git import without Lean opens environment selection; no preparation is requested before a choice; library pins, compatibility and retry errors are preserved',
  )
  await f.page.screenshot({
    path: path.join(reportDir, 'library-choices.png'),
    fullPage: true,
  })
  await f.page.reload()
  await setup().waitFor()
  assert.deepEqual(await checked(), ['mathlib'])
  await setup()
    .getByRole('checkbox', { name: /^Physlib/ })
    .check()
  assert(
    await setup()
      .getByRole('checkbox', { name: /^CSLib/ })
      .isDisabled(),
  )
  await setup()
    .getByText(/with Physlib’s compatible Mathlib revision/)
    .waitFor()
  await setup()
    .getByRole('checkbox', { name: /^Lean basics/ })
    .check()
  await setup()
    .getByLabel('Lean version', { exact: true })
    .selectOption('custom')
  await setup()
    .getByLabel('Exact Lean version', { exact: true })
    .fill('4.36.0-rc1')
  await f.page.setViewportSize({ width: 390, height: 844 })
  await setup()
    .getByRole('button', { name: 'Prepare environment', exact: true })
    .scrollIntoViewIfNeeded()
  assert(
    await f.page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  )
  await f.page.screenshot({
    path: path.join(reportDir, 'mobile-lean-version.png'),
    fullPage: true,
  })
  failSelection = false
  await setup()
    .getByRole('button', { name: 'Prepare environment', exact: true })
    .click()
  await setup().waitFor({ state: 'hidden' })
  assert.deepEqual(requests.at(-1), {
    libraries: [],
    toolchain: 'leanprover/lean4:v4.36.0-rc1',
  })
  await f.page.setViewportSize({ width: 1600, height: 1000 })
  project.status = 'ready'
  project.toolchain = requests.at(-1).toolchain
  f.state.files[id]['Main.lean'] = 'import Lean\n'
  await f.page.getByRole('button', { name: 'Main.lean', exact: true }).waitFor()
  assert.equal(f.state.files[id]['paper.md'], '# Original paper\n')
  f.report.checks.push(
    'Pending setup survives reload; Physlib compatibility, custom exact Lean versions and mobile layout work; submission returns to preparation and the editor',
  )
  f.assertClean()
  f.report.passed = true
} catch (error) {
  f.report.failure = error.stack
  await f.page.screenshot({
    path: path.join(reportDir, 'failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(f.report, null, 2) + '\n',
  )
  await f.browser.close()
}
console.log(
  JSON.stringify({ passed: f.report.passed, checks: f.report.checks }),
)
