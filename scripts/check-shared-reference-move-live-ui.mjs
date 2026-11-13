#!/usr/bin/env node
// Real browser hooks, auth, memberships, HTTP, WebSockets and workspace storage.
// Markdown editors avoid Lean workers; the isolated runtime never calls a provider.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { createStudio } from '../server/studio.mjs'
import { fixtureModelDiscovery } from '../server/tests/fixtures/model-discovery.mjs'
import { until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/shared-reference-move-live-ui')
await fs.mkdir(output, { recursive: true })
const dataDir = await fs.mkdtemp(path.join(output, 'data-'))
const providerBase = 'https://provider.example/v1'
const report = {
  passed: false,
  cleanupComplete: false,
  providerCalls: 0,
  checks: [],
  browserErrors: [],
}
await fs.writeFile(
  path.join(output, 'report.json'),
  JSON.stringify(report, null, 2) + '\n',
)
const fetchOriginal = globalThis.fetch
globalThis.fetch = (input, options) => {
  const url =
    typeof input === 'string' || input instanceof URL
      ? String(input)
      : input.url
  if (url.startsWith(providerBase)) {
    report.providerCalls++
    throw new Error('Provider requests are disabled in this browser check.')
  }
  return fetchOriginal(input, options)
}

let studio, browser, releaseWrite, heldFinished
let writeHeld = false
const pages = []
try {
  await fs.access(path.resolve('client/dist/index.html'))
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async run(root, args) {
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true })
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    spawn() {
      throw new Error('This Markdown browser check must not start a worker.')
    },
  }
  studio = await createStudio({
    dataDir,
    runtime,
    modelDiscoverer: fixtureModelDiscovery,
    titleGenerator: async () => null,
    providerLimits: { get: async () => 1, current: () => 1 },
    config: {
      defaultModel: 'fixture-model',
      models: [{ id: 'fixture-model' }],
      provider: { LEMEX_BASE_URL: providerBase },
      lemex: {},
      redact: String,
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${studio.server.address().port}`
  const admin = {
    id: 'owner',
    token: (
      await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
    ).trim(),
  }
  await studio.auth.updateProfile(admin, { name: 'Fixture administrator' })
  const accounts = []
  for (const name of ['Move editor A', 'Move editor B']) {
    const created = await studio.auth.createUser(admin, { name })
    const account = { id: created.user.id, name, token: created.token }
    await studio.auth.updateProfile(account, { name })
    await studio.providers.save(
      account.id,
      `offline-${account.id}`,
      providerBase,
    )
    accounts.push(account)
  }
  const project = await studio.workspaces.create(admin.id, {
    name: 'Shared reference move fixture',
    preset: 'lean',
    autoRepair: false,
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, admin.id).status, 'ready')
  const request = (actor, endpoint, { body, method = 'GET' } = {}) =>
    fetch(origin + endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${actor.token}`,
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  for (const account of accounts) {
    const grant = await request(
      admin,
      `/api/projects/${project.id}/sharing/members/${account.id}`,
      {
        method: 'PUT',
        body: { role: 'editor' },
      },
    )
    assert.equal(grant.status, 200)
  }
  const baseline =
    '# Linked proof notes\n\n![Figure](../assets/Figure.svg)\n\n[Proof](Proof.lean)\n'
  const sources = {
    'assets/Figure.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>\n',
    'Linked/Notes.md': baseline,
    'Linked/Helper.lean': 'theorem helper : True := by trivial\n',
    'Linked/Proof.lean': 'import Linked.Helper\nexample : True := by trivial\n',
    'README.md': '[Notes](Linked/Notes.md)\n',
  }
  for (const [filename, content] of Object.entries(sources))
    await studio.workspaces.writeFile(
      project.id,
      admin.id,
      filename,
      content,
      null,
    )
  await studio.workspaces.createFolder(project.id, admin.id, {
    path: 'Archive',
  })

  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  })
  for (const account of accounts) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    })
    const login = await context.request.post(origin + '/api/login', {
      data: { token: account.token },
    })
    assert.equal(login.status(), 200)
    await context.addInitScript(
      ({ id }) => {
        localStorage.setItem('lemex-project', id)
        localStorage.setItem(`lemex-file-${id}`, 'Linked/Notes.md')
        localStorage.setItem('lemex-theme', 'dark')
      },
      { id: project.id },
    )
    const page = await context.newPage()
    page.on('pageerror', (error) =>
      report.browserErrors.push(error.stack || error.message),
    )
    await page.goto(origin)
    await page
      .locator('.monaco-editor textarea')
      .first()
      .waitFor({ timeout: 30_000 })
    await page.locator('.editor-loading').waitFor({ state: 'hidden' })
    await until(
      async () =>
        (await page.locator('.file-tab').innerText()).includes('Notes.md'),
      'shared Markdown editor',
    )
    pages.push({ page, account })
  }
  const [mover, peer] = pages
  await until(
    () =>
      [...studio.projectDocuments.documents.values()].some(
        (record) =>
          record.path === 'Linked/Notes.md' && record.clients.size === 2,
      ),
    'both real shared document subscriptions',
  )
  report.checks.push(
    'Two authenticated Editor accounts open the same real saved document through the browser and shared WebSocket service.',
  )

  const marker = 'PEER_DRAFT_DURING_REAL_MOVE'
  let finishWrite
  const gate = new Promise((resolve) => {
    releaseWrite = resolve
  })
  heldFinished = new Promise((resolve) => {
    finishWrite = resolve
  })
  const write = studio.workspaces.writeFile.bind(studio.workspaces)
  studio.workspaces.writeFile = async (...args) => {
    const [id, actor, filename, content] = args
    const pause =
      !writeHeld &&
      id === project.id &&
      actor === peer.account.id &&
      filename === 'Linked/Notes.md' &&
      content.includes(marker)
    if (pause) {
      writeHeld = true
      await gate
    }
    try {
      return await write(...args)
    } catch (error) {
      if (pause) report.staleWriteRejected = error.status === 409
      throw error
    } finally {
      if (pause) finishWrite()
    }
  }
  const type = async (page, value) => {
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press(editorShortcuts.documentEnd)
    await page.keyboard.insertText(value)
  }
  await type(peer.page, '\n' + marker + '\n')
  await until(() => writeHeld, 'the real peer write to enter', 10_000)

  await mover.page
    .locator('.folder-toggle')
    .and(mover.page.getByTitle('Linked', { exact: true }))
    .click({ button: 'right' })
  await mover.page
    .getByRole('menuitem', { name: 'Move to folder…', exact: true })
    .click()
  const dialog = mover.page.getByRole('dialog', {
    name: 'Move folder',
    exact: true,
  })
  await dialog
    .getByLabel('Destination folder', { exact: true })
    .selectOption('Archive')
  await dialog.getByLabel('Name', { exact: true }).fill('Renamed')
  assert.equal(
    await dialog
      .getByLabel('Update imports and file links', { exact: true })
      .isChecked(),
    true,
  )
  const receipt = mover.page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/projects/${project.id}/move`) &&
      response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: 'Move folder', exact: true }).click()
  const response = await receipt
  const moved = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(moved))
  assert.equal(moved.to, 'Archive/Renamed')
  assert(moved.references.updatedPaths.includes('Archive/Renamed/Notes.md'))
  assert(moved.references.updatedPaths.includes('Archive/Renamed/Proof.lean'))
  await dialog.waitFor({ state: 'hidden' })
  releaseWrite()
  if (writeHeld) await heldFinished
  assert.equal(report.staleWriteRejected, true)
  const source = async (filename) => {
    const response = await request(
      admin,
      `/api/projects/${project.id}/file?path=${encodeURIComponent(filename)}`,
    )
    assert.equal(response.status, 200)
    return (await response.json()).content
  }
  const savedPath = 'Archive/Renamed/Notes.md'
  await until(async () => {
    const content = await source(savedPath)
    return (
      content.includes(marker) && content.includes('](../../assets/Figure.svg)')
    )
  }, 'the real move to save the pending draft and rewritten relative link')
  const editorText = (page) =>
    page.locator('.monaco-editor .view-lines').first().innerText()
  for (const { page } of pages)
    await until(async () => {
      const content = await editorText(page)
      return (
        content.includes(marker) && content.includes('../../assets/Figure.svg')
      )
    }, 'both real editors to show the merged moved document')
  assert.match(
    await source('Archive/Renamed/Proof.lean'),
    /import Archive\.Renamed\.Helper/,
  )
  assert.equal(await source('README.md'), '[Notes](Archive/Renamed/Notes.md)\n')
  await assert.rejects(fs.stat(path.join(project.root, 'Linked')), {
    code: 'ENOENT',
  })
  report.checks.push(
    'The real sidebar move renames a shared folder, rewrites its links and Lean imports, rejects a held old-path write, and saves the peer draft at the destination.',
  )

  await type(mover.page, '\nEDITOR_A_AFTER_MOVE\n')
  await until(
    async () => (await source(savedPath)).includes('EDITOR_A_AFTER_MOVE'),
    'editor A to keep saving after the move',
  )
  await type(peer.page, '\nEDITOR_B_AFTER_MOVE\n')
  await until(async () => {
    const saved = await source(savedPath)
    return (
      saved.includes('EDITOR_A_AFTER_MOVE') &&
      saved.includes('EDITOR_B_AFTER_MOVE')
    )
  }, 'both editors to keep saving after the move')
  for (const { page } of pages) {
    await until(async () => {
      const content = await editorText(page)
      return (
        content.includes('EDITOR_A_AFTER_MOVE') &&
        content.includes('EDITOR_B_AFTER_MOVE')
      )
    }, 'both editors to converge after further typing')
    const alerts = await page.locator('[role="alert"]').allTextContents()
    assert(
      !alerts.some((message) =>
        /changed while disconnected|overlap your typing|could not be saved/.test(
          message,
        ),
      ),
      JSON.stringify(alerts),
    )
  }
  report.checks.push(
    'Both real React editors continue editing and converge after the move without a blocked-save warning.',
  )
  assert.equal(
    report.browserErrors.length,
    0,
    JSON.stringify(report.browserErrors),
  )
  assert.equal(report.providerCalls, 0)
  report.references = moved.references
  report.passed = true
} catch (error) {
  report.error = error.stack || String(error)
  for (const [index, { page }] of pages.entries())
    await page
      .screenshot({ path: path.join(output, `failure-${index + 1}.png`) })
      .catch(() => {})
  throw error
} finally {
  releaseWrite?.()
  if (writeHeld) await heldFinished
  const cleanupErrors = []
  for (const [label, close] of [
    ['browser', () => browser?.close()],
    ['server', () => studio?.close()],
  ]) {
    try {
      await close()
    } catch (error) {
      cleanupErrors.push(`${label}: ${error.message || error}`)
    }
  }
  if (!cleanupErrors.length) {
    try {
      await fs.rm(dataDir, { recursive: true, force: true })
      report.cleanupComplete = true
    } catch (error) {
      cleanupErrors.push(`fixture data: ${error.message || error}`)
    }
  }
  globalThis.fetch = fetchOriginal
  if (cleanupErrors.length) {
    report.passed = false
    report.cleanupErrors = cleanupErrors
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
  if (cleanupErrors.length) process.exitCode = 1
}
