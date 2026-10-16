#!/usr/bin/env node
// Verify setup/repair progress and recovery without calling any providers.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const id = 'setup-progress-fixture'
const project = {
  id,
  name: 'Setup progress',
  status: 'preparing',
  setupPhase: 'preparing-dependencies',
  toolchain: 'leanprover/lean4:v4.34.1',
}
const f = await chatBrowserFixture({
  session: {
    user: { id: 'fixture', name: 'Fixture' },
    templates: [],
    models: [],
    defaultModel: 'fixture',
    runtime: { ready: true },
  },
  projects: [project],
  files: { [id]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: 'fixture-chat', projectId: id, title: 'Fixture', runCount: 0 }],
  runs: [],
})
const reportDir = path.resolve('.runtime/setup-progress-ui')
await fs.mkdir(reportDir, { recursive: true })
let stops = 0
let prepares = 0
let detailRequests = 0
let listRequests = 0
await f.page.route('**/api/projects', (route) => {
  listRequests++
  return route.fulfill({
    json: f.state.projects.map((item) => {
      const metadata = { ...item }
      delete metadata.log
      return metadata
    }),
  })
})
await f.page.route(`**/api/projects/${id}`, (route) => {
  detailRequests++
  return route.fulfill({ json: project })
})
await f.page.route(`**/api/projects/${id}/prepare`, (route) => {
  prepares++
  project.status = 'preparing'
  project.setupEventAfter = (project.setupEventAfter || 0) + 1
  project.setupStartedAt = new Date().toISOString()
  project.setupPhase = 'preparing-dependencies'
  delete project.dependencyWarning
  delete project.needsPreparation
  return route.fulfill({ json: project })
})
await f.page.route(`**/api/projects/${id}/prepare/stop`, (route) => {
  stops++
  project.status = 'error'
  project.error = 'Project setup stopped. You can retry when ready.'
  project.setupRepair.status = 'failed'
  return route.fulfill({ json: project })
})
try {
  await f.page.goto(process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090')
  await f.page.getByText('Preparing libraries', { exact: true }).waitFor()
  assert(await f.page.locator('.setup-repair-notice .spinner').isVisible())
  project.setupPhase = 'cloning-repository'
  await f.page.getByText('Importing the repository', { exact: true }).waitFor()
  project.setupPhase = 'selecting-revision'
  await f.page
    .getByText('Selecting the project revision', { exact: true })
    .waitFor()
  project.setupPhase = 'repairing-setup'
  project.setupRepair = {
    id: 'repair-fixture',
    status: 'running',
    message: 'Lemex is checking configuration.',
  }
  await f.page.getByText('Lemex is repairing setup', { exact: true }).waitFor()
  project.setupPhase = 'validating-repair'
  await f.page.getByText('Testing the setup repair', { exact: true }).waitFor()
  await f.page.getByRole('button', { name: 'Stop setup', exact: true }).click()
  await until(() => stops === 1, 'repair stopped')
  await f.page
    .getByRole('button', { name: 'Retry setup', exact: true })
    .waitFor()
  assert.equal(await f.page.locator('.setup-repair-notice .spinner').count(), 0)
  project.status = 'ready'
  project.setupBuildStatus = 'warnings'
  project.sourceRevision = 'a'.repeat(40)
  project.log =
    'Starting: Building dependency mathlib.\nBuild completed successfully (32 jobs).\nVerified dependency revision mathlib: ' +
    'b'.repeat(40) +
    '\n'
  project.setupRepair.status = 'completed'
  project.buildWarning = 'A proof in Main.lean still has unsolved goals.'
  delete project.error
  await f.page.reload()
  await f.page
    .getByText('Project build needs attention', { exact: true })
    .waitFor()
  await f.page.getByText(project.buildWarning, { exact: true }).waitFor()
  await f.page.getByText('Setup repaired and tested', { exact: true }).waitFor()
  await f.page
    .locator('.setup-status')
    .getByText('Build warnings', { exact: true })
    .waitFor()
  assert.equal(
    await f.page.locator('.setup-digest').innerText(),
    'Lean v4.34.1 · aaaaaaa',
  )
  await f.page
    .locator('.setup-facts')
    .getByText(project.sourceRevision, { exact: true })
    .waitFor()
  assert.equal(await f.page.locator('.setup-editor-details summary').count(), 1)
  assert(await f.page.locator('.setup-log').isVisible())
  assert.match(
    await f.page.locator('.setup-log').innerText(),
    /Building dependency mathlib/,
  )
  project.setupBuildStatus = 'passed'
  delete project.buildWarning
  delete project.setupRepair
  project.log += Array.from(
    { length: 300 },
    (_, i) => `Build output line ${i}\n`,
  ).join('')
  await f.page.setViewportSize({ width: 1280, height: 720 })
  await f.page.reload()
  await f.page
    .locator('.setup-status')
    .getByText('Build passed', { exact: true })
    .waitFor()
  assert(
    (await f.page.locator('.setup-editor-details').boundingBox()).height < 40,
  )
  await f.page.screenshot({ path: path.join(reportDir, 'setup-collapsed.png') })
  await f.page.getByText('Project setup', { exact: true }).click()
  const typography = await f.page
    .locator('.setup-editor-details')
    .evaluate((element) => ({
      heading: getComputedStyle(element.querySelector('summary')).fontSize,
      content: getComputedStyle(element.querySelector('.setup-facts')).fontSize,
    }))
  assert.equal(typography.heading, '12px')
  assert.equal(typography.content, '12px')
  const heading = f.page.locator('.setup-editor-details > summary')
  await heading.focus()
  await f.page.keyboard.press('Enter')
  assert.equal(
    await f.page.locator('.setup-editor-details').getAttribute('open'),
    null,
  )
  assert.equal(await f.page.locator('.setup-log').isVisible(), false)
  assert(await f.page.locator('.setup-digest').isVisible())
  await f.page.keyboard.press('Enter')
  assert.notEqual(
    await f.page.locator('.setup-editor-details').getAttribute('open'),
    null,
  )
  assert(await f.page.locator('.setup-log').isVisible())
  assert.equal(await f.page.locator('.setup-editor-details details').count(), 0)
  assert.match(
    await f.page.locator('.setup-log').innerText(),
    /Verified dependency revision mathlib/,
  )
  const scrollers = await f.page
    .locator('.setup-editor-details')
    .evaluate((element) => {
      const log = element.querySelector('.setup-log')
      element.scrollTop = element.scrollHeight
      return {
        height: element.getBoundingClientRect().height,
        panelScrolls: element.scrollHeight > element.clientHeight,
        logScrolls: log.scrollHeight - log.clientHeight > 1,
      }
    })
  assert(scrollers.height <= 181)
  assert(scrollers.panelScrolls)
  assert.equal(scrollers.logScrolls, false)
  const pinnedHeading = await f.page
    .locator('.setup-editor-details')
    .evaluate(async (element) => {
      await new Promise(requestAnimationFrame)
      return Math.abs(
        element.querySelector('summary').getBoundingClientRect().top -
          element.getBoundingClientRect().top,
      )
    })
  assert(
    pinnedHeading <= 1,
    'setup heading stays visible while its output scrolls',
  )
  f.report.setupLayout = {
    typography,
    ...scrollers,
    pinnedHeadingOffset: pinnedHeading,
  }
  await f.page.screenshot({ path: path.join(reportDir, 'setup-expanded.png') })
  await f.page.setViewportSize({ width: 1600, height: 1000 })
  const background = {
    id: 'background-setup',
    name: 'Background',
    status: 'preparing',
  }
  f.state.projects.push(background)
  f.state.files[background.id] = {}
  await f.page.reload()
  await f.page.getByText('Project setup', { exact: true }).click()
  await f.page.locator('.setup-log').waitFor()
  const initialDetails = detailRequests
  const initialLists = listRequests
  await until(() => listRequests >= initialLists + 2, 'background setup polls')
  assert.equal(
    detailRequests,
    initialDetails,
    'completed setup logs are fetched once while other projects prepare',
  )
  project.setupEventAfter = 200
  project.setupStartedAt = new Date().toISOString()
  project.log = 'Refreshed setup output from a new attempt.\n'
  await until(
    async () =>
      (await f.page.locator('.setup-log').innerText()).includes(
        'Refreshed setup output',
      ),
    'new attempt reloads the log',
  )
  assert.equal(detailRequests, initialDetails + 1)
  f.state.projects.splice(f.state.projects.indexOf(background), 1)
  project.needsPreparation = true
  project.dependencyWarning =
    'This project uses an older dependency cache. Use Refresh setup.'
  await f.page.reload()
  await f.page
    .getByText('Dependencies need preparation', { exact: true })
    .waitFor()
  assert(
    await f.page
      .getByRole('button', { name: 'Check Project', exact: true })
      .isDisabled(),
  )
  await f.page
    .getByRole('button', { name: 'About Refresh setup', exact: true })
    .click()
  const help = f.page.getByRole('tooltip')
  await help.waitFor()
  assert.match(await help.innerText(), /reuse valid compiled caches/)
  assert.match(await help.innerText(), /Lemex repairs it automatically/)
  assert.match(await help.innerText(), /pinned versions are preserved/)
  assert.equal(prepares, 0, 'opening help does not start setup')
  await f.page.mouse.move(0, 0)
  await f.page.keyboard.press('Escape')
  await help.waitFor({ state: 'hidden' })
  await f.page
    .getByRole('button', { name: 'Refresh setup', exact: true })
    .click()
  await until(() => prepares === 1, 'ready project cache preparation')
  await f.page.getByText('Preparing libraries', { exact: true }).waitFor()
  project.status = 'ready'
  f.state.session.lemex = { configured: false }
  await f.ready()
  await f.page
    .getByRole('button', { name: 'Import or create project', exact: true })
    .first()
    .click()
  const dialog = f.page.getByRole('dialog')
  await dialog.waitFor()
  const repairChoice = dialog.getByRole('checkbox', {
    name: /Let Lemex repair setup if needed/,
  })
  assert(await repairChoice.isDisabled())
  assert.equal(await repairChoice.isChecked(), false)
  await dialog
    .getByText(/Lemex setup repair is unavailable on this server/)
    .waitFor()
  f.assertClean()
  f.report.checks.push(
    'Setup shows clone and repair progress, Stop and Retry, a version/revision/build summary and contextual output; Refresh setup has clickable cache and repair help; dependency warnings block new checks; unavailable Lemex repair is explained and disabled.',
  )
  f.report.passed = true
} catch (error) {
  f.report.passed = false
  f.report.error = error.stack
  process.exitCode = 1
} finally {
  await f.page.screenshot({
    path: path.join(reportDir, 'browser.png'),
    fullPage: true,
  })
  await f.browser.close()
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(f.report, null, 2),
  )
}
console.log(JSON.stringify(f.report, null, 2))
