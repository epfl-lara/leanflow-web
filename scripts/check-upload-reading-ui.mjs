#!/usr/bin/env node
// Closed API/editor fixture: selecting new files must finish before submission.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/upload-reading-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
let fixture
const result = { checks: [] }
try {
  const projectId = 'upload-reading-project'
  fixture = await chatBrowserFixture({
    base: `http://127.0.0.1:${server.address().port}`,
    session: {
      user: { id: 'upload-reading-user', name: 'Upload fixture' },
      templates: [],
      models: [{ id: 'fixture', name: 'Fixture' }],
      defaultModel: 'fixture',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [{ id: projectId, name: 'Upload fixture', status: 'ready' }],
    files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
    chats: [{ id: 'upload-reading-chat', projectId, title: 'Upload fixture' }],
    runs: [],
  })
  const { page, state } = fixture
  const uploads = []
  const created = []
  await page.route(`**/api/projects/${projectId}/upload`, (route) => {
    const input = route.request().postDataJSON()
    uploads.push(input)
    for (const file of input.files)
      state.files[projectId][file.path] = file.content
    return route.fulfill({ json: { applied: input.files.length } })
  })
  await page.route('**/api/projects', (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const input = route.request().postDataJSON()
    created.push(input)
    const project = {
      id: 'uploaded-new-project',
      name: 'New upload',
      status: 'ready',
    }
    state.projects.push(project)
    state.files[project.id] = Object.fromEntries(
      input.files.map((file) => [file.path, file.content]),
    )
    return route.fulfill({ json: project })
  })
  await fixture.ready()
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'Second.lean')
        await new Promise((resolve) => {
          window.__releaseUploadRead = resolve
        })
      return read.call(this)
    }
  })
  async function selectWhileReading(dialog, submitLabel, requests) {
    const input = dialog.getByLabel('Upload source files', { exact: true })
    await input.setInputFiles({
      name: 'First.lean',
      mimeType: 'text/plain',
      buffer: Buffer.from('-- first\n'),
    })
    await dialog.getByText('1 file ready', { exact: true }).waitFor()
    await input.setInputFiles({
      name: 'Second.lean',
      mimeType: 'text/plain',
      buffer: Buffer.from('-- second\n'),
    })
    await dialog.getByText('Reading files…', { exact: true }).waitFor()
    assert.equal(
      await dialog
        .getByRole('button', { name: submitLabel, exact: true })
        .isDisabled(),
      true,
    )
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Clear selection', exact: true })
        .isDisabled(),
      true,
    )
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Cancel', exact: true })
        .isDisabled(),
      true,
    )
    const count = requests.length
    await dialog.locator('form').evaluate((form) => form.requestSubmit())
    assert.equal(requests.length, count)
    await page.keyboard.press('Escape')
    assert.equal(await dialog.isVisible(), true)
    await page.evaluate(() => window.__releaseUploadRead())
    await dialog.getByText('Second.lean', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: submitLabel, exact: true }).click()
    await until(
      () => requests.length === count + 1,
      `${submitLabel} sends the new selection`,
    )
    assert.deepEqual(requests.at(-1).files, [
      { path: 'Second.lean', content: '-- second\n' },
    ])
  }
  await page.getByRole('button', { name: 'Upload', exact: true }).click()
  await selectWhileReading(
    page.getByRole('dialog', { name: 'Add local files', exact: true }),
    'Add files',
    uploads,
  )
  result.checks.push(
    'Adding files waits for the new selection and never submits the previous files',
  )
  await page
    .getByRole('button', { name: 'Import or create project', exact: true })
    .first()
    .click()
  const dialog = page.getByRole('dialog', {
    name: 'Open a Lean project',
    exact: true,
  })
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
  await selectWhileReading(dialog, 'Open uploaded project', created)
  result.checks.push(
    'Creating a project waits for the new selection, including keyboard or programmatic submission',
  )
  fixture.assertClean()
  result.passed = true
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  result.error = error.stack
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
