#!/usr/bin/env node
// Exercise import/upload controls without repository downloads or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const reportDir = path.resolve('.runtime/import-ui')
await fs.mkdir(reportDir, { recursive: true })
const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-upload-browser-'))
await fs.mkdir(path.join(folder, '.lake'))
await fs.writeFile(
  path.join(folder, '.env'),
  'DUMMY_PRIVATE_SETTING=not-a-real-secret',
)
await fs.writeFile(path.join(folder, '.lake', 'build.txt'), 'generated cache')
await fs.writeFile(
  path.join(folder, 'lean-toolchain'),
  'leanprover/lean4:v4.34.1\n',
)
await fs.writeFile(path.join(folder, 'lakefile.toml'), 'name = "uploaded"\n')
await fs.writeFile(
  path.join(folder, 'Uploaded.lean'),
  'example : True := by trivial\n',
)
const projectId = 'import-ui-existing'
const f = await chatBrowserFixture({
  session: {
    user: { id: 'import-ui-owner', name: 'Import fixture' },
    templates: [
      {
        id: 'lean',
        name: 'Lean basics',
        toolchain: 'leanprover/lean4:v4.34.1',
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
    ],
    models: [{ id: 'fixture', name: 'Fixture' }],
    defaultModel: 'fixture',
    runtime: { ready: true },
  },
  projects: [{ id: projectId, name: 'Upload target', status: 'ready' }],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [
    { id: 'import-ui-chat', projectId, title: 'Import fixture', runCount: 0 },
  ],
  runs: [],
})
const requests = [],
  report = f.report
try {
  await f.page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const input = route.request().postDataJSON()
    requests.push(input)
    const value = {
      id: `import-ui-${requests.length}`,
      name: input.name || 'HOLLight-Lean',
      status: 'preparing',
      repository: input.repository,
      setupRepair: {
        id: 'repair-fixture',
        status: 'running',
        message:
          'Automatic setup failed. Lemex is repairing the project configuration.',
      },
      log: 'Fixture setup output.\n',
    }
    f.state.projects.push(value)
    f.state.files[value.id] = Object.fromEntries(
      (input.files || []).map((file) => [file.path, file.content]),
    )
    await route.fulfill({ json: value })
  })
  await f.page.route(`**/api/projects/${projectId}/upload`, async (route) => {
    const input = route.request().postDataJSON()
    requests.push(input)
    for (const file of input.files)
      f.state.files[projectId][file.path] = file.content
    await route.fulfill({
      json: {
        applied: input.files.length,
        files: input.files.map((file) => ({ path: file.path })),
      },
    })
  })
  await f.ready()
  await f.page.getByRole('button', { name: 'Upload', exact: true }).click()
  await f.page
    .getByLabel('Upload source files', { exact: true })
    .setInputFiles({
      name: 'Added.lean',
      mimeType: 'text/plain',
      buffer: Buffer.from('example : 1 = 1 := rfl\n'),
    })
  await f.page.getByRole('button', { name: 'Add files', exact: true }).click()
  await until(
    async () => !!f.state.files[projectId]['Added.lean'],
    'uploaded file in current project',
  )
  assert.equal(
    f.state.files[projectId]['Main.lean'],
    'example : True := by trivial\n',
  )
  report.checks.push(
    'Local file upload adds files without replacing existing source',
  )
  const open = () =>
    f.page
      .getByRole('button', { name: 'Import or create project', exact: true })
      .first()
      .click()
  await open()
  const link =
    'https://github.com/epfl-lara/jordan-curve-theorem/tree/main/HOLLight-Lean'
  await f.page.getByLabel('Repository or GitHub folder link').fill(link)
  assert.equal(
    await f.page.locator('.import-options').getAttribute('open'),
    null,
  )
  await f.page
    .getByRole('button', { name: 'Import project', exact: true })
    .click()
  await until(
    async () => requests.some((input) => input.repository === link),
    'nested repository import',
  )
  assert.equal(
    requests.find((input) => input.repository === link).autoRepair,
    true,
  )
  await f.page.getByText('Lemex is repairing setup', { exact: true }).waitFor()
  await f.page
    .getByRole('button', { name: 'Stop setup', exact: true })
    .waitFor()
  report.checks.push(
    'GitHub folder link imports directly with advanced fields optional and automatic repair announced',
  )
  await f.page.screenshot({
    path: path.join(reportDir, 'announced-setup-repair.png'),
    fullPage: true,
  })
  await open()
  await f.page
    .getByRole('dialog')
    .getByRole('button', { name: 'Upload', exact: true })
    .click()
  await f.page
    .getByLabel('Upload project folder', { exact: true })
    .setInputFiles(folder)
  await f.page.getByText('3 files ready', { exact: true }).waitFor()
  await f.page.screenshot({
    path: path.join(reportDir, 'folder-upload.png'),
    fullPage: true,
  })
  await f.page.getByLabel(/Let Lemex repair setup if needed/).uncheck()
  await f.page
    .getByRole('button', { name: 'Open uploaded project', exact: true })
    .click()
  await until(
    async () => requests.some((input) => input.files?.length === 3),
    'folder project upload',
  )
  const uploaded = requests.find((input) => input.files?.length === 3)
  assert.deepEqual(uploaded.files.map((file) => file.path).sort(), [
    'Uploaded.lean',
    'lakefile.toml',
    'lean-toolchain',
  ])
  assert.equal(uploaded.autoRepair, false)
  assert(!JSON.stringify(uploaded).includes('DUMMY_PRIVATE_SETTING'))
  report.checks.push(
    'Folder upload strips enclosing folder, excludes private/cache files, and respects repair opt-out',
  )
  await open()
  await f.page.getByRole('button', { name: 'New project', exact: true }).click()
  assert.equal(
    await f.page.getByRole('checkbox', { name: /^Mathlib/ }).isChecked(),
    true,
  )
  await f.page.getByRole('checkbox', { name: /^CSLib/ }).check()
  assert.equal(
    await f.page.getByRole('checkbox', { name: /^Physlib/ }).isDisabled(),
    true,
  )
  await f.page.screenshot({
    path: path.join(reportDir, 'combined-libraries.png'),
    fullPage: true,
  })
  await f.page
    .getByRole('button', { name: 'Create project', exact: true })
    .click()
  await until(
    async () => requests.some((input) => input.libraries?.includes('cslib')),
    'combined library creation',
  )
  assert.deepEqual(
    requests.find((input) => input.libraries?.includes('cslib')).libraries,
    ['mathlib', 'cslib'],
  )
  report.checks.push(
    'Mathlib and CSLib can be selected together while incompatible Physlib pins are explained and disabled',
  )
  f.assertClean()
  report.passed = true
} catch (error) {
  report.failure = error.stack
  await f.page.screenshot({
    path: path.join(reportDir, 'failure.png'),
    fullPage: true,
  })
  throw error
} finally {
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await f.browser.close()
  await fs.rm(folder, { recursive: true, force: true })
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks }))
