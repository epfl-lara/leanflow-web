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
await f.page.route(`**/api/projects/${id}/prepare`, (route) => {
  prepares++
  project.status = 'preparing'
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
  project.setupRepair.status = 'completed'
  project.buildWarning = 'A proof in Main.lean still has unsolved goals.'
  delete project.error
  await f.page.reload()
  await f.page
    .getByText('Project opened with build errors', { exact: true })
    .waitFor()
  await f.page.getByText(project.buildWarning, { exact: true }).waitFor()
  await f.page.getByText('Setup repaired and tested', { exact: true }).waitFor()
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
  await f.page.reload()
  await f.page
    .getByRole('button', { name: 'Import or create project', exact: true })
    .first()
    .click()
  const dialog = f.page.getByRole('dialog')
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
    'Setup shows live repair progress, Stop and Retry; Refresh setup has clickable cache and repair help; dependency warnings block new checks; unavailable Lemex repair is explained and disabled.',
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
