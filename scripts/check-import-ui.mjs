#!/usr/bin/env node
// Exercise import/upload controls without repository downloads or provider calls.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
const aggregateFiles = Array.from(
  { length: 4 },
  (_, index) => `Aggregate${index}.lean`,
)
for (const name of aggregateFiles)
  await fs.writeFile(
    path.join(folder, name),
    '-- ' + 'a'.repeat(5_420_000) + '\n',
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
  await f.page.getByRole('button', { name: 'Upload', exact: true }).click()
  const largeSource = process.env.STUDIO_LARGE_SOURCE_FILE
    ? await fs.readFile(process.env.STUDIO_LARGE_SOURCE_FILE, 'utf8')
    : '-- ' + 'a'.repeat(5_400_000) + '\n'
  report.largeSource = {
    name: process.env.STUDIO_LARGE_SOURCE_FILE
      ? path.basename(process.env.STUDIO_LARGE_SOURCE_FILE)
      : 'synthetic Lean source',
    bytes: Buffer.byteLength(largeSource),
    sha256: createHash('sha256').update(largeSource).digest('hex'),
  }
  await f.page
    .getByLabel('Upload source files', { exact: true })
    .setInputFiles({
      name: 'Large.lean',
      mimeType: 'text/plain',
      buffer: Buffer.from(largeSource),
    })
  await f.page.getByText('1 file ready', { exact: true }).waitFor()
  await f.page.getByRole('button', { name: 'Add files', exact: true }).click()
  await until(
    async () =>
      f.state.files[projectId]['Large.lean']?.length === largeSource.length,
    'large Lean upload',
  )
  let largeSaves = 0
  await f.page.route(
    `**/api/projects/${projectId}/file?path=Large.lean`,
    async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback()
      const input = route.request().postDataJSON()
      const before = f.state.files[projectId]['Large.lean']
      assert.equal(
        input.expectedHash,
        createHash('sha256').update(before).digest('hex'),
      )
      f.state.files[projectId]['Large.lean'] = input.content
      largeSaves++
      await route.fulfill({
        json: {
          hash: createHash('sha256').update(input.content).digest('hex'),
          requiresPreparation: false,
        },
      })
    },
  )
  await f.page.getByRole('button', { name: 'Large.lean', exact: true }).click()
  await f.page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await until(
    async () =>
      (await f.page.locator('.monaco-editor .view-lines').innerText())
        .replaceAll('\u00a0', ' ')
        .startsWith(largeSource.split(/\r?\n/, 1)[0].trim().slice(0, 24)),
    'large source editor',
    60000,
  )
  await f.page.locator('.monaco-editor textarea').focus()
  await f.page.keyboard.press('Control+End')
  await f.page.keyboard.insertText('-- edited large source\n')
  const saveLarge = f.page.getByRole('button', { name: 'Save', exact: true })
  await until(() => saveLarge.isEnabled(), 'dirty large source')
  await saveLarge.click()
  await until(async () => largeSaves === 1, 'large source saved')
  assert.equal(
    createHash('sha256')
      .update(f.state.files[projectId]['Large.lean'])
      .digest('hex'),
    createHash('sha256')
      .update(largeSource + '-- edited large source\n')
      .digest('hex'),
  )
  await f.page.getByRole('button', { name: 'Main.lean', exact: true }).click()
  report.checks.push(
    `A ${report.largeSource.bytes}-byte source opens in the editor, accepts a manual edit and saves with its original hash`,
  )
  await f.page.getByRole('button', { name: 'Upload', exact: true }).click()
  await f.page
    .getByLabel('Upload source files', { exact: true })
    .setInputFiles({
      name: 'TooLarge.lean',
      mimeType: 'text/plain',
      buffer: Buffer.from('a'.repeat(8 * 1024 * 1024 + 1)),
    })
  await f.page
    .getByText(
      'TooLarge.lean is larger than 8 MiB. Reduce the file or split Lean sources into smaller modules.',
      { exact: true },
    )
    .waitFor()
  await f.page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(f.state.files[projectId]['TooLarge.lean'], undefined)
  report.checks.push(
    `A ${report.largeSource.bytes}-byte Lean source uploads; files over 8 MiB receive an actionable error before any upload`,
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
  await f.page.getByText('7 files ready', { exact: true }).waitFor()
  await f.page.screenshot({
    path: path.join(reportDir, 'folder-upload.png'),
    fullPage: true,
  })
  await f.page.getByLabel(/Let Lemex repair setup if needed/).uncheck()
  await f.page
    .getByRole('button', { name: 'Open uploaded project', exact: true })
    .click()
  await until(
    async () => requests.some((input) => input.files?.length === 7),
    'folder project upload',
  )
  const uploaded = requests.find((input) => input.files?.length === 7)
  assert.deepEqual(uploaded.files.map((file) => file.path).sort(), [
    ...aggregateFiles,
    'Uploaded.lean',
    'lakefile.toml',
    'lean-toolchain',
  ])
  assert.equal(uploaded.autoRepair, false)
  assert(!JSON.stringify(uploaded).includes('DUMMY_PRIVATE_SETTING'))
  report.aggregateSourceBytes = uploaded.files.reduce(
    (bytes, file) => bytes + Buffer.byteLength(file.content),
    0,
  )
  assert(report.aggregateSourceBytes >= 21_670_380)
  report.checks.push(
    `A ${report.aggregateSourceBytes}-byte folder uploads, strips its enclosing folder, excludes private/cache files, and respects repair opt-out`,
  )
  await open()
  await f.page.locator('.import-options > summary').click()
  await f.page.getByLabel('Lean project subdirectory').fill('old/import/path')
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
  assert.equal(
    requests.find((input) => input.libraries?.includes('cslib')).subdirectory,
    undefined,
  )
  report.checks.push(
    'Mathlib and CSLib can be selected together, incompatible Physlib pins are explained, and switching from import drops the old subdirectory',
  )
  await open()
  await f.page.getByRole('button', { name: 'New project', exact: true }).click()
  await f.page.getByRole('checkbox', { name: /^Physlib/ }).check()
  assert.equal(
    await f.page.getByRole('checkbox', { name: /^CSLib/ }).isDisabled(),
    true,
  )
  await f.page.getByText(/with Physlib’s compatible Mathlib revision/).waitFor()
  await f.page
    .getByRole('button', { name: 'Create project', exact: true })
    .click()
  await until(
    async () => requests.some((input) => input.libraries?.includes('physlib')),
    'Mathlib and Physlib creation',
  )
  assert.deepEqual(
    requests.find((input) => input.libraries?.includes('physlib')).libraries,
    ['mathlib', 'physlib'],
  )
  report.checks.push(
    'Mathlib and Physlib can be combined with the actual selected toolchain displayed',
  )

  // Keep fixture detail responses available while presenting an empty sidebar.
  await f.page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] })
    return route.fallback()
  })
  const welcome = async () => {
    await f.page.reload()
    await f.page
      .getByRole('heading', { name: 'Start with your project.', exact: true })
      .waitFor()
  }
  const dialog = () => f.page.getByRole('dialog')
  const checkedLibraries = () =>
    dialog()
      .locator('input[name="libraries"]:checked')
      .evaluateAll((inputs) => inputs.map((input) => input.value))
  for (const template of f.state.session.templates) {
    await welcome()
    const card = f.page.getByRole('button', {
      name: `Create a ${template.name} project`,
      exact: true,
    })
    if (template.id === 'lean' || template.id === 'mathlib') {
      await card.focus()
      await f.page.keyboard.press(template.id === 'lean' ? 'Enter' : 'Space')
    } else {
      await card.click()
    }
    await dialog().waitFor()
    assert.equal(
      await dialog()
        .getByRole('button', { name: 'New project', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    )
    assert.deepEqual(await checkedLibraries(), [template.id])
    if (template.id === 'lean')
      assert.equal(
        await dialog().getByLabel('Lean version', { exact: true }).inputValue(),
        template.toolchain.replace('leanprover/lean4:', ''),
      )
    if (template.id === 'mathlib')
      await f.page.screenshot({
        path: path.join(reportDir, 'welcome-mathlib.png'),
        fullPage: true,
      })
    const requestCount = requests.length
    await dialog()
      .getByRole('button', { name: 'Create project', exact: true })
      .click()
    await dialog().waitFor({ state: 'hidden' })
    assert.equal(requests.length, requestCount + 1)
    assert.deepEqual(
      requests.at(-1).libraries,
      template.id === 'lean' ? [] : [template.id],
    )
    assert.equal(
      requests.at(-1).toolchain,
      template.id === 'lean' ? template.toolchain : undefined,
    )
    assert.equal(requests.at(-1).repository, undefined)
  }
  report.checks.push(
    'Every welcome card opens New project with only its preset selected and submits that choice; Lean basics keeps its pinned version; Enter and Space activate cards',
  )

  await welcome()
  await f.page
    .getByRole('button', { name: 'Create a CSLib project', exact: true })
    .click()
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
  await f.page
    .getByRole('button', { name: 'Create a Physlib project', exact: true })
    .click()
  assert.deepEqual(await checkedLibraries(), ['physlib'])
  await f.page.keyboard.press('Escape')
  await open()
  assert.equal(
    await dialog()
      .getByRole('button', { name: 'Repository', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  )
  await dialog()
    .getByRole('button', { name: 'New project', exact: true })
    .click()
  assert.deepEqual(await checkedLibraries(), ['mathlib'])
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
  report.checks.push(
    'Closing and reopening cards resets the preset; the general import/create button retains the Repository tab and default Mathlib selection',
  )

  await f.page.setViewportSize({ width: 390, height: 844 })
  await welcome()
  await f.page
    .getByRole('button', { name: 'Create a Mathlib project', exact: true })
    .click()
  assert.deepEqual(await checkedLibraries(), ['mathlib'])
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
  report.checks.push('Welcome cards remain usable on a narrow mobile viewport')

  f.state.session.templates = f.state.session.templates.map((template) => ({
    ...template,
    ready: template.id !== 'physlib',
  }))
  await welcome()
  await f.page
    .getByRole('button', { name: 'Create a Physlib project', exact: true })
    .click()
  assert.deepEqual(await checkedLibraries(), ['physlib'])
  assert.equal(
    await dialog()
      .getByRole('button', { name: 'Create project', exact: true })
      .isDisabled(),
    true,
  )
  await dialog()
    .getByText(/A selected library is not installed/)
    .waitFor()
  await dialog()
    .getByRole('checkbox', { name: /^Physlib/ })
    .uncheck()
  await dialog()
    .getByRole('checkbox', { name: /^Mathlib/ })
    .check()
  assert.deepEqual(await checkedLibraries(), ['mathlib'])
  assert.equal(
    await dialog()
      .getByRole('button', { name: 'Create project', exact: true })
      .isEnabled(),
    true,
  )
  report.checks.push(
    'An unavailable card preserves its selection, explains why creation is disabled, and lets the user choose an installed library',
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
