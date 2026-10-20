#!/usr/bin/env node
// All writes target the in-memory fixture, never a real workspace or provider.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import {
  chatBrowserFixture,
  sleep,
  until,
} from './lib/chat-browser-fixture.mjs'

const output = new URL('../.runtime/autosave-ui/', import.meta.url)
await fs.mkdir(output, { recursive: true })
const a = 'autosave-a',
  b = 'autosave-b',
  chatId = 'autosave-chat'
const active = {
  id: 'autosave-run',
  projectId: a,
  chatId,
  status: 'running',
  mode: 'search',
  createdAt: '2026-10-20T08:00:00Z',
  prompt: 'Explain this proof.',
  message: 'Inspecting the proof.',
  eventCursor: 1,
}
const fixture = await chatBrowserFixture({
  session: {
    user: { id: 'fixture-owner', name: 'Fixture owner' },
    templates: [],
    models: [{ id: 'fixture-model', name: 'Fixture model' }],
    defaultModel: 'fixture-model',
    runtime: { ready: true },
    lemex: { revision: 'fixture', available: true },
  },
  projects: [a, b].map((id, index) => ({
    id,
    name: index ? 'Autosave Beta' : 'Autosave Alpha',
    status: 'ready',
    toolchain: 'leanprover/lean4:v4.35.0-rc4',
  })),
  files: {
    [a]: {
      'Main.lean': '-- ALPHA\nexample : True := by trivial\n',
      'Other.lean': '-- ALPHA_OTHER\nexample : True := by trivial\n',
    },
    [b]: { 'Main.lean': '-- BETA\nexample : True := by trivial\n' },
  },
  chats: [
    { id: chatId, projectId: a, title: 'Autosave while chatting' },
    { id: 'beta-chat', projectId: b, title: 'Beta conversation' },
  ],
  runs: [active],
})
const { page, browser, state, report, emit } = fixture
const writes = () =>
  report.requests.filter((request) => request.method === 'PUT')
const select = (name) =>
  page.locator('.project-item').and(page.getByTitle(name, { exact: true }))
const editor = () => page.locator('.monaco-editor textarea').first()
const hash = (content) => createHash('sha256').update(content).digest('hex')
async function append(text) {
  await editor().focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(text)
}
async function saved(projectId, marker) {
  await until(
    () => state.files[projectId]['Main.lean'].includes(marker),
    `saved ${marker}`,
  )
  await until(
    () => page.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
    'clean editor buffer',
  )
}
let releaseSave
try {
  await fixture.ready()
  await append('-- FIRST_EDIT\n')
  await sleep(350)
  await append('-- SECOND_EDIT\n')
  await sleep(500)
  assert.equal(writes().length, 0, 'Keystrokes must be debounced')
  for (let index = 0; index < 8; index++) {
    await emit(active, 'message', `\nProgress ${index}.`)
    await sleep(220)
  }
  await saved(a, 'SECOND_EDIT')
  assert.equal(
    writes().length,
    1,
    'Chat streaming must not reschedule or duplicate saves',
  )
  assert(state.files[a]['Main.lean'].includes('FIRST_EDIT'))
  await sleep(1750)
  assert.equal(writes().length, 1)
  report.checks.push(
    'Debounced edits save once while chat streams; clean buffers generate no extra writes',
  )

  let inFlight = 0,
    maxInFlight = 0,
    held = false
  state.onSave = async ({ save }) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    if (!held) {
      held = true
      await new Promise((resolve) => {
        releaseSave = resolve
      })
    }
    try {
      return await save()
    } finally {
      inFlight--
    }
  }
  const beforeSlow = state.files[a]['Main.lean']
  await append('-- SLOW_SAVE\n')
  await until(() => !!releaseSave, 'held save request')
  await append('-- TYPED_DURING_SAVE\n')
  assert(!state.files[a]['Main.lean'].includes('TYPED_DURING_SAVE'))
  releaseSave()
  releaseSave = null
  await saved(a, 'TYPED_DURING_SAVE')
  assert.equal(maxInFlight, 1)
  const slowWrites = writes().slice(-2)
  assert.equal(slowWrites[0].body.expectedHash, hash(beforeSlow))
  assert.equal(
    slowWrites[1].body.expectedHash,
    hash(slowWrites[0].body.content),
  )
  state.onSave = null
  report.checks.push(
    'Slow saves are serialized; typing during a save is preserved and uses the returned file hash',
  )

  let attempts = 0
  state.onSave = ({ respond, save }) =>
    ++attempts === 1
      ? respond({ error: 'Temporary connection problem' }, 503)
      : save()
  await append('-- RECOVERED\n')
  await page
    .locator('.autosave-alert')
    .getByText('Autosave will retry', { exact: false })
    .waitFor()
  await saved(a, 'RECOVERED')
  assert.equal(attempts, 2)
  await page.locator('.autosave-alert').waitFor({ state: 'hidden' })
  state.onSave = null
  report.checks.push(
    'Temporary failures keep edits and recover automatically without a manual save',
  )

  const beforeOffline = writes().length
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => false,
    })
    window.dispatchEvent(new Event('offline'))
  })
  await append('-- OFFLINE_EDIT\n')
  await page
    .locator('.autosave-alert')
    .getByText('Offline.', { exact: false })
    .waitFor()
  await sleep(1800)
  assert.equal(writes().length, beforeOffline)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => true,
    })
    window.dispatchEvent(new Event('online'))
  })
  await saved(a, 'OFFLINE_EDIT')
  report.checks.push(
    'Offline edits remain in the tab and save when connectivity returns',
  )

  const beforeComposition = writes().length
  await page.evaluate(() =>
    document.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    ),
  )
  await append('-- COMPOSITION_EDIT\n')
  await sleep(1800)
  assert.equal(writes().length, beforeComposition)
  await page.evaluate(() =>
    document.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    ),
  )
  await saved(a, 'COMPOSITION_EDIT')
  report.checks.push(
    'Input composition finishes before autosave writes the file',
  )

  const openFile = async (name, marker) => {
    await page
      .locator('.file-item')
      .and(page.getByTitle(name, { exact: true }))
      .click()
    await until(
      async () =>
        (await page.locator('.file-tab').innerText()).includes(name) &&
        (await page.locator('.monaco-editor').innerText()).includes(marker),
      `open ${name}`,
    )
  }
  await openFile('Other.lean', 'ALPHA_OTHER')
  await openFile('Main.lean', 'ALPHA')
  const beforeFileSwitch = writes().length
  await append('-- MULTI_MAIN\n')
  await openFile('Other.lean', 'ALPHA_OTHER')
  await append('-- MULTI_OTHER\n')
  await until(
    () =>
      state.files[a]['Main.lean'].includes('MULTI_MAIN') &&
      state.files[a]['Other.lean'].includes('MULTI_OTHER'),
    'both dirty buffers saved',
  )
  assert.equal(writes().length, beforeFileSwitch + 2)
  assert(writes().at(-2).body.content.includes('MULTI_MAIN'))
  assert(writes().at(-1).body.content.includes('MULTI_OTHER'))
  assert(!state.files[a]['Other.lean'].includes('MULTI_MAIN'))
  assert(!state.files[a]['Main.lean'].includes('MULTI_OTHER'))
  await openFile('Main.lean', 'MULTI_MAIN')
  report.checks.push(
    'File navigation saves each changed file with its own hash and keeps source contents separate',
  )

  const beforeContinuous = writes().length
  for (let index = 0; index < 12; index++) {
    await append(`-- CONTINUOUS_${index}\n`)
    await sleep(900)
  }
  assert(
    writes().length > beforeContinuous,
    'Continuous typing must not postpone autosave indefinitely',
  )
  await saved(a, 'CONTINUOUS_11')
  assert(
    writes().length - beforeContinuous <= 3,
    'Continuous edits must remain coalesced',
  )
  report.checks.push(
    'Continuous typing still saves within the maximum delay without writing every edit',
  )

  await append('-- SAVE_BEFORE_SWITCH\n')
  await select('Autosave Beta').click()
  await until(
    async () =>
      (await page.locator('.monaco-editor').innerText()).includes('BETA'),
    'Beta editor',
  )
  assert.equal(
    await page
      .getByRole('dialog', { name: 'Save your changes?', exact: true })
      .count(),
    0,
  )
  assert(state.files[a]['Main.lean'].includes('SAVE_BEFORE_SWITCH'))
  assert(!state.files[b]['Main.lean'].includes('SAVE_BEFORE_SWITCH'))
  await append('-- BETA_EDIT\n')
  await saved(b, 'BETA_EDIT')
  assert(!state.files[a]['Main.lean'].includes('BETA_EDIT'))
  await select('Autosave Alpha').click()
  await until(
    async () =>
      (await page.locator('.monaco-editor').innerText()).includes('ALPHA'),
    'Alpha editor',
  )
  report.checks.push(
    'Project navigation flushes edits without a dialog and keeps identically named files isolated',
  )

  const remote = '-- REMOTE_CHANGE\nexample : True := by trivial\n'
  state.files[a]['Main.lean'] = remote
  await append('-- LOCAL_CONFLICT\n')
  await page
    .locator('.autosave-alert')
    .getByText('Autosave paused', { exact: false })
    .waitFor()
  const conflictWrites = writes().length
  await append('-- KEEP_TYPING\n')
  await sleep(2500)
  assert.equal(
    writes().length,
    conflictWrites,
    'Typing must not retry a stale hash',
  )
  assert.equal(state.files[a]['Main.lean'], remote)
  assert(
    (await page.locator('.monaco-editor').innerText()).includes('KEEP_TYPING'),
  )
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await until(
    () => writes().length === conflictWrites + 1,
    'explicit conflict retry',
  )
  await page
    .locator('.autosave-alert')
    .getByText('Autosave paused', { exact: false })
    .waitFor()
  assert.equal(state.files[a]['Main.lean'], remote)
  report.checks.push(
    'Conflicts pause autosave, preserve local edits and never overwrite a newer saved file, including on explicit retry',
  )
  fixture.assertClean()
  await page.screenshot({
    path: new URL('conflict-preserved.png', output).pathname,
    fullPage: true,
  })
  await select('Autosave Beta').click()
  const dialog = page.getByRole('dialog', {
    name: 'Save your changes?',
    exact: true,
  })
  await dialog.waitFor()
  assert.equal(
    await select('Autosave Alpha').getAttribute('aria-current'),
    'page',
  )
  assert.equal(state.files[a]['Main.lean'], remote)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert(
    (await page.locator('.monaco-editor').innerText()).includes('KEEP_TYPING'),
  )
  await select('Autosave Beta').click()
  await dialog
    .getByRole('button', { name: 'Discard edits', exact: true })
    .click()
  await until(
    async () =>
      (await page.locator('.monaco-editor').innerText()).includes('BETA_EDIT'),
    'explicit discard and navigation',
  )
  assert.equal(state.files[a]['Main.lean'], remote)
  report.checks.push(
    'Failed navigation saves offer cancel or explicit discard; neither silently overwrites the saved file',
  )
  fixture.assertClean()
  console.log(
    `PASS: ${report.checks.length} autosave checks; every write used isolated files and hash checks`,
  )
} catch (error) {
  await page.screenshot({
    path: new URL('failure.png', output).pathname,
    fullPage: true,
  })
  throw error
} finally {
  releaseSave?.()
  await fs.writeFile(
    new URL('report.json', output),
    JSON.stringify(report, null, 2),
  )
  await browser.close()
}
