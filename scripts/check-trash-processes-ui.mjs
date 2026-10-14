#!/usr/bin/env node
// Mock every API and Lean connection: no real project, provider, or process is touched.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  chatBrowserFixture,
  sleep,
  until,
} from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/trash-processes-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'trash-processes-project'
const otherProjectId = 'trash-processes-other'
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const source = 'example : True := by trivial\n'
const fixture = await chatBrowserFixture({
  base,
  session: {
    user: { id: 'trash-processes-owner', name: 'Trash fixture' },
    templates: [],
    models: [],
    runtime: { ready: true },
  },
  projects: [
    { id: projectId, name: 'Process fixture', status: 'ready' },
    { id: otherProjectId, name: 'Remaining project', status: 'ready' },
  ],
  files: {
    [projectId]: { 'Main.lean': source },
    [otherProjectId]: { 'Main.lean': source },
  },
  chats: [
    { id: 'trash-processes-chat', projectId, title: 'Process chat' },
    {
      id: 'trash-processes-other-chat',
      projectId: otherProjectId,
      title: 'Remaining chat',
    },
  ],
  runs: [],
})
const { page, browser, state, report } = fixture
const createdAt = '2026-10-13T12:34:56.000Z'
let trashItems = [
  {
    trashId: 'retired-project',
    projectId: 'retired-workspace',
    projectName: 'Retired project',
    name: 'Retired project',
    path: null,
    kind: 'project',
    createdAt,
    sizeBytes: 12_500_000,
  },
  {
    trashId: 'retired-file',
    projectId,
    projectName: 'Process fixture',
    name: 'Old.lean',
    path: 'Old.lean',
    kind: 'file',
    createdAt,
    sizeBytes: 2_500_000,
  },
  {
    trashId: 'retired-folder',
    projectId,
    projectName: 'Process fixture',
    name: 'Old proofs',
    path: 'Old proofs',
    kind: 'folder',
    createdAt,
    sizeBytes: 5_000_000,
  },
  {
    trashId: 'restore-file',
    projectId,
    projectName: 'Process fixture',
    name: 'Restore.lean',
    path: 'Restore.lean',
    kind: 'file',
    createdAt,
    sizeBytes: 125,
  },
  {
    trashId: 'deletion-retry',
    projectId,
    projectName: 'Process fixture',
    name: 'Partial deletion',
    path: 'Partial deletion',
    kind: 'folder',
    createdAt,
    sizeBytes: 1_000_000,
    deleting: true,
    recoverable: false,
  },
]
const actions = []
const externalRequests = []
report.actions = actions
report.externalRequests = externalRequests
let holdDelete = null
let holdCheck = null
let holdStop = null
let holdTrash = null
let checkCount = 0
let clockTime
const jobs = new Map()
const trash = () => page.getByRole('dialog', { name: 'Trash', exact: true })
const confirmation = () =>
  page.getByRole('dialog', { name: 'Permanently delete item?', exact: true })
const deleteDialog = () =>
  page.getByRole('dialog', { name: 'Delete project?', exact: true })
const row = (name) =>
  trash()
    .locator('.trash-item')
    .filter({ has: page.getByText(name, { exact: true }) })
const requestCount = (suffix) =>
  actions.filter((action) => action.endpoint.endsWith(suffix)).length
const respond = (route, value, status = 200) =>
  route.fulfill({ status, json: value })

await page.route('**/*', async (route) => {
  const url = new URL(route.request().url())
  if (/^https?:$/.test(url.protocol) && url.origin !== new URL(base).origin) {
    externalRequests.push(url.href)
    return route.abort()
  }
  return route.fallback()
})
await page.route('**/api/trash**', async (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  if (endpoint === '/api/trash' && request.method() === 'GET')
    return respond(route, trashItems)
  const match = /^\/api\/trash\/([^/]+)\/(restore|delete-forever)$/.exec(
    endpoint,
  )
  if (!match || request.method() !== 'POST') return route.fallback()
  actions.push({ method: 'POST', endpoint, body: request.postDataJSON() })
  const item = trashItems.find((entry) => entry.trashId === match[1])
  assert(item, 'Trash request targeted an unavailable item')
  if (match[2] === 'delete-forever' && holdDelete) {
    const pending = holdDelete
    return new Promise((resolve) => {
      pending.release = async (success) => {
        if (success)
          trashItems = trashItems.filter(
            (entry) => entry.trashId !== item.trashId,
          )
        await respond(
          route,
          success
            ? { deleted: true }
            : {
                error:
                  'Fixture disk is temporarily unavailable. Retry deletion.',
              },
          success ? 200 : 503,
        )
        resolve()
      }
    })
  }
  assert(!(match[2] === 'restore' && item.recoverable === false))
  trashItems = trashItems.filter((entry) => entry.trashId !== item.trashId)
  return respond(
    route,
    match[2] === 'restore' ? { restored: true } : { deleted: true },
  )
})
await page.route('**/api/projects/*/checks', (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  if (request.method() !== 'GET') return route.fallback()
  return respond(
    route,
    [...jobs.values()].filter(
      (job) =>
        job.projectId === endpoint.split('/')[3] &&
        !['completed', 'cancelled', 'failed'].includes(job.status),
    ),
  )
})
await page.route('**/api/projects/*/check', (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  assert.equal(request.method(), 'POST')
  actions.push({ method: 'POST', endpoint, body: request.postDataJSON() })
  const job = {
    id: `trash-check-${++checkCount}`,
    projectId: endpoint.split('/')[3],
    status: 'running',
    createdAt: new Date(clockTime - 125_000).toISOString(),
    log: 'Waiting for a fixture evaluation.',
  }
  jobs.set(job.id, job)
  if (holdCheck) {
    const pending = holdCheck
    return new Promise((resolve) => {
      pending.release = async () => {
        await respond(route, job, 202)
        resolve()
      }
    })
  }
  return respond(route, job, 202)
})
await page.route('**/api/jobs/**', (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  const match = /^\/api\/jobs\/([^/]+)(\/stop)?$/.exec(endpoint)
  if (!match) return route.fallback()
  const job = jobs.get(match[1])
  assert(job, 'Unknown fixture check job')
  if (request.method() === 'GET' && !match[2]) return respond(route, job)
  if (request.method() !== 'POST' || !match[2]) return route.fallback()
  actions.push({ method: 'POST', endpoint, body: request.postDataJSON() })
  if (holdStop) {
    const pending = holdStop
    return new Promise((resolve) => {
      pending.release = async (success) => {
        if (success) job.status = 'cancelled'
        await respond(
          route,
          success
            ? job
            : {
                error: 'Fixture check could not be stopped. Retry Stop check.',
              },
          success ? 200 : 503,
        )
        resolve()
      }
    })
  }
  job.status = 'cancelled'
  return respond(route, job)
})
await page.route('**/api/projects/*/trash', async (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  const id = endpoint.split('/')[3]
  const body = request.postDataJSON()
  assert.equal(request.method(), 'POST')
  actions.push({ method: 'POST', endpoint, body })
  if (!body.stopActive)
    return respond(
      route,
      {
        error:
          'Stop active checks and Lemex runs, and wait for project preparation, before deleting or restoring project data.',
      },
      409,
    )
  assert.deepEqual(body, { stopActive: true })
  const project = state.projects.find((entry) => entry.id === id)
  assert(project, 'Trash request crossed project boundaries')
  const complete = () => {
    for (const job of jobs.values())
      if (job.projectId === id) job.status = 'cancelled'
    state.projects = state.projects.filter((entry) => entry.id !== id)
    return {
      trashId: `trashed-${id}`,
      projectId: id,
      projectName: project.name,
      path: null,
      kind: 'project',
      createdAt: new Date(clockTime).toISOString(),
      sizeBytes: 100,
    }
  }
  if (holdTrash) {
    const pending = holdTrash
    return new Promise((resolve) => {
      pending.release = async (success) => {
        await respond(
          route,
          success
            ? complete()
            : {
                error:
                  'Fixture process is still stopping. Retry moving to Trash.',
              },
          success ? 200 : 409,
        )
        resolve()
      }
    })
  }
  return respond(route, complete())
})

async function openTrash() {
  await page
    .getByRole('button', { name: 'Open Trash', exact: true })
    .first()
    .click()
  await trash().waitFor()
  await row('Retired project').waitFor()
}
async function openPermanentDelete(name) {
  await row(name)
    .getByRole('button', { name: `Permanently delete ${name}`, exact: true })
    .click()
  await confirmation().waitFor()
}
async function moveProject(name) {
  const projectRow = page.locator('.project-row').filter({ hasText: name })
  await projectRow.scrollIntoViewIfNeeded()
  await projectRow.hover()
  await page
    .getByRole('button', { name: `Move project ${name} to trash`, exact: true })
    .click()
  await deleteDialog().waitFor()
}
async function checkingMinutes() {
  const text = await page.locator('.lean-check-button').innerText()
  const match = /^Checking…\s+(\d+\.\d{2}) min$/.exec(text)
  assert(match, `Check did not display elapsed minutes: ${text}`)
  return Number(match[1])
}

try {
  await fixture.ready()
  await openTrash()
  const projectRow = row('Retired project')
  const restoreBounds = await projectRow
    .getByRole('button', { name: 'Restore', exact: true })
    .boundingBox()
  const nameBounds = await projectRow
    .getByText('Retired project', { exact: true })
    .boundingBox()
  const sizeBounds = await projectRow
    .getByText('12.50 MB', { exact: true })
    .boundingBox()
  const eraseButton = projectRow.getByRole('button', {
    name: 'Permanently delete Retired project',
    exact: true,
  })
  const eraseBounds = await eraseButton.boundingBox()
  assert(restoreBounds && nameBounds && sizeBounds && eraseBounds)
  assert(
    restoreBounds.x + restoreBounds.width <= nameBounds.x,
    'Restore must appear left of the name',
  )
  assert(
    nameBounds.x + nameBounds.width <= sizeBounds.x,
    'Size must appear right of the name',
  )
  assert(
    sizeBounds.x + sizeBounds.width <= eraseBounds.x,
    'Delete icon must appear right of the size',
  )
  const color = await eraseButton.evaluate(
    (element) => getComputedStyle(element).color,
  )
  const channels = color.match(/\d+(?:\.\d+)?/g)?.map(Number)
  assert(
    channels && channels[0] > channels[1] + 25 && channels[0] > channels[2],
    `Delete icon was not red: ${color}`,
  )
  assert(
    await row('Partial deletion')
      .getByRole('button', { name: 'Restore', exact: true })
      .isDisabled(),
  )
  assert(
    await row('Partial deletion')
      .getByRole('button', {
        name: 'Permanently delete Partial deletion',
        exact: true,
      })
      .isEnabled(),
  )
  report.checks.push(
    'Trash rows show Restore, item name, decimal MB size, and a red permanent-delete icon in that order; partial deletions permit retry but cannot be restored.',
  )

  await openPermanentDelete('Retired project')
  const details = await confirmation().innerText()
  const deletionDate = await page.evaluate(
    (value) => new Date(value).toLocaleString(),
    createdAt,
  )
  for (const value of [
    'Retired project',
    'project',
    '12.50 MB',
    deletionDate,
    'Deleted',
    'Project',
  ])
    assert(details.includes(value), `Confirmation omitted ${value}`)
  assert(
    await confirmation()
      .getByRole('button', { name: 'Delete Forever', exact: true })
      .isEnabled(),
  )
  await confirmation()
    .getByRole('button', { name: 'Do Nothing', exact: true })
    .click()
  await row('Retired project').waitFor()
  assert.equal(
    requestCount('/delete-forever'),
    0,
    'Cancellation performed permanent deletion',
  )

  holdDelete = {}
  await openPermanentDelete('Retired project')
  await confirmation()
    .getByRole('button', { name: 'Delete Forever', exact: true })
    .click()
  await until(() => !!holdDelete.release, 'held permanent deletion')
  assert(
    await confirmation()
      .getByRole('button', { name: 'Deleting…', exact: true })
      .isDisabled(),
  )
  assert(
    await confirmation()
      .getByRole('button', { name: 'Do Nothing', exact: true })
      .isDisabled(),
  )
  assert(await confirmation().getByLabel('Close dialog').isDisabled())
  await holdDelete.release(false)
  await confirmation()
    .getByRole('alert')
    .filter({ hasText: 'temporarily unavailable' })
    .waitFor()
  assert(trashItems.some((entry) => entry.trashId === 'retired-project'))
  await confirmation()
    .getByRole('button', { name: 'Do Nothing', exact: true })
    .click()
  await row('Retired project').waitFor()
  holdDelete = null
  await openPermanentDelete('Retired project')
  await confirmation()
    .getByRole('button', { name: 'Delete Forever', exact: true })
    .click()
  await until(
    async () =>
      (await trash().count()) > 0 &&
      (await row('Retired project').count()) === 0,
    'project permanently deleted',
  )
  report.checks.push(
    'Permanent deletion repeats project, type, MB size, and deletion date; Do Nothing sends no write; pending controls prevent duplicate actions; failure retains the item for a successful retry.',
  )

  for (const name of ['Old.lean', 'Old proofs', 'Partial deletion']) {
    await openPermanentDelete(name)
    await confirmation()
      .getByRole('button', { name: 'Delete Forever', exact: true })
      .click()
    await until(
      async () =>
        (await trash().count()) > 0 && (await row(name).count()) === 0,
      `${name} permanently deleted`,
    )
  }
  await page.setViewportSize({ width: 620, height: 900 })
  assert(
    await trash().evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    'Trash dialog overflowed horizontally',
  )
  await row('Restore.lean')
    .getByRole('button', {
      name: 'Permanently delete Restore.lean',
      exact: true,
    })
    .scrollIntoViewIfNeeded()
  await page.screenshot({
    path: path.join(output, 'trash-narrow.png'),
    fullPage: true,
  })
  await row('Restore.lean')
    .getByRole('button', { name: 'Restore', exact: true })
    .click()
  await until(
    async () => (await row('Restore.lean').count()) === 0,
    'restoration remains available',
  )
  await trash().getByText('Trash is empty.', { exact: true }).waitFor()
  await trash().getByRole('button', { name: 'Close', exact: true }).click()
  await page.setViewportSize({ width: 1600, height: 1000 })
  report.checks.push(
    'Project, file, folder, and incomplete-deletion entries can be permanently deleted; restoration still works and the narrow dialog remains reachable without horizontal overflow.',
  )

  clockTime = Date.now()
  await page.clock.install({ time: clockTime })
  holdCheck = {}
  await page.getByRole('button', { name: 'Check Project', exact: true }).click()
  await until(() => !!holdCheck.release, 'held check start request')
  const starting = page.getByRole('button', {
    name: 'Starting check…',
    exact: true,
  })
  assert(
    await starting.isDisabled(),
    'Pending check start permitted another check',
  )
  const startingBounds = await starting.boundingBox()
  assert(startingBounds)
  await page.mouse.click(
    startingBounds.x + startingBounds.width / 2,
    startingBounds.y + startingBounds.height / 2,
  )
  await sleep(150)
  assert.equal(
    checkCount,
    1,
    'Repeated clicks launched duplicate project checks',
  )
  await holdCheck.release()
  holdCheck = null
  await page.getByRole('button', { name: 'Stop check', exact: true }).waitFor()
  const initialMinutes = await checkingMinutes()
  assert(
    Math.abs(initialMinutes - 125 / 60) < 0.05,
    'Elapsed timer ignored the job creation time',
  )
  await fixture.ready()
  await page.getByRole('button', { name: 'Stop check', exact: true }).waitFor()
  assert.equal(checkCount, 1, 'Reloading launched another project check')
  assert(
    Math.abs((await checkingMinutes()) - initialMinutes) < 0.1,
    'Reloading reset the active check timer',
  )
  await page.clock.fastForward(60_000)
  clockTime += 60_000
  const laterMinutes = await checkingMinutes()
  assert(
    Math.abs(laterMinutes - initialMinutes - 1) < 0.1,
    'Elapsed timer did not advance with wall time',
  )
  holdStop = {}
  await page.getByRole('button', { name: 'Stop check', exact: true }).click()
  await until(() => !!holdStop.release, 'held check cancellation')
  assert(
    await page
      .getByRole('button', { name: 'Stopping…', exact: true })
      .isDisabled(),
  )
  assert(await page.locator('.lean-check-button').isDisabled())
  await page.locator('.monaco-editor textarea').focus()
  assert(
    await page
      .locator('.monaco-editor')
      .evaluate((element) => element.contains(document.activeElement)),
    'Pending stop prevented editor access',
  )
  await holdStop.release(false)
  await page
    .getByText('Fixture check could not be stopped. Retry Stop check.', {
      exact: true,
    })
    .waitFor()
  await page.getByRole('button', { name: 'Stop check', exact: true }).waitFor()
  holdStop = null
  jobs.set('preexisting-check', {
    id: 'preexisting-check',
    projectId,
    status: 'running',
    createdAt: new Date(clockTime - 30_000).toISOString(),
    log: 'A check started in another tab.',
  })
  await page.getByRole('button', { name: 'Stop check', exact: true }).click()
  await until(
    () => jobs.get('trash-check-1').status === 'cancelled',
    'first check stopped while another remains',
  )
  await until(
    () =>
      page.getByRole('button', { name: 'Stop check', exact: true }).isEnabled(),
    'remaining check remains stoppable',
  )
  assert(await page.locator('.lean-check-button').isDisabled())
  assert.equal(jobs.get('preexisting-check').status, 'running')
  await page.getByRole('button', { name: 'Stop check', exact: true }).click()
  await until(
    () =>
      page
        .getByRole('button', { name: 'Check Project', exact: true })
        .isEnabled(),
    'check stopped',
  )
  assert.equal(
    await page.getByRole('button', { name: 'Stop check', exact: true }).count(),
    0,
  )
  assert.equal(requestCount('/stop'), 3)
  assert.equal(jobs.get('preexisting-check').status, 'cancelled')
  report.checks.push(
    'A held start disables Check Project and repeated clicks launch one job; Checking displays wall-clock minutes from createdAt, survives reload, and advances by one minute; Stop is guarded while pending, preserves editor access, supports error retry, and exposes another preexisting active check until it is also stopped.',
  )

  await page.getByRole('button', { name: 'Check Project', exact: true }).click()
  await page.getByRole('button', { name: 'Stop check', exact: true }).waitFor()
  await moveProject('Process fixture')
  const stopAll = () =>
    deleteDialog().getByRole('button', {
      name: 'Stop all processes and move to Trash',
      exact: true,
    })
  await stopAll().waitFor()
  const beforeCancel = requestCount('/trash')
  await deleteDialog()
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  assert.equal(
    requestCount('/trash'),
    beforeCancel,
    'Cancelling project deletion stopped or trashed the project',
  )
  assert.equal(jobs.get('trash-check-2').status, 'running')
  await moveProject('Process fixture')
  holdTrash = {}
  await stopAll().click()
  await until(() => !!holdTrash.release, 'held stop-all-and-trash request')
  assert(
    await deleteDialog()
      .getByRole('button', { name: 'Cancel', exact: true })
      .isDisabled(),
  )
  assert(await deleteDialog().getByLabel('Close dialog').isDisabled())
  assert(
    await deleteDialog()
      .getByRole('button', { name: /Stopping|Moving/ })
      .isDisabled(),
  )
  await holdTrash.release(false)
  await deleteDialog()
    .getByRole('alert')
    .filter({ hasText: 'still stopping' })
    .waitFor()
  assert(state.projects.some((entry) => entry.id === projectId))
  holdTrash = null
  await stopAll().click()
  await until(
    async () => (await deleteDialog().count()) === 0,
    'active project moved to trash',
  )
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Move project Process fixture to trash',
        exact: true,
      })
      .count(),
    0,
  )
  assert.equal(jobs.get('trash-check-2').status, 'cancelled')
  assert.equal(state.projects.length, 1)
  await page.locator('.monaco-editor').waitFor()
  report.checks.push(
    'Deleting a project with an active check offers Stop all processes and move to Trash; Cancel keeps it running; pending guards prevent repeated writes; failure keeps the project and successful retry removes it.',
  )

  await moveProject('Remaining project')
  await deleteDialog()
    .getByRole('button', { name: 'Move to Trash', exact: true })
    .click()
  await deleteDialog()
    .getByRole('alert')
    .filter({ hasText: 'Stop active checks' })
    .waitFor()
  await stopAll().waitFor()
  await stopAll().click()
  await until(
    async () => (await deleteDialog().count()) === 0,
    'server-reported active work stopped and trashed',
  )
  assert.equal(state.projects.length, 0)
  assert(
    actions.some(
      (action) =>
        action.endpoint === `/api/projects/${otherProjectId}/trash` &&
        !action.body.stopActive,
    ),
  )
  assert(
    actions.some(
      (action) =>
        action.endpoint === `/api/projects/${otherProjectId}/trash` &&
        action.body.stopActive === true,
    ),
  )
  report.checks.push(
    'A normal trash request rejected for server-side active work exposes the combined stop-and-trash action and retries with stopActive:true.',
  )
  assert.deepEqual(
    externalRequests,
    [],
    'Browser attempted an external request',
  )
  fixture.assertClean()
  report.providerCalls = 0
  report.realProcessStops = 0
  report.passed = true
  console.log(
    'PASS: Trash restore/permanent deletion, elapsed check timer, stop/retry, and stop-all-and-trash flows; all APIs mocked.',
  )
} catch (error) {
  report.passed = false
  report.error = error.stack || error.message
  process.exitCode = 1
  await page
    .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
    .catch(() => {})
  console.error(report.error)
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await browser.close()
}
