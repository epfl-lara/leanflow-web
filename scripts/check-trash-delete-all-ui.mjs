#!/usr/bin/env node
// Entirely mocked APIs and Lean: never deletes real projects or invokes a provider.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const output = path.resolve('.runtime/trash-delete-all-ui')
await fs.mkdir(output, { recursive: true })
const projectId = 'bulk-live-project'
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'bulk-owner', name: 'Bulk fixture' },
    templates: [],
    models: [],
    runtime: { ready: true },
  },
  projects: [{ id: projectId, name: 'Live project', status: 'ready' }],
  files: { [projectId]: { 'Main.lean': 'example : True := by trivial\n' } },
  chats: [{ id: 'bulk-chat', projectId, title: 'Live chat' }],
  runs: [],
})
const { page, browser, report } = fixture
const createdAt = '2026-10-14T08:00:00.000Z'
const item = (trashId, name, kind, workspace, sizeBytes) => ({
  trashId,
  name,
  kind,
  projectId: workspace,
  projectName: workspace,
  path: kind === 'project' || kind === 'chat' ? null : name,
  createdAt,
  sizeBytes,
  recoverable: true,
})
let items = [
  item('project', 'Archived project', 'project', 'archived', 20_000_000),
  item('child', 'Archived proof', 'file', 'archived', 3_000_000),
  item('folder', 'Old folder', 'folder', projectId, 5_000_000),
  item('chat', 'Archived chat', 'chat', 'archived', 500_000),
  item('unknown', 'Unknown size', 'file', projectId, null),
]
const writes = []
report.writes = writes
let pending
await page.route('**/api/trash**', async (route) => {
  const request = route.request(),
    endpoint = new URL(request.url()).pathname
  if (endpoint === '/api/trash' && request.method() === 'GET')
    return route.fulfill({ json: items })
  if (endpoint !== '/api/trash/delete-all' || request.method() !== 'POST')
    return route.fallback()
  writes.push(request.postDataJSON())
  await new Promise((resolve) => {
    pending = async (value, status = 200) => {
      if (status === 200)
        items = items.filter(
          (entry) => !value.deletedTrashIds.includes(entry.trashId),
        )
      await route.fulfill({ status, json: value })
      pending = null
      resolve()
    }
  })
})
const trash = () => page.getByRole('dialog', { name: 'Trash', exact: true })
const confirmation = () =>
  page.getByRole('dialog', { name: 'Delete all trash?', exact: true })
const confirm = async () => {
  await confirmation()
    .getByRole('button', { name: 'Delete Forever', exact: true })
    .click()
  await until(() => !!pending, 'bulk deletion request')
}
try {
  await fixture.ready()
  await page.getByRole('button', { name: 'Open Trash', exact: true }).click()
  await until(
    async () => (await trash().locator('.trash-item').count()) === 5,
    'trash list',
  )
  await trash().getByRole('button', { name: 'Delete All', exact: true }).click()
  const details = await confirmation().innerText()
  assert(details.includes('5 items'))
  assert(details.includes('25.50 MB'), 'Archived child data was counted twice')
  assert(details.includes('Size is unavailable for 1 item'))
  assert(details.includes('cannot be undone'))
  await confirmation()
    .getByRole('button', { name: 'Do Nothing', exact: true })
    .click()
  assert.equal(writes.length, 0, 'Cancel deleted Trash')
  assert.equal(await trash().locator('.trash-item').count(), 5)
  report.checks.push(
    'Delete All confirms count, size without duplicate project content, unknown sizes and irreversibility; Do Nothing preserves every item.',
  )

  await trash().getByRole('button', { name: 'Delete All', exact: true }).click()
  await confirm()
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
  assert(
    await confirmation()
      .getByRole('button', { name: 'Close dialog', exact: true })
      .isDisabled(),
  )
  await page.keyboard.press('Escape')
  assert(await confirmation().isVisible())
  await pending({ error: 'Deletion temporarily unavailable. Retry.' }, 503)
  await until(
    async () =>
      (await confirmation().innerText()).includes('temporarily unavailable'),
    'request failure',
  )
  await confirmation()
    .getByRole('button', { name: 'Do Nothing', exact: true })
    .click()
  assert.equal(await trash().locator('.trash-item').count(), 5)
  report.checks.push(
    'Pending deletion guards repeated actions and closing; HTTP failure preserves the entire list and permits retry.',
  )

  await trash().getByRole('button', { name: 'Delete All', exact: true }).click()
  items.push(
    item('new', 'Added after confirmation', 'file', projectId, 1_000_000),
  )
  await confirm()
  assert.deepEqual(
    new Set(writes.at(-1).trashIds),
    new Set(['project', 'child', 'folder', 'chat', 'unknown']),
  )
  await pending({
    deletedTrashIds: ['project', 'child', 'chat'],
    failures: [
      {
        trashId: 'folder',
        name: 'Old folder',
        error: 'Stop its active check first.',
      },
      { trashId: 'unknown', name: 'Unknown size', error: 'Retry this item.' },
    ],
  })
  await until(
    async () => (await confirmation().innerText()).includes('2 items'),
    'remaining confirmation',
  )
  assert(
    (await confirmation().innerText()).includes('Stop its active check first.'),
  )
  await confirm()
  assert.deepEqual(
    new Set(writes.at(-1).trashIds),
    new Set(['folder', 'unknown']),
    'Retry included already deleted items',
  )
  await pending({ deletedTrashIds: ['folder', 'unknown'], failures: [] })
  await until(
    async () => (await trash().locator('.trash-item').count()) === 1,
    'newer trash preserved',
  )
  assert((await trash().innerText()).includes('Added after confirmation'))
  report.checks.push(
    'Partial deletion explains failures, retries only remaining items, clears project children, and preserves and displays trash added after confirmation.',
  )

  await trash().getByRole('button', { name: 'Delete All', exact: true }).click()
  await confirm()
  await pending({ deletedTrashIds: ['new'], failures: [] })
  await until(
    async () => (await trash().innerText()).includes('Trash is empty.'),
    'empty trash',
  )
  assert(
    await trash()
      .getByRole('button', { name: 'Delete All', exact: true })
      .isDisabled(),
  )
  fixture.assertClean()
  assert.equal(writes.length, 4)
  await page.screenshot({ path: path.join(output, 'empty-trash.png') })
  report.checks.push(
    'Successful Delete All empties Trash and disables the action when empty.',
  )
  report.ok = true
  console.log('Trash Delete All browser checks passed.')
} catch (error) {
  report.ok = false
  report.failure = error.stack || error.message
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
