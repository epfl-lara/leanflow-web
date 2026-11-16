#!/usr/bin/env node
// Closed browser fixtures: no real clone, credentials, provider or Git mutation.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/git-usability-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const base = `http://127.0.0.1:${server.address().port}`
const checks = []
let fixture
async function makeFixture(project, files) {
  return chatBrowserFixture({
    base,
    session: {
      user: { id: 'git-usability-user', name: 'Git fixture' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [project],
    files: { [project.id]: files },
    chats: [
      { id: `${project.id}-chat`, projectId: project.id, title: 'Git fixture' },
    ],
    runs: [],
  })
}
try {
  const id = 'git-usability-project'
  fixture = await makeFixture(
    { id, name: 'Git usability fixture', status: 'ready' },
    {
      'Main.lean': 'example : True := by trivial\n',
      'Other.lean': '-- other\n',
      'Both.lean': '-- staged and unstaged\n',
      'New.lean': '-- new\n',
    },
  )
  const { page } = fixture
  const info = {
    repository: true,
    branch: 'proof/work',
    revision: 'a'.repeat(40),
    publishingEnabled: false,
    remoteUrl: null,
    pullRemoteUrl: null,
    pullBranch: 'main',
    changes: [
      { status: 'M ', path: 'Main.lean' },
      { status: ' M', path: 'Other.lean' },
      { status: 'MM', path: 'Both.lean' },
      { status: '??', path: 'New.lean' },
    ],
    diff: 'diff --git a/Main.lean b/Main.lean\n--- a/Main.lean\n+++ b/Main.lean\n@@ -1 +1 @@\n-old\n+new\n',
    diffTruncated: true,
    commits: [
      { sha: 'a'.repeat(40), message: 'A local commit without a remote' },
    ],
    reviewToken: 'fixture-review',
    mutationBlocked: false,
  }
  const actions = []
  let previewReads = 0
  let previewAvailable = false
  await page.route(`**/api/projects/${id}/file?path=New.lean`, (route) => {
    previewReads++
    return !previewAvailable
      ? route.fulfill({
          status: 503,
          json: { error: 'File preview is temporarily unavailable.' },
        })
      : route.fulfill({ json: { content: '-- new\n' } })
  })
  await page.route(`**/api/projects/${id}/git`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: info })
    const body = route.request().postDataJSON()
    actions.push(body)
    assert.equal(body.action, 'pull')
    return route.fulfill({
      json: {
        pulled: true,
        updated: true,
        branch: body.branch,
        remoteUrl: body.remoteUrl,
        needsPreparation: false,
        paths: [],
        removedPaths: [],
      },
    })
  })
  const connectionData = {
    connections: [],
    identity: { name: 'Server author', email: 'server@example.invalid' },
  }
  let failLookup = true
  let failConnect = true
  let failRefreshAfterSave = false
  let connectionWrites = 0
  const fakeToken = 'fixture-git-token-never-saved-in-browser'
  await page.route('**/api/git-connections*', (route) => {
    const request = route.request()
    if (request.method() === 'GET')
      return failLookup
        ? route.fulfill({
            status: 503,
            json: { error: 'Connection list is temporarily unavailable.' },
          })
        : route.fulfill({ json: connectionData })
    const body = request.postDataJSON()
    if (body.action === 'identity')
      connectionData.identity = { name: body.name, email: body.email }
    else {
      assert.equal(body.action, 'connect')
      assert.equal(body.token, fakeToken)
      connectionWrites++
      if (failConnect) {
        failConnect = false
        return route.fulfill({
          status: 503,
          json: { error: 'The connection could not be saved. Retry.' },
        })
      }
      connectionData.connections = [
        { host: 'github.com', provider: 'github', username: 'fixture-user' },
      ]
      if (failRefreshAfterSave) failLookup = true
    }
    return route.fulfill({ json: connectionData })
  })
  await fixture.ready()
  await page
    .getByRole('button', { name: 'Git connections', exact: true })
    .first()
    .click()
  const connections = page.getByRole('dialog', {
    name: 'Git connections',
    exact: true,
  })
  await connections
    .getByText('Connection list is temporarily unavailable.', { exact: true })
    .waitFor()
  await connections.locator('details > summary').click()
  const authorName = connections.getByLabel('Author name', { exact: true })
  const authorEmail = connections.getByLabel('Author email', { exact: true })
  const accessToken = connections.getByLabel('Access token', { exact: true })
  await authorName.fill('My draft author')
  await accessToken.fill(fakeToken)
  failLookup = false
  await connections
    .getByRole('button', { name: 'Retry loading connections', exact: true })
    .click()
  await until(
    async () => (await authorEmail.inputValue()) === 'server@example.invalid',
    'connection retry loads untouched identity fields',
  )
  assert.equal(await authorName.inputValue(), 'My draft author')
  assert.equal(await accessToken.inputValue(), fakeToken)
  await connections
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  await connections
    .getByText('The connection could not be saved. Retry.', { exact: true })
    .waitFor()
  assert.equal(await accessToken.inputValue(), fakeToken)
  await connections
    .getByRole('button', { name: 'Save author', exact: true })
    .click()
  await connections
    .getByText(
      'Commit author saved for Source control, terminals and agents.',
      { exact: true },
    )
    .waitFor()
  assert.equal(await accessToken.inputValue(), fakeToken)
  failRefreshAfterSave = true
  await connections
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  await connections
    .getByText(
      'Connection saved for imports, pulls, pushes, terminals and agents.',
      { exact: true },
    )
    .waitFor()
  assert.equal(await accessToken.inputValue(), '')
  failLookup = false
  await connections
    .getByRole('button', { name: 'Retry loading connections', exact: true })
    .click()
  await connections
    .getByRole('button', { name: 'Disconnect github.com', exact: true })
    .waitFor()
  assert.equal(connectionWrites, 2)
  assert.equal(
    await page.evaluate(
      (value) =>
        JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value),
      fakeToken,
    ),
    false,
  )
  await connections.getByRole('button', { name: 'Close', exact: true }).click()
  checks.push(
    'Connection lookup/write failures retry without losing masked tokens or author drafts; confirmed saves clear tokens and metadata retries do not repeat writes',
  )

  await page
    .getByRole('button', { name: /^Source control/ })
    .first()
    .click()
  const git = page.getByRole('dialog', { name: 'Source control', exact: true })
  await git.getByRole('tab', { name: 'History', exact: true }).click()
  await git
    .getByRole('list', { name: 'Local commit history', exact: true })
    .getByText('A local commit without a remote', { exact: true })
    .waitFor()
  assert.equal(actions.length, 0)
  const history = git.getByRole('tab', { name: 'History', exact: true })
  await history.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(
    await git
      .getByRole('tab', { name: 'Publish', exact: true })
      .getAttribute('aria-selected'),
    'true',
  )
  await page.keyboard.press('ArrowRight')
  assert.equal(
    await git
      .getByRole('tab', { name: 'Changes', exact: true })
      .getAttribute('aria-selected'),
    'true',
  )
  const files = git.getByRole('list', {
    name: 'Changed project files',
    exact: true,
  })
  assert(
    (
      await files.getByRole('button', { name: /Main\.lean/ }).innerText()
    ).includes('Staged'),
  )
  assert(
    (
      await files.getByRole('button', { name: /Other\.lean/ }).innerText()
    ).includes('Unstaged'),
  )
  assert(
    (
      await files.getByRole('button', { name: /Both\.lean/ }).innerText()
    ).includes('Staged + unstaged'),
  )
  await git
    .getByText('The tracked diff preview is incomplete.', { exact: false })
    .waitFor()
  await files.getByRole('button', { name: /New\.lean/ }).click()
  await git
    .getByRole('button', { name: 'Retry preview', exact: true })
    .waitFor()
  previewAvailable = true
  await git.getByRole('button', { name: 'Retry preview', exact: true }).click()
  await git.locator('.git-diff').getByText('-- new', { exact: true }).waitFor()
  assert.equal(previewReads, 4)
  checks.push(
    'Local history works without publishing or a remote, tabs support keyboard navigation, staged/unstaged states differ, and truncated previews are explicit',
  )
  info.publishingEnabled = true
  info.remoteUrl = 'https://github.com/push-owner/fork.git'
  info.pullRemoteUrl = 'https://github.com/upstream/project.git'
  await git.getByRole('button', { name: 'Refresh', exact: true }).click()
  await until(
    async () =>
      (await git.getByLabel('Pull from', { exact: true }).inputValue()) ===
      info.pullRemoteUrl,
    'canonical pull source loaded',
  )
  await git.getByRole('tab', { name: 'Publish', exact: true }).click()
  const destination = git.locator('.git-destination-options')
  if (!(await destination.evaluate((element) => element.open)))
    await destination.locator('summary').click()
  await git
    .getByLabel('Repository URL', { exact: true })
    .fill('https://github.com/another-owner/another-fork.git')
  await git.getByRole('button', { name: 'Pull', exact: true }).click()
  await until(() => actions.length === 1, 'pull from original source')
  assert.equal(actions[0].remoteUrl, 'https://github.com/upstream/project.git')
  assert.equal(
    await git.getByLabel('Repository URL', { exact: true }).inputValue(),
    'https://github.com/another-owner/another-fork.git',
  )
  info.pullRemoteUrl = null
  await git.getByRole('button', { name: 'Refresh', exact: true }).click()
  await until(
    async () =>
      (await git.getByLabel('Pull from', { exact: true }).inputValue()) === '',
    'unsupported pull source stays empty',
  )
  assert.equal(
    await git.getByRole('button', { name: 'Pull', exact: true }).isDisabled(),
    true,
  )
  await git
    .getByLabel('Pull from', { exact: true })
    .fill('https://github.com/explicit-source/project.git')
  await git.getByLabel('Pull branch', { exact: true }).fill('release')
  await git.getByRole('button', { name: 'Pull', exact: true }).click()
  await until(() => actions.length === 2, 'explicit pull source')
  assert.equal(
    actions[1].remoteUrl,
    'https://github.com/explicit-source/project.git',
  )
  assert.equal(actions[1].branch, 'release')
  await git.getByRole('button', { name: 'Close', exact: true }).click()
  fixture.assertClean()
  await fixture.browser.close()
  fixture = null
  checks.push(
    'Editing a push fork never redirects Pull; an unsupported source stays empty and an explicit pull source is honored',
  )

  const notesId = 'git-notes-project'
  fixture = await makeFixture(
    { id: notesId, name: 'Notes without Lean', status: 'needs-setup' },
    { 'Notes.md': '# My original notes\n' },
  )
  const notesPage = fixture.page
  let gitUnavailable = true
  let initializeRequests = 0
  const notesInfo = {
    repository: false,
    branch: null,
    changes: [],
    diff: '',
    commits: [],
    remoteUrl: null,
    pullRemoteUrl: null,
  }
  await notesPage.route(`**/api/projects/${notesId}/git`, (route) => {
    if (route.request().method() === 'GET')
      return gitUnavailable
        ? route.fulfill({
            status: 503,
            json: { error: 'Git status is temporarily unavailable.' },
          })
        : route.fulfill({ json: notesInfo })
    assert.equal(route.request().postDataJSON().action, 'initialize')
    initializeRequests++
    if (initializeRequests === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Version control could not start. Retry.' },
      })
    Object.assign(notesInfo, {
      repository: true,
      branch: 'main',
      changes: [{ status: '??', path: 'Notes.md' }],
      reviewToken: 'notes-review',
    })
    return route.fulfill({ json: notesInfo })
  })
  await notesPage.goto(base)
  assert.equal(initializeRequests, 0)
  await notesPage
    .getByRole('button', { name: /^Source control/ })
    .first()
    .click()
  const notesGit = notesPage.getByRole('dialog', {
    name: 'Source control',
    exact: true,
  })
  await notesGit
    .getByText('Git status is temporarily unavailable.', { exact: true })
    .waitFor()
  assert.equal(
    await notesGit
      .getByRole('button', { name: 'Refresh', exact: true })
      .isEnabled(),
    true,
  )
  gitUnavailable = false
  await notesGit.getByRole('button', { name: 'Refresh', exact: true }).click()
  await notesGit
    .getByRole('button', { name: 'Start version control', exact: true })
    .waitFor()
  assert.equal(
    await notesGit.getByLabel('Commit message', { exact: true }).count(),
    0,
  )
  await notesGit
    .getByRole('button', { name: 'Start version control', exact: true })
    .click()
  await notesGit
    .getByText('Version control could not start. Retry.', { exact: true })
    .waitFor()
  assert.equal(
    fixture.state.files[notesId]['Notes.md'],
    '# My original notes\n',
  )
  await notesGit
    .getByRole('button', { name: 'Start version control', exact: true })
    .click()
  await notesGit.getByLabel('Commit message', { exact: true }).waitFor()
  assert.equal(initializeRequests, 2)
  assert.equal(fixture.state.projects[0].status, 'needs-setup')
  assert.equal(
    fixture.state.files[notesId]['Notes.md'],
    '# My original notes\n',
  )
  await notesGit.getByRole('tab', { name: 'History', exact: true }).click()
  await notesGit
    .getByText('No commits to show yet.', { exact: false })
    .waitFor()
  fixture.assertClean()
  checks.push(
    'A notes-only project can refresh failed Git status and initialize local version control without Lean setup, data loss or uploading files',
  )
  await notesGit.getByRole('button', { name: 'Close', exact: true }).click()
  Object.assign(fixture.state.projects[0], {
    status: 'error',
    needsPreparation: true,
    error: 'Lean setup needs attention.',
  })
  await notesPage.reload()
  await notesPage
    .getByRole('button', { name: /^Source control/ })
    .first()
    .click()
  await notesGit
    .getByLabel('Commit message', { exact: true })
    .fill('My saved notes')
  await until(
    async () =>
      await notesGit
        .getByRole('button', { name: 'Commit saved changes', exact: true })
        .isEnabled(),
    'source control works before Lean setup succeeds',
  )
  assert.equal(
    initializeRequests,
    2,
    'Opening source control must not initialize or mutate Git automatically',
  )
  await until(
    () => fixture.report.collaborationSockets.length > 0,
    'recoverable project live connection',
  )
  Object.assign(fixture.state.projects[0], {
    status: 'preparing',
    setupPhase: 'preparing-dependencies',
  })
  fixture.sendCollaboration({ type: 'project' })
  await notesGit
    .getByText(
      'Project setup is running. Stop setup or wait for it to finish before changing source control.',
      { exact: true },
    )
    .waitFor()
  assert.equal(
    await notesGit
      .getByRole('button', { name: 'Commit saved changes', exact: true })
      .isDisabled(),
    true,
  )
  await notesGit
    .locator('.git-commit-form')
    .evaluate((form) => form.requestSubmit())
  assert.equal(initializeRequests, 2)
  await notesGit.getByRole('tab', { name: 'History', exact: true }).click()
  await notesGit
    .getByText('No commits to show yet.', { exact: false })
    .waitFor()
  fixture.assertClean()
  checks.push(
    'Git remains reachable for recoverable setup errors; preparation keeps history readable while mutation controls and submit handlers stay blocked',
  )
  console.log(JSON.stringify({ passed: true, checks }, null, 2))
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ passed: true, checks }, null, 2),
  )
} catch (error) {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: false,
        checks,
        error: error.stack,
        pageText: await fixture?.page.locator('body').innerText(),
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
