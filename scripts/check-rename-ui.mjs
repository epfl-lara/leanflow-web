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
const clientMessages = []
const browserErrors = []
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
  page.on('pageerror', (error) => browserErrors.push(String(error.stack)))
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type()))
      browserErrors.push(message.text())
  })
  page.on('websocket', (socket) => {
    socket.on('framereceived', (event) => {
      try {
        leanMessages.push(JSON.parse(String(event.payload)))
      } catch {}
    })
    socket.on('framesent', (event) => {
      try {
        clientMessages.push({
          url: socket.url(),
          message: JSON.parse(String(event.payload)),
        })
      } catch {}
    })
  })
  await page.goto(base)
  const editor = page.locator('.monaco-editor textarea').first()
  async function saveAndWait(button, batch = false) {
    const response = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname ===
          `/api/projects/${project.id}/${batch ? 'files' : 'file'}`,
    )
    await button.click()
    const saved = await response
    assert.equal(saved.status(), 200, await saved.text())
  }
  await editor.waitFor({ state: 'visible', timeout: 60000 })
  await until(
    () =>
      leanMessages.some(
        (message) => message.method === 'textDocument/publishDiagnostics',
      ),
    'real Lean diagnostics',
    60000,
  )
  async function placeSymbolCursor(needle, oldName, filePath = 'Main.lean') {
    const lines = (
      await studio.workspaces.readFile(project.id, 'owner', filePath)
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
  }
  async function startRename(
    needle,
    oldName,
    newName,
    contextMenu = false,
    filePath = 'Main.lean',
  ) {
    await placeSymbolCursor(needle, oldName, filePath)
    const input = page.locator('.rename-box input').first()
    // Lean's reference index can finish after its first diagnostics notification.
    await until(
      async () => {
        await editor.focus()
        await page.keyboard.press('Escape')
        if (contextMenu) {
          await page.keyboard.press('Shift+F10')
          const action = page.getByRole('menuitem', { name: /Rename Symbol/ })
          if (!(await action.isVisible())) {
            await page.keyboard.press('Escape')
            return false
          }
          await action.hover()
          await page.keyboard.press('Enter')
        } else await page.keyboard.press('F2')
        await sleep(300)
        if (!(await input.isVisible())) return false
        if ((await input.inputValue()) === oldName) return true
        await input.press('Escape')
        return false
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
  }
  async function rename(
    needle,
    oldName,
    newName,
    expectedSource,
    contextMenu = false,
    rejection = '',
  ) {
    await startRename(needle, oldName, newName, contextMenu)
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
    await saveAndWait(save)
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
  await saveAndWait(page.getByRole('button', { name: 'Save', exact: true }))
  let otherSource =
    'import Main\nimport Use.Extra\ndef otherUse : RenameFixture.Cell := RenameFixture.Cell.blank\n'
  let nestedSource =
    'import Main\nnamespace Nested\ndef nestedUse : RenameFixture.Cell := _root_.RenameFixture.Cell.blank\nend Nested\n'
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
      { path: 'Use/Extra.lean', content: nestedSource },
    ],
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  await page.evaluate((id) => {
    localStorage.setItem('lemex-project', id)
    localStorage.setItem(`lemex-file-${id}`, 'Main.lean')
  }, project.id)
  const projectMark = leanMessages.length
  await page.reload()
  await editor.waitFor({ state: 'visible', timeout: 60000 })
  await until(
    () =>
      leanMessages
        .slice(projectMark)
        .some(
          (message) => message.method === 'textDocument/publishDiagnostics',
        ),
    'multi-file Lean diagnostics',
    60000,
  )
  const beforeShift = await studio.workspaces.readFile(
    project.id,
    'owner',
    'Use.lean',
  )
  otherSource = '-- inserted after the editor connected\n' + otherSource
  await studio.workspaces.writeFile(
    project.id,
    'owner',
    'Use.lean',
    otherSource,
    beforeShift.hash,
  )
  await placeSymbolCursor('def blank : Cell := {}', 'blank')
  await page.keyboard.press('F2')
  await page
    .getByRole('alert')
    .filter({ hasText: /Use.lean.*Check Project/ })
    .first()
    .waitFor()
  assert.equal(
    await page.locator('.rename-box input').first().isVisible(),
    false,
  )
  const indexed = await context.request.post(
    `${base}/api/projects/${project.id}/check`,
    { data: { path: 'Main.lean' } },
  )
  assert(indexed.ok())
  const indexedJob = await indexed.json()
  await until(
    () =>
      ['completed', 'failed'].includes(
        studio.events.getMetadata(indexedJob.id).status,
      ),
    'rebuild shifted module',
    60000,
  )
  assert.equal(
    studio.events.getMetadata(indexedJob.id).status,
    'completed',
    studio.events.getMetadata(indexedJob.id).log,
  )
  report.checks.push(
    'An unopened module shifted after connection is rejected safely; rebuilding refreshes its real Lean index without reconnecting.',
  )
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('-- preserve my unsaved note\n')
  await startRename('def blank : Cell := {}', 'blank', 'blankC', true)
  const saveAll = page.getByRole('button', {
    name: 'Save all (3)',
    exact: true,
  })
  await until(() => saveAll.isEnabled(), 'all three renamed buffers')
  assert(await page.locator('.file-item[title="Use.lean"] .dirty-dot').count())
  await page
    .getByRole('button', { name: 'Move file Main.lean to trash', exact: true })
    .click()
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await page
    .getByRole('alert')
    .filter({ hasText: /Save or discard unsaved changes/ })
    .waitFor()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert(await saveAll.isEnabled())
  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean'))
      .content,
    source,
  )
  report.checks.push(
    'Deleting a staged file is blocked without dropping edits in other files, and every staged file is marked in the file tree.',
  )
  await editor.focus()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await until(
    () => saveAll.count().then((count) => !count),
    'workspace rename undo',
  )
  assert(
    await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(),
  )
  await page.keyboard.press('Control+Shift+z')
  await until(() => saveAll.isEnabled(), 'workspace rename redo')
  await page.locator('.file-item[title="Use.lean"]').click()
  await until(
    () =>
      page
        .locator('.monaco-editor')
        .first()
        .innerText()
        .then((text) => text.includes('Cell.blankC')),
    'inspect renamed reference buffer',
  )
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.locator('.file-item[title="Main.lean"]').click()
  await until(
    () =>
      page
        .locator('.monaco-editor')
        .first()
        .innerText()
        .then((text) =>
          text.replaceAll('\u00a0', ' ').includes('namespace RenameFixture'),
        ),
    'return to definition file',
  )
  await editor.focus()
  await page.keyboard.press('Control+End')
  await until(
    () =>
      page
        .locator('.monaco-editor')
        .first()
        .innerText()
        .then((text) =>
          text.replaceAll('\u00a0', ' ').includes('preserve my unsaved note'),
        ),
    'unsaved note retained across files',
  )
  await editor.focus()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await until(
    () => saveAll.count().then((count) => !count),
    'workspace undo after visiting other files',
  )
  await page.keyboard.press('Control+Shift+z')
  await until(
    () => saveAll.isEnabled(),
    'workspace redo after visiting other files',
  )

  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean'))
      .content,
    source,
  )
  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Use.lean')).content,
    otherSource,
  )
  const nestedBefore = await studio.workspaces.readFile(
    project.id,
    'owner',
    'Use/Extra.lean',
  )
  await studio.workspaces.writeFile(
    project.id,
    'owner',
    'Use/Extra.lean',
    nestedSource + '-- external edit\n',
    nestedBefore.hash,
  )
  await saveAll.click()
  await page
    .getByRole('alert')
    .filter({ hasText: /changed since it was opened/ })
    .waitFor()
  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean'))
      .content,
    source,
  )
  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Use.lean')).content,
    otherSource,
  )
  assert(await saveAll.isEnabled())
  const folder = page.locator('.folder-toggle[title="Use"]')
  if ((await folder.getAttribute('aria-expanded')) !== 'true')
    await folder.click()
  await page.locator('.file-item[title="Use/Extra.lean"]').click()
  await page.getByRole('button', { name: 'Reload file', exact: true }).click()
  await page
    .getByRole('button', { name: 'Reload this file', exact: true })
    .click()
  await until(
    () =>
      page
        .getByRole('button', { name: 'Save all (2)', exact: true })
        .isEnabled(),
    'reload preserves sibling drafts',
  )
  await until(
    () =>
      page
        .locator('.monaco-editor')
        .first()
        .innerText()
        .then((text) =>
          text.replaceAll('\u00a0', ' ').includes('external edit'),
        ),
    'new saved content loaded for only this file',
  )
  nestedSource += '-- external edit\n'
  await editor.focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(
    nestedSource.replaceAll('Cell.blank', 'Cell.blankC'),
  )
  await until(() => saveAll.isEnabled(), 'merged external file draft')
  await page.locator('.file-item[title="Main.lean"]').click()
  await until(
    () =>
      page
        .locator('.monaco-editor')
        .first()
        .innerText()
        .then((text) => text.includes('blankC')),
    'sibling rename retained after targeted reload',
  )
  report.checks.push(
    'Per-file reload resolves a last-file conflict, preserves both sibling drafts and the external edit, and permits one atomic Save all.',
  )

  await saveAndWait(saveAll, true)
  await until(
    async () =>
      (await studio.workspaces.readFile(project.id, 'owner', 'Use.lean'))
        .content === otherSource.replaceAll('Cell.blank', 'Cell.blankC'),
    'saved cross-file references',
  )
  const multiExpected = qualifiedExpected + '-- preserve my unsaved note\n'
  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean'))
      .content,
    multiExpected,
  )
  assert.equal(
    (await studio.workspaces.readFile(project.id, 'owner', 'Use/Extra.lean'))
      .content,
    nestedSource.replaceAll('Cell.blank', 'Cell.blankC'),
  )
  report.checks.push(
    'Context-menu rename updates three files, including unvisited nested modules, and one Save commits them together while retaining unsaved user edits.',
    'Native workspace undo and redo cover every renamed file; inspecting another staged file preserves the original unsaved note.',
    'A concurrent change in the last file rejects the entire Save and keeps all three browser buffers for recovery.',
  )
  const multiCheck = await context.request.post(
    `${base}/api/projects/${project.id}/check`,
    { data: { path: 'Main.lean' } },
  )
  assert(multiCheck.ok())
  const multiJob = await multiCheck.json()
  await until(
    () =>
      ['completed', 'failed'].includes(
        studio.events.getMetadata(multiJob.id).status,
      ),
    'multi-file renamed project build',
    60000,
  )
  assert.equal(
    studio.events.getMetadata(multiJob.id).status,
    'completed',
    studio.events.getMetadata(multiJob.id).error,
  )
  report.checks.push(
    'The project with three renamed modules compiles using the pinned Lean release.',
  )
  const readFile = studio.workspaces.readFile.bind(studio.workspaces)
  let heldRead = false,
    releaseRead
  const gate = new Promise((resolve) => {
    releaseRead = resolve
  })
  studio.workspaces.readFile = async (...args) => {
    if (args[2] === 'Use/Extra.lean') {
      heldRead = true
      await gate
    }
    return readFile(...args)
  }
  const cancelMark = clientMessages.length
  try {
    await startRename('def blankC : Cell := {}', 'blankC', 'cancelledName')
    await until(() => heldRead, 'rename awaiting another source')
    await editor.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('-- typed during pending rename\n')
  } finally {
    studio.workspaces.readFile = readFile
    releaseRead()
  }
  await until(
    () =>
      clientMessages
        .slice(cancelMark)
        .some(({ message }) => message.method === '$/cancelRequest'),
    'native rename cancellation',
  )
  await saveAndWait(page.getByRole('button', { name: 'Save', exact: true }))
  await until(
    async () =>
      (await readFile(project.id, 'owner', 'Main.lean')).content ===
      multiExpected + '-- typed during pending rename\n',
    'typing preserved after rename cancellation',
  )
  assert.equal(
    (await readFile(project.id, 'owner', 'Use.lean')).content,
    otherSource.replaceAll('Cell.blank', 'Cell.blankC'),
  )
  const latestCheck = await context.request.post(
    `${base}/api/projects/${project.id}/check`,
    { data: { path: 'Main.lean' } },
  )
  assert(latestCheck.ok())
  const latestJob = await latestCheck.json()
  await until(
    () =>
      ['completed', 'failed'].includes(
        studio.events.getMetadata(latestJob.id).status,
      ),
    'compile latest saved sources',
    60000,
  )
  assert.equal(
    studio.events.getMetadata(latestJob.id).status,
    'completed',
    studio.events.getMetadata(latestJob.id).log,
  )
  await page.locator('.file-item[title="Use.lean"]').click()
  await until(
    () =>
      page
        .locator('.monaco-editor')
        .first()
        .innerText()
        .then((text) => text.includes('otherUse')),
    'reference file ready',
  )
  await startRename('def otherUse', 'blankC', 'blankD', true, 'Use.lean')
  await until(() => saveAll.isEnabled(), 'rename initiated from another module')
  await page.locator('.file-item[title="lakefile.toml"]').click()
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
  await until(
    () =>
      page
        .getByRole('dialog')
        .count()
        .then((count) => !count),
    'discard all affected buffers',
  )
  assert.equal(await saveAll.count(), 0)
  await page.locator('.file-item[title="Use.lean"]').click()
  await until(
    () =>
      page
        .locator('.monaco-editor')
        .first()
        .innerText()
        .then((text) => text.includes('Cell.blankC')),
    'discarded reference restored',
  )
  assert(
    await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
  )
  report.checks.push(
    'Typing while a multi-file rename is waiting cancels it without losing the new text or changing other files; Discard resets every staged buffer.',
  )
  const oldId = project.id
  const switchMark = clientMessages.length
  await page.locator('.project-item[title="Rename regression"]').click()
  await until(
    () =>
      clientMessages
        .slice(switchMark)
        .some(
          ({ url, message }) =>
            !url.endsWith(oldId) &&
            message.method === 'textDocument/didOpen' &&
            message.params.textDocument.text.includes('-- refreshed'),
        ),
    'original project reconnected',
  )
  assert(
    !clientMessages
      .slice(switchMark)
      .some(
        ({ url, message }) =>
          !url.endsWith(oldId) &&
          message.method === 'textDocument/didOpen' &&
          /\/Use(?:\/|\.lean)/.test(message.params.textDocument.uri),
      ),
    'Other projects must not receive hidden rename models',
  )
  report.checks.push(
    'Switching projects disposes hidden rename models before the next Lean connection starts.',
  )
  const openBySocket = new Map()
  let peakOpenFiles = 0
  for (const { url, message } of clientMessages) {
    let opened = openBySocket.get(url)
    if (!opened) {
      opened = new Set()
      openBySocket.set(url, opened)
    }
    if (message.method === 'textDocument/didOpen')
      opened.add(message.params.textDocument.uri)
    if (message.method === 'textDocument/didClose')
      opened.delete(message.params.textDocument.uri)
    peakOpenFiles = Math.max(peakOpenFiles, opened.size)
  }
  assert.equal(
    peakOpenFiles,
    1,
    'Hidden rename buffers must not open Lean workers',
  )
  report.peakOpenLeanFiles = peakOpenFiles
  report.checks.push(
    'Only the visible file is open in Lean throughout multi-file rename, undo, inspection, saves, and project switches.',
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
  report.browserErrors = browserErrors
  await browser?.close()
  await studio?.close()
  await fs.writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await fs.writeFile(
    path.join(directory, 'client-messages.json'),
    JSON.stringify(clientMessages, null, 2) + '\n',
  )
  await fs.writeFile(
    path.join(directory, 'lsp-messages.json'),
    JSON.stringify(leanMessages, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report, null, 2))
