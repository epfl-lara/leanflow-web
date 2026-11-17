#!/usr/bin/env node
// Chromium drives the production editor. All project files and Lean messages are fixtures.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const projectId = 'proof-status-project'
const main = [
  '/-- This documented theorem has no unfinished proof. -/',
  'theorem finished : True := by',
  '  trivial -- sorry in a comment',
  'def note := "sorry"',
  'lemma unfinished : True := by',
  '  sorry',
  '',
  'example : True := by',
  '  exact 3',
].join('\n')
const second = 'import Main\ntheorem another : True := by exact finished'
const mainUri = 'file:///workspace/Main.lean'
const secondUri = 'file:///workspace/Second.lean'
const output = path.resolve('.runtime/proof-status-ui')
await fs.mkdir(output, { recursive: true })

const range = (startLine, startCharacter, endLine, endCharacter) => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
})
function symbol(name, source, start, end) {
  return {
    name,
    kind: 12,
    range: range(start, 0, end, source.split('\n')[end].length),
  }
}
const symbols = {
  [mainUri]: [
    // Lean includes the doc comment in the range. The check belongs on line 2.
    symbol('finished', main, 0, 2),
    symbol('note', main, 3, 3),
    // Mathlib's lemma macro can be absent from documentSymbol.
    symbol('example', main, 7, 8),
  ],
  [secondUri]: [symbol('another', second, 1, 1)],
}
const sorry = {
  severity: 2,
  range: range(4, 6, 4, 16),
  message: "declaration uses 'sorry'",
  source: 'Lean 4',
}
const typeError = {
  severity: 1,
  range: range(8, 8, 8, 9),
  message: 'Type mismatch: 3 has type Nat but is expected to have type True',
  source: 'Lean 4',
}
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'participant', name: 'Participant' },
    templates: [],
    models: [],
    runtime: { ready: true },
    lemex: { configured: true },
  },
  projects: [
    {
      id: projectId,
      name: 'Theorem checks',
      status: 'ready',
      toolchain: 'leanprover/lean4:v4.34.1',
    },
  ],
  files: { [projectId]: { 'Main.lean': main, 'Second.lean': second } },
  chats: [{ id: 'proof-status-chat', projectId, title: 'Fixture' }],
  runs: [],
})
const { page, state, sendLean } = fixture
const versions = new Map()
const opens = new Map()
let barrier = 0
const acknowledged = new Set()
const waiters = new Map()
const completed = new Set()
const versionKey = (uri, version) => JSON.stringify([uri, version])
state.onLeanMessage = (message, _url, socket) => {
  if (
    message.method === 'textDocument/hover' &&
    message.params.textDocument.uri === mainUri &&
    message.params.position.line === 4 &&
    message.params.position.character < 5
  ) {
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          contents: { kind: 'markdown', value: 'Macro `lemma`' },
          range: range(4, 0, 5, 7),
        },
      }),
    )
    return true
  }
  if (message.method === 'textDocument/waitForDiagnostics') {
    const { uri, version } = message.params
    const key = versionKey(uri, version)
    const reply = () =>
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }),
      )
    if (completed.has(key)) reply()
    else waiters.set(key, [...(waiters.get(key) || []), reply])
    return true
  }
  const document = message.params?.textDocument
  if (message.method === 'textDocument/didOpen') {
    completed.delete(versionKey(document.uri, document.version))
    opens.set(document.uri, (opens.get(document.uri) || 0) + 1)
  }
  if (
    ['textDocument/didOpen', 'textDocument/didChange'].includes(message.method)
  )
    versions.set(document.uri, document.version)
  if (message.method === 'textDocument/documentSymbol')
    state.documentSymbols = symbols[document.uri]
  if (typeof message.id === 'string' && message.id.startsWith('fixture-flush-'))
    acknowledged.add(message.id)
}
const list = page.getByRole('list', { name: 'Declarations in this file' })
const entry = (name) =>
  list
    .locator('.proof-outline-entry')
    .filter({ has: page.getByText(name, { exact: true }) })
const labels = {
  checked: 'Lean checked',
  warning: 'Lean warning',
  error: 'Lean error',
  pending: 'Awaiting Lean',
}
async function status(name, kind) {
  await expect(
    entry(name).getByRole('img', { name: labels[kind], exact: true }),
  ).toBeVisible()
}
async function gutter(kind, count) {
  const glyph = page.locator('.monaco-editor .proof-gutter-' + kind)
  await expect(glyph).toHaveCount(count)
  if (count) await expect(glyph.first()).toBeVisible()
}
function notify(method, params) {
  sendLean({ jsonrpc: '2.0', method, params })
}
function progress(uri, version, processing) {
  notify('$/lean/fileProgress', {
    textDocument: { uri, version },
    processing: processing ? [{ range: range(0, 0, 9, 0), kind: 1 }] : [],
  })
}
function diagnostics(uri, version, values) {
  notify('textDocument/publishDiagnostics', {
    uri,
    version,
    diagnostics: values,
    isIncremental: false,
  })
}
function releaseDiagnostics(uri, version) {
  const key = versionKey(uri, version)
  completed.add(key)
  for (const reply of waiters.get(key) || []) reply()
  waiters.delete(key)
}
function finish(uri, version, values) {
  progress(uri, version, true)
  diagnostics(uri, version, values)
  progress(uri, version, false)
  releaseDiagnostics(uri, version)
}
// A reply on the same JSON-RPC connection confirms Chromium received the earlier
// notifications before we inspect whether a late packet changed the display.
async function flush() {
  const id = 'fixture-flush-' + ++barrier
  sendLean({
    jsonrpc: '2.0',
    id,
    method: 'workspace/configuration',
    params: { items: [] },
  })
  await until(
    () => acknowledged.has(id),
    'Lean connection notification barrier',
  )
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
}
try {
  await fixture.ready()
  await status('finished', 'pending')
  await status('unfinished', 'pending')
  await status('example', 'pending')
  await gutter('checked', 0)
  await expect(entry('note').locator('[data-proof-status]')).toHaveCount(0)

  const v1 = versions.get(mainUri)
  assert(Number.isSafeInteger(v1))
  progress(mainUri, v1, true)
  diagnostics(mainUri, v1, [sorry, typeError])
  progress(mainUri, v1, false)
  await until(
    () => waiters.has(versionKey(mainUri, v1)),
    'version-specific Lean diagnostics barrier',
  )
  await flush()
  await status('finished', 'pending')
  releaseDiagnostics(mainUri, v1)
  await status('finished', 'checked')
  await status('unfinished', 'warning')
  await status('example', 'error')
  await gutter('checked', 1)
  await gutter('warning', 1)
  await gutter('error', 1)
  for (const [kind, header] of [
    ['checked', 'theorem finished'],
    ['warning', 'lemma unfinished'],
    ['error', 'example : True'],
  ]) {
    const glyph = await page
      .locator('.monaco-editor .proof-gutter-' + kind)
      .boundingBox()
    const line = await page
      .locator('.monaco-editor .view-line')
      .filter({ hasText: header })
      .boundingBox()
    assert(
      glyph &&
        line &&
        Math.abs(glyph.y + glyph.height / 2 - (line.y + line.height / 2)) <
          line.height / 2,
      kind + ' mark belongs on its declaration line',
    )
  }
  await page.screenshot({ path: path.join(output, 'dark.png') })
  await page
    .getByRole('button', { name: 'Use light theme', exact: true })
    .click()
  await status('unfinished', 'warning')
  await page.screenshot({ path: path.join(output, 'light.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  const closeTools = page.getByRole('button', {
    name: 'Close tools panel',
    exact: true,
  })
  if (await closeTools.isVisible()) await closeTools.click()
  await gutter('checked', 1)
  await gutter('warning', 1)
  await gutter('error', 1)
  await page.screenshot({ path: path.join(output, 'mobile-editor.png') })
  await page
    .getByRole('button', { name: 'Open projects and files', exact: true })
    .click()
  await expect
    .poll(async () =>
      Math.round((await page.locator('.sidebar').boundingBox()).x),
    )
    .toBe(0)
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const warningEntry = entry('unfinished')
  await warningEntry.focus()
  await expect(warningEntry).toBeFocused()
  await expect(warningEntry).toHaveAccessibleName(/unfinished.*Lean warning/)
  const warningMark = warningEntry.getByRole('img', { name: 'Lean warning' })
  await expect(warningMark).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: path.join(output, 'mobile-outline.png') })
  await page.keyboard.press('Enter')
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/)
  await page.setViewportSize({ width: 1600, height: 1000 })

  // Correct only the failing proof with ordinary Monaco keyboard controls.
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press(editorShortcuts.documentEnd)
  await page.keyboard.press(editorShortcuts.lineStart)
  await page.keyboard.press(editorShortcuts.selectLineEnd)
  await page.keyboard.insertText('  trivial')
  await until(
    () => versions.get(mainUri) > v1,
    'new source version sent to Lean',
  )
  const v2 = versions.get(mainUri)
  await status('example', 'pending')
  finish(mainUri, v1, [])
  await flush()
  await status('example', 'pending')
  await gutter('checked', 0)
  finish(mainUri, v2, [sorry])
  await status('finished', 'checked')
  await status('unfinished', 'warning')
  await status('example', 'checked')
  await gutter('checked', 2)
  await gutter('error', 0)
  await until(
    () => state.files[projectId]['Main.lean'].endsWith('trivial'),
    'corrected source saved',
  )

  await page.locator('.file-item[title="Second.lean"]').click()
  await status('another', 'pending')
  finish(mainUri, v2, [])
  await flush()
  await status('another', 'pending')
  await gutter('checked', 0)
  const secondVersion = versions.get(secondUri)
  assert(Number.isSafeInteger(secondVersion))
  finish(secondUri, secondVersion, [])
  await status('another', 'checked')
  await gutter('checked', 1)

  state.files[projectId]['Main.lean'] += '\n-- Changed in another editor.'
  await page.getByRole('button', { name: 'Refresh files', exact: true }).click()
  const refreshImports = page.getByRole('button', {
    name: 'Refresh imports',
    exact: true,
  })
  await expect(refreshImports).toBeVisible()
  await status('another', 'pending')
  await gutter('checked', 0)
  const openCount = opens.get(secondUri)
  await refreshImports.click()
  await until(() => opens.get(secondUri) > openCount, 'Lean reopened the file')
  await expect(refreshImports).toBeHidden()
  await status('another', 'pending')
  finish(secondUri, versions.get(secondUri), [])
  await status('another', 'checked')
  fixture.assertClean()
  console.log(
    'Theorem, lemma and example indicators distinguish checked, warning and error in Chromium. Editing, switching files and refreshing imports withdraw stale results until Lean finishes the current version.',
  )
} catch (error) {
  await page
    .screenshot({ path: path.join(output, 'failure.png') })
    .catch(() => {})
  throw error
} finally {
  await fixture.browser.close()
}
