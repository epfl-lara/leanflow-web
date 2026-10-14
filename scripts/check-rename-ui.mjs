#!/usr/bin/env node
// Exercise real F2 rename, saving and Lean compilation in an isolated studio.
// No user projects, live service, provider credentials or model calls are used.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import { Runtime } from '../server/runtime.mjs'
import { createStudio } from '../server/studio.mjs'
import { sleep, until } from './lib/chat-browser-fixture.mjs'

const directory = path.resolve('.runtime/rename-ui', randomUUID())
const dataDir = path.join(directory, 'data')
await fs.mkdir(directory, { recursive: true })
const toolchain = 'leanprover/lean4:v4.33.0'
const source = `namespace RenameFixture
structure Cell where
  value : Nat := 0
namespace Cell
def blank : Cell := {}
end Cell
namespace Screen
def blank : Cell := Cell.blank
def sample : Cell := Cell.blank
end Screen
inductive Mode where
  | empty
  | full
def mode : Mode := .empty
def explicitMode : Mode := Mode.empty
def modeValue : Mode → Nat
  | .empty => 0
  | .full => 1
end RenameFixture
`
const qualifiedExpected = source
  .replace('def blank : Cell := {}', 'def blankC : Cell := {}')
  .replaceAll('Cell.blank', 'Cell.blankC')
const referenceExpected = qualifiedExpected.replaceAll('blankC', 'blankD')
const qualifiedInputExpected = referenceExpected.replaceAll('blankD', 'blankE')
const expected = qualifiedInputExpected
  .replace('  | empty\n', '  | vacant\n')
  .replaceAll('.empty', '.vacant')
const report = {
  directory,
  toolchain,
  providerCalls: 0,
  checks: [],
  passed: false,
}
const runtime = new Runtime({ dataDir, scope: 'helper', cpus: 1, memory: '2g' })
let studio, browser, page
const leanMessages = []
try {
  studio = await createStudio({
    dataDir,
    runtime,
    config: {
      defaultModel: 'offline-fixture',
      models: [],
      provider: {},
      redact: String,
      lemex: {},
    },
  })
  assert.equal(runtime.ready, true, runtime.error)
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${studio.server.address().port}`
  let project = await studio.workspaces.create('owner', {
    name: 'Rename regression',
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: toolchain + '\n' },
      {
        path: 'lakefile.toml',
        content:
          'name = "rename_fixture"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n',
      },
      { path: 'Main.lean', content: source },
    ],
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  })
  const signedIn = await context.request.post(base + '/api/login', {
    data: { token },
  })
  assert(signedIn.ok(), 'Disposable studio sign-in failed')
  await context.addInitScript(
    ({ id }) => {
      if (!localStorage.getItem('lemex-project'))
        localStorage.setItem('lemex-project', id)
      localStorage.setItem(`lemex-file-${id}`, 'Main.lean')
    },
    { id: project.id },
  )
  page = await context.newPage()
  page.on('websocket', (socket) =>
    socket.on('framereceived', (event) => {
      try {
        leanMessages.push(JSON.parse(String(event.payload)))
      } catch {}
    }),
  )
  await page.goto(base)
  const editor = page.locator('.monaco-editor textarea').first()
  await editor.waitFor({ state: 'visible', timeout: 60000 })
  await until(
    () =>
      leanMessages.some(
        (message) => message.method === 'textDocument/publishDiagnostics',
      ),
    'real Lean diagnostics',
    60000,
  )
  async function rename(
    needle,
    oldName,
    newName,
    expectedSource,
    contextMenu = false,
    rejection = '',
  ) {
    const lines = (
      await studio.workspaces.readFile(project.id, 'owner', 'Main.lean')
    ).content.split('\n')
    const targetLine = lines.findIndex((line) => line.includes(needle))
    assert(targetLine >= 0)
    await editor.focus()
    await page.keyboard.press('Control+Home')
    for (let line = 0; line < targetLine; line++)
      await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    for (
      let column = 0;
      column < lines[targetLine].indexOf(oldName) + 1;
      column++
    )
      await page.keyboard.press('ArrowRight')
    const input = page.locator('.rename-box input').first()
    // Lean's reference index can finish after its first diagnostics notification.
    await until(
      async () => {
        await editor.focus()
        if (contextMenu) {
          await page.keyboard.press('Shift+F10')
          await page.getByRole('menuitem', { name: /Rename Symbol/ }).hover()
          await page.keyboard.press('Enter')
        } else await page.keyboard.press('F2')
        await sleep(300)
        return input.isVisible()
      },
      'Lean rename reference index',
      30000,
    )
    assert.equal(
      await input.inputValue(),
      oldName,
      'The rename box should offer only the identifier being changed',
    )
    await input.fill(newName)
    await input.press('Enter')
    const save = page.getByRole('button', { name: 'Save', exact: true })
    if (rejection) {
      const notice = page.getByRole('alert').filter({ hasText: rejection })
      await notice.waitFor({ state: 'visible' })
      assert.equal(await save.isEnabled(), false)
      assert.equal(
        (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean'))
          .content,
        expectedSource,
      )
      await notice.getByRole('button', { name: 'Dismiss', exact: true }).click()
      return
    }
    await until(() => save.isEnabled(), 'renamed editor buffer')
    await save.click()
    await until(
      async () =>
        (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean'))
          .content === expectedSource,
      'saved rename',
    )
  }
  await rename('def blank : Cell := {}', 'blank', 'blankC', qualifiedExpected)
  report.checks.push(
    'F2 on the declaration preserves Cell. on both references; Save writes the expected source.',
  )
  await rename('def sample', 'blankC', 'blankD', referenceExpected, true)
  report.checks.push(
    'Context-menu Rename Symbol on a qualified reference offers the leaf name and updates its declaration without changing namespaces.',
  )
  await rename('def sample', 'blankD', 'Cell.blankE', qualifiedInputExpected)
  report.checks.push(
    'Entering a qualifier copied from a reference changes only the declaration’s final name.',
  )
  await rename('def mode :', 'empty', 'vacant', expected)
  report.checks.push(
    'F2 on a constructor retains leading dots in expressions and match patterns, and preserves qualified Mode. references.',
  )
  await rename(
    'def sample',
    'blankE',
    'Other.blankF',
    expected,
    false,
    'Enter only the final identifier name, without a new namespace.',
  )
  report.checks.push(
    'Unsupported namespace changes show an actionable error and leave the editor and saved file unchanged.',
  )
  const checkResponse = await context.request.post(
    `${base}/api/projects/${project.id}/check`,
    { data: { path: 'Main.lean' } },
  )
  assert(checkResponse.ok())
  const check = await checkResponse.json()
  await until(
    () =>
      ['completed', 'failed'].includes(
        studio.events.getMetadata(check.id).status,
      ),
    'renamed project build',
    60000,
  )
  const checked = studio.events.getMetadata(check.id)
  assert.equal(checked.status, 'completed', checked.log || checked.error)
  report.checks.push(
    'The renamed project and selected file compile with the pinned Lean 4.33 release.',
  )
  const mark = leanMessages.length
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('-- refreshed\n')
  await until(
    () =>
      leanMessages
        .slice(mark)
        .some(
          (message) => message.method === 'textDocument/publishDiagnostics',
        ),
    'fresh diagnostics after rename',
    30000,
  )
  const diagnostics = leanMessages
    .filter((message) => message.method === 'textDocument/publishDiagnostics')
    .at(-1)
  assert(
    !diagnostics.params.diagnostics.some((item) => item.severity === 1),
    JSON.stringify(diagnostics),
  )
  report.checks.push(
    'The live editor reports no Lean errors after the rename and a subsequent unsaved edit.',
  )
  const otherSource =
    'import Main\ndef otherUse : RenameFixture.Cell := RenameFixture.Cell.blank\n'
  project = await studio.workspaces.create('owner', {
    name: 'Multi-file rename safety',
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: toolchain + '\n' },
      {
        path: 'lakefile.toml',
        content:
          'name = "rename_multi"\ndefaultTargets = ["Main", "Use"]\n[[lean_lib]]\nname = "Main"\n[[lean_lib]]\nname = "Use"\n',
      },
      { path: 'Main.lean', content: source },
      { path: 'Use.lean', content: otherSource },
    ],
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  await page.evaluate((id) => {
    localStorage.setItem('lemex-project', id)
    localStorage.setItem(`lemex-file-${id}`, 'Main.lean')
  }, project.id)
  await page.reload()
  await editor.waitFor({ state: 'visible', timeout: 60000 })
  await rename(
    'def blank : Cell := {}',
    'blank',
    'blankC',
    source,
    false,
    'This rename affects multiple files.',
  )
  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Use.lean')).content,
    otherSource,
  )
  report.checks.push(
    'A real multi-file rename is rejected before any buffer or saved source changes, with a visible explanation.',
  )
  await page.screenshot({ path: path.join(directory, 'renamed.png') })
  report.passed = true
} catch (error) {
  report.error = error.stack
  await page
    ?.screenshot({ path: path.join(directory, 'failure.png') })
    .catch(() => {})
  process.exitCode = 1
} finally {
  await browser?.close()
  await studio?.close()
  await fs.writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await fs.writeFile(
    path.join(directory, 'lsp-messages.json'),
    JSON.stringify(leanMessages, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report, null, 2))
