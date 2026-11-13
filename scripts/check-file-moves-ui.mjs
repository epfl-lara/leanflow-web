#!/usr/bin/env node
// Exercise sidebar rename/move and real editor buffers against isolated APIs.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const output = path.resolve('.runtime/file-moves-ui')
await fs.mkdir(output, { recursive: true })
const app = express()
app.use(express.static(path.resolve('client/dist')))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`
const projectId = 'file-moves-fixture'
let fixture
try {
  fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: 'file-moves-owner', name: 'Fixture' },
      templates: [],
      models: [{ id: 'fixture-model', name: 'Fixture model' }],
      defaultModel: 'fixture-model',
      runtime: { ready: true },
      lemex: { configured: true },
    },
    projects: [{ id: projectId, name: 'File moves fixture', status: 'ready' }],
    files: {
      [projectId]: {
        'Main.lean': 'example : True := by trivial\n',
        'lakefile.toml': 'name = "file_moves_fixture"\n',
        'Notes.lean': '-- Existing file must be kept\n',
        'Destination/Keep.lean': '-- Destination fixture\n',
        'Nested/Child.lean':
          '-- Nested fixture\nexample : True := by trivial\n',
        'figures/diagram.svg': '<svg><!-- source diagram --></svg>\n',
        'Destination/figures/keep.svg':
          '<svg><!-- existing diagram --></svg>\n',
        'Reference.md': '![Diagram](figures/diagram.svg)\n',
      },
    },
    chats: [{ id: 'file-moves-chat', projectId, title: 'Fixture' }],
    runs: [],
  })
  const { page, state, report } = fixture
  const moves = [],
    order = []
  let failMove = false
  let warnReferences = false
  state.onSave = ({ save }) => {
    order.push('save')
    return save()
  }
  await page.route(`**/api/projects/${projectId}/move`, async (route) => {
    assert.equal(route.request().method(), 'POST')
    const body = route.request().postDataJSON()
    moves.push(body)
    order.push('move')
    if (failMove) {
      failMove = false
      return route.fulfill({
        status: 409,
        json: {
          error:
            'Wait for the current Git operation before starting other project work.',
        },
      })
    }
    const files = state.files[projectId]
    const paths = Object.keys(files).filter(
      (name) => name === body.from || name.startsWith(body.from + '/'),
    )
    assert(paths.length)
    assert(
      !Object.hasOwn(files, body.to),
      'A move must never overwrite its destination',
    )
    const kind = Object.hasOwn(files, body.from) ? 'file' : 'folder'
    for (const name of paths) {
      files[body.to + name.slice(body.from.length)] = files[name]
      delete files[name]
    }
    const updatedPaths = []
    if (body.updateReferences && body.from === 'figures') {
      files['Reference.md'] =
        '![Diagram](Destination/ImportedFigures/diagram.svg)\n'
      updatedPaths.push('Reference.md')
    }
    if (body.updateReferences && body.from === 'Reference.md') {
      files['Destination/Guide.md'] =
        '![Diagram](ImportedFigures/diagram.svg)\n'
      updatedPaths.push('Destination/Guide.md')
    }
    return route.fulfill({
      json: {
        from: body.from,
        to: body.to,
        kind,
        ...(body.updateReferences
          ? {
              references: {
                updatedFiles: updatedPaths.length,
                updatedReferences: updatedPaths.length,
                updatedPaths,
                skippedFiles: warnReferences ? 1 : 0,
                ...(warnReferences
                  ? {
                      warning:
                        'The move completed. Some files changed or could not be scanned, so their references were left unchanged. Review imports and links that use the old path.',
                    }
                  : {}),
              },
            }
          : {}),
      },
    })
  })
  const editor = () => page.locator('.monaco-editor textarea').first()
  const editorText = () =>
    page.locator('.monaco-editor .view-lines').first().innerText()
  const composer = page.getByLabel('Message Lemex')
  const attachment = (name) =>
    page
      .locator('.file-context-chip')
      .and(page.getByTitle(name, { exact: true }))
  const file = (name) =>
    page.locator('.file-item').and(page.getByTitle(name, { exact: true }))
  const folder = (name) =>
    page.locator('.folder-toggle').and(page.getByTitle(name, { exact: true }))
  const dialog = (name) => page.getByRole('dialog', { name, exact: true })
  async function actions(name, kind = 'file') {
    if (kind === 'file') await file(name).click({ button: 'right' })
    else await folder(name).click({ button: 'right' })
  }
  async function rename(name, value, kind = 'file') {
    await actions(name, kind)
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const input = dialog(`Rename ${kind}`).getByLabel('New name', {
      exact: true,
    })
    await input.click()
    await input.press('ControlOrMeta+A')
    await page.keyboard.insertText(value)
  }
  async function move(name, parent, kind = 'file', newName) {
    await actions(name, kind)
    await page
      .getByRole('menuitem', { name: 'Move to folder…', exact: true })
      .click()
    await dialog(`Move ${kind}`)
      .getByLabel('Destination folder', { exact: true })
      .selectOption(parent)
    if (newName) {
      const input = dialog(`Move ${kind}`).getByLabel('Name', {
        exact: true,
      })
      await input.click()
      await input.fill(newName)
      await until(
        async () =>
          (await dialog(`Move ${kind}`)
            .locator('#move-entry-preview')
            .innerText()) === `New path: ${parent}/${newName}`,
        'move preview uses the chosen name',
      )
    }
    await dialog(`Move ${kind}`)
      .getByRole('button', { name: `Move ${kind}`, exact: true })
      .click()
    await dialog(`Move ${kind}`).waitFor({ state: 'hidden' })
  }
  async function opened(name, marker) {
    await until(
      async () =>
        (await page.locator('.file-tab').innerText()).includes(name) &&
        (await editorText()).includes(marker),
      `editor follows ${name}`,
    )
    await page.locator('.editor-loading').waitFor({ state: 'hidden' })
  }
  await fixture.ready()
  await opened('Main.lean', 'example')
  await composer.fill('Keep this request and use @Ma')
  await composer.press('Enter')
  await attachment('Main.lean').waitFor()
  await page.getByLabel('Select context', { exact: true }).click()
  const focus = page.getByRole('dialog', {
    name: 'Choose context',
    exact: true,
  })
  await focus.getByLabel('Lines', { exact: true }).fill('1')
  await focus.getByRole('button', { name: 'Use lines', exact: true }).click()
  await editor().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('\n-- SAVE_BEFORE_RENAME\n')
  await rename('Main.lean', 'Renamed.lean')
  await dialog('Rename file')
    .getByRole('button', { name: 'Rename file', exact: true })
    .click()
  await dialog('Rename file').waitFor({ state: 'hidden' })
  await opened('Renamed.lean', 'SAVE_BEFORE_RENAME')
  await attachment('Renamed.lean').waitFor()
  assert(
    (
      await page.getByLabel('Focused proof', { exact: true }).innerText()
    ).includes('Renamed.lean'),
  )
  assert.equal(
    await page.evaluate(
      (id) => localStorage.getItem(`lemex-file-${id}`),
      projectId,
    ),
    'Renamed.lean',
    'Reload must reopen the renamed active file',
  )
  assert(!Object.hasOwn(state.files[projectId], 'Main.lean'))
  assert(
    Object.hasOwn(state.files[projectId], 'Renamed.lean'),
    JSON.stringify({ moves, paths: Object.keys(state.files[projectId]) }),
  )
  assert(state.files[projectId]['Renamed.lean'].includes('SAVE_BEFORE_RENAME'))
  assert(order.indexOf('save') < order.indexOf('move'))
  report.checks.push(
    'Renaming from the sidebar saves dirty text first and keeps the active editor at the new path with its content.',
  )

  const beforeCollision = moves.length
  await rename('Renamed.lean', 'Notes.lean')
  await dialog('Rename file').getByRole('alert').waitFor()
  assert.equal(
    await dialog('Rename file')
      .getByRole('button', { name: 'Rename file', exact: true })
      .isDisabled(),
    true,
  )
  await dialog('Rename file')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  assert.equal(moves.length, beforeCollision)
  assert.equal(
    state.files[projectId]['Notes.lean'],
    '-- Existing file must be kept\n',
  )
  report.checks.push(
    'Duplicate names are rejected before sending, and cancelling keeps both files untouched.',
  )

  await move('Renamed.lean', 'Destination')
  await opened('Destination/Renamed.lean', 'SAVE_BEFORE_RENAME')
  await attachment('Destination/Renamed.lean').waitFor()
  assert(!Object.hasOwn(state.files[projectId], 'Renamed.lean'))
  await editor().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.insertText('\n-- SAVE_AFTER_MOVE\n')
  await page
    .locator('.file-actions')
    .getByRole('button', { name: /^Save(?: all.*)?$/ })
    .click()
  await until(
    () =>
      state.files[projectId]['Destination/Renamed.lean'].includes(
        'SAVE_AFTER_MOVE',
      ),
    'save at new path',
  )
  assert(!Object.hasOwn(state.files[projectId], 'Renamed.lean'))
  report.checks.push(
    'Move to folder changes the active path; subsequent edits save at the new path without recreating the old file.',
  )

  await folder('Nested').click()
  await file('Nested/Child.lean').click()
  await opened('Nested/Child.lean', 'Nested')
  await composer.fill('Use the attached proof and @Nested/Ch')
  await composer.press('Enter')
  await attachment('Nested/Child.lean').waitFor()
  const savedDraft = await composer.inputValue()
  await rename('Nested', 'RenamedFolder', 'folder')
  await dialog('Rename folder')
    .getByRole('button', { name: 'Rename folder', exact: true })
    .click()
  await dialog('Rename folder').waitFor({ state: 'hidden' })
  await opened('RenamedFolder/Child.lean', 'Nested')
  await move('RenamedFolder', 'Destination', 'folder')
  await opened('Destination/RenamedFolder/Child.lean', 'Nested')
  assert.equal(
    await page.evaluate(
      (id) => localStorage.getItem(`lemex-file-${id}`),
      projectId,
    ),
    'Destination/RenamedFolder/Child.lean',
    'Folder moves must remember the active child at its new path',
  )
  assert(
    !Object.keys(state.files[projectId]).some(
      (name) => name.startsWith('Nested/') || name.startsWith('RenamedFolder/'),
    ),
  )
  await page.reload()
  await opened('Destination/RenamedFolder/Child.lean', 'Nested')
  await attachment('Destination/RenamedFolder/Child.lean').waitFor()
  await attachment('Destination/Renamed.lean').waitFor()
  assert.equal(await composer.inputValue(), savedDraft)
  assert(
    (
      await page.getByLabel('Focused proof', { exact: true }).innerText()
    ).includes('Destination/Renamed.lean'),
  )
  report.checks.push(
    'Folder rename and move preserve nested files, remembered selection, attached files, focused proof and unsent text after reload.',
  )

  failMove = true
  const beforeFailure =
    state.files[projectId]['Destination/RenamedFolder/Child.lean']
  await rename('Destination/RenamedFolder/Child.lean', 'Later.lean')
  await dialog('Rename file')
    .getByRole('button', { name: 'Rename file', exact: true })
    .click()
  await dialog('Rename file').getByRole('alert').waitFor()
  assert.match(
    await dialog('Rename file').getByRole('alert').innerText(),
    /Wait for the current Git operation/,
  )
  assert.equal(
    state.files[projectId]['Destination/RenamedFolder/Child.lean'],
    beforeFailure,
  )
  await dialog('Rename file')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  assert.equal(
    report.requests.filter((request) => request.endpoint.endsWith('/stop'))
      .length,
    0,
  )
  report.checks.push(
    'Git-operation refusals keep the file and editor intact and show an actionable error.',
  )

  let submitted
  state.onCreateRun = ({ chat, body, respond }) => {
    submitted = body
    const run = {
      id: 'moved-files-request',
      projectId,
      chatId: chat.id,
      status: 'running',
      mode: body.mode,
      prompt: body.prompt,
      message: 'Fixture request accepted.',
      files: body.files,
      eventCursor: 1,
      createdAt: new Date().toISOString(),
    }
    state.runs.push(run)
    return respond(run, 202)
  }
  await composer.press('Enter')
  await until(() => !!submitted, 'request using moved attachments')
  assert.deepEqual([...submitted.files].sort(), [
    'Destination/Renamed.lean',
    'Destination/RenamedFolder/Child.lean',
  ])
  assert.equal(submitted.proofTarget.path, 'Destination/Renamed.lean')
  report.checks.push(
    'Sending with Enter uses the renamed attachments and focused proof, so the next request has no stale source paths.',
  )

  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  await move('Notes.lean', 'Destination', 'file', 'Reference.lean')
  assert.equal(
    state.files[projectId]['Destination/Reference.lean'],
    '-- Existing file must be kept\n',
  )
  assert(!Object.hasOwn(state.files[projectId], 'Notes.lean'))
  assert.equal(state.runs.at(-1).status, 'running')
  assert.equal(
    report.requests.filter((request) => request.endpoint.endsWith('/stop'))
      .length,
    0,
  )
  report.checks.push(
    'Files can move and rename together during an active assistant run without stopping it.',
  )

  await file('Reference.md').click()
  await opened('Reference.md', 'figures/diagram.svg')
  await actions('figures', 'folder')
  await page
    .getByRole('menuitem', { name: 'Move to folder…', exact: true })
    .click()
  await dialog('Move folder')
    .getByLabel('Destination folder', { exact: true })
    .selectOption('Destination')
  assert.match(
    await dialog('Move folder').getByRole('alert').innerText(),
    /Destination\/figures already exists/,
  )
  assert.equal(
    await dialog('Move folder')
      .getByRole('button', { name: 'Move folder', exact: true })
      .isDisabled(),
    true,
  )
  await dialog('Move folder')
    .getByLabel('Name', { exact: true })
    .fill('ImportedFigures')
  assert.equal(
    await dialog('Move folder')
      .getByRole('checkbox', { name: 'Update imports and file links' })
      .isChecked(),
    true,
  )
  assert.equal(await dialog('Move folder').getByRole('alert').count(), 0)
  assert.match(
    await dialog('Move folder').locator('#move-entry-preview').innerText(),
    /Destination\/ImportedFigures/,
  )
  await dialog('Move folder').screenshot({
    path: path.join(output, 'move-folder.png'),
  })
  await dialog('Move folder')
    .getByRole('button', { name: 'Move folder', exact: true })
    .click()
  await dialog('Move folder').waitFor({ state: 'hidden' })
  assert.equal(
    state.files[projectId]['Destination/ImportedFigures/diagram.svg'],
    '<svg><!-- source diagram --></svg>\n',
  )
  assert.equal(
    state.files[projectId]['Destination/figures/keep.svg'],
    '<svg><!-- existing diagram --></svg>\n',
  )
  assert(!Object.hasOwn(state.files[projectId], 'figures/diagram.svg'))
  await opened('Reference.md', 'Destination/ImportedFigures/diagram.svg')
  assert.equal(moves.at(-1).updateReferences, true)
  report.checks.push(
    'Folder collisions can be resolved by renaming during the move; automatic reference updates are on by default and refresh an open referencing document.',
  )

  await move('Reference.md', 'Destination', 'file', 'Guide.md')
  await opened('Destination/Guide.md', 'ImportedFigures/diagram.svg')
  assert.equal(
    state.files[projectId]['Destination/Guide.md'],
    '![Diagram](ImportedFigures/diagram.svg)\n',
  )
  report.checks.push(
    'A moved document follows its new path and refreshes rewritten relative links without needing a reload.',
  )

  await rename('Destination/Guide.md', 'Manual.md')
  await dialog('Rename file')
    .getByRole('checkbox', { name: 'Update imports and file links' })
    .uncheck()
  await dialog('Rename file')
    .getByRole('button', { name: 'Rename file', exact: true })
    .click()
  await dialog('Rename file').waitFor({ state: 'hidden' })
  await opened('Destination/Manual.md', 'ImportedFigures/diagram.svg')
  assert.equal(moves.at(-1).updateReferences, false)
  report.checks.push(
    'Automatic reference updates can be turned off for a move or rename.',
  )

  warnReferences = true
  await rename('Destination/Manual.md', 'Review.md')
  await dialog('Rename file')
    .getByRole('button', { name: 'Rename file', exact: true })
    .click()
  await dialog('Rename file').waitFor({ state: 'hidden' })
  await opened('Destination/Review.md', 'ImportedFigures/diagram.svg')
  await page
    .getByText(
      'Moved to Destination/Review.md. The move completed. Some files changed or could not be scanned, so their references were left unchanged. Review imports and links that use the old path.',
      { exact: true },
    )
    .waitFor()
  report.checks.push(
    'A partial reference update leaves a persistent actionable warning after the move dialog closes.',
  )

  await actions('lakefile.toml')
  for (const name of ['Rename', 'Move to folder…'])
    assert.equal(
      await page.getByRole('menuitem', { name, exact: true }).isDisabled(),
      true,
    )
  await page.keyboard.press('Escape')
  report.checks.push(
    'Project setup files show disabled rename and move actions.',
  )

  await file('Destination/Reference.lean').click()
  await opened('Destination/Reference.lean', 'kept')
  state.projects[0].accessRole = 'viewer'
  await page.reload()
  await fixture.ready()
  await file('Destination/Reference.lean').click({ button: 'right' })
  assert.equal(
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).count(),
    0,
  )
  assert.equal(
    await page
      .getByRole('menuitem', { name: 'Move to folder…', exact: true })
      .count(),
    0,
  )
  report.checks.push('Viewers have no rename or move actions.')

  state.projects[0].accessRole = 'editor'
  state.projects[0].kind = 'single-file'
  await page.reload()
  await file('Destination/Reference.lean').click({ button: 'right' })
  for (const name of ['Rename', 'Move to folder…'])
    assert.equal(
      await page.getByRole('menuitem', { name, exact: true }).isDisabled(),
      true,
    )
  assert.equal(await dialog('Rename file').count(), 0)
  report.checks.push(
    'Playgrounds with extra files explain that conversion is required and cannot leave a stale move dialog behind.',
  )
  fixture.assertClean()
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        checks: report.checks,
        errors: report.errors,
        moves: moves.length,
      },
      null,
      2,
    ) + '\n',
  )
  console.log(JSON.stringify({ passed: true, checks: report.checks }, null, 2))
} finally {
  await fixture?.browser.close()
  await new Promise((resolve) => server.close(resolve))
}
