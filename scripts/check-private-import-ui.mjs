#!/usr/bin/env node
// Exercise private import controls against isolated fixtures, without providers.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, '.runtime/private-import-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(path.join(root, 'client/dist')))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`
const projectId = 'private-import-fixture'
const fakeToken = `fixture-token-${randomUUID()}`
const fakeUsername = 'gitlab+deploy-token-fixture'
let fixture
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'fixture-owner', name: 'Fixture owner' },
      templates: [
        {
          id: 'lean',
          name: 'Lean basics',
          toolchain: 'leanprover/lean4:v4.34.1',
          ready: true,
        },
      ],
      models: [],
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [{ id: projectId, name: 'Import fixture', status: 'ready' }],
    files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
    chats: [{ id: 'private-import-chat', projectId, title: 'Fixture chat' }],
    runs: [],
  })
  const { page, state, report } = fixture
  const imports = []
  const prepareRequests = []
  const externalRequests = []
  let holdImport = false
  let releaseImport = null
  let failPrepare = false
  let holdPrepare = false
  let releasePrepare = null
  await page.route('**/*', async (route) => {
    const address = new URL(route.request().url())
    if (/^https?:$/.test(address.protocol) && address.origin !== base) {
      externalRequests.push(address.href)
      return route.abort()
    }
    return route.fallback()
  })
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON()
    imports.push(body)
    if (holdImport) {
      holdImport = false
      await new Promise((resolve) => {
        releaseImport = resolve
      })
      releaseImport = null
    }
    const project = {
      id: `private-import-${imports.length}`,
      name: `Imported fixture ${imports.length}`,
      status: 'ready',
      ...(body.repository ? { repository: body.repository } : {}),
    }
    state.projects.push(project)
    state.files[project.id] = { 'Main.lean': 'example : True := by trivial\n' }
    return route.fulfill({ json: project })
  })
  await page.route('**/api/projects/*/prepare', async (route) => {
    const request = route.request()
    assert.equal(request.method(), 'POST')
    const body = request.postDataJSON()
    prepareRequests.push(body)
    if (holdPrepare) {
      holdPrepare = false
      await new Promise((resolve) => {
        releasePrepare = resolve
      })
      releasePrepare = null
    }
    if (failPrepare) {
      failPrepare = false
      return route.fulfill({
        status: 403,
        json: {
          error: 'Repository access was denied. Check the token permissions.',
        },
      })
    }
    const id = new URL(request.url()).pathname.split('/')[3]
    const project = state.projects.find((value) => value.id === id)
    assert(project)
    project.status = 'ready'
    delete project.repositoryAuthenticationRequired
    delete project.error
    return route.fulfill({ json: project })
  })
  const importDialog = () =>
    page.getByRole('dialog', { name: 'Open a Lean project', exact: true })
  const accessDialog = () =>
    page.getByRole('dialog', { name: 'Repository access', exact: true })
  const token = () =>
    importDialog().getByLabel('Repository token', { exact: false })
  const username = () =>
    importDialog().getByLabel('Repository username', { exact: false })
  const url = () =>
    importDialog().getByLabel('Repository or GitHub / GitLab folder link')
  const openImport = async () => {
    await page
      .getByRole('button', { name: 'Import or create project', exact: true })
      .first()
      .click()
    await importDialog().waitFor()
  }
  const openPrivate = async () => {
    await importDialog()
      .getByText('Private repository access', { exact: true })
      .click()
  }
  const submitImport = async () => {
    await importDialog()
      .getByRole('button', { name: 'Import project', exact: true })
      .click()
    await importDialog().waitFor({ state: 'hidden' })
  }
  const storageHasToken = () =>
    page.evaluate(
      (credential) =>
        JSON.stringify({ ...localStorage, ...sessionStorage }).includes(
          credential,
        ),
      fakeToken,
    )

  await fixture.ready()
  await openImport()
  await url().fill('https://github.com/fixture/public-project.git')
  await submitImport()
  assert.equal(imports.length, 1)
  assert.equal(imports[0].repositoryToken, undefined)
  assert.equal(imports[0].repositoryUsername, undefined)
  report.checks.push('Public imports submit without repository credentials.')

  await openImport()
  const gitlabLink =
    'https://gitlab.com/group/subgroup/private-project/-/tree/main/Lean'
  await url().fill(gitlabLink)
  await openPrivate()
  assert.equal(await token().getAttribute('type'), 'password')
  assert.equal(await token().getAttribute('autocomplete'), 'new-password')
  await username().fill(fakeUsername)
  await importDialog()
    .getByRole('button', { name: 'Import project', exact: true })
    .click()
  await importDialog().getByRole('alert').waitFor()
  assert.match(
    await importDialog().getByRole('alert').innerText(),
    /Enter a repository token for this username/,
  )
  assert.equal(imports.length, 1)
  await token().fill(fakeToken)
  await username().fill(fakeUsername)
  assert.equal(await storageHasToken(), false)
  await url().fill('https://github.com/fixture/another-private.git')
  assert.equal(await token().inputValue(), '')
  assert.equal(await username().inputValue(), '')
  await token().fill(fakeToken)
  await username().fill(fakeUsername)
  await importDialog()
    .getByRole('button', { name: 'Upload', exact: true })
    .click()
  await importDialog()
    .getByRole('button', { name: 'Repository', exact: true })
    .click()
  await openPrivate()
  assert.equal(await token().inputValue(), '')
  assert.equal(await username().inputValue(), '')
  await token().fill(fakeToken)
  await username().fill(fakeUsername)
  await importDialog()
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await openImport()
  await url().fill(gitlabLink)
  await openPrivate()
  assert.equal(await token().inputValue(), '')
  assert.equal(await username().inputValue(), '')
  report.checks.push(
    'Changing repository or source, and closing the dialog, clears credentials without browser storage.',
  )

  await token().fill(` ${fakeToken} `)
  await username().fill(` ${fakeUsername} `)
  holdImport = true
  await importDialog()
    .getByRole('button', { name: 'Import project', exact: true })
    .click()
  await until(() => releaseImport !== null, 'private import pending')
  assert.equal(await token().isDisabled(), true)
  assert.equal(await username().isDisabled(), true)
  assert.equal(
    await importDialog()
      .getByRole('button', { name: 'Cancel', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await importDialog()
      .getByRole('button', { name: 'Upload', exact: true })
      .isDisabled(),
    true,
  )
  releaseImport()
  await importDialog().waitFor({ state: 'hidden' })
  assert.equal(imports.length, 2)
  assert.equal(imports[1].repository, gitlabLink)
  assert.equal(imports[1].repositoryToken, fakeToken)
  assert.equal(imports[1].repositoryUsername, fakeUsername)
  assert.equal(await storageHasToken(), false)
  report.checks.push(
    'Private GitLab folder imports include only the entered token and optional deploy-token username; submission is protected while pending.',
  )

  await openImport()
  await openPrivate()
  assert.equal(await token().inputValue(), '')
  assert.equal(await username().inputValue(), '')
  await url().fill('https://github.com/fixture/private-project.git')
  await token().fill(fakeToken)
  await submitImport()
  assert.equal(imports.length, 3)
  assert.equal(imports[2].repositoryToken, fakeToken)
  assert.equal(imports[2].repositoryUsername, undefined)
  assert.equal(await storageHasToken(), false)
  report.checks.push(
    'Private GitHub imports work with a token and omit an unnecessary username.',
  )

  await openImport()
  await url().fill('https://github.com/fixture/private-project.git')
  await openPrivate()
  await token().fill(fakeToken)
  await username().fill(fakeUsername)
  await importDialog()
    .getByRole('button', { name: 'New project', exact: true })
    .click()
  await importDialog()
    .getByRole('button', { name: 'Create project', exact: true })
    .click()
  await importDialog().waitFor({ state: 'hidden' })
  assert.equal(imports.length, 4)
  assert.equal(imports[3].repository, undefined)
  assert.equal(imports[3].repositoryToken, undefined)
  assert.equal(imports[3].repositoryUsername, undefined)
  report.checks.push(
    'Creating a new project after switching source omits repository credentials.',
  )

  const failedProject = state.projects.at(-1)
  failedProject.status = 'error'
  failedProject.repository = 'https://gitlab.com/group/private-project.git'
  failedProject.repositoryAuthenticationRequired = true
  failedProject.error =
    'Repository access was denied. Provide a token to retry.'
  await page.reload()
  await page.getByRole('button', { name: 'Retry setup', exact: true }).click()
  await accessDialog().waitFor()
  const retryToken = () =>
    accessDialog().getByLabel('Repository token', { exact: true })
  const retryUsername = () =>
    accessDialog().getByLabel('Repository username', { exact: false })
  const retry = () =>
    accessDialog().getByRole('button', { name: 'Retry setup', exact: true })
  assert.equal(await retryToken().inputValue(), '')
  assert.equal(await retry().isDisabled(), true)
  await accessDialog()
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  assert.equal(prepareRequests.length, 0)
  await page.getByRole('button', { name: 'Retry setup', exact: true }).click()
  await accessDialog().waitFor()
  await retryToken().fill(fakeToken)
  await retryUsername().fill(fakeUsername)
  failPrepare = true
  await retry().click()
  await accessDialog().getByRole('alert').waitFor()
  assert.match(
    await accessDialog().getByRole('alert').innerText(),
    /token permissions/,
  )
  assert.equal(await retryToken().inputValue(), '')
  assert.equal(await retryUsername().inputValue(), '')
  assert.equal(await retry().isDisabled(), true)
  await retryToken().fill(` ${fakeToken} `)
  await retryUsername().fill(fakeUsername)
  holdPrepare = true
  await retry().click()
  await until(() => releasePrepare !== null, 'retry import pending')
  assert.equal(await retryToken().isDisabled(), true)
  assert.equal(
    await accessDialog()
      .getByRole('button', { name: 'Cancel', exact: true })
      .isDisabled(),
    true,
  )
  releasePrepare()
  await accessDialog().waitFor({ state: 'hidden' })
  assert.equal(prepareRequests.length, 2)
  for (const input of prepareRequests) {
    assert.equal(input.repositoryToken, fakeToken)
    assert.equal(input.repositoryUsername, fakeUsername)
  }
  assert.equal(await storageHasToken(), false)
  report.checks.push(
    'Authentication failures request fresh credentials on Retry setup, support cancellation and actionable errors, and lock duplicate submissions.',
  )

  fixture.assertClean()
  assert.equal(externalRequests.length, 0)
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        checks: report.checks,
        errors: report.errors,
        externalRequests,
        imports: imports.length,
        retries: prepareRequests.length,
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify(
      {
        checks: report.checks,
        errors: report.errors,
        externalRequests,
        imports: imports.length,
        retries: prepareRequests.length,
      },
      null,
      2,
    ),
  )
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
