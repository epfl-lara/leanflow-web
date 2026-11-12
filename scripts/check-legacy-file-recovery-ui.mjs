#!/usr/bin/env node
// Built client, closed authenticated APIs and Lean fixtures. No user files,
// credentials, providers or running project workers are used by these checks.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/legacy-file-recovery-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(
  express.static(process.env.STUDIO_TEST_DIST || path.resolve('client/dist')),
)
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const base = `http://127.0.0.1:${server.address().port}`
const project = {
  id: 'legacy-recovery-project',
  name: 'Older interrupted project',
  status: 'ready',
  accessRole: 'admin',
}
const healthy = {
  id: 'legacy-recovery-healthy',
  name: 'Unrelated healthy project',
  status: 'ready',
  accessRole: 'admin',
}
const paused = {
  ...project,
  status: 'error',
  needsPreparation: false,
  fileRecoveryRequired: true,
  legacyFileRecoveryRequired: true,
  error: 'An older interrupted file update needs review.',
}
const source = 'example : True := by trivial\n'
const original = '-- retained original\nexample : True := by trivial\n'
const later = '-- later edit must remain\n'
const marker = '-- PRIVATE_LEGACY_RECOVERY_DRAFT\n'
const chatDraft =
  'My private conversation draft must survive every recovery choice.'
const firstId = '1794479000000-11111111-1111-4111-8111-111111111111'
const secondId = '1794479000001-22222222-2222-4222-8222-222222222222'
const firstReview = {
  id: firstId,
  revision: 'a'.repeat(64),
  createdAt: '2026-11-12T08:00:00Z',
  canRestore: true,
  unchanged: false,
  error: null,
  files: [
    {
      path: 'Main.lean',
      originalHash: '1'.repeat(64),
      currentHash: '2'.repeat(64),
      savedHash: '2'.repeat(64),
      originalAvailable: true,
      originalDownloadAvailable: true,
      alreadyOriginal: false,
      changedAfterUpdate: false,
    },
    {
      path: 'Created.lean',
      originalHash: null,
      currentHash: '3'.repeat(64),
      savedHash: '3'.repeat(64),
      originalAvailable: true,
      originalDownloadAvailable: false,
      alreadyOriginal: false,
      changedAfterUpdate: false,
    },
  ],
}
const secondReview = {
  id: secondId,
  revision: 'b'.repeat(64),
  createdAt: '2026-11-12T08:01:00Z',
  canRestore: false,
  unchanged: false,
  error: null,
  files: [
    {
      path: 'Later.lean',
      originalHash: '4'.repeat(64),
      currentHash: '5'.repeat(64),
      savedHash: '6'.repeat(64),
      originalAvailable: true,
      originalDownloadAvailable: true,
      alreadyOriginal: false,
      changedAfterUpdate: true,
    },
  ],
}
const legacyBase = `/api/projects/${project.id}/file-recovery/legacy`
const envelope = (reviews) => ({
  reviews: reviews.map((review) => ({
    ...review,
    fileCount: review.fileCount ?? review.files.length,
    fileOffset: review.fileOffset ?? 0,
    nextFileOffset: review.nextFileOffset ?? null,
  })),
  nextCursor: null,
  totalRecords: reviews.length,
})
const checks = []
const fixtures = []
const releases = new Set()
let active

async function makeFixture(
  userId,
  { viewer = false, ready = true, keyless = false } = {},
) {
  const role = viewer ? 'viewer' : 'admin'
  const fixture = await chatBrowserFixture({
    base,
    session: {
      user: {
        id: userId,
        name: viewer ? 'Recovery Viewer' : 'Recovery Admin',
        role: 'user',
        profileComplete: true,
      },
      templates: [],
      models: viewer || keyless ? [] : [{ id: 'fixture', name: 'Fixture' }],
      ...(viewer || keyless ? {} : { defaultModel: 'fixture' }),
      runtime: { ready: true },
      lemex: { configured: !viewer && !keyless },
    },
    projects: [
      { ...(ready ? project : paused), accessRole: role },
      { ...healthy, accessRole: role },
    ],
    files: {
      [project.id]: {
        'Main.lean': source,
        'Created.lean': '-- created\n',
        'Later.lean': later,
      },
      [healthy.id]: { 'Main.lean': '-- healthy source\n' },
    },
    chats: [
      {
        id: `${userId}-chat`,
        projectId: project.id,
        title: 'Private recovery discussion',
      },
      {
        id: `${userId}-healthy-chat`,
        projectId: healthy.id,
        title: 'Healthy discussion',
      },
    ],
    runs: [],
  })
  fixtures.push(fixture)
  active = fixture
  const sockets = new Map()
  await fixture.page.routeWebSocket(
    '**/websocket/collaboration/**',
    (socket) => {
      sockets.set(new URL(socket.url()).pathname.split('/').at(-1), socket)
      socket.send(JSON.stringify({ type: 'ready' }))
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw))
        if (message.type === 'open')
          socket.send(
            JSON.stringify({
              type: 'error',
              path: message.path,
              status: 429,
              message: 'Use version-checked saving in this fixture.',
            }),
          )
      })
    },
  )
  fixture.pause = async () => {
    fixture.state.projects = [
      { ...paused, accessRole: role },
      { ...healthy, accessRole: role },
    ]
    sockets.get(project.id).send(JSON.stringify({ type: 'project' }))
    await fixture.page
      .getByRole('region', { name: 'Project file recovery', exact: true })
      .waitFor()
  }
  fixture.state.onSave = ({ respond }) =>
    respond({ error: 'Keep this private local draft for recovery.' }, 409)
  return fixture
}

async function held(route, response, setRelease) {
  const result = await new Promise((resolve) => {
    const release = (value = response) => {
      releases.delete(release)
      resolve(value)
    }
    releases.add(release)
    setRelease(release)
  })
  // A browser abort is expected in timeout/unmount cases; the page must handle it.
  await route.fulfill(result).catch(() => {})
}

const panelFor = (page) =>
  page.getByRole('region', { name: 'Project file recovery', exact: true })
const reviewFor = (page) =>
  page.getByRole('region', { name: 'Review older file updates', exact: true })
const recordFor = (page, filename) =>
  reviewFor(page)
    .locator('.legacy-recovery-record')
    .filter({
      has: page.getByRole('button', {
        name: `Download original ${filename}`,
        exact: true,
      }),
    })
const selection = (page) =>
  page.evaluate(
    (id) => ({
      project: localStorage.getItem('lemex-project'),
      file: localStorage.getItem(`lemex-file-${id}`),
      chat: localStorage.getItem(`lemex-chat-${id}`),
    }),
    project.id,
  )
const frames = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
async function downloaded(page, button) {
  const pending = page.waitForEvent('download')
  await button.click()
  const download = await pending
  return {
    content: await fs.readFile(await download.path(), 'utf8'),
    name: download.suggestedFilename(),
  }
}
async function confirmRestore(record) {
  await until(
    () =>
      reviewFor(record.page())
        .getAttribute('aria-busy')
        .then((value) => value === 'false'),
    'recovery review ready before confirmation',
  )
  const choose = record.getByRole('button', {
    name: 'Restore originals',
    exact: true,
  })
  if (await choose.count()) await choose.click()
  await record
    .getByRole('button', { name: 'Confirm restore originals', exact: true })
    .click()
}

try {
  const userId = 'legacy-recovery-admin'
  const fixture = await makeFixture(userId)
  const { page, state } = fixture
  let reviews = structuredClone([firstReview, secondReview])
  let reviewRequests = 0,
    releaseRestore
  const posts = [],
    originals = []
  await page.route(`${base}${legacyBase}**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    assert.equal(request.headers()['x-leanflow-user'], userId)
    if (request.method() === 'GET' && url.pathname === legacyBase) {
      reviewRequests++
      return route.fulfill({ json: envelope(reviews) })
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/original')) {
      const filename = url.searchParams.get('path')
      assert(['Main.lean', 'Later.lean'].includes(filename))
      originals.push(filename)
      return route.fulfill({
        contentType: 'application/octet-stream',
        body:
          filename === 'Main.lean'
            ? original
            : '-- original before later edit\n',
      })
    }
    assert.equal(request.method(), 'POST')
    const id = url.pathname.split('/').at(-1),
      body = request.postDataJSON()
    assert.deepEqual(Object.keys(body).sort(), ['decision', 'revision'])
    const review = reviews.find((item) => item.id === id)
    assert.equal(body.revision, review.revision)
    posts.push({ id, ...body })
    if (id === firstId) {
      assert.equal(body.decision, 'restore')
      const attempts = posts.filter((item) => item.id === firstId).length
      if (attempts === 1) {
        reviews = reviews.map((item) =>
          item.id === firstId ? { ...item, revision: 'c'.repeat(64) } : item,
        )
        return route.fulfill({
          status: 409,
          json: {
            error:
              'Project files changed after this review. Refresh the recovery review before continuing.',
          },
        })
      }
      if (attempts === 2)
        return route.fulfill({
          status: 503,
          json: {
            error:
              'Storage is temporarily unavailable. Your files are kept; retry when storage is available.',
          },
        })
      assert.equal(attempts, 3)
      await held(route, { json: paused }, (release) => {
        releaseRestore = release
      })
      return
    }
    assert.equal(id, secondId)
    assert.equal(body.decision, 'keep-current')
    assert.equal(state.files[project.id]['Later.lean'], later)
    reviews = reviews.filter((item) => item.id !== id)
    state.projects = [project, healthy]
    return route.fulfill({ json: project })
  })
  await page.route(`**/api/projects/${project.id}/download`, (route) => {
    assert.equal(route.request().headers()['x-leanflow-user'], userId)
    return route.fulfill({
      contentType: 'application/zip',
      body: 'AVAILABLE_PROJECT_FILES',
      headers: {
        'Content-Disposition': 'attachment; filename="older-project.zip"',
      },
    })
  })
  await fixture.ready()
  await page.getByLabel('Message Lemex').fill(chatDraft)
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText(marker)
  await until(
    () => page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
    'private source draft',
  )
  const selected = await selection(page)
  await fixture.pause()
  const panel = panelFor(page),
    review = reviewFor(page)
  await recordFor(page, 'Main.lean').waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Retry file recovery', exact: true })
      .count(),
    0,
  )
  assert.equal(
    await recordFor(page, 'Later.lean')
      .getByRole('button', { name: 'Restore originals', exact: true })
      .isDisabled(),
    true,
  )
  await recordFor(page, 'Later.lean')
    .getByText('Changed since this update; automatic restore is unavailable', {
      exact: false,
    })
    .waitFor()
  await recordFor(page, 'Main.lean')
    .getByText('Created by this update; restoring removes this file', {
      exact: false,
    })
    .waitFor()
  const firstOriginal = await downloaded(
    page,
    recordFor(page, 'Main.lean').getByRole('button', {
      name: 'Download original Main.lean',
      exact: true,
    }),
  )
  assert.equal(firstOriginal.content, original)
  assert.equal(firstOriginal.name, 'original-Main.lean')
  assert.equal(
    (
      await downloaded(
        page,
        recordFor(page, 'Later.lean').getByRole('button', {
          name: 'Download original Later.lean',
          exact: true,
        }),
      )
    ).content,
    '-- original before later edit\n',
  )
  assert.deepEqual(originals, ['Main.lean', 'Later.lean'])
  assert.equal(
    (
      await downloaded(
        page,
        panel.getByRole('button', { name: 'Download project', exact: true }),
      )
    ).content,
    'AVAILABLE_PROJECT_FILES',
  )
  async function assertDraft() {
    assert.deepEqual(await selection(page), selected)
    assert.equal(
      (
        await downloaded(
          page,
          panel.getByRole('button', {
            name: 'Download draft: Main.lean',
            exact: true,
          }),
        )
      ).content,
      source + marker,
    )
    assert.equal(state.files[healthy.id]['Main.lean'], '-- healthy source\n')
    assert.equal(state.files[project.id]['Later.lean'], later)
  }
  await assertDraft()
  checks.push(
    'Admin review explains removals and later edits, disables unsafe restoration, and downloads authenticated originals, saved project files and exact private drafts.',
  )

  await recordFor(page, 'Main.lean')
    .getByRole('button', { name: 'Restore originals', exact: true })
    .click()
  const confirmation = review.getByRole('group', {
    name: 'Confirm recovery choice',
    exact: true,
  })
  await confirmation
    .getByText('Current files are backed up in history.', { exact: false })
    .waitFor()
  await confirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await recordFor(page, 'Later.lean')
    .getByRole('button', { name: 'Keep current files', exact: true })
    .click()
  await confirmation
    .getByText('The retained originals stay in history.', { exact: false })
    .waitFor()
  await confirmation
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  assert.equal(posts.length, 0)
  await assertDraft()
  checks.push(
    'Restore and Keep current require an explicit confirmation; cancelling either choice sends no mutation and keeps drafts and selection.',
  )

  await confirmRestore(recordFor(page, 'Main.lean'))
  await review
    .getByRole('alert')
    .filter({ hasText: 'Project files changed after this review.' })
    .waitFor()
  await frames(page)
  assert.equal(posts.length, 1)
  await assertDraft()
  await review
    .getByRole('button', { name: 'Refresh recovery review', exact: true })
    .click()
  await until(() => reviewRequests === 2, 'explicit stale-review refresh')
  await confirmRestore(recordFor(page, 'Main.lean'))
  await review
    .getByRole('alert')
    .filter({ hasText: 'Storage is temporarily unavailable.' })
    .waitFor()
  await frames(page)
  assert.equal(posts.length, 2)
  await assertDraft()
  await confirmRestore(recordFor(page, 'Main.lean'))
  await until(() => !!releaseRestore, 'pending restoration')
  assert.equal(await review.getAttribute('aria-busy'), 'true')
  assert.equal(
    await review
      .getByRole('button', { name: 'Refresh recovery review', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await recordFor(page, 'Later.lean')
      .getByRole('button', { name: 'Keep current files', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(
    await recordFor(page, 'Main.lean')
      .getByRole('button', { name: 'Saving recovery choice…', exact: true })
      .isDisabled(),
    true,
  )
  state.files[project.id]['Main.lean'] = original
  delete state.files[project.id]['Created.lean']
  reviews = reviews.filter((item) => item.id !== firstId)
  releaseRestore()
  releaseRestore = undefined
  await recordFor(page, 'Main.lean').waitFor({ state: 'hidden' })
  await recordFor(page, 'Later.lean').waitFor()
  await assertDraft()
  assert.equal(posts.length, 3)
  checks.push(
    'Stale 409 and failed 503 responses preserve private drafts, require explicit retries, and keep pending actions disabled without retry loops.',
  )

  await recordFor(page, 'Later.lean')
    .getByRole('button', { name: 'Keep current files', exact: true })
    .click()
  assert.equal(posts.length, 3)
  await confirmation
    .getByRole('button', { name: 'Confirm keep current files', exact: true })
    .click()
  await panel.waitFor({ state: 'hidden' })
  await page.locator('.monaco-editor').first().waitFor()
  await until(
    () =>
      page
        .locator('.monaco-editor .view-lines')
        .first()
        .innerText()
        .then((value) =>
          value.replaceAll('\u00a0', ' ').includes(marker.trim()),
        ),
    'private editor draft after all recovery choices',
  )
  assert.equal(await page.getByLabel('Message Lemex').inputValue(), chatDraft)
  assert.deepEqual(await selection(page), selected)
  assert.equal(state.files[project.id]['Main.lean'], original)
  assert.equal(state.files[project.id]['Later.lean'], later)
  assert.equal(posts.length, 4)
  fixture.assertClean()
  await page.screenshot({ path: path.join(output, 'recovered.png') })
  checks.push(
    'Resolving multiple records resumes the same project, file and private chat; current later edits and exact local source/chat drafts survive both choices.',
  )

  await fixture.browser.close()
  const paged = await makeFixture('legacy-paging-admin', { ready: false })
  const pagedPage = paged.page
  const manyFiles = Array.from({ length: 100 }, (_, index) =>
    index === 0
      ? firstReview.files[0]
      : { ...firstReview.files[1], path: `Section/Created${index}.lean` },
  )
  const pagedRecord = {
    ...firstReview,
    fileCount: 101,
    fileOffset: 0,
    nextFileOffset: 100,
    files: manyFiles,
  }
  let filePageRequests = 0,
    recordPageRequests = 0,
    pagedPosts = 0
  await pagedPage.route(`${base}${legacyBase}**`, (route) => {
    const request = route.request(),
      url = new URL(request.url())
    assert.equal(request.headers()['x-leanflow-user'], 'legacy-paging-admin')
    if (request.method() === 'POST') {
      pagedPosts++
      return route.fulfill({
        status: 503,
        json: { error: 'This fixture only reviews pages.' },
      })
    }
    assert.equal(request.method(), 'GET')
    if (url.searchParams.has('recordId')) {
      assert.equal(url.searchParams.get('recordId'), firstId)
      assert.equal(url.searchParams.get('fileOffset'), '100')
      filePageRequests++
      return route.fulfill({
        json: {
          ...envelope([
            {
              ...pagedRecord,
              fileOffset: 100,
              nextFileOffset: null,
              files: [{ ...firstReview.files[0], path: 'Last.lean' }],
            },
          ]),
          totalRecords: 2,
        },
      })
    }
    if (url.searchParams.has('cursor')) {
      assert.equal(url.searchParams.get('cursor'), 'next-interrupted-page')
      recordPageRequests++
      return route.fulfill({
        json: { ...envelope([secondReview]), totalRecords: 2 },
      })
    }
    return route.fulfill({
      json: {
        ...envelope([pagedRecord]),
        nextCursor: 'next-interrupted-page',
        totalRecords: 2,
      },
    })
  })
  await pagedPage.goto(base)
  const pagedReview = reviewFor(pagedPage)
  await pagedReview.getByText('101 affected files', { exact: false }).waitFor()
  const pagedRow = pagedReview.locator('.legacy-recovery-record')
  assert.equal(await pagedRow.locator('li').count(), 100)
  assert.equal(
    await pagedRow
      .getByRole('button', { name: 'Previous files', exact: true })
      .isDisabled(),
    true,
  )
  await pagedRow
    .getByRole('button', { name: 'Next files', exact: true })
    .click()
  await pagedRow.getByText('Last.lean', { exact: true }).waitFor()
  assert.equal(await pagedRow.locator('li').count(), 1)
  assert.equal(
    await pagedRow
      .getByRole('button', { name: 'Previous files', exact: true })
      .isEnabled(),
    true,
  )
  assert.equal(
    await pagedRow
      .getByRole('button', { name: 'Next files', exact: true })
      .isDisabled(),
    true,
  )
  await pagedRow
    .getByRole('button', { name: 'Restore originals', exact: true })
    .click()
  await pagedRow
    .getByRole('group', { name: 'Confirm recovery choice', exact: true })
    .getByText(
      'Restoring affects all 101 files in this update, including files on other pages.',
      { exact: false },
    )
    .waitFor()
  await pagedRow.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(pagedPosts, 0)
  await pagedReview
    .getByRole('button', { name: 'Next interrupted updates', exact: true })
    .click()
  await recordFor(pagedPage, 'Later.lean').waitFor()
  assert.equal(
    await recordFor(pagedPage, 'Later.lean')
      .getByRole('button', { name: 'Restore originals', exact: true })
      .isDisabled(),
    true,
  )
  assert.equal(filePageRequests, 1)
  assert.equal(recordPageRequests, 1)
  assert.equal(pagedPosts, 0)
  assert.equal((await selection(pagedPage)).project, project.id)
  paged.assertClean()
  checks.push(
    'Bounded file and interrupted-update pages remain navigable; confirmation explicitly covers all 101 files across pages, cancellation sends no mutation, and later-edited records remain protected.',
  )
  await paged.browser.close()

  const timed = await makeFixture('legacy-timeout-admin', { ready: false })
  const timedPage = timed.page
  await timedPage.addInitScript(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    window.__legacyTimeoutMs = 250
    AbortSignal.timeout = (milliseconds) =>
      timeout(
        milliseconds === 30000 && window.__legacyTimeoutMs
          ? window.__legacyTimeoutMs
          : milliseconds,
      )
  })
  let listMode = 'hold',
    releaseList,
    releasePost
  let lists = 0,
    timedPosts = 0
  await timedPage.route(`${base}${legacyBase}**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    assert.equal(request.headers()['x-leanflow-user'], 'legacy-timeout-admin')
    if (request.method() === 'GET' && url.pathname === legacyBase) {
      lists++
      if (listMode === 'hold')
        return held(route, { json: envelope([firstReview]) }, (release) => {
          releaseList = release
        })
      return route.fulfill({ json: envelope([firstReview]) })
    }
    assert.equal(request.method(), 'POST')
    assert.deepEqual(request.postDataJSON(), {
      decision: 'restore',
      revision: firstReview.revision,
    })
    timedPosts++
    return held(route, { json: project }, (release) => {
      releasePost = release
    })
  })
  await timedPage.goto(base)
  const timedReview = reviewFor(timedPage)
  await timedReview
    .getByRole('alert')
    .filter({ hasText: /timed out|took too long/i })
    .waitFor()
  assert.equal(lists, 1)
  assert.equal(
    await timedReview
      .getByRole('button', { name: 'Refresh recovery review', exact: true })
      .isEnabled(),
    true,
  )
  releaseList()
  releaseList = undefined
  listMode = 'ready'
  await timedReview
    .getByRole('button', { name: 'Refresh recovery review', exact: true })
    .click()
  await recordFor(timedPage, 'Main.lean').waitFor()
  await confirmRestore(recordFor(timedPage, 'Main.lean'))
  await timedReview
    .getByRole('alert')
    .filter({ hasText: /timed out|took too long/i })
    .waitFor()
  assert.equal(timedPosts, 1)
  assert.equal(timed.state.files[project.id]['Main.lean'], source)
  releasePost()
  releasePost = undefined
  await frames(timedPage)
  assert.equal(timedPosts, 1)
  await timedReview
    .getByRole('button', { name: 'Refresh recovery review', exact: true })
    .click()
  await recordFor(timedPage, 'Main.lean').waitFor()
  await timedPage.evaluate(() => {
    window.__legacyTimeoutMs = 0
  })
  await confirmRestore(recordFor(timedPage, 'Main.lean'))
  await until(
    () => !!releasePost && timedPosts === 2,
    'pending recovery before navigation',
  )
  const selectHealthy = () =>
    timedPage
      .locator('.project-item')
      .and(timedPage.getByTitle(healthy.name, { exact: true }))
      .click()
  await selectHealthy()
  await timedPage.locator('.monaco-editor').first().waitFor()
  releasePost()
  releasePost = undefined
  await frames(timedPage)
  assert.equal((await selection(timedPage)).project, healthy.id)
  assert.equal(await panelFor(timedPage).count(), 0)
  assert.equal(
    timed.state.files[healthy.id]['Main.lean'],
    '-- healthy source\n',
  )
  listMode = 'hold'
  await timedPage
    .locator('.project-item')
    .and(timedPage.getByTitle(project.name, { exact: true }))
    .click()
  await until(() => !!releaseList, 'pending review before unmount')
  await selectHealthy()
  await timedPage.locator('.monaco-editor').first().waitFor()
  releaseList()
  releaseList = undefined
  await frames(timedPage)
  assert.equal((await selection(timedPage)).project, healthy.id)
  assert.equal(await panelFor(timedPage).count(), 0)
  assert.equal(timedPosts, 2)
  timed.assertClean()
  checks.push(
    'Timed-out review and recovery requests expose explicit retry; leaving during a pending review or recovery ignores late responses and keeps the newly selected project usable without unhandled errors.',
  )

  const keyless = await makeFixture('legacy-keyless-admin', {
    ready: false,
    keyless: true,
  })
  const keylessPage = keyless.page
  let keylessChoices = 0
  await keylessPage.route(`${base}${legacyBase}**`, (route) => {
    const request = route.request(),
      url = new URL(request.url())
    assert.equal(request.headers()['x-leanflow-user'], 'legacy-keyless-admin')
    if (request.method() === 'GET' && url.pathname === legacyBase)
      return route.fulfill({ json: envelope([firstReview]) })
    if (request.method() === 'GET' && url.pathname.endsWith('/original'))
      return route.fulfill({
        contentType: 'application/octet-stream',
        body: original,
      })
    assert.equal(request.method(), 'POST')
    assert.deepEqual(request.postDataJSON(), {
      revision: firstReview.revision,
      decision: 'keep-current',
    })
    keylessChoices++
    keyless.state.projects = [project, healthy]
    return route.fulfill({ json: project })
  })
  await keylessPage.goto(base)
  const keylessReview = reviewFor(keylessPage)
  await recordFor(keylessPage, 'Main.lean').waitFor()
  assert.equal(
    await keylessPage.getByLabel('Your Lemex API key', { exact: true }).count(),
    0,
  )
  assert.equal(
    (
      await downloaded(
        keylessPage,
        recordFor(keylessPage, 'Main.lean').getByRole('button', {
          name: 'Download original Main.lean',
          exact: true,
        }),
      )
    ).content,
    original,
  )
  await recordFor(keylessPage, 'Main.lean')
    .getByRole('button', { name: 'Keep current files', exact: true })
    .click()
  assert.equal(keylessChoices, 0)
  await keylessReview
    .getByRole('button', { name: 'Confirm keep current files', exact: true })
    .click()
  await panelFor(keylessPage).waitFor({ state: 'hidden' })
  assert.equal(keylessChoices, 1)
  assert.equal((await selection(keylessPage)).project, project.id)
  assert.equal(keyless.state.files[project.id]['Main.lean'], source)
  keyless.assertClean()
  checks.push(
    'An Admin without a provider key can review, download originals and explicitly resolve an older interrupted update without entering provider credentials or changing project source.',
  )

  const deferred = await makeFixture('legacy-deferred-admin', { keyless: true })
  deferred.state.projects = [
    { ...project, legacyRecoveryReviewAvailable: true },
    { ...healthy, accessRole: 'viewer' },
  ]
  const deferredPage = deferred.page
  let deferredListRequests = 0,
    deferredMode = 'ready',
    releaseDeferred
  await deferredPage.route(`${base}${legacyBase}**`, (route) => {
    assert.equal(
      route.request().headers()['x-leanflow-user'],
      'legacy-deferred-admin',
    )
    assert.equal(route.request().method(), 'GET')
    deferredListRequests++
    if (deferredMode === 'hold')
      return held(route, { json: envelope([firstReview]) }, (release) => {
        releaseDeferred = release
      })
    return route.fulfill({ json: envelope([firstReview]) })
  })
  await deferred.ready()
  assert.equal(deferredListRequests, 0)
  assert.equal(
    await deferredPage
      .getByLabel('Your Lemex API key', { exact: true })
      .count(),
    0,
  )
  const deferredMarker = '-- deferred review keeps editing available'
  await deferredPage.locator('.monaco-editor textarea').first().focus()
  await deferredPage.keyboard.press(editorShortcuts.documentEnd)
  await deferredPage.keyboard.insertText(deferredMarker)
  await until(
    () =>
      deferredPage
        .getByRole('button', { name: 'Save', exact: true })
        .isEnabled(),
    'editable keyless Admin deferred project',
  )
  await deferredPage.locator('.monaco-editor textarea').first().focus()
  await deferredPage.keyboard.press(
    process.platform === 'darwin' ? 'Meta+a' : 'Control+a',
  )
  await deferredPage.keyboard.insertText(source)
  await until(
    () =>
      deferredPage
        .getByRole('button', { name: 'Save', exact: true })
        .isDisabled(),
    'clean source before deferred review navigation',
  )
  const summary = deferredPage.locator('.legacy-recovery-notice summary')
  await summary
    .getByText('Review older file updates', { exact: true })
    .waitFor()
  await summary.click()
  await recordFor(deferredPage, 'Main.lean').waitFor()
  assert.equal(deferredListRequests, 1)
  assert.equal(await panelFor(deferredPage).count(), 0)
  await summary.click()
  await reviewFor(deferredPage).waitFor({ state: 'hidden' })
  deferredMode = 'hold'
  await summary.click()
  await until(() => !!releaseDeferred, 'deferred review before project switch')
  await deferredPage
    .locator('.project-item')
    .and(deferredPage.getByTitle(healthy.name, { exact: true }))
    .click()
  await deferredPage.locator('.monaco-editor').first().waitFor()
  releaseDeferred()
  releaseDeferred = undefined
  await frames(deferredPage)
  assert.equal((await selection(deferredPage)).project, healthy.id)
  await until(
    () =>
      deferredPage
        .locator('.monaco-editor .view-lines')
        .first()
        .innerText()
        .then((value) =>
          value.replaceAll('\u00a0', ' ').includes('-- healthy source'),
        ),
    'selected viewer source after late deferred response',
  )
  assert.equal(await reviewFor(deferredPage).count(), 0)
  assert.equal(deferredListRequests, 2)
  deferred.assertClean()
  checks.push(
    'A keyless Admin can keep editing a deferred-scan project; recovery is fetched only on explicit disclosure, and a late review response cannot replace another selected project.',
  )

  const viewer = await makeFixture('legacy-recovery-viewer', {
    viewer: true,
    ready: false,
  })
  const viewerPage = viewer.page
  let viewerLegacyRequests = 0
  await viewerPage.route(`${base}${legacyBase}**`, (route) => {
    viewerLegacyRequests++
    return route.fulfill({
      status: 403,
      json: { error: 'Admin review is required.' },
    })
  })
  await viewerPage.route(`**/api/projects/${project.id}/download`, (route) => {
    assert.equal(
      route.request().headers()['x-leanflow-user'],
      'legacy-recovery-viewer',
    )
    return route.fulfill({
      contentType: 'application/zip',
      body: 'VIEWER_AVAILABLE_PROJECT_FILES',
    })
  })
  await viewerPage.goto(base)
  const viewerPanel = panelFor(viewerPage)
  await viewerPanel.waitFor()
  assert.equal(await reviewFor(viewerPage).count(), 0)
  for (const name of [
    'Retry file recovery',
    'Restore originals',
    'Keep current files',
    'Confirm restore originals',
    'Confirm keep current files',
  ])
    assert.equal(
      await viewerPage.getByRole('button', { name, exact: true }).count(),
      0,
    )
  assert.equal(
    await viewerPage.getByLabel('Your Lemex API key', { exact: true }).count(),
    0,
  )
  assert.equal(
    (
      await downloaded(
        viewerPage,
        viewerPanel.getByRole('button', {
          name: 'Download project',
          exact: true,
        }),
      )
    ).content,
    'VIEWER_AVAILABLE_PROJECT_FILES',
  )
  viewer.state.projects = [
    { ...project, accessRole: 'viewer' },
    { ...healthy, accessRole: 'viewer' },
  ]
  await viewerPanel
    .getByRole('button', { name: 'Refresh project status', exact: true })
    .click()
  await viewerPanel.waitFor({ state: 'hidden' })
  await viewerPage.locator('.monaco-editor').first().waitFor()
  assert.equal((await selection(viewerPage)).project, project.id)
  assert.equal(
    await viewerPage.getByLabel('Your Lemex API key', { exact: true }).count(),
    0,
  )
  assert.equal(viewerLegacyRequests, 0)
  viewer.assertClean()
  checks.push(
    'A keyless Viewer can export saved files and refresh after recovery, with no Admin recovery actions, private original requests or provider-setup requirement.',
  )
  const result = {
    passed: true,
    checks,
    admin: { reviewRequests, posts, originalDownloads: originals },
    timeouts: { lists, posts: timedPosts },
    viewerLegacyRequests,
    keylessChoices,
    deferredListRequests,
  }
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ passed: false, checks, error: error.stack }, null, 2),
  )
  await active?.page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  for (const release of [...releases]) release()
  await Promise.allSettled(fixtures.map((fixture) => fixture.browser.close()))
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
