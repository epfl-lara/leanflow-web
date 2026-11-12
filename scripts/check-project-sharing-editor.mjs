#!/usr/bin/env node
// Real shared edits with a fixture-only admission point into the editor queue.
// The shipped bundle and installed dependencies are never modified.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { createSharingLiveFixture } from './lib/sharing-live-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const directory = path.resolve('.runtime/sharing-editor-review')
await fs.mkdir(directory, { recursive: true })
const report = { checks: [], errors: [], providerCalls: 0, passed: false }
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out: ${label}`)
}
let fixture, browser
try {
  fixture = await createSharingLiveFixture()
  const initial = await fixture.studio.workspaces.readFile(
    fixture.project.id,
    fixture.accounts.admin.id,
    'Main.lean',
  )
  await fixture.studio.workspaces.writeFile(
    fixture.project.id,
    fixture.accounts.admin.id,
    'Main.lean',
    Array.from(
      { length: 160 },
      (_, index) => `-- baseline line ${index}\n`,
    ).join('') + 'example : True := by trivial\n',
    initial.hash,
  )
  browser = await chromium.launch({ headless: true })
  const pages = {}
  const makePage = async (actor, queueFixture = false) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => report.errors.push(error.message))
    page.on('request', (request) => {
      if (request.url().startsWith('https://provider.example/'))
        report.providerCalls++
    })
    if (queueFixture)
      await page.route('**/assets/index-*.js', async (route) => {
        const response = await route.fetch()
        let body = await response.text()
        if (
          !body.includes(
            '[LeanFlow Web] Could not finish closing the Lean editor.',
          )
        )
          return route.fulfill({ response, body })
        // Checked transform of LeanWorkspace's actual serialize() function.
        // Only this isolated browser can deliberately hold the existing queue.
        const pattern =
          /function ([\w$]+)\(([\w$]+)\)\{const ([\w$]+)=([\w$]+)\.then\(\2\);return \4=\3\.catch\(\(\)=>\{\}\),\3\}/g
        const matches = [...body.matchAll(pattern)]
        assert.equal(
          matches.length,
          1,
          'Review the editor queue fixture transform',
        )
        const budget =
          'maxComputationTimeMs:200,maxOperations:2e6,maxTokens:3e5'
        assert.equal(
          body.split(budget).length,
          2,
          'Review the live diff budget fixture transform',
        )
        body = body.replace(
          budget,
          'maxComputationTimeMs:200,maxOperations:2e6,maxTokens:64',
        )
        body += `\nglobalThis.__sharingEditorQueue=${matches[0][1]};\n`
        await route.fulfill({ response, body })
      })
    const login = await context.request.post(fixture.origin + '/api/login', {
      data: { token: fixture.accounts[actor].token },
      headers: { Origin: fixture.origin },
    })
    assert.equal(login.status(), 200)
    await page.goto(fixture.origin)
    await page
      .locator('.project-item')
      .filter({ hasText: fixture.project.name })
      .click()
    await page.locator('.monaco-editor textarea').first().waitFor()
    await page.locator('.editor-loading').waitFor({ state: 'hidden' })
    pages[actor] = page
    return page
  }
  const a = await makePage('editorA')
  const b = await makePage('editorB', true)
  const source = () =>
    fixture.studio.workspaces.readFile(
      fixture.project.id,
      fixture.accounts.admin.id,
      'Main.lean',
    )
  const append = async (page, content) => {
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press(editorShortcuts.documentEnd)
    await page.keyboard.insertText(content)
  }
  await until(
    () => fixture.studio.projectDocuments.clients.size === 2,
    'two shared sessions',
  )
  await b.evaluate(() => {
    window.__sharingQueueStarted = false
    window.__sharingEditorQueue(
      () =>
        new Promise((resolve) => {
          window.__releaseSharingQueue = resolve
          window.__sharingQueueStarted = true
        }),
    )
  })
  await until(
    () => b.evaluate(() => window.__sharingQueueStarted),
    'editor lifecycle queue held',
  )
  await append(a, '-- REMOTE_WHILE_QUEUE_BUSY\n')
  await until(
    async () => (await source()).content.includes('REMOTE_WHILE_QUEUE_BUSY'),
    'remote edit saved',
  )
  // Let the authenticated websocket deliver its remote update while unrelated
  // Lean lifecycle work is still held, then type before releasing that work.
  await new Promise((resolve) => setTimeout(resolve, 150))
  await append(b, '-- LOCAL_WHILE_QUEUE_BUSY\n')
  await new Promise((resolve) => setTimeout(resolve, 150))
  await b.evaluate(() => window.__releaseSharingQueue())
  await until(
    async () => (await source()).content.includes('LOCAL_WHILE_QUEUE_BUSY'),
    'local edit saved',
  )
  const saved = (await source()).content
  assert(
    saved.includes('REMOTE_WHILE_QUEUE_BUSY'),
    'A local keystroke must preserve text delivered while the Lean lifecycle queue is busy',
  )
  await until(
    async () =>
      (await b.locator('.monaco-editor .view-lines').innerText()).includes(
        'REMOTE_WHILE_QUEUE_BUSY',
      ),
    'editor receives remote text',
  )
  report.checks.push(
    'Remote text survives local typing while an unrelated Lean lifecycle task is deliberately held',
  )
  const beforePaste = (await source()).content
  const pasted =
    '-- replaced first line\n' +
    beforePaste.split('\n').slice(1).join('\n') +
    '-- replaced last line\n'
  await b.locator('.monaco-editor textarea').first().focus()
  await b.keyboard.press('ControlOrMeta+a')
  await b.keyboard.insertText(pasted)
  await b
    .getByText(
      'Main.lean uses normal version-checked saving because this edit is too complex to merge live. Switch to another project and back, or reload this page to retry live editing.',
      { exact: true },
    )
    .waitFor()
  await until(
    async () => (await source()).content === pasted,
    'complex edit saved through ordinary file transactions',
  )
  await b.keyboard.press('ControlOrMeta+z')
  await until(
    async () => (await source()).content === beforePaste,
    'fallback undo saved without removing earlier remote edits',
  )
  await b.keyboard.press('ControlOrMeta+Shift+z')
  await until(
    async () => (await source()).content === pasted,
    'fallback redo saved',
  )
  report.checks.push(
    'A complex-edit fallback keeps private Undo and Redo across ordinary saves and preserves previously received remote text',
  )
  assert.deepEqual(report.errors, [])
  assert.equal(report.providerCalls, 0)
  report.passed = true
} catch (error) {
  report.failure = error.stack || String(error)
  throw error
} finally {
  await browser?.close()
  await fixture?.close()
  await fs.writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report))
