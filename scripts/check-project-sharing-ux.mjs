#!/usr/bin/env node
// Actual server/accounts/files. Delayed or failed responses model network faults;
// successful sharing responses and collaboration traffic always reach the server.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'
import JSZip from 'jszip'
import { createSharingLiveFixture } from './lib/sharing-live-fixture.mjs'

const output = path.resolve('.runtime/sharing-ui-review')
await fs.mkdir(output, { recursive: true })
const report = { checks: [], errors: [], providerCalls: 0, passed: false }
const record = (name) => {
  report.checks.push(name)
  console.log(`PASS ${name}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await sleep(60)
  }
  throw new Error(`Timed out: ${label}`)
}
let fixture, browser
const contexts = []
const pages = {}
try {
  fixture = await createSharingLiveFixture()
  browser = await chromium.launch({ headless: true })
  const pageFor = async (key) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1050 },
    })
    contexts.push(context)
    const response = await context.request.post(fixture.origin + '/api/login', {
      data: { token: fixture.accounts[key].token },
      headers: { Origin: fixture.origin },
    })
    assert.equal(response.status(), 200)
    const page = await context.newPage()
    pages[key] = page
    page.on('pageerror', (error) =>
      report.errors.push({ account: key, message: error.message }),
    )
    page.on('request', (request) => {
      if (request.url().startsWith('https://provider.example/'))
        report.providerCalls++
    })
    await page.goto(fixture.origin)
    await page
      .locator('.project-item')
      .filter({ hasText: fixture.project.name })
      .click()
    await page.locator('.monaco-editor textarea').first().waitFor()
    return page
  }
  const admin = await pageFor('admin')
  const viewer = await pageFor('viewer')
  const dialog = admin.getByRole('dialog', {
    name: 'Share project',
    exact: true,
  })
  const openSharing = async () => {
    await admin.getByRole('button', { name: 'Share', exact: true }).click()
    await dialog.getByText('People with access', { exact: true }).waitFor()
  }
  const capture = async (name) => {
    await admin.screenshot({
      path: path.join(output, name + '.png'),
      fullPage: true,
      mask: [admin.locator('.sharing-link-copy input')],
    })
  }
  await openSharing()
  await capture('desktop-sharing')
  for (let i = 0; i < 24; i++) {
    await admin.keyboard.press('Tab')
    assert.equal(
      await admin.evaluate(
        () =>
          document.activeElement === document.body ||
          !!document.activeElement?.closest('dialog'),
      ),
      true,
    )
  }
  await admin.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(
    await admin
      .getByRole('button', { name: 'Share', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  record(
    'Sharing traps keyboard focus, closes with Escape and returns focus to Share',
  )
  await openSharing()
  await admin.setViewportSize({ width: 390, height: 844 })
  await capture('narrow-sharing')
  assert.equal(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
  )
  await admin.setViewportSize({ width: 1440, height: 1050 })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  record('Sharing layout stays inside the 390px viewport')

  const sharingUrl =
    fixture.origin + `/api/projects/${fixture.project.id}/sharing`
  let failLoad = true
  await admin.route(sharingUrl, async (route) => {
    if (failLoad) {
      failLoad = false
      await route.abort('failed')
    } else await route.continue()
  })
  await admin.getByRole('button', { name: 'Share', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  await capture('sharing-load-error')
  await dialog
    .getByRole('button', { name: 'Retry sharing', exact: true })
    .click()
  await dialog.getByText('People with access', { exact: true }).waitFor()
  await admin.unroute(sharingUrl)
  record('A failed sharing load retries in place without closing the dialog')
  assert.equal(
    await dialog.getByLabel('Find an account').getAttribute('maxlength'),
    '80',
  )
  await dialog
    .getByText('Keep at least one project admin.', { exact: true })
    .waitFor()
  await dialog.getByText('You', { exact: true }).waitFor()
  record(
    'Account search matches server limits and sole-admin protection is explained visibly',
  )

  await dialog.getByLabel('New share link role').selectOption('viewer')
  const delayedMetadata = []
  const projectsUrl = fixture.origin + '/api/projects'
  await admin.route(projectsUrl, (route) => delayedMetadata.push(route))
  await dialog
    .getByRole('button', { name: 'Create share link', exact: true })
    .click()
  const link = dialog.getByLabel('Viewer share link', { exact: true })
  await link.waitFor()
  await until(
    () => delayedMetadata.length > 0,
    'sharing metadata refresh is delayed',
  )
  assert.equal(
    await dialog.getByRole('button', { name: 'Done', exact: true }).isEnabled(),
    true,
  )
  await Promise.all(delayedMetadata.map((route) => route.continue()))
  await admin.unroute(projectsUrl)
  record(
    'A slow background project refresh cannot lock the sharing dialog after its change succeeds',
  )
  const invitation = await link.inputValue()
  await admin.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click()
  await dialog.getByText('Copied', { exact: true }).waitFor()
  assert.equal(
    await admin.evaluate(() => navigator.clipboard.readText()),
    invitation,
  )
  await capture('desktop-link-copied')
  await admin.setViewportSize({ width: 390, height: 844 })
  await link.scrollIntoViewIfNeeded()
  await capture('narrow-link-created')
  assert.equal(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
  )
  await admin.setViewportSize({ width: 1440, height: 1050 })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await openSharing()
  await dialog
    .getByText('Create a new link if you need to copy it again.', {
      exact: true,
    })
    .waitFor()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  record(
    'Real invitation copies to the clipboard with feedback, and reopened links explain how to share again',
  )

  const secondAdmin = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorA.id}`,
    { method: 'PUT', body: { role: 'admin' } },
  )
  assert.equal(secondAdmin.status, 200)
  await secondAdmin.json()
  await openSharing()
  const memberUrl =
    fixture.origin +
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorB.id}`
  await admin.route(memberUrl, async (route) => {
    await route.fetch()
    await route.abort('failed')
  })
  await dialog
    .getByLabel('Role for Sharing Editor B', { exact: true })
    .selectOption('viewer')
  await dialog
    .getByRole('button', {
      name: 'Apply role for Sharing Editor B',
      exact: true,
    })
    .click()
  await dialog
    .getByRole('button', { name: 'Confirm access change', exact: true })
    .click()
  await dialog
    .getByText(
      'The saved access list has been refreshed. Check it before retrying.',
      { exact: true },
    )
    .waitFor()
  await until(
    async () =>
      (await dialog
        .getByLabel('Role for Sharing Editor B', { exact: true })
        .inputValue()) === 'viewer',
    'persisted role visible after lost HTTP response',
  )
  await admin.unroute(memberUrl)
  const restoredMember = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorB.id}`,
    { method: 'PUT', body: { role: 'editor' } },
  )
  assert.equal(restoredMember.status, 200)
  await restoredMember.json()
  record(
    'A sharing mutation with a lost response refreshes and displays the actual saved role before retry',
  )
  await dialog
    .getByLabel('Role for Sharing Admin', { exact: true })
    .selectOption('editor')
  await dialog
    .getByRole('button', { name: 'Apply role for Sharing Admin', exact: true })
    .click()
  await dialog
    .getByText('You will lose access to sharing and project deletion.', {
      exact: false,
    })
    .waitFor()
  await dialog
    .getByRole('button', { name: 'Cancel access change', exact: true })
    .click()
  assert.equal(
    await dialog
      .getByLabel('Role for Sharing Admin', { exact: true })
      .inputValue(),
    'admin',
  )
  await dialog
    .getByLabel('Role for Sharing Admin', { exact: true })
    .selectOption('editor')
  await dialog
    .getByRole('button', { name: 'Apply role for Sharing Admin', exact: true })
    .click()
  await dialog
    .getByRole('button', { name: 'Confirm access change', exact: true })
    .click()
  await dialog.waitFor({ state: 'hidden' })
  await until(
    async () =>
      !(await admin
        .getByRole('button', { name: 'Share', exact: true })
        .count()),
    'self-demotion updates permissions',
  )
  assert.equal(
    fixture.studio.workspaces.get(fixture.project.id, fixture.accounts.admin.id)
      .accessRole,
    'editor',
  )
  const restore = await fixture.request(
    'editorA',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.admin.id}`,
    { method: 'PUT', body: { role: 'admin' } },
  )
  assert.equal(restore.status, 200)
  await restore.json()
  assert.equal(
    fixture.studio.workspaces.get(fixture.project.id, fixture.accounts.admin.id)
      .accessRole,
    'admin',
  )
  await admin.getByRole('button', { name: 'Share', exact: true }).waitFor()
  record(
    'An admin can cancel self-demotion, then explicitly confirm it and regain admin access through another admin',
  )

  const snapshot = await fixture.studio.workspaces.terminalSnapshot(
    fixture.project.id,
    fixture.accounts.admin.id,
    'ux-recovery',
  )
  await fixture.studio.workspaces.retainTerminalSnapshot(
    snapshot,
    'Your private terminal files are ready to recover.',
  )
  const recoveriesUrl =
    fixture.origin + `/api/projects/${fixture.project.id}/terminal-recoveries`
  let recoveryGets = 0,
    releaseStale
  const stale = new Promise((resolve) => {
    releaseStale = resolve
  })
  let staleHeld = false
  await admin.route(recoveriesUrl, async (route) => {
    recoveryGets++
    if (recoveryGets === 2) {
      const response = await route.fetch()
      staleHeld = true
      await stale
      await route.fulfill({ response }).catch(() => {})
    } else await route.continue()
  })
  await admin.reload()
  await admin.getByText('Recover terminal files', { exact: false }).waitFor()
  await until(() => staleHeld, 'delayed recovery refresh')
  await admin
    .getByRole('button', { name: 'Discard recovery copy', exact: true })
    .click()
  assert.equal(
    await admin
      .getByRole('button', { name: 'Confirm discard', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await capture('desktop-recovery-confirmation')
  await admin.setViewportSize({ width: 390, height: 844 })
  const assistantClose = admin.getByRole('button', {
    name: 'Close tools panel',
    exact: true,
  })
  if (await assistantClose.isVisible()) await assistantClose.click()
  assert(
    (
      await admin
        .getByRole('button', { name: 'Confirm discard', exact: true })
        .boundingBox()
    ).height >= 44,
  )
  await capture('narrow-recovery-confirmation')
  assert.equal(
    await admin
      .locator('.terminal-recoveries')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
  )
  await admin.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(
    await admin
      .getByRole('button', { name: 'Discard recovery copy', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  )
  await admin
    .getByRole('button', { name: 'Discard recovery copy', exact: true })
    .click()
  const discarded = admin.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().includes(snapshot.runId),
  )
  await admin
    .getByRole('button', { name: 'Confirm discard', exact: true })
    .click()
  assert.equal((await discarded).status(), 200)
  await assert.rejects(fs.stat(path.dirname(snapshot.root)), { code: 'ENOENT' })
  releaseStale()
  await sleep(300)
  assert.equal(
    await admin.getByText('Recover terminal files', { exact: false }).count(),
    0,
  )
  await admin.unroute(recoveriesUrl)
  record(
    'Recovery confirmation fits narrow screens, manages focus and rejects a stale refresh after actual deletion',
  )

  await viewer.getByText('Viewer', { exact: true }).first().waitFor()
  assert.equal(
    await viewer.getByRole('button', { name: 'Share', exact: true }).count(),
    0,
  )
  assert.equal(
    await viewer.getByRole('button', { name: 'Terminal', exact: true }).count(),
    0,
  )
  assert.equal(
    await viewer.getByLabel('Message Lemex', { exact: true }).count(),
    0,
  )
  await viewer.screenshot({ path: path.join(output, 'desktop-viewer.png') })
  await viewer.setViewportSize({ width: 390, height: 844 })
  await viewer.screenshot({ path: path.join(output, 'narrow-viewer.png') })
  record(
    'Viewer state clearly shows read-only access without sharing, terminal or agent submission controls',
  )
  const editorB = await pageFor('editorB')
  await editorB.context().setOffline(true)
  await editorB.locator('.monaco-editor textarea').first().focus()
  await editorB.keyboard.press('ControlOrMeta+End')
  await editorB.keyboard.insertText('\n-- READONLY_DRAFT_PROTECTION\n')
  const demotion = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorB.id}`,
    { method: 'PUT', body: { role: 'viewer' } },
  )
  assert.equal(demotion.status, 200)
  await demotion.json()
  await editorB.context().setOffline(false)
  await until(
    async () =>
      (await editorB
        .getByRole('button', { name: 'Terminal', exact: true })
        .count()) === 0,
    'read-only access refreshed after offline draft',
  )
  await editorB
    .getByText('Unsaved drafts · download to keep', { exact: true })
    .waitFor()
  assert((await editorB.locator('.file-tab .dirty-dot').count()) > 0)
  const reloadPrompt = editorB.waitForEvent('dialog')
  const reloadAttempt = editorB.reload().catch(() => {})
  const prompt = await reloadPrompt
  assert.equal(prompt.type(), 'beforeunload')
  await prompt.dismiss()
  await reloadAttempt
  await editorB
    .locator('.project-item')
    .filter({ hasText: fixture.privateProject.name })
    .click()
  const draftDialog = editorB.getByRole('dialog', {
    name: 'Keep your unsaved drafts?',
    exact: true,
  })
  await draftDialog.waitFor()
  assert.equal(
    await draftDialog
      .getByRole('button', { name: 'Save & continue', exact: true })
      .count(),
    0,
  )
  const draftDownload = editorB.waitForEvent('download')
  await draftDialog
    .getByRole('button', { name: 'Download draft: Main.lean', exact: true })
    .click()
  assert(
    (await fs.readFile(await (await draftDownload).path(), 'utf8')).includes(
      'READONLY_DRAFT_PROTECTION',
    ),
  )
  await draftDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await editorB
    .locator('.project-item')
    .filter({ hasText: fixture.privateProject.name })
    .click()
  await draftDialog
    .getByRole('button', { name: 'Discard edits', exact: true })
    .click()
  await until(
    async () =>
      (await editorB.locator('.workspace-title').innerText()).includes(
        fixture.privateProject.name,
      ),
    'explicit readonly draft discard permits navigation',
  )
  const editorRestore = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorB.id}`,
    { method: 'PUT', body: { role: 'editor' } },
  )
  assert.equal(editorRestore.status, 200)
  await editorRestore.json()
  await editorB.reload()
  await editorB
    .locator('.project-item')
    .filter({ hasText: fixture.project.name })
    .click()
  await editorB.locator('.monaco-editor textarea').first().waitFor()
  record(
    'Demoted offline drafts retain unsaved status, native reload protection and Download/Cancel/Discard navigation without attempting a forbidden save',
  )
  const revokedCopy = await fixture.studio.workspaces.terminalSnapshot(
    fixture.project.id,
    fixture.accounts.editorB.id,
    'ux-revoked-recovery',
  )
  await fixture.studio.workspaces.retainTerminalSnapshot(
    revokedCopy,
    'Your private terminal files are ready to recover.',
  )
  const removal = await fixture.request(
    'admin',
    `/api/projects/${fixture.project.id}/sharing/members/${fixture.accounts.editorB.id}`,
    { method: 'DELETE', body: {} },
  )
  assert.equal(removal.status, 200)
  await removal.json()
  await editorB
    .getByText('Your access to this project has ended.', { exact: false })
    .waitFor()
  await editorB.reload()
  await until(
    async () =>
      (await editorB.locator('.workspace-title').innerText()).includes(
        fixture.privateProject.name,
      ),
    'reload selects remaining own project',
  )
  assert.equal(
    (
      await fixture.request(
        'editorB',
        `/api/projects/${fixture.project.id}/file?path=Main.lean`,
      )
    ).status,
    404,
  )
  await editorB
    .getByRole('button', { name: 'Account settings', exact: true })
    .click()
  const account = editorB.getByRole('dialog', {
    name: 'Assistant settings',
    exact: true,
  })
  await account.locator('.account-terminal-recoveries summary').click()
  const recoveryLink = account.getByRole('link', {
    name: 'Download terminal files',
    exact: true,
  })
  await recoveryLink.waitFor()
  assert((await recoveryLink.getAttribute('href')).includes(fixture.project.id))
  assert.equal(
    new URL(
      await recoveryLink.getAttribute('href'),
      fixture.origin,
    ).searchParams.get('expectedUserId'),
    fixture.accounts.editorB.id,
  )
  await recoveryLink.scrollIntoViewIfNeeded()
  await editorB.screenshot({
    path: path.join(output, 'desktop-account-recovery.png'),
    mask: [editorB.locator('input[type=password]')],
  })
  await editorB.setViewportSize({ width: 390, height: 844 })
  await recoveryLink.scrollIntoViewIfNeeded()
  assert((await recoveryLink.boundingBox()).height >= 44)
  await editorB.screenshot({
    path: path.join(output, 'narrow-account-recovery.png'),
    mask: [editorB.locator('input[type=password]')],
  })
  assert.equal(
    await account.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
    true,
  )
  const recovered = editorB.waitForEvent('download')
  await recoveryLink.click()
  const zip = await JSZip.loadAsync(
    await fs.readFile(await (await recovered).path()),
  )
  const main = Object.values(zip.files).find(
    (file) => !file.dir && /(^|\/)Main\.lean$/.test(file.name),
  )
  assert(main)
  assert((await main.async('string')).includes('shared baseline'))
  await account
    .getByRole('button', { name: 'Discard recovery copy', exact: true })
    .click()
  await account
    .getByRole('button', { name: 'Confirm discard', exact: true })
    .scrollIntoViewIfNeeded()
  await editorB.screenshot({
    path: path.join(output, 'narrow-account-recovery-confirmation.png'),
    mask: [editorB.locator('input[type=password]')],
  })
  await account
    .getByRole('button', { name: 'Confirm discard', exact: true })
    .click()
  await account
    .getByText('No private terminal copies to recover.', { exact: true })
    .waitFor()
  await assert.rejects(fs.stat(path.dirname(revokedCopy.root)), {
    code: 'ENOENT',
  })
  record(
    'After revocation and reload into another project, Account settings still discovers, downloads and discards only the caller private terminal copy',
  )
  assert.deepEqual(report.errors, [])
  assert.equal(report.providerCalls, 0)
  report.passed = true
} catch (error) {
  report.browserState = {}
  for (const [key, page] of Object.entries(pages)) {
    let projectRole = 'revoked'
    try {
      projectRole = fixture?.studio.workspaces.get(
        fixture.project.id,
        fixture.accounts[key].id,
      )?.accessRole
    } catch {}
    report.browserState[key] = {
      text: await page
        .locator('body')
        .innerText()
        .catch(() => ''),
      projectRole,
    }
  }
  report.failure = String(error.stack).replace(
    /#share=[A-Za-z0-9_%=-]+/g,
    '#share=[invitation]',
  )
  console.error(report.failure)
  process.exitCode = 1
} finally {
  await Promise.allSettled(contexts.map((context) => context.close()))
  await browser?.close()
  await fixture?.close()
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
