#!/usr/bin/env node
// Verify common Git settings and credential reuse without external Git writes.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/git-connections-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(path.resolve('client/dist')))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`
const fakeToken = `fixture-common-git-${randomUUID()}`
const oneUse = `fixture-one-use-${randomUUID()}`
let fixture
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'git-fixture-owner', name: 'Git fixture' },
      templates: [],
      models: [],
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [
      {
        id: 'git-common-fixture',
        name: 'Common Git fixture',
        status: 'ready',
        repository: 'https://github.com/fixture/common.git',
        publishingEnabled: true,
      },
    ],
    files: {
      'git-common-fixture': { 'Main.lean': 'example : True := by trivial\n' },
    },
    chats: [
      {
        id: 'git-common-chat',
        projectId: 'git-common-fixture',
        title: 'Git fixture',
      },
    ],
    runs: [],
  })
  const { page, state, report } = fixture
  const metadata = {
    connections: [],
    identity: { name: 'Fixture owner', email: 'fixture@example.invalid' },
  }
  const imports = [],
    pushes = [],
    prepares = [],
    external = []
  let releaseConnection = null,
    holdConnection = false,
    legacy = false
  const git = {
    repository: true,
    branch: 'proof/common',
    revision: 'a'.repeat(40),
    changes: [],
    diff: '',
    commits: [{ sha: 'a'.repeat(40), message: 'Fixture proof' }],
    reviewToken: 'fixture-review',
    mutationBlocked: false,
    publishingEnabled: true,
    remoteUrl: 'https://github.com/fixture/common.git',
    provider: 'github',
    baseBranch: 'main',
  }
  let reviewed
  await page.route('**/*', async (route) => {
    const address = new URL(route.request().url())
    if (/^https?:$/.test(address.protocol) && address.origin !== base) {
      external.push(address.href)
      return route.abort()
    }
    return route.fallback()
  })
  await page.route('**/api/git-connections*', async (route) => {
    const request = route.request()
    if (legacy)
      return route.fulfill({
        status: 404,
        json: { error: 'API endpoint not found.' },
      })
    if (request.method() === 'PUT') {
      const body = request.postDataJSON()
      if (body.action === 'connect') {
        assert.equal(body.token, fakeToken)
        if (holdConnection) {
          holdConnection = false
          await new Promise((resolve) => {
            releaseConnection = resolve
          })
          releaseConnection = null
        }
        const entry = {
          host: body.host,
          provider: body.provider,
          username: body.username || 'fixture-user',
          updatedAt: new Date().toISOString(),
        }
        metadata.connections = metadata.connections
          .filter((value) => value.host !== entry.host)
          .concat(entry)
      } else {
        assert.equal(body.action, 'identity')
        metadata.identity = { name: body.name, email: body.email }
      }
    } else if (request.method() === 'DELETE') {
      assert.deepEqual(
        request.postDataJSON(),
        {},
        'disconnect must satisfy the server JSON request contract',
      )
      const host = new URL(request.url()).searchParams.get('host')
      metadata.connections = metadata.connections.filter(
        (value) => value.host !== host,
      )
    } else assert.equal(request.method(), 'GET')
    assert(!JSON.stringify(metadata).includes(fakeToken))
    return route.fulfill({ json: metadata })
  })
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const body = route.request().postDataJSON()
    imports.push(body)
    const project = {
      id: `common-import-${imports.length}`,
      name: `Common import ${imports.length}`,
      status: 'ready',
      repository: body.repository,
      publishingEnabled: true,
    }
    state.projects.push(project)
    state.files[project.id] = { 'Main.lean': 'example : True := by trivial\n' }
    return route.fulfill({ json: project })
  })
  await page.route('**/api/projects/*/prepare', async (route) => {
    prepares.push(route.request().postDataJSON())
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const project = state.projects.find((value) => value.id === id)
    project.status = 'ready'
    delete project.repositoryAuthenticationRequired
    delete project.error
    return route.fulfill({ json: project })
  })
  await page.route('**/api/projects/*/git', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: git })
    const body = route.request().postDataJSON()
    if (body.action === 'preview-push') {
      reviewed = {
        previewId: randomUUID(),
        head: git.revision,
        branch: body.branch,
        remoteUrl: body.remoteUrl,
        provider: body.provider,
        baseBranch: body.baseBranch || 'main',
        historyCount: 1,
        commits: git.commits,
        uncommittedCount: 0,
      }
      return route.fulfill({ json: reviewed })
    }
    assert.equal(body.action, 'push')
    pushes.push(body)
    const provider = reviewed.provider
    const result = {
      ...reviewed,
      pushed: true,
      review: {
        kind: provider === 'gitlab' ? 'merge-request' : 'pull-request',
        label:
          provider === 'gitlab'
            ? 'Open merge request on GitLab'
            : 'Open pull request on GitHub',
        url:
          provider === 'gitlab'
            ? 'https://gitlab.com/fixture/common/-/merge_requests/new?merge_request%5Bsource_branch%5D=proof%2Fcommon'
            : 'https://github.com/fixture/common/compare/main...proof%2Fcommon?expand=1',
      },
    }
    git.lastPublished = result
    return route.fulfill({ json: result })
  })
  const connections = () =>
    page.getByRole('dialog', { name: 'Git connections', exact: true })
  const importDialog = () =>
    page.getByRole('dialog', { name: 'Open a Lean project', exact: true })
  const source = () =>
    page.getByRole('dialog', { name: 'Source control', exact: true })
  const closeConnections = () =>
    connections().getByRole('button', { name: 'Close', exact: true }).click()
  const preview = () =>
    source().getByRole('button', { name: 'Preview push', exact: true }).click()
  const publish = () =>
    source().getByRole('button', {
      name: 'Publish reviewed commit',
      exact: true,
    })
  await fixture.ready()
  await page
    .getByRole('button', { name: 'Git connections', exact: true })
    .first()
    .click()
  await connections().waitFor()
  await connections()
    .getByText('Commit author · Fixture owner', { exact: true })
    .click()
  await until(
    async () =>
      (await connections()
        .getByLabel('Author name', { exact: true })
        .inputValue()) === 'Fixture owner',
    'shared author loaded',
  )
  assert.equal(
    await connections()
      .getByLabel('Access token', { exact: true })
      .getAttribute('type'),
    'password',
  )
  await connections()
    .getByLabel('Access token', { exact: true })
    .fill(fakeToken)
  holdConnection = true
  await connections()
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  await until(() => releaseConnection !== null, 'save connection pending')
  assert.equal(
    await connections()
      .getByLabel('Access token', { exact: true })
      .inputValue(),
    '',
  )
  assert.equal(
    await connections()
      .getByRole('button', { name: 'Save connection', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await connections()
      .getByRole('button', { name: 'Close', exact: true })
      .isDisabled(),
    true,
  )
  releaseConnection()
  await connections()
    .getByRole('button', { name: 'Disconnect github.com', exact: true })
    .waitFor()
  await connections()
    .getByLabel('Author name', { exact: true })
    .fill('Shared Git author')
  await connections()
    .getByLabel('Author email', { exact: true })
    .fill('shared@example.invalid')
  await connections()
    .getByRole('button', { name: 'Save author', exact: true })
    .click()
  await until(
    () => metadata.identity.name === 'Shared Git author',
    'shared author saved',
  )
  await until(
    async () =>
      !(await connections()
        .getByRole('button', { name: 'Close', exact: true })
        .isDisabled()),
    'settings saved',
  )
  await connections()
    .getByText('Commit author · Shared Git author', { exact: true })
    .click()
  await connections().evaluate((dialog) => {
    dialog.scrollTop = 0
  })
  await page.screenshot({ path: path.join(output, 'git-connections.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(
    await connections().evaluate(
      (dialog) => dialog.scrollWidth <= dialog.clientWidth + 1,
    ),
    true,
  )
  await page.setViewportSize({ width: 1600, height: 1000 })
  await closeConnections()
  report.checks.push(
    'A common host connection and commit identity save without retaining tokens in the form; pending writes lock controls.',
  )

  await page
    .getByRole('button', { name: 'Import or create project', exact: true })
    .first()
    .click()
  await importDialog()
    .getByLabel('Repository or GitHub / GitLab folder link')
    .fill('https://github.com/fixture/private.git')
  await importDialog()
    .getByText('Uses your saved connection to github.com.', { exact: false })
    .waitFor()
  await importDialog()
    .getByRole('button', { name: 'Git connections', exact: true })
    .click()
  await connections().waitFor()
  assert.equal(
    await connections()
      .getByLabel('Access token', { exact: true })
      .inputValue(),
    '',
  )
  await closeConnections()
  assert.equal(
    await importDialog()
      .getByLabel('Repository or GitHub / GitLab folder link')
      .inputValue(),
    'https://github.com/fixture/private.git',
  )
  await importDialog()
    .getByRole('button', { name: 'Import project', exact: true })
    .click()
  await importDialog().waitFor({ state: 'hidden' })
  assert.equal(imports[0].repositoryToken, undefined)
  assert.equal(imports[0].repositoryUsername, undefined)
  report.checks.push(
    'Import recognizes the matching saved host and submits without asking for the token again; managing connections preserves the form.',
  )

  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await preview()
  await source()
    .getByRole('heading', { name: 'Review before publishing' })
    .waitFor()
  assert.equal(await publish().isDisabled(), false)
  await publish().click()
  const pr = source().getByRole('link', {
    name: 'Open pull request on GitHub',
    exact: true,
  })
  await pr.waitFor()
  assert.match(
    await pr.getAttribute('href'),
    /github\.com\/fixture\/common\/compare\//,
  )
  assert.equal(pushes[0].token, undefined)
  report.checks.push(
    'Publishing uses the same connection after review, and a confirmed push exposes the GitHub request form.',
  )

  await source()
    .getByLabel('Repository URL', { exact: true })
    .fill('https://gitlab.com/fixture/common.git')
  await preview()
  await source()
    .getByRole('heading', { name: 'Review before publishing' })
    .waitFor()
  assert.equal(await publish().isDisabled(), true)
  await source().getByLabel('Repository token', { exact: true }).fill(oneUse)
  await publish().click()
  const mr = source().getByRole('link', {
    name: 'Open merge request on GitLab',
    exact: true,
  })
  await mr.waitFor()
  assert.equal(pushes[1].token, oneUse)
  assert.match(
    await mr.getAttribute('href'),
    /gitlab\.com\/fixture\/common\/-\/merge_requests\/new/,
  )
  report.checks.push(
    'A connection for another host is never reused; a one-use override remains available and a confirmed GitLab push opens its merge-request form.',
  )

  await source()
    .getByRole('button', { name: 'Git connections', exact: true })
    .first()
    .click()
  await connections()
    .getByLabel('Provider', { exact: true })
    .selectOption('gitlab')
  await connections()
    .getByLabel('Access token', { exact: true })
    .fill(fakeToken)
  await connections()
    .getByRole('button', { name: 'Save connection', exact: true })
    .click()
  await connections()
    .getByRole('button', { name: 'Disconnect gitlab.com', exact: true })
    .waitFor()
  await connections()
    .getByRole('button', { name: 'Disconnect github.com', exact: true })
    .click()
  await until(
    async () =>
      !(await connections()
        .getByRole('button', { name: 'Disconnect github.com', exact: true })
        .count()),
    'connection removed',
  )
  await closeConnections()
  await preview()
  await source()
    .getByText('Uses your saved connection to gitlab.com.', { exact: false })
    .waitFor()
  assert.equal(await publish().isDisabled(), false)
  await source().getByRole('button', { name: 'Close', exact: true }).click()
  report.checks.push(
    'Saving or disconnecting a connection refreshes the open workflow immediately without changing its destination.',
  )

  const failed = state.projects.at(-1)
  failed.status = 'error'
  failed.repository = 'https://gitlab.com/fixture/private.git'
  failed.repositoryAuthenticationRequired = true
  failed.error = 'Repository authentication needed.'
  await page.reload()
  await page.getByRole('button', { name: 'Retry setup', exact: true }).click()
  const retry = page.getByRole('dialog', {
    name: 'Repository access',
    exact: true,
  })
  await retry
    .getByText('Uses your saved connection to gitlab.com.', { exact: false })
    .waitFor()
  assert.equal(
    await retry
      .getByRole('button', { name: 'Retry setup', exact: true })
      .isDisabled(),
    false,
  )
  await retry.getByRole('button', { name: 'Retry setup', exact: true }).click()
  await retry.waitFor({ state: 'hidden' })
  assert.deepEqual(prepares, [{}])
  report.checks.push(
    'Retrying an authenticated import can use the same saved connection without resending a token from the browser.',
  )

  legacy = true
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await preview()
  await source()
    .getByRole('heading', { name: 'Review before publishing' })
    .waitFor()
  assert.equal(await publish().isDisabled(), true)
  await source().getByLabel('Repository token', { exact: true }).fill(oneUse)
  assert.equal(await publish().isDisabled(), false)
  const storage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  )
  assert(!storage.includes(fakeToken) && !storage.includes(oneUse))
  assert.equal(external.length, 0)
  fixture.assertClean()
  await page.screenshot({
    path: path.join(output, 'legacy-token-fallback.png'),
  })
  report.checks.push(
    'Older servers without saved connections retain the one-use token flow; browser storage and external providers receive no credentials.',
  )
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        checks: report.checks,
        browserErrors: report.errors,
        externalRequests: external.length,
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({ passed: true, checks: report.checks, output }, null, 2),
  )
} finally {
  await fixture?.browser.close()
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
