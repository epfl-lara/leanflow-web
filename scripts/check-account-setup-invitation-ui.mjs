#!/usr/bin/env node
// Closed API/editor fixture. Failed invitations must remain recoverable before
// provider setup, so existing viewer access does not require an API key.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
const output = path.resolve('.runtime/account-setup-invitation-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(
  express.static(process.env.STUDIO_TEST_DIST || path.resolve('client/dist')),
)
const server = await new Promise((resolve) => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
let fixture
const result = { checks: [] }
try {
  const base = `http://127.0.0.1:${server.address().port}`
  const project = {
    id: 'viewer-project',
    name: 'Accessible viewer project',
    status: 'ready',
    accessRole: 'viewer',
  }
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: {
        id: 'viewer-user',
        name: 'Viewer User',
        role: 'user',
        profileComplete: true,
      },
      templates: [],
      models: [],
      runtime: { ready: true },
      lemex: { configured: false },
    },
    projects: [project],
    files: { [project.id]: { 'Main.lean': 'example : True := by trivial\n' } },
    chats: [{ id: 'viewer-chat', projectId: project.id, title: 'Viewer chat' }],
    runs: [],
  })
  const { page, report } = fixture
  let joins = 0
  await page.route('**/api/project-invitations/join', (route) => {
    joins++
    return route.fulfill({
      status: 404,
      json: { error: 'The project invitation is no longer available.' },
    })
  })
  await page.goto(base + '/#share=expired-audit-invitation')
  await page.getByRole('heading', { name: 'Welcome, Viewer User.' }).waitFor()
  await until(() => joins === 1, 'invitation attempted')
  await page
    .getByText('The project invitation is no longer available.', {
      exact: true,
    })
    .waitFor()
  await page.screenshot({ path: path.join(output, 'invitation-error.png') })
  const snapshot = {
    invitationRequests: joins,
    errorVisible: await page
      .getByText('The project invitation is no longer available.', {
        exact: true,
      })
      .count(),
    retryInvitation: await page
      .getByRole('button', { name: 'Retry invitation', exact: true })
      .count(),
    dismiss: await page
      .getByRole('button', { name: 'Dismiss', exact: true })
      .count(),
    viewerProjectButton: await page
      .getByRole('button', {
        name: 'Open viewer project: Accessible viewer project',
        exact: true,
      })
      .count(),
    projectListRequests: report.requests.filter(
      (r) => r.endpoint === '/api/projects',
    ).length,
    pendingInvitation: await page.evaluate(() =>
      sessionStorage.getItem('lemex-project-invitation'),
    ),
  }
  assert.equal(snapshot.errorVisible, 1)
  assert.equal(snapshot.retryInvitation, 1)
  assert.equal(snapshot.dismiss, 1)
  assert.equal(snapshot.viewerProjectButton, 0)
  assert.equal(snapshot.projectListRequests, 0)
  result.checks.push(snapshot)
  // Both recovery choices remain available before a provider key is configured.
  await page
    .getByRole('button', { name: 'Retry invitation', exact: true })
    .click()
  await until(() => joins === 2, 'invitation retried')
  await page
    .getByText('The project invitation is no longer available.', {
      exact: true,
    })
    .waitFor()
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await page.locator('.monaco-editor').waitFor()
  assert(
    (
      await page.locator('.project-item[aria-current=page]').innerText()
    ).includes('Accessible viewer project'),
  )
  result.checks.push({
    name: 'Retry and Dismiss work before provider setup; dismissal restores existing viewer project access without an API key',
    editorVisible: await page.locator('.monaco-editor').isVisible(),
  })
  fixture.assertClean()
  result.passed = true
  result.errors = report.errors
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  result.error = error.stack
  await fixture?.page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
