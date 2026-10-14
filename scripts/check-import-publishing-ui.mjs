#!/usr/bin/env node
// Exercise repository import and reviewed publishing without external writes.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/import-publishing-ui')
await fs.mkdir(output, { recursive: true })
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8091'
const token = `dummy-publishing-${randomUUID()}`
const digest = (value) => createHash('sha256').update(value).digest('hex')
const initialId = 'publishing-existing'
const initialProject = {
  id: initialId,
  name: 'Publishing fixture',
  status: 'ready',
  repository: 'https://github.com/fixture/publishing.git',
  publishingEnabled: false,
}
const fixture = await chatBrowserFixture({
  base,
  session: {
    user: { id: 'publishing-fixture-owner', name: 'Publishing fixture' },
    templates: [],
    models: [],
    runtime: { ready: true },
    lemex: { configured: false },
  },
  projects: [initialProject],
  files: { [initialId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [
    {
      id: 'publishing-chat',
      projectId: initialId,
      title: 'Publishing fixture',
    },
  ],
  runs: [],
})
const { page, state, report, browser } = fixture
const imports = [],
  actions = [],
  externalRequests = [],
  infos = new Map(),
  previews = new Map()
let pendingPush = null
const metadata = (project, branch = 'main') => ({
  repository: true,
  branch,
  revision: 'a'.repeat(40),
  changes: [],
  diff: '',
  remoteUrl: project.repository,
  commits: [{ sha: 'a'.repeat(40), message: 'Saved fixture proof' }],
  reviewToken: digest(project.id),
  mutationBlocked: false,
  publishingEnabled: project.publishingEnabled,
  provider: project.repository.includes('github.com')
    ? 'github'
    : project.repository.includes('gitlab.com')
      ? 'gitlab'
      : 'other',
  suggestedBranch: `leanflow/${project.id}`,
  baseBranch: 'main',
})
infos.set(initialId, metadata(initialProject))
const importDialog = () =>
  page.getByRole('dialog', { name: 'Open a Lean project', exact: true })
const gitDialog = () =>
  page.getByRole('dialog', { name: 'Source control', exact: true })
const gitButton = (name) =>
  gitDialog().getByRole('button', { name, exact: true })
const publishedLinks = () =>
  gitDialog().getByRole('link', { name: /Open (pull|merge) request/ })

await page.route('**/*', async (route) => {
  const address = new URL(route.request().url())
  if (
    /^https?:$/.test(address.protocol) &&
    address.origin !== new URL(base).origin
  ) {
    externalRequests.push(address.href)
    return route.abort()
  }
  return route.fallback()
})
await page.route('**/api/projects', async (route) => {
  if (route.request().method() !== 'POST') return route.fallback()
  const body = route.request().postDataJSON()
  assert.equal(typeof body.publishingEnabled, 'boolean')
  assert(body.repository, 'Publishing import omitted its repository')
  imports.push(body)
  const project = {
    id: `publishing-import-${imports.length}`,
    name: `Imported fixture ${imports.length}`,
    status: 'ready',
    repository: body.repository,
    publishingEnabled: body.publishingEnabled,
  }
  const info = metadata(
    project,
    body.publishingEnabled
      ? body.workingBranch || `leanflow/${project.id}`
      : 'main',
  )
  state.projects.push(project)
  state.files[project.id] = { 'Main.lean': 'example : True := by trivial\n' }
  infos.set(project.id, info)
  return route.fulfill({ json: project })
})
await page.route('**/api/projects/*/git', async (route) => {
  const request = route.request(),
    id = new URL(request.url()).pathname.split('/')[3],
    info = infos.get(id)
  assert(info, `Unknown source-control fixture ${id}`)
  if (request.method() === 'GET') return route.fulfill({ json: info })
  const body = request.postDataJSON()
  actions.push({
    projectId: id,
    ...body,
    ...(body.token ? { token: '[redacted test credential]' } : {}),
  })
  if (body.action === 'enable-publishing') {
    assert.equal(info.publishingEnabled, false)
    assert.equal(
      body.token,
      undefined,
      'Enabling publishing requested a credential',
    )
    info.publishingEnabled = true
    const project = state.projects.find((item) => item.id === id)
    project.publishingEnabled = true
    return route.fulfill({ json: info })
  }
  if (body.action === 'branch') {
    info.branch = body.name
    return route.fulfill({ json: info })
  }
  if (body.action === 'preview-push') {
    assert.equal(info.publishingEnabled, true)
    assert.equal(
      body.token,
      undefined,
      'Preview included a repository credential',
    )
    const preview = {
      previewId: randomUUID(),
      head: info.revision,
      branch: body.branch,
      remoteUrl: body.remoteUrl,
      provider: body.provider,
      ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
      historyCount: 1,
      commits: info.commits,
      uncommittedCount: info.changes.length,
    }
    previews.set(preview.previewId, structuredClone(preview))
    return route.fulfill({ json: preview })
  }
  if (body.action === 'push') {
    assert.equal(body.token, token)
    const reviewed = previews.get(body.previewId)
    assert(reviewed, 'Publishing did not reference a reviewed preview')
    for (const key of ['head', 'branch', 'remoteUrl', 'provider', 'baseBranch'])
      assert.equal(body[key], undefined, `Push overrides reviewed ${key}`)
    assert.equal(pendingPush, null, 'Overlapping publish requests')
    return new Promise((resolve) => {
      pendingPush = {
        reviewed,
        release: async (result) => {
          info.lastPublished = {
            pushed: true,
            head: reviewed.head,
            branch: reviewed.branch,
            remoteUrl: reviewed.remoteUrl,
            provider: reviewed.provider,
            ...(reviewed.baseBranch ? { baseBranch: reviewed.baseBranch } : {}),
            ...result,
          }
          await route.fulfill({ json: info.lastPublished })
          pendingPush = null
          resolve()
        },
      }
    })
  }
  throw new Error(`Unexpected publishing action: ${body.action}`)
})

async function openImport() {
  await page
    .getByRole('button', { name: 'Import or create project', exact: true })
    .first()
    .click()
  await importDialog().waitFor()
}
async function finishImport(repository) {
  const count = imports.length
  await importDialog()
    .getByLabel('Repository or GitHub folder link', { exact: true })
    .fill(repository)
  await importDialog()
    .getByRole('button', { name: 'Import project', exact: true })
    .click()
  await importDialog().waitFor({ state: 'hidden' })
  await until(async () => imports.length === count + 1, 'repository imported')
  await until(
    async () =>
      (await page.locator('.workbench-header').innerText()).includes(
        `Imported fixture ${imports.length}`,
      ),
    'imported project selected',
  )
  await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  return imports.at(-1)
}
async function openPublish() {
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await gitDialog().waitFor()
  await until(
    async () =>
      !(await gitDialog()
        .getByText('Loading saved source-control state…', { exact: true })
        .count()),
    'publishing metadata loaded',
  )
  assert.equal(
    await gitDialog()
      .getByRole('tab', { name: 'Publish', exact: true })
      .getAttribute('aria-selected'),
    'true',
    'Publish shortcut opened the Changes tab',
  )
}
async function assertNoStoredToken() {
  const storage = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }),
  )
  assert(
    !storage.includes(token),
    'Repository token persisted in browser storage',
  )
}
async function inspectPublishedLink(name, href) {
  const link = gitDialog().getByRole('link', { name, exact: true })
  await link.waitFor()
  assert.equal(await link.getAttribute('href'), href)
  assert.equal(new URL(href).protocol, 'https:')
  if ((await link.getAttribute('target')) === '_blank')
    assert(
      /(?:noopener|noreferrer)/.test((await link.getAttribute('rel')) || ''),
      'External review form lacks opener protection',
    )
}
async function assertDialogFits(dialog) {
  const box = await dialog.boundingBox()
  assert(box, 'Publishing dialog has no visible bounds')
  assert(
    box.x >= 0 && box.x + box.width <= 391,
    'Publishing dialog exceeds the mobile viewport',
  )
  const dimensions = await dialog.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }))
  assert(
    dimensions.scrollWidth <= dimensions.clientWidth + 1,
    `Publishing dialog has horizontal overflow: ${JSON.stringify(dimensions)}`,
  )
}
async function reviewedPublish({
  repository,
  branch,
  provider,
  baseBranch,
  result,
  closeWhilePending = false,
}) {
  await gitDialog()
    .getByLabel('Repository URL', { exact: true })
    .fill(repository)
  await gitDialog().getByLabel('Target branch', { exact: true }).fill(branch)
  await gitDialog()
    .getByLabel('Repository host', { exact: true })
    .selectOption(provider)
  if (provider !== 'other')
    await gitDialog()
      .getByLabel(/^Merge into branch/)
      .fill(baseBranch)
  else
    assert.equal(
      await gitDialog()
        .getByLabel(/^Merge into branch/)
        .count(),
      0,
    )
  const before = actions.filter((item) => item.action === 'push').length
  assert.equal(
    await publishedLinks().count(),
    0,
    'Review link appeared before push',
  )
  await gitButton('Preview push').click()
  const review = gitDialog().getByRole('region', { name: 'Reviewed push' })
  await review.waitFor()
  assert((await review.innerText()).includes(repository))
  assert((await review.innerText()).includes(branch))
  const lastPreview = actions
    .filter((item) => item.action === 'preview-push')
    .at(-1)
  assert.equal(lastPreview.provider, provider)
  assert.equal(lastPreview.baseBranch, baseBranch || undefined)
  assert.equal(actions.filter((item) => item.action === 'push').length, before)
  assert.equal(
    await publishedLinks().count(),
    0,
    'Preview opened an unconfirmed review form',
  )
  await gitDialog().getByLabel('Repository token', { exact: true }).fill(token)
  await assertNoStoredToken()
  await gitButton('Publish reviewed commit').click()
  await until(async () => !!pendingPush, 'reviewed publish request')
  assert.equal(
    await gitDialog()
      .getByLabel('Repository token', { exact: true })
      .inputValue(),
    '',
    'One-use token remained visible during publish',
  )
  await assertNoStoredToken()
  assert.equal(
    await publishedLinks().count(),
    0,
    'Review form appeared before push confirmation',
  )
  if (closeWhilePending) {
    await gitButton('Close').click()
    await gitDialog().waitFor({ state: 'hidden' })
  }
  await pendingPush.release(result)
  if (closeWhilePending) await openPublish()
  const published = gitDialog().getByRole('region', {
    name: 'Published branch',
  })
  await published.waitFor()
  assert((await published.innerText()).includes(branch))
  assert((await published.innerText()).includes(repository))
  if (closeWhilePending) {
    assert.equal(
      await gitDialog().getByLabel('Repository token', { exact: true }).count(),
      0,
      'Reopened publishing restored a one-use repository credential',
    )
    report.checks.push(
      `Closing a pending ${provider} push and reopening restores its confirmed branch and review form without repeating the push or retaining credentials`,
    )
  }
  await until(
    async () =>
      !(await gitDialog()
        .getByRole('region', { name: 'Reviewed push' })
        .count()),
    'one-use preview cleared',
  )
  await assertNoStoredToken()
  assert.equal(
    actions.filter((item) => item.action === 'push').length,
    before + 1,
  )
}

try {
  await fixture.ready()
  await openImport()
  const checkbox = importDialog().getByRole('checkbox', {
    name: 'Enable publishing changes back',
    exact: true,
  })
  assert(await checkbox.isChecked(), 'Publishing is not enabled by default')
  assert.equal(
    await importDialog()
      .getByLabel(/^Working branch/)
      .inputValue(),
    '',
  )
  const githubRepository = 'https://github.com/fixture/publishing.git'
  await importDialog()
    .getByLabel('Repository or GitHub folder link', { exact: true })
    .fill(githubRepository)
  await importDialog()
    .getByRole('button', { name: 'About Publishing changes', exact: true })
    .click()
  const explanation = page.getByRole('tooltip')
  await explanation.waitFor()
  assert(/branch/i.test(await explanation.innerText()))
  assert(/push|publish/i.test(await explanation.innerText()))
  assert.equal(imports.length, 0, 'Publishing help imported a repository')
  await page.keyboard.press('Escape')
  await explanation.waitFor({ state: 'hidden' })
  assert(
    await importDialog().isVisible(),
    'Dismissing publishing help closed the import dialog',
  )
  assert.equal(
    await importDialog()
      .getByLabel('Repository or GitHub folder link', { exact: true })
      .inputValue(),
    githubRepository,
    'Dismissing publishing help discarded the typed repository',
  )
  report.checks.push(
    'Escape dismisses publishing help while keeping the import dialog and typed repository open',
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await importDialog()
    .getByRole('button', { name: 'About Publishing changes', exact: true })
    .click()
  await explanation.waitFor()
  await until(
    async () =>
      explanation.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        const front = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        )
        const card = element.querySelector('.MuiTooltip-tooltip') || element
        return (
          front !== null &&
          element.contains(front) &&
          Number(getComputedStyle(card).opacity) >= 0.95
        )
      }),
    'publishing help above its containing dialog',
  )
  await page.screenshot({
    path: path.join(output, 'import-publishing-mobile.png'),
    fullPage: true,
  })
  await assertDialogFits(importDialog())
  await page.keyboard.press('Escape')
  await explanation.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1600, height: 1000 })
  const githubImport = await finishImport(githubRepository)
  assert.equal(githubImport.publishingEnabled, true)
  assert.equal(githubImport.workingBranch, undefined)
  report.checks.push(
    'Repository import enables publishing by default, explains it through an info icon, and leaves generated branch naming to the server',
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: path.join(output, 'publishing-header-mobile.png'),
    fullPage: true,
  })
  const mobilePublish = page.getByRole('button', {
    name: 'Publish',
    exact: true,
  })
  const publishBounds = await mobilePublish.boundingBox()
  assert(publishBounds, 'Publish shortcut has no mobile bounds')
  assert(
    publishBounds.x >= 0 && publishBounds.x + publishBounds.width <= 391,
    `Publish shortcut is clipped on mobile: ${JSON.stringify(publishBounds)}`,
  )
  await mobilePublish.click({ trial: true })
  await openPublish()
  await page.setViewportSize({ width: 1600, height: 1000 })
  report.checks.push(
    'The Publish shortcut fits a 390px ready-project header and can open publishing without scrolling sideways',
  )
  assert.equal(
    await gitDialog().getByLabel('Target branch', { exact: true }).inputValue(),
    'leanflow/publishing-import-1',
  )
  const githubReview =
    'https://github.com/fixture/publishing/compare/main...proof%2Fgithub-ui?expand=1'
  await reviewedPublish({
    repository: 'https://github.com/fixture/publishing.git',
    branch: 'proof/github-ui',
    provider: 'github',
    baseBranch: 'main',
    closeWhilePending: true,
    result: {
      review: {
        kind: 'pull-request',
        label: 'Open pull request on GitHub',
        url: githubReview,
      },
    },
  })
  await inspectPublishedLink('Open pull request on GitHub', githubReview)
  const publishedBranch = gitDialog().getByRole('region', {
    name: 'Published branch',
  })
  assert((await publishedBranch.innerText()).includes('proof/github-ui'))
  assert(
    (await publishedBranch.innerText()).includes(
      'https://github.com/fixture/publishing.git',
    ),
  )
  assert(/complete|finish|submit|review/i.test(await gitDialog().innerText()))
  await page.screenshot({
    path: path.join(output, 'github-published.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await publishedBranch.scrollIntoViewIfNeeded()
  await assertDialogFits(gitDialog())
  await page.screenshot({
    path: path.join(output, 'github-published-mobile.png'),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  report.checks.push(
    'Import publishing help and the published GitHub branch fit a 390px mobile viewport without horizontal overflow',
  )
  report.checks.push(
    'The Publish shortcut opens the reviewed push flow; only a confirmed GitHub push exposes its safe pull-request form and published branch destination',
  )
  await gitButton('Close').click()

  await openImport()
  await importDialog()
    .getByLabel(/^Working branch/)
    .fill('proof/gitlab-ui')
  const gitlabImport = await finishImport(
    'https://gitlab.com/fixture/publishing.git',
  )
  assert.equal(gitlabImport.publishingEnabled, true)
  assert.equal(gitlabImport.workingBranch, 'proof/gitlab-ui')
  await openPublish()
  assert.equal(
    await gitDialog().getByLabel('Target branch', { exact: true }).inputValue(),
    'proof/gitlab-ui',
  )
  const gitlabQuery = new URLSearchParams({
    'merge_request[source_branch]': 'proof/gitlab-ui',
    'merge_request[target_branch]': 'main',
  })
  const gitlabReview = `https://gitlab.com/fixture/publishing/-/merge_requests/new?${gitlabQuery}`
  await reviewedPublish({
    repository: 'https://gitlab.com/fixture/publishing.git',
    branch: 'proof/gitlab-ui',
    provider: 'gitlab',
    baseBranch: 'main',
    closeWhilePending: true,
    result: {
      review: {
        kind: 'merge-request',
        label: 'Open merge request on GitLab',
        url: gitlabReview,
      },
    },
  })
  await inspectPublishedLink('Open merge request on GitLab', gitlabReview)
  assert.equal(
    await gitDialog()
      .getByRole('link', { name: 'Open pull request on GitHub', exact: true })
      .count(),
    0,
  )
  await page.screenshot({
    path: path.join(output, 'gitlab-published.png'),
    fullPage: true,
  })
  report.checks.push(
    'An explicit import branch reaches GitLab publishing; confirmed push exposes the supplied merge-request form instead of a pull-request link',
  )
  await gitButton('Close').click()

  await openImport()
  await importDialog()
    .getByLabel(/^Working branch/)
    .fill('proof/ignored-when-disabled')
  await importDialog()
    .getByRole('checkbox', {
      name: 'Enable publishing changes back',
      exact: true,
    })
    .uncheck()
  const disabled = await finishImport(
    'https://git.example.invalid/fixture/publishing.git',
  )
  assert.equal(disabled.publishingEnabled, false)
  assert.equal(
    disabled.workingBranch,
    undefined,
    'Disabled publishing submitted a working branch',
  )
  await openPublish()
  assert.equal(
    actions.filter((item) => item.action === 'enable-publishing').length,
    0,
  )
  assert.equal(actions.filter((item) => item.action === 'push').length, 2)
  await gitButton('Enable publishing').click()
  await until(
    async () =>
      actions.filter((item) => item.action === 'enable-publishing').length ===
      1,
    'publishing enabled explicitly',
  )
  await until(
    async () =>
      (await gitDialog()
        .getByLabel('Target branch', { exact: true })
        .inputValue()) !== 'main',
    'enabled publishing suggests a separate branch',
  )
  assert.equal(
    await gitDialog().getByLabel('Target branch', { exact: true }).inputValue(),
    infos.get('publishing-import-3').suggestedBranch,
  )
  const fork = 'https://code.example.invalid/my-space/publishing.git'
  await gitDialog().getByLabel('Repository URL', { exact: true }).fill(fork)
  await gitDialog()
    .getByLabel('Repository host', { exact: true })
    .selectOption('gitlab')
  await gitDialog()
    .getByLabel(/^Merge into branch/)
    .fill('release/stable')
  await gitDialog().getByRole('tab', { name: 'Changes', exact: true }).click()
  await gitDialog().locator('.git-branch-section > summary').click()
  assert.equal(
    await gitDialog().getByLabel('Branch name', { exact: true }).inputValue(),
    infos.get('publishing-import-3').suggestedBranch,
    'Branch form omitted the suggested name from loaded metadata',
  )
  await gitDialog()
    .getByLabel('Branch name', { exact: true })
    .fill('proof/other-ui')
  await gitDialog()
    .locator('.git-branch-section')
    .getByRole('button', { name: 'Create branch', exact: true })
    .click()
  await until(
    async () =>
      (await gitDialog().locator('.git-toolbar').innerText()).includes(
        'proof/other-ui',
      ),
    'explicit working branch created',
  )
  await gitDialog().getByRole('tab', { name: 'Publish', exact: true }).click()
  assert.equal(
    await gitDialog()
      .getByLabel('Repository URL', { exact: true })
      .inputValue(),
    fork,
  )
  assert.equal(
    await gitDialog()
      .getByLabel('Repository host', { exact: true })
      .inputValue(),
    'gitlab',
  )
  assert.equal(
    await gitDialog()
      .getByLabel(/^Merge into branch/)
      .inputValue(),
    'release/stable',
  )
  report.checks.push(
    'Later enabled publishing suggests a new branch; creating a local branch preserves an entered self-hosted fork, provider and merge target',
  )
  await reviewedPublish({
    repository: 'https://git.example.invalid/fixture/publishing.git',
    branch: 'proof/other-ui',
    provider: 'other',
    baseBranch: '',
    result: {},
  })
  assert.equal(
    await publishedLinks().count(),
    0,
    'Other Git host received an invented PR or MR link',
  )
  report.checks.push(
    'Import can disable publishing without retaining an entered branch; a later explicit enable plus local branch supports another Git host without inventing a PR/MR integration',
  )

  assert.equal(externalRequests.length, 0, JSON.stringify(externalRequests))
  assert.equal(actions.filter((item) => item.action === 'push').length, 3)
  assert(
    !actions.some((item) => /pull|merge|request/i.test(item.action)),
    'The browser tried to create a PR or MR instead of opening the host form',
  )
  fixture.assertClean()
  report.imports = imports
  report.gitActions = actions
  report.externalRequests = externalRequests
  report.externalWrites = 0
  report.providerCalls = 0
  report.passed = true
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: report.checks,
        externalWrites: 0,
        providerCalls: 0,
      },
      null,
      2,
    ),
  )
} catch (error) {
  report.failure = error.stack || error.message
  await page
    .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
}
