#!/usr/bin/env node
// Browser-only source control tests. No real repository, credential or push.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  chatBrowserFixture,
  sleep,
  until,
} from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/git-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'git-ui-fixture'
const otherId = 'git-ui-other'
const token = 'dummy-' + randomUUID()
const hash = (text) => createHash('sha256').update(text).digest('hex')
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8091'
const fixture = await chatBrowserFixture({
  base,
  session: {
    user: { id: 'git-fixture-owner', name: 'Git fixture' },
    templates: [],
    models: [],
    runtime: { ready: true },
  },
  projects: [
    { id: projectId, name: 'Git fixture', status: 'ready' },
    { id: otherId, name: 'Other project', status: 'ready' },
  ],
  files: {
    [projectId]: {
      'Main.lean': 'example : True := by trivial\n',
      'Notes.lean': '-- UNTRACKED_REVIEW\n',
    },
    [otherId]: { 'Main.lean': 'example : True := by trivial\n' },
  },
  chats: [
    { id: 'git-chat', projectId, title: 'Git fixture chat' },
    { id: 'other-git-chat', projectId: otherId, title: 'Other chat' },
  ],
  runs: [],
})
const { page, state, report, browser } = fixture
const info = {
  repository: true,
  branch: 'main',
  revision: 'a'.repeat(40),
  changes: [
    { status: ' M', path: 'Main.lean' },
    { status: '??', path: 'Notes.lean' },
  ],
  diff: 'diff --git a/Main.lean b/Main.lean\n--- a/Main.lean\n+++ b/Main.lean\n@@ -1 +1 @@\n-example : True := by simp\n+example : True := by trivial\n',
  remoteUrl: 'https://github.com/fixture/reviewed.git',
  commits: [{ sha: 'a'.repeat(40), message: 'Initial saved proof' }],
  reviewToken: hash('initial'),
  mutationBlocked: false,
  author: { name: 'Git fixture', email: 'fixture-owner@lemex-web.local' },
}
const actions = []
const previews = new Map()
const externalRequests = []
let pushed,
  holdPush,
  holdPreview,
  holdGet,
  failCommit = false,
  failNextGet = false,
  failStatusAfterPush = false,
  pushWarning = '',
  getRequests = 0,
  pendingGets = 0,
  maxPendingGets = 0
const dialog = () =>
  page.getByRole('dialog', { name: 'Source control', exact: true })
const button = (name) => dialog().getByRole('button', { name, exact: true })
const publishTab = () =>
  dialog().getByRole('tab', { name: 'Publish', exact: true })
async function open() {
  await page.getByRole('button', { name: /^Source control/ }).click()
  await dialog().waitFor()
  await until(
    async () =>
      !(await dialog()
        .getByText('Loading saved source-control state…', { exact: true })
        .count()),
    'source control loaded',
  )
}
await page.route('**/*', async (route) => {
  const url = route.request().url()
  if (/^https?:/.test(url) && new URL(url).origin !== new URL(base).origin) {
    externalRequests.push(url)
    return route.abort()
  }
  return route.fallback()
})
async function preview() {
  await button('Preview push').click()
  await dialog().getByRole('region', { name: 'Reviewed push' }).waitFor()
}
async function noStoredCredential() {
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
await page.route('**/api/projects/*/git', async (route) => {
  const request = route.request(),
    id = new URL(request.url()).pathname.split('/')[3]
  const respond = (body, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  if (request.method() === 'GET') {
    getRequests++
    pendingGets++
    maxPendingGets = Math.max(maxPendingGets, pendingGets)
    try {
      if (id === projectId && failNextGet) {
        failNextGet = false
        return await respond(
          { error: 'Fixture metadata unavailable after confirmed publish.' },
          503,
        )
      }
      if (id === projectId && holdGet && !holdGet.release) {
        const pending = holdGet
        return await new Promise((resolve) => {
          pending.release = async () => {
            await respond(info)
            resolve()
          }
        })
      }
      return await respond(
        id === projectId
          ? info
          : { ...info, remoteUrl: null, changes: [], revision: 'c'.repeat(40) },
      )
    } finally {
      pendingGets--
    }
  }
  const body = request.postDataJSON()
  actions.push({
    ...body,
    ...(body.token ? { token: '[redacted test credential]' } : {}),
  })
  assert.equal(id, projectId, 'Git action crossed project boundaries')
  if (info.mutationBlocked) return respond({ error: info.blockedReason }, 409)
  if (body.action === 'commit') {
    if (failCommit) {
      assert.notEqual(
        body.reviewToken,
        info.reviewToken,
        'Stale-review fixture did not change its saved snapshot',
      )
      return respond(
        {
          error:
            'Project files changed after this review. Refresh and review the current changes before committing.',
        },
        409,
      )
    }
    assert.equal(body.message, 'Reviewed saved proof changes')
    assert.equal(
      body.reviewToken,
      info.reviewToken,
      'Commit omitted the exact reviewed file digest',
    )
    assert.equal(body.authorName, 'Proof author')
    assert.equal(body.authorEmail, 'proof-author@example.invalid')
    info.revision = 'b'.repeat(40)
    info.changes = []
    info.diff = ''
    info.reviewToken = hash('committed')
    info.commits.unshift({ sha: info.revision, message: body.message })
    return respond(info)
  }
  if (body.action === 'branch') {
    info.branch = body.name
    return respond(info)
  }
  if (body.action === 'preview-push') {
    const value = {
      previewId: randomUUID(),
      head: info.revision,
      branch: body.branch,
      remoteUrl: body.remoteUrl,
      historyCount: 2,
      commits: info.commits,
      uncommittedCount: info.changes.length,
    }
    previews.set(value.previewId, structuredClone(value))
    if (holdPreview) {
      const pending = holdPreview
      return new Promise((resolve) => {
        pending.release = async () => {
          await respond(value)
          resolve()
        }
      })
    }
    return respond(value)
  }
  if (body.action === 'push') {
    assert.equal(body.token, token)
    const reviewed = previews.get(body.previewId)
    assert(reviewed, 'Publish did not reference a reviewed preview')
    assert.equal(
      body.head,
      undefined,
      'Push attempted to override reviewed HEAD',
    )
    assert.equal(
      body.remoteUrl,
      undefined,
      'Push attempted to override reviewed destination',
    )
    assert.equal(
      body.branch,
      undefined,
      'Push attempted to override reviewed branch',
    )
    pushed = { previewId: body.previewId, username: body.username }
    if (holdPush)
      return new Promise((resolve) => {
        holdPush.release = async (success = false) => {
          await respond(
            success
              ? {
                  pushed: true,
                  head: reviewed.head,
                  branch: reviewed.branch,
                  remoteUrl: reviewed.remoteUrl,
                }
              : {
                  error:
                    'The repository rejected this push: non-fast-forward. Fetch and review the branch before retrying.',
                },
            success ? 200 : 409,
          )
          resolve()
        }
      })
    if (failStatusAfterPush) {
      failNextGet = true
      failStatusAfterPush = false
    }
    return respond({
      pushed: true,
      head: reviewed.head,
      branch: reviewed.branch,
      remoteUrl: reviewed.remoteUrl,
      ...(pushWarning ? { warning: pushWarning } : {}),
    })
  }
  throw new Error('Unexpected Git action: ' + body.action)
})
await page.route(`**/api/projects/${projectId}/file?*`, async (route) => {
  const request = route.request()
  if (request.method() !== 'PUT') return route.fallback()
  const filename = new URL(request.url()).searchParams.get('path'),
    body = request.postDataJSON()
  assert.equal(body.expectedHash, hash(state.files[projectId][filename]))
  state.files[projectId][filename] = body.content
  info.reviewToken = hash(body.content)
  info.diff += '\n+-- SAVED_EDITOR_CHANGE\n'
  actions.push({ action: 'save', filename })
  return route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ content: body.content, hash: hash(body.content) }),
  })
})
try {
  await fixture.ready()
  await open()
  holdGet = {}
  await button('Refresh').click()
  await until(async () => !!holdGet.release, 'held Git metadata refresh')
  const requestsWhileHeld = getRequests
  await sleep(8500)
  assert.equal(
    getRequests,
    requestsWhileHeld,
    'Background polls overlapped a held metadata refresh',
  )
  assert.equal(maxPendingGets, 1, 'Git metadata requests overlapped')
  const pendingRefresh = holdGet
  holdGet = null
  await pendingRefresh.release()
  await until(async () => pendingGets === 0, 'held refresh finished')
  report.checks.push(
    'A held Git metadata refresh prevents overlapping background polls across two timer intervals',
  )
  assert(
    (await dialog().innerText()).includes('Saved changes · all tracked files'),
  )
  await dialog()
    .getByRole('list', { name: 'Changed project files' })
    .getByRole('button', { name: /Notes\.lean/ })
    .click()
  await until(
    async () => (await dialog().innerText()).includes('UNTRACKED_REVIEW'),
    'untracked saved file preview',
  )
  state.files[projectId]['Notes.lean'] = '-- REFRESHED_UNTRACKED_REVIEW\n'
  info.reviewToken = hash('untracked changed')
  await button('Refresh').click()
  await until(
    async () =>
      (await dialog().innerText()).includes('REFRESHED_UNTRACKED_REVIEW'),
    'refreshed untracked contents',
  )
  report.checks.push(
    'Saved tracked diff and untracked contents are reviewable; refreshing reloads changed untracked contents',
  )
  await page.getByLabel('Close dialog').click()
  await page.locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n-- SAVED_EDITOR_CHANGE\n')
  await open()
  await dialog()
    .getByLabel('Commit message', { exact: true })
    .fill('Reviewed saved proof changes')
  await dialog().locator('.git-author-section > summary').click()
  await dialog().getByLabel('Author name', { exact: true }).waitFor()
  assert((await dialog().innerText()).includes('fixture-owner@lemex-web.local'))
  await dialog().getByLabel('Author name', { exact: true }).fill('Proof author')
  await dialog()
    .getByLabel('Author email', { exact: true })
    .fill('proof-author@example.invalid')
  await button('Save and review changes').click()
  await button('Commit saved changes').waitFor()
  assert.equal(
    actions.filter((value) => value.action === 'commit').length,
    0,
    'Saving dirty editor committed before review',
  )
  assert(actions.some((value) => value.action === 'save'))
  assert((await dialog().innerText()).includes('SAVED_EDITOR_CHANGE'))
  failCommit = true
  info.reviewToken = hash('files changed after user review')
  await button('Commit saved changes').click()
  await until(
    async () =>
      (await dialog().getByRole('alert').innerText()).includes(
        'changed after this review',
      ),
    'stale commit review error',
  )
  assert.equal(
    await dialog().getByLabel('Commit message', { exact: true }).inputValue(),
    'Reviewed saved proof changes',
  )
  failCommit = false
  await button('Refresh').click()
  await button('Commit saved changes').click()
  await until(
    async () =>
      (await dialog().innerText()).includes('Saved project changes committed'),
    'commit success',
  )
  assert.equal(
    await dialog().getByLabel('Commit message', { exact: true }).inputValue(),
    '',
  )
  report.checks.push(
    'Dirty editor requires save and renewed review before commit; exact reviewToken and optional author are submitted; stale-review failure retains message; success updates history',
  )
  info.branch = 'HEAD (no branch)'
  await button('Refresh').click()
  await publishTab().click()
  await until(
    async () =>
      (await dialog().innerText()).includes(
        'Create a local branch before publishing',
      ),
    'detached HEAD guidance',
  )
  assert(await button('Preview push').isDisabled())
  const actionsBeforeDetached = actions.length
  await dialog()
    .getByRole('button', { name: 'Create branch', exact: true })
    .click()
  assert.equal(
    actions.length,
    actionsBeforeDetached,
    'Detached HEAD guidance performed a mutation',
  )
  report.checks.push(
    'Detached HEAD requires an explicit local branch before publishing',
  )
  await dialog()
    .getByLabel('Branch name', { exact: true })
    .fill('proof/ui-fixture')
  await dialog()
    .locator('.git-branch-section')
    .getByRole('button', { name: 'Create branch', exact: true })
    .click()
  await until(
    async () =>
      (await dialog().locator('.git-toolbar').innerText()).includes(
        'proof/ui-fixture',
      ),
    'created local branch',
  )
  await publishTab().click()
  assert.equal(
    await dialog().getByLabel('Target branch', { exact: true }).inputValue(),
    'proof/ui-fixture',
  )
  holdPreview = {}
  await button('Preview push').click()
  await until(async () => !!holdPreview.release, 'held preview request')
  assert(await button('Close').isEnabled(), 'Pending preview trapped the modal')
  assert(await dialog().getByLabel('Close dialog').isEnabled())
  assert(
    (await dialog().innerText()).includes(
      'You can close this view while the operation continues.',
    ),
  )
  info.mutationBlocked = true
  info.blockedReason = 'A Git operation is still running.'
  const previewInFlight = holdPreview
  const actionsBeforeClosingPreview = actions.length
  await button('Close').click()
  await until(
    async () => !(await dialog().count()),
    'preview dialog closes before request finishes',
  )
  await page.locator('.view-lines').click()
  await open()
  await publishTab().click()
  await until(
    async () => (await dialog().innerText()).includes(info.blockedReason),
    'reopened preview view is guarded by backend busy state',
  )
  assert(await button('Preview push').isDisabled())
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).count(),
    0,
  )
  assert.equal(
    actions.length,
    actionsBeforeClosingPreview,
    'Reopening sent another Git mutation',
  )
  holdPreview = null
  await previewInFlight.release()
  assert.equal(
    await dialog().getByRole('region', { name: 'Reviewed push' }).count(),
    0,
    'A closed view response revived an old preview',
  )
  info.mutationBlocked = false
  delete info.blockedReason
  await button('Refresh').click()
  await until(
    async () => await button('Preview push').isEnabled(),
    'preview operation finished',
  )
  report.checks.push(
    'Held preview permits closing and editor access; reopening stays backend-guarded and late results do not revive the previous modal',
  )
  await preview()
  const reviewed = dialog().getByRole('region', { name: 'Reviewed push' })
  assert((await reviewed.innerText()).includes(info.revision))
  assert((await reviewed.innerText()).includes(info.remoteUrl))
  assert((await reviewed.innerText()).includes('2 commits'))
  assert(
    (await reviewed.innerText()).includes(
      'uncommitted changes and unsaved editor changes are excluded',
    ),
  )
  assert.equal(
    await dialog()
      .getByLabel('Repository token', { exact: true })
      .getAttribute('type'),
    'password',
  )
  await page.screenshot({
    path: path.join(output, 'reviewed-push-desktop.png'),
    fullPage: true,
  })
  await dialog().getByLabel('Repository token', { exact: true }).fill(token)
  await noStoredCredential()
  await dialog()
    .getByLabel('Target branch', { exact: true })
    .fill('proof/another-target')
  assert.equal(
    await reviewed.count(),
    0,
    'Destination change retained a stale push preview',
  )
  await preview()
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).inputValue(),
    '',
  )
  info.revision = 'd'.repeat(40)
  info.reviewToken = hash('head changed externally')
  await button('Refresh').click()
  await until(
    async () => !(await reviewed.count()),
    'HEAD change invalidates preview',
  )
  await preview()
  await dialog().getByLabel('Repository token', { exact: true }).fill(token)
  await dialog().getByRole('tab', { name: 'Changes', exact: true }).click()
  await publishTab().click()
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).inputValue(),
    '',
    'Switching away retained repository credentials',
  )
  report.checks.push(
    'Publish preview identifies exact commit, destination and history; destination changes invalidate preview; tab changes clear credentials',
  )
  await dialog().getByLabel('Repository token', { exact: true }).fill(token)
  await dialog()
    .getByLabel(/^Username/)
    .fill('fixture-user')
  holdPush = {}
  await button('Publish reviewed commit').click()
  await until(async () => !!holdPush.release, 'held publish request')
  assert(pushed.previewId)
  assert.equal(pushed.username, 'fixture-user')
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).inputValue(),
    '',
  )
  assert.equal(
    await dialog()
      .getByLabel(/^Username/)
      .inputValue(),
    '',
  )
  assert(
    await dialog().getByLabel('Repository token', { exact: true }).isDisabled(),
  )
  assert((await reviewed.innerText()).includes(info.revision))
  assert((await dialog().innerText()).includes('Publishing reviewed commit'))
  await noStoredCredential()
  await holdPush.release(false)
  await until(
    async () =>
      (await dialog().getByRole('alert').innerText()).includes(
        'non-fast-forward',
      ),
    'push rejection',
  )
  assert.equal(await reviewed.count(), 0)
  await preview()
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).inputValue(),
    '',
  )
  await dialog().getByLabel('Repository token', { exact: true }).fill(token)
  holdPush = null
  await button('Publish reviewed commit').click()
  await until(
    async () => (await dialog().innerText()).includes('Published '),
    'confirmed push success',
  )
  assert.equal(await reviewed.count(), 0)
  await noStoredCredential()
  report.checks.push(
    'Publishing shows progress, clears credentials immediately, handles non-fast-forward rejection, and requires a fresh preview for retry',
  )
  await preview()
  await dialog().getByLabel('Repository token', { exact: true }).fill(token)
  pushWarning =
    'The repository was pushed, but its destination could not be saved for the next visit.'
  failStatusAfterPush = true
  await button('Publish reviewed commit').click()
  await until(async () => {
    const text = await dialog().innerText()
    return (
      text.includes(pushWarning) &&
      text.includes(
        'Published successfully. Refresh Source control to load the current status.',
      )
    )
  }, 'confirmed publish remains successful after destination warning and metadata failure')
  assert(
    (await dialog().locator('.git-notice').innerText()).startsWith(
      'Published ',
    ),
  )
  assert(
    !(await dialog().getByRole('alert').innerText()).includes('push failed'),
  )
  assert.equal(await reviewed.count(), 0)
  await noStoredCredential()
  pushWarning = ''
  report.checks.push(
    'A confirmed push retains Published status and destination-save warning when subsequent metadata refresh fails; credentials remain cleared',
  )
  await preview()
  await dialog().getByLabel('Repository token', { exact: true }).fill(token)
  holdPush = {}
  await button('Publish reviewed commit').click()
  await until(async () => !!holdPush.release, 'held push permits closing')
  assert(await button('Close').isEnabled(), 'Pending push trapped the modal')
  assert(await dialog().getByLabel('Close dialog').isEnabled())
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).inputValue(),
    '',
  )
  const pushInFlight = holdPush
  info.mutationBlocked = true
  info.blockedReason = 'A Git operation is still running.'
  const actionsBeforeClosingPush = actions.length
  await dialog().getByLabel('Close dialog').click()
  await until(
    async () => !(await dialog().count()),
    'push dialog closes before request finishes',
  )
  await page.locator('.view-lines').click()
  await open()
  await publishTab().click()
  await until(
    async () => (await dialog().innerText()).includes(info.blockedReason),
    'reopened push view is guarded by backend busy state',
  )
  assert(await button('Preview push').isDisabled())
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).count(),
    0,
  )
  assert.equal(
    actions.length,
    actionsBeforeClosingPush,
    'Reopening repeated a push mutation',
  )
  holdPush = null
  await pushInFlight.release(true)
  info.mutationBlocked = false
  delete info.blockedReason
  await button('Refresh').click()
  await until(
    async () => await button('Preview push').isEnabled(),
    'push operation finished after closed view',
  )
  await preview()
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).inputValue(),
    '',
  )
  await noStoredCredential()
  report.checks.push(
    'Held publish permits closing and editor access; reopening retains server busy guards, never repeats the push, and requires an empty one-use credential for a fresh preview',
  )
  info.mutationBlocked = true
  info.blockedReason =
    'Stop active Lean checks and Lemex runs before changing Git.'
  await button('Refresh').click()
  await until(
    async () => (await dialog().innerText()).includes(info.blockedReason),
    'active-work block',
  )
  assert(await button('Preview push').isDisabled())
  await dialog().getByRole('tab', { name: 'Changes', exact: true }).click()
  assert(
    await dialog().getByLabel('Commit message', { exact: true }).isDisabled(),
  )
  const actionCountBlocked = actions.length
  await dialog().locator('.git-branch-section > summary').click()
  assert(await dialog().getByLabel('Branch name', { exact: true }).isDisabled())
  assert.equal(actions.length, actionCountBlocked)
  report.checks.push(
    'Active work blocks commit, branch and publish controls while saved changes remain inspectable',
  )
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.screenshot({
    path: path.join(output, 'source-control-laptop.png'),
    fullPage: true,
  })
  await page.getByLabel('Close dialog').click()
  info.mutationBlocked = false
  delete info.blockedReason
  await open()
  await publishTab().click()
  await preview()
  await dialog().getByLabel('Repository token', { exact: true }).fill(token)
  await page.getByLabel('Close dialog').click()
  await open()
  await publishTab().click()
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).count(),
    0,
    'Modal remount retained a push preview or token',
  )
  await preview()
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).inputValue(),
    '',
  )
  await page.setViewportSize({ width: 620, height: 900 })
  await page.screenshot({
    path: path.join(output, 'source-control-narrow.png'),
    fullPage: true,
  })
  const bounds = await dialog().boundingBox()
  assert(
    bounds && bounds.x >= 0 && bounds.x + bounds.width <= 620,
    'Source-control dialog overflowed narrow viewport',
  )
  await button('Publish reviewed commit').scrollIntoViewIfNeeded()
  const publishBounds = await button('Publish reviewed commit').boundingBox()
  assert(
    publishBounds &&
      publishBounds.y >= 0 &&
      publishBounds.y + publishBounds.height <= 900,
    'Publish control is unreachable in the narrow dialog',
  )
  assert(
    await dialog().evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    'Source-control dialog has horizontal page overflow',
  )
  await page.screenshot({
    path: path.join(output, 'publish-controls-narrow.png'),
    fullPage: true,
  })
  report.checks.push(
    'Desktop, laptop and narrow source-control layouts keep review and publishing controls readable and reachable without page overflow',
  )
  await page.getByLabel('Close dialog').click()
  await page.setViewportSize({ width: 1366, height: 768 })
  await page
    .locator('.project-row')
    .filter({ hasText: 'Other project' })
    .getByRole('button')
    .first()
    .click()
  await open()
  await publishTab().click()
  assert.equal(
    await dialog().getByLabel('Repository token', { exact: true }).count(),
    0,
  )
  await noStoredCredential()
  assert(!JSON.stringify(report).includes(token))
  assert.deepEqual(
    externalRequests,
    [],
    'Browser attempted an external request',
  )
  assert(
    actions.every((action) =>
      ['save', 'commit', 'branch', 'preview-push', 'push'].includes(
        action.action,
      ),
    ),
  )
  fixture.assertClean()
  report.actions = actions
  report.providerCalls = 0
  report.externalPushes = 0
  report.passed = true
  console.log(
    'PASS: Git review, dirty saves, commit/branch, reviewed publish, credential clearing, conflicts and active-work guards; all APIs mocked',
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || error.message
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
