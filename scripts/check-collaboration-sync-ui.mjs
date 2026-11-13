#!/usr/bin/env node
// Two real editors and the document service, with isolated files and terminal bytes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import express from 'express'
import { ProjectDocuments } from '../server/project-documents.mjs'
import { unchangedFileMoves } from '../server/workspace-moves.mjs'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'
import { editorShortcuts } from './lib/editor-shortcuts.mjs'

const projectId = 'terminal-sync-fixture'
const output = path.resolve('.runtime/collaboration-sync-ui')
await fs.mkdir(output, { recursive: true })
await fs.rm(path.join(output, 'report.json'), { force: true })
await fs.rm(path.join(output, 'failure.json'), { force: true })
const hash = (content) => createHash('sha256').update(content).digest('hex')
const sources = {
  'Main.lean': 'example : True := by trivial\n',
  'lakefile.toml': 'name = "terminal_sync_fixture"\n',
  'Notes.lean': '-- another file\n',
  'Other.lean': '-- independent saved file\n',
  'RestOnly.lean': '-- capacity fallback fixture\n',
  'Linked/Helper.lean': 'theorem helper : True := by trivial\n',
  'Linked/Proof.lean': 'import Linked.Helper\n\nexample : True := by trivial\n',
}
const fixtures = []
const releaseReads = []
const listeners = new Set()
const writes = []
let heldWrite = null
function holdWrite(marker) {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  heldWrite = { marker, promise, release, entered: false }
  return heldWrite
}
const notify = (event) => {
  for (const listener of listeners)
    listener({ projectId, kind: 'files', ...event })
}
const workspaces = {
  get: () => ({ id: projectId, accessRole: 'admin' }),
  requireEditor() {
    return this.get()
  },
  subscribeChanges(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  async readFile(_project, _actor, name) {
    if (!Object.hasOwn(sources, name))
      throw Object.assign(new Error('File was removed.'), { status: 404 })
    return { content: sources[name], hash: hash(sources[name]) }
  },
  async writeFile(_project, actor, name, content, expectedHash, options) {
    if (heldWrite && content.includes(heldWrite.marker)) {
      const held = heldWrite
      held.entered = true
      await held.promise
      if (heldWrite === held) heldWrite = null
    }
    options?.assertAuthorized?.()
    if (!Object.hasOwn(sources, name) || hash(sources[name]) !== expectedHash)
      throw Object.assign(new Error('File changed before saving.'), {
        status: 409,
      })
    sources[name] = content
    writes.push({ actor, path: name })
    notify({ paths: [name] })
    return { content, hash: hash(content) }
  },
}
const documents = new ProjectDocuments({ workspaces })
const app = express()
app.use(express.static(process.env.STUDIO_TEST_DIST || 'client/dist'))
const server = await new Promise((resolve) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
})
const base = `http://127.0.0.1:${server.address().port}`
const adapters = []
const terminalMoves = []
const terminalSockets = []
const liveOpenRequests = []
let heldDocuments = null
let pausePeerReconnect = false
let resumePeer = null

async function browser(actor) {
  const fixture = await chatBrowserFixture({
    base,
    session: {
      user: { id: actor, name: actor },
      models: [],
      templates: [],
      runtime: { ready: true },
    },
    projects: [
      {
        id: projectId,
        name: 'Terminal sync fixture',
        accessRole: 'admin',
        status: 'ready',
      },
    ],
    files: { [projectId]: sources },
    chats: [{ id: `${actor}-chat`, projectId, title: 'Fixture' }],
    runs: [],
  })
  fixtures.push(fixture)
  // Both APIs and live documents read the same saved files.
  fixture.state.files[projectId] = sources
  await fixture.page.route(`**/api/projects/${projectId}/file?*`, (route) => {
    const request = route.request()
    const name = new URL(request.url()).searchParams.get('path')
    if (request.method() === 'GET' && !Object.hasOwn(sources, name))
      return route.fulfill({ status: 404, json: { error: 'File not found.' } })
    return route.fallback()
  })
  fixture.state.onSave = async ({ entries, save }) => {
    // Creation retries after a lost response use the server's exact-content
    // retry rule; a different existing file must still return a conflict.
    for (const entry of entries)
      if (
        entry.expectedHash === null &&
        Object.hasOwn(sources, entry.path) &&
        sources[entry.path] === entry.content
      )
        entry.expectedHash = hash(sources[entry.path])
    const valid = entries.every(
      (entry) =>
        entry.expectedHash ===
        (Object.hasOwn(sources, entry.path) ? hash(sources[entry.path]) : null),
    )
    await save()
    if (valid) notify({ paths: entries.map((entry) => entry.path) })
  }
  await fixture.page.routeWebSocket(
    '**/websocket/collaboration/**',
    (socket) => {
      const ws = new EventEmitter()
      ws.readyState = 1
      ws.actor = actor
      ws.bufferedAmount = 0
      ws.send = (raw) => {
        if (ws.readyState !== 1) return
        const packet = JSON.parse(raw)
        if (
          heldDocuments &&
          actor === heldDocuments.actor &&
          packet.type === 'document' &&
          packet.path === heldDocuments.path
        ) {
          heldDocuments.messages.push(() => {
            if (ws.readyState === 1) socket.send(raw)
          })
          return
        }
        socket.send(raw)
      }
      ws.close = (code = 1000, reason = '') => {
        if (ws.readyState !== 1) return
        ws.readyState = 3
        socket.close({ code, reason })
        ws.emit('close')
      }
      ws.terminate = () => ws.close()
      ws.ping = () => ws.emit('pong')
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw))
        if (request.type === 'open')
          liveOpenRequests.push({ actor, path: request.path })
        if (request.type === 'open' && request.path === 'RestOnly.lean') {
          ws.send(
            JSON.stringify({
              type: 'error',
              path: request.path,
              requestId: request.requestId,
              status: 429,
              message: 'Fixture live capacity full.',
            }),
          )
          return
        }
        ws.emit('message', Buffer.from(String(raw)))
      })
      socket.onClose(() => {
        if (ws.readyState !== 1) return
        ws.readyState = 3
        ws.emit('close')
      })
      adapters.push(ws)
      if (actor === 'terminal-peer' && pausePeerReconnect)
        resumePeer = () => documents.connect(ws, projectId, actor)
      else documents.connect(ws, projectId, actor)
    },
  )
  await fixture.page.route('**/api/projects/*/terminal/stop', (route) =>
    route.fulfill({ json: { stopped: true } }),
  )
  await fixture.page.routeWebSocket('**/websocket/terminal/**', (socket) => {
    terminalSockets.push(socket)
    let command = ''
    socket.send(Buffer.from('/workspace $ '))
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.type !== 'input') return
      command += message.data
      if (!command.includes('\r')) return
      const [program, from, to] = command.trim().split(/\s+/)
      command = ''
      assert.equal(program, 'mv')
      assert(Object.hasOwn(sources, from))
      assert(!Object.hasOwn(sources, to))
      const content = sources[from]
      delete sources[from]
      sources[to] = content
      const moves = unchangedFileMoves([
        { path: from, before: content, after: null },
        { path: to, before: null, after: content },
      ])
      terminalMoves.push({ from, to })
      notify({ paths: [from, to], removedPaths: [from], moves })
      socket.send(Buffer.from('/workspace $ '))
    })
  })
  await fixture.ready()
  return fixture
}

const editor = (fixture) =>
  fixture.page.locator('.monaco-editor textarea').first()
const text = (fixture) =>
  fixture.page.locator('.monaco-editor .view-lines').first().innerText()
async function opened(fixture, filename) {
  await until(
    async () =>
      (await fixture.page.locator('.file-tab').innerText()).includes(filename),
    `editor opens ${filename}`,
  )
  await fixture.page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await fixture.page
    .locator('.file-tab')
    .getByText('Joining live editing…', { exact: true })
    .waitFor({ state: 'hidden' })
}
async function type(fixture, value) {
  await fixture.page.locator('.editor-loading').waitFor({ state: 'hidden' })
  await fixture.page
    .locator('.file-tab')
    .getByText('Joining live editing…', { exact: true })
    .waitFor({ state: 'hidden' })
  await editor(fixture).focus()
  await fixture.page.keyboard.press(editorShortcuts.documentEnd)
  await fixture.page.keyboard.insertText(value)
}

try {
  const owner = await browser('terminal-owner')
  const peer = await browser('terminal-peer')
  await until(
    () =>
      [...documents.documents.values()].some(
        (record) => record.path === 'Main.lean' && record.clients.size === 2,
      ),
    'both live editors subscribed',
  )
  await type(peer, '\n-- PEER_BEFORE_MOVE\n')
  await until(
    () => sources['Main.lean'].includes('PEER_BEFORE_MOVE'),
    'peer edit is durable before the move',
  )
  const initialSave = holdWrite('SAVE_BEFORE_TERMINAL')
  await type(owner, '\n-- SAVE_BEFORE_TERMINAL\n')
  await owner.page
    .getByRole('button', { name: 'Terminal', exact: true })
    .click()
  await until(
    () => initialSave.entered,
    'browser save is waiting for its durable acknowledgement',
  )
  assert.equal(
    await owner.page
      .getByRole('region', { name: 'Project terminal', exact: true })
      .count(),
    0,
    'a terminal cannot snapshot an unacknowledged draft',
  )
  initialSave.release()
  const terminal = owner.page.getByRole('region', {
    name: 'Project terminal',
    exact: true,
  })
  await terminal.getByText('Connected', { exact: true }).waitFor()
  async function move(from, to) {
    await owner.page.getByLabel('Project terminal input').focus()
    await owner.page.keyboard.type(`mv ${from} ${to}`)
    await owner.page.keyboard.press('Enter')
    await Promise.all([
      opened(owner, path.posix.basename(to)),
      opened(peer, path.posix.basename(to)),
    ])
    assert(!Object.hasOwn(sources, from))
  }
  await move('Main.lean', 'Proofs/Moved.lean')
  const afterFirstMove = writes.length
  // A delayed rejection from an old subscription cannot poison the new file.
  for (const ws of adapters)
    ws.send(
      JSON.stringify({
        type: 'error',
        path: 'Main.lean',
        status: 409,
        message: 'Retired old-path request.',
      }),
    )
  await type(owner, '\n-- OWNER_AFTER_MOVE\n')
  await type(peer, '\n-- PEER_AFTER_MOVE\n')
  await until(
    () =>
      sources['Proofs/Moved.lean'].includes('OWNER_AFTER_MOVE') &&
      sources['Proofs/Moved.lean'].includes('PEER_AFTER_MOVE'),
    'both editors save after terminal move',
  )
  await until(
    async () =>
      (await text(owner)).includes('PEER_AFTER_MOVE') &&
      (await text(peer)).includes('OWNER_AFTER_MOVE'),
    'both editors converge',
  )
  assert(
    writes.slice(afterFirstMove).every((write) => write.path !== 'Main.lean'),
  )
  await move('Proofs/Moved.lean', 'Proofs/Renamed.lean')
  await type(peer, '\n-- AFTER_SECOND_MOVE\n')
  await until(
    () => sources['Proofs/Renamed.lean'].includes('AFTER_SECOND_MOVE'),
    'continued saving after a second move',
  )
  await terminal
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  await owner.page
    .locator('.file-item')
    .and(owner.page.getByTitle('lakefile.toml', { exact: true }))
    .click()
  await opened(owner, 'lakefile.toml')
  await type(owner, '\n# CONFIG_AFTER_MOVE\n')
  await until(
    () => sources['lakefile.toml'].includes('CONFIG_AFTER_MOVE'),
    'configuration still saves through HTTP',
  )

  const select = async (fixture, filename) => {
    await fixture.page
      .locator('.file-item')
      .and(fixture.page.getByTitle(filename, { exact: true }))
      .click()
    await opened(fixture, path.posix.basename(filename))
  }

  for (const fixture of [owner, peer]) {
    await fixture.page
      .locator('.folder-toggle')
      .and(fixture.page.getByTitle('Linked', { exact: true }))
      .click()
    await select(fixture, 'Linked/Proof.lean')
  }
  const movedDraft = holdWrite('DRAFT_DURING_REFERENCE_MOVE')
  await type(peer, '\n-- DRAFT_DURING_REFERENCE_MOVE\n')
  await until(
    () => movedDraft.entered,
    'a peer has unpublished typing inside the folder being moved',
  )
  sources['Archive/Proof.lean'] = sources['Linked/Proof.lean'].replace(
    'Linked.Helper',
    'Archive.Helper',
  )
  sources['Archive/Helper.lean'] = sources['Linked/Helper.lean']
  delete sources['Linked/Proof.lean']
  delete sources['Linked/Helper.lean']
  notify({
    paths: ['Linked', 'Archive', 'Archive/Proof.lean'],
    removedPaths: ['Linked'],
    moves: [{ from: 'Linked', to: 'Archive' }],
  })
  movedDraft.release()
  await until(
    () =>
      sources['Archive/Proof.lean'].includes('DRAFT_DURING_REFERENCE_MOVE') &&
      sources['Archive/Proof.lean'].includes('Archive.Helper'),
    'moved-file imports and pending typing save together',
  )
  await until(
    async () =>
      (await text(owner)).includes('Archive.Helper') &&
      (await text(peer)).includes('Archive.Helper'),
    'both editors show the rewritten import at the new path',
  )
  await type(owner, '\n-- OWNER_AFTER_REFERENCE_MOVE\n')
  await until(
    async () =>
      (await text(owner)).includes('DRAFT_DURING_REFERENCE_MOVE') &&
      (await text(peer)).includes('OWNER_AFTER_REFERENCE_MOVE') &&
      sources['Archive/Proof.lean'].includes('OWNER_AFTER_REFERENCE_MOVE'),
    'both editors continue collaborating after a move rewrites imports',
  )
  assert(!Object.hasOwn(sources, 'Linked/Proof.lean'))
  for (const fixture of [owner, peer])
    assert(
      !(await fixture.page.locator('[role="alert"]').allTextContents()).some(
        (message) => /changed while disconnected/.test(message),
      ),
      'an announced move with disjoint edits must not leave autosave blocked',
    )

  await select(owner, 'Notes.lean')
  await select(peer, 'Notes.lean')
  const orphanedSave = holdWrite('KEEP_DELETED_DRAFT')
  await type(owner, '\n-- KEEP_DELETED_DRAFT\n')
  await until(
    () => orphanedSave.entered,
    'a deleted document has unacknowledged local typing',
  )
  delete sources['Notes.lean']
  notify({ paths: ['Notes.lean'], removedPaths: ['Notes.lean'] })
  await owner.page
    .getByRole('button', { name: 'Download draft: Notes.lean', exact: true })
    .waitFor()
  assert((await text(owner)).includes('KEEP_DELETED_DRAFT'))
  orphanedSave.release()
  await select(owner, 'Other.lean')
  await type(owner, '\n-- SAVE_WITH_DETACHED_DRAFT\n')
  await until(
    () => sources['Other.lean'].includes('SAVE_WITH_DETACHED_DRAFT'),
    'an unrelated live file saves while an orphaned draft is retained',
  )
  await select(owner, 'lakefile.toml')
  await type(owner, '\n# REST_WITH_DETACHED_DRAFT\n')
  await until(
    () => sources['lakefile.toml'].includes('REST_WITH_DETACHED_DRAFT'),
    'ordinary saving ignores unavailable drafts',
  )
  await owner.page
    .getByRole('button', { name: 'Save a copy: Notes.lean', exact: true })
    .click()
  const recover = owner.page.getByRole('dialog', {
    name: 'Save draft as a new file',
    exact: true,
  })
  const name = recover.getByLabel('File name', { exact: true })
  await name.fill('Other.lean')
  const originalOther = sources['Other.lean']
  await recover
    .getByRole('button', { name: 'Save a copy', exact: true })
    .click()
  await recover.locator('.error-message').waitFor()
  assert.equal(
    sources['Other.lean'],
    originalOther,
    'recovery cannot replace an existing file',
  )
  await name.fill('Recovered.lean')
  let failRecoveryRefresh = true
  await owner.page.route(`**/api/projects/${projectId}/files`, (route) => {
    if (failRecoveryRefresh) {
      return route.fulfill({
        status: 503,
        json: { error: 'Fixture recovery refresh interrupted.' },
      })
    }
    return route.fallback()
  })
  await recover
    .getByRole('button', { name: 'Save a copy', exact: true })
    .click()
  await recover
    .getByText('Fixture recovery refresh interrupted.', { exact: true })
    .waitFor()
  failRecoveryRefresh = false
  assert(sources['Recovered.lean'].includes('KEEP_DELETED_DRAFT'))
  assert.equal(
    await owner.page
      .locator('.draft-downloads button')
      .filter({ hasText: 'Notes.lean' })
      .count(),
    1,
    'a failed refresh must leave the original draft recoverable',
  )
  await recover
    .getByRole('button', { name: 'Save a copy', exact: true })
    .click()
  await recover.waitFor({ state: 'hidden' })
  await opened(owner, 'Recovered.lean')
  assert(sources['Recovered.lean'].includes('KEEP_DELETED_DRAFT'))
  assert(!Object.hasOwn(sources, 'Notes.lean'))
  const recoveredSource = sources['Recovered.lean']

  await select(peer, 'Recovered.lean')
  pausePeerReconnect = true
  const peerSocket = adapters.findLast(
    (ws) => ws.actor === 'terminal-peer' && ws.readyState === 1,
  )
  peerSocket.close(1011, 'Fixture disconnect')
  await type(peer, '\n-- OFFLINE_DRAFT_TO_KEEP\n')
  delete sources['Recovered.lean']
  notify({ paths: ['Recovered.lean'], removedPaths: ['Recovered.lean'] })
  await until(
    () => !!resumePeer,
    'the disconnected editor attempts to reconnect',
  )
  pausePeerReconnect = false
  resumePeer()
  await peer.page
    .getByRole('button', {
      name: 'Download draft: Recovered.lean',
      exact: true,
    })
    .waitFor()
  assert((await text(peer)).includes('OFFLINE_DRAFT_TO_KEEP'))
  await select(peer, 'Other.lean')
  await type(peer, '\n-- SAVE_AFTER_MISSED_DELETE\n')
  await until(
    () => sources['Other.lean'].includes('SAVE_AFTER_MISSED_DELETE'),
    'saving continues after a deletion missed while disconnected',
  )
  assert(!Object.hasOwn(sources, 'Recovered.lean'))

  sources['Recovered.lean'] = recoveredSource
  notify({ paths: ['Recovered.lean'] })
  await select(owner, 'Recovered.lean')
  await until(
    async () =>
      !(await owner.page
        .locator('.file-tab')
        .getByText('Read only', { exact: true })
        .count()),
    'reopened restored source is editable',
  )
  await opened(owner, 'Recovered.lean')
  await type(owner, '\n-- EDIT_AFTER_RESTORING_IDENTICAL_FILE\n')
  await until(
    () =>
      sources['Recovered.lean'].includes('EDIT_AFTER_RESTORING_IDENTICAL_FILE'),
    'explicitly reopening an identical restored file clears its read-only removed view',
  )
  await select(peer, 'Recovered.lean')
  assert.equal(
    await peer.page
      .locator('.file-tab')
      .getByText('Read only', { exact: true })
      .count(),
    1,
  )
  assert(
    !sources['Recovered.lean'].includes('OFFLINE_DRAFT_TO_KEEP'),
    'viewing a restored path cannot replay its detached draft',
  )
  assert.equal(
    await peer.page
      .getByRole('button', {
        name: 'Download draft: Recovered.lean',
        exact: true,
      })
      .count(),
    1,
    'restoring a path cannot automatically publish an offline draft into its new document',
  )

  // Reusing the original saved bytes must not reattach a draft belonging to
  // the deleted document when the restored document is subsequently renamed.
  sources['Recovered.lean'] = recoveredSource
  notify({ paths: ['Recovered.lean'] })
  await until(
    async () =>
      !(await text(owner)).includes('EDIT_AFTER_RESTORING_IDENTICAL_FILE'),
    'the restored source has its original saved baseline again',
  )
  sources['RestoredRenamed.lean'] = sources['Recovered.lean']
  delete sources['Recovered.lean']
  notify({
    paths: ['Recovered.lean', 'RestoredRenamed.lean'],
    removedPaths: ['Recovered.lean'],
    moves: [{ from: 'Recovered.lean', to: 'RestoredRenamed.lean' }],
  })
  await opened(owner, 'RestoredRenamed.lean')
  await peer.page
    .getByRole('button', {
      name: 'Download draft: Recovered.lean',
      exact: true,
    })
    .waitFor()
  assert((await text(peer)).includes('OFFLINE_DRAFT_TO_KEEP'))
  await select(peer, 'RestoredRenamed.lean')
  assert(!(await text(peer)).includes('OFFLINE_DRAFT_TO_KEEP'))
  await type(peer, '\n-- EDIT_NEW_DOCUMENT_AFTER_RENAME\n')
  await until(
    () =>
      sources['RestoredRenamed.lean'].includes(
        'EDIT_NEW_DOCUMENT_AFTER_RENAME',
      ),
    'the renamed replacement document saves independently of the old draft',
  )
  assert(!sources['RestoredRenamed.lean'].includes('OFFLINE_DRAFT_TO_KEEP'))
  assert(!Object.hasOwn(sources, 'Recovered.lean'))

  sources['PendingOpen.lean'] = '-- source opened during a move\n'
  notify({ paths: ['PendingOpen.lean'] })
  let openReadEntered = false
  let releaseOpenRead
  const openReadGate = new Promise((resolve) => {
    releaseOpenRead = resolve
  })
  releaseReads.push(releaseOpenRead)
  await owner.page.route(
    `**/api/projects/${projectId}/file?path=PendingOpen.lean`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const content = sources['PendingOpen.lean']
      openReadEntered = true
      await openReadGate
      return route.fulfill({ json: { content, hash: hash(content) } })
    },
  )
  await owner.page
    .locator('.file-item')
    .and(owner.page.getByTitle('PendingOpen.lean', { exact: true }))
    .click()
  await until(() => openReadEntered, 'a file open holds its source response')
  sources['PendingRenamed.lean'] = sources['PendingOpen.lean']
  delete sources['PendingOpen.lean']
  notify({
    paths: ['PendingOpen.lean', 'PendingRenamed.lean'],
    removedPaths: ['PendingOpen.lean'],
    moves: [{ from: 'PendingOpen.lean', to: 'PendingRenamed.lean' }],
  })
  await opened(owner, 'PendingRenamed.lean')
  const oldOpenResponse = owner.page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get('path') === 'PendingOpen.lean',
  )
  releaseOpenRead()
  await (await oldOpenResponse).finished()
  await type(owner, '\n-- SAVE_AFTER_PENDING_OPEN_MOVE\n')
  await until(
    () =>
      sources['PendingRenamed.lean'].includes('SAVE_AFTER_PENDING_OPEN_MOVE'),
    'a moved pending open saves at the new path',
  )
  assert(!Object.hasOwn(sources, 'PendingOpen.lean'))

  let reloadReadEntered = false
  let releaseReloadRead
  const reloadReadGate = new Promise((resolve) => {
    releaseReloadRead = resolve
  })
  releaseReads.push(releaseReloadRead)
  await owner.page.route(
    `**/api/projects/${projectId}/file?path=PendingRenamed.lean`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const content = sources['PendingRenamed.lean']
      reloadReadEntered = true
      await reloadReadGate
      return route.fulfill({ json: { content, hash: hash(content) } })
    },
  )
  await owner.page
    .getByRole('button', { name: 'Reload file', exact: true })
    .click()
  const reloadDialog = owner.page.getByRole('dialog', {
    name: 'Reload saved file',
    exact: true,
  })
  await reloadDialog
    .getByRole('button', { name: 'Reload this file', exact: true })
    .click()
  await until(() => reloadReadEntered, 'a reload holds its source response')
  sources['FinalPending.lean'] = sources['PendingRenamed.lean']
  delete sources['PendingRenamed.lean']
  notify({
    paths: ['PendingRenamed.lean', 'FinalPending.lean'],
    removedPaths: ['PendingRenamed.lean'],
    moves: [{ from: 'PendingRenamed.lean', to: 'FinalPending.lean' }],
  })
  await opened(owner, 'FinalPending.lean')
  const oldReloadResponse = owner.page.waitForResponse(
    (response) =>
      new URL(response.url()).searchParams.get('path') ===
      'PendingRenamed.lean',
  )
  releaseReloadRead()
  await (await oldReloadResponse).finished()
  await reloadDialog.waitFor({ state: 'hidden' })
  await type(owner, '\n-- SAVE_AFTER_PENDING_RELOAD_MOVE\n')
  await until(
    () =>
      sources['FinalPending.lean'].includes('SAVE_AFTER_PENDING_RELOAD_MOVE'),
    'a delayed reload cannot select or recreate the old path',
  )
  assert(!Object.hasOwn(sources, 'PendingRenamed.lean'))

  let deletedReloadEntered = false
  let releaseDeletedReload
  const deletedReloadGate = new Promise((resolve) => {
    releaseDeletedReload = resolve
  })
  releaseReads.push(releaseDeletedReload)
  await owner.page.route(
    `**/api/projects/${projectId}/file?path=FinalPending.lean`,
    async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      const content = sources['FinalPending.lean']
      deletedReloadEntered = true
      await deletedReloadGate
      return route.fulfill({ json: { content, hash: hash(content) } })
    },
  )
  const deletedReloadSave = holdWrite('KEEP_DELETED_DURING_RELOAD')
  await type(owner, '\n-- KEEP_DELETED_DURING_RELOAD\n')
  await until(
    () => deletedReloadSave.entered,
    'reload has an unacknowledged draft',
  )
  await owner.page
    .getByRole('button', { name: 'Reload file', exact: true })
    .click()
  await reloadDialog
    .getByRole('button', { name: 'Reload this file', exact: true })
    .click()
  await until(
    () => deletedReloadEntered,
    'the deleted file has an in-flight reload',
  )
  delete sources['FinalPending.lean']
  notify({ paths: ['FinalPending.lean'], removedPaths: ['FinalPending.lean'] })
  await owner.page
    .getByRole('button', {
      name: 'Download draft: FinalPending.lean',
      exact: true,
    })
    .waitFor()
  releaseDeletedReload()
  deletedReloadSave.release()
  await reloadDialog.waitFor({ state: 'hidden' })
  assert((await text(owner)).includes('KEEP_DELETED_DURING_RELOAD'))
  assert.equal(
    await owner.page
      .locator('.file-tab')
      .getByText('Read only', { exact: true })
      .count(),
    1,
  )
  assert(!Object.hasOwn(sources, 'FinalPending.lean'))

  await select(owner, 'Other.lean')
  await owner.page
    .getByRole('button', { name: 'Terminal', exact: true })
    .click()
  await terminal.getByText('Connected', { exact: true }).waitFor()
  const mergedSave = holdWrite('LOCAL_EDIT_DURING_TERMINAL_CHANGE')
  await type(owner, '\n-- LOCAL_EDIT_DURING_TERMINAL_CHANGE\n')
  await until(
    () => mergedSave.entered,
    'a live edit is waiting while the terminal changes its source',
  )
  sources['Other.lean'] += '\n-- EXTERNAL_EDIT_TO_MERGE\n'
  notify({ paths: ['Other.lean'] })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal(
    await owner.page.locator('.live-edit-alert').count(),
    0,
    'live-managed files do not show an HTTP refresh conflict while a write is pending',
  )
  mergedSave.release()
  await until(
    () =>
      sources['Other.lean'].includes('LOCAL_EDIT_DURING_TERMINAL_CHANGE') &&
      sources['Other.lean'].includes('EXTERNAL_EDIT_TO_MERGE'),
    'both live and terminal edits are saved after a merge',
  )
  await owner.page.locator('.live-edit-alert').waitFor({ state: 'hidden' })
  const opensBeforeDelayedUpdate = liveOpenRequests.filter(
    (request) =>
      request.actor === 'terminal-owner' && request.path === 'Other.lean',
  ).length
  heldDocuments = { actor: 'terminal-owner', path: 'Other.lean', messages: [] }
  sources['Other.lean'] += '\n-- READABLE_BEFORE_LIVE_UPDATE\n'
  notify({ paths: ['Other.lean'] })
  await until(
    () => heldDocuments.messages.length > 0,
    'saved source is readable while its live update is delayed',
  )
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal(
    liveOpenRequests.filter(
      (request) =>
        request.actor === 'terminal-owner' && request.path === 'Other.lean',
    ).length,
    opensBeforeDelayedUpdate,
    'terminal polling cannot replace an existing live subscription',
  )
  await type(owner, '\n-- TYPING_DURING_DELAYED_LIVE_UPDATE\n')
  await until(
    () => sources['Other.lean'].includes('TYPING_DURING_DELAYED_LIVE_UPDATE'),
    'typing remains saveable while incoming live packets are delayed',
  )
  const delayedMessages = heldDocuments.messages
  heldDocuments = null
  for (const deliver of delayedMessages) deliver()
  await until(
    async () => (await text(owner)).includes('READABLE_BEFORE_LIVE_UPDATE'),
    'the existing live subscription receives the delayed update',
  )
  assert.equal(await owner.page.locator('.live-edit-alert').count(), 0)
  assert(sources['Other.lean'].includes('READABLE_BEFORE_LIVE_UPDATE'))
  terminalSockets.at(-1).send(
    JSON.stringify({
      type: 'sync',
      state: 'paused',
      message: 'Other.lean changed in the browser.',
    }),
  )
  await terminal.locator('.terminal-sync-alert').waitFor()
  assert(
    (await terminal.locator('.terminal-sync-alert').innerText()).includes(
      'Open a new terminal',
    ),
  )
  terminalSockets
    .at(-1)
    .close({ code: 1011, reason: 'Fixture terminal disconnect' })
  const reconnectSave = holdWrite('SAVE_BEFORE_TERMINAL_RECONNECT')
  await type(owner, '\n-- SAVE_BEFORE_TERMINAL_RECONNECT\n')
  const beforeReconnect = terminalSockets.length
  await terminal
    .getByRole('button', { name: 'Reconnect terminal', exact: true })
    .click()
  await until(
    () => reconnectSave.entered,
    'terminal reconnect waits for its pending browser save',
  )
  assert.equal(terminalSockets.length, beforeReconnect)
  await editor(owner).focus()
  reconnectSave.release()
  await terminal.getByText('Connected', { exact: true }).waitFor()
  assert.equal(terminalSockets.length, beforeReconnect + 1)
  assert(
    await editor(owner).evaluate(
      (element) => document.activeElement === element,
    ),
    'a delayed terminal reconnect must not steal editor focus',
  )

  let staleListings = 0
  await owner.page.route(`**/api/projects/${projectId}/files`, (route) => {
    if (staleListings < 2) {
      staleListings++
      return route.fulfill({
        json: Object.entries(sources)
          .filter(([name]) => name !== 'Other.lean')
          .map(([path, content]) => ({ path, size: content.length })),
      })
    }
    return route.fallback()
  })
  const confirmed = owner.page.waitForResponse((response) => {
    const url = new URL(response.url())
    return (
      staleListings >= 1 &&
      response.request().method() === 'GET' &&
      url.pathname === `/api/projects/${projectId}/file` &&
      url.searchParams.get('path') === 'Other.lean'
    )
  })
  notify({ paths: [] })
  await until(
    () => staleListings >= 2,
    'terminal refresh receives a stale listing',
  )
  await confirmed
  await type(owner, '\n-- EDIT_AFTER_STALE_LISTING\n')
  await until(
    () => sources['Other.lean'].includes('EDIT_AFTER_STALE_LISTING'),
    'a stale listing cannot detach an existing source',
  )
  assert.equal(
    await owner.page
      .locator('.file-tab')
      .getByText('Read only', { exact: true })
      .count(),
    0,
  )

  await select(peer, 'RestOnly.lean')
  pausePeerReconnect = true
  resumePeer = null
  adapters
    .findLast((ws) => ws.actor === 'terminal-peer' && ws.readyState === 1)
    .close(1011, 'Fixture ordinary-save disconnect')
  await type(peer, '\n-- KEEP_OFFLINE_ORDINARY_DRAFT\n')
  delete sources['RestOnly.lean']
  notify({ paths: ['RestOnly.lean'], removedPaths: ['RestOnly.lean'] })
  await until(() => !!resumePeer, 'ordinary-saving tab reconnects')
  pausePeerReconnect = false
  resumePeer()
  await peer.page
    .getByRole('button', { name: 'Download draft: RestOnly.lean', exact: true })
    .waitFor()
  await select(peer, 'Other.lean')
  await type(peer, '\n-- SAVE_AFTER_ORDINARY_FILE_DISAPPEARED\n')
  await until(
    () =>
      sources['Other.lean'].includes('SAVE_AFTER_ORDINARY_FILE_DISAPPEARED'),
    'ordinary-saving missed deletions do not freeze healthy files',
  )
  assert(!Object.hasOwn(sources, 'RestOnly.lean'))
  await terminal
    .getByRole('button', { name: 'Close terminal', exact: true })
    .click()
  for (const fixture of fixtures) fixture.assertClean()
  assert.equal(terminalMoves.length, 2)
  const report = {
    passed: true,
    checks: [
      'Two live editors follow terminal file moves and continue receiving and saving each other’s edits.',
      'Late old-path errors cannot stop destination saves or recreate old files.',
      'Repeated terminal moves keep the editor attached, and unrelated configuration saves still work.',
      'Moving a folder while rewriting imports preserves a peer’s unpublished typing and both editors continue saving at the new path.',
      'Terminal startup waits for durable browser saves before taking its working copy.',
      'Terminal reconnect also waits for durable browser saves before opening another private copy.',
      'A deletion with unacknowledged typing preserves the draft and lets unrelated live and HTTP saves continue.',
      'Save a copy rejects existing destinations, saves a new file, and never recreates the removed path.',
      'A recovery refresh failure keeps the original draft; retrying the acknowledged creation is idempotent.',
      'A reconnect after a missed deletion keeps offline edits and allows continued work in other files.',
      'Identical restored files can be reopened and edited while another tab’s offline draft stays protected.',
      'Renaming a restored file cannot revive or publish a draft belonging to its deleted predecessor.',
      'Moves during pending opens and reloads follow the new path and reject delayed old-path responses.',
      'Deletion during an in-flight reload keeps the newest draft protected and cannot revive its removed path.',
      'Paused terminal synchronization stays visible with recovery guidance.',
      'Live-managed files avoid HTTP conflict warnings and preserve subscriptions when disk reads outrun delayed live updates.',
      'Stale or bounded listings cannot detach a source that still exists.',
      'Ordinary-saving files reconcile missed deletions after reconnect while retaining offline drafts.',
    ],
  }
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report))
} catch (error) {
  const diagnostics = []
  for (const fixture of fixtures)
    diagnostics.push({
      tab: await fixture.page.locator('.file-tab').innerText(),
      editor: await text(fixture),
      alerts: await fixture.page.locator('[role="alert"]').allTextContents(),
      loading: await fixture.page.locator('.editor-loading').count(),
    })
  await fs.writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      { message: error.message, diagnostics, sources, writes },
      null,
      2,
    ) + '\n',
  )
  throw error
} finally {
  heldWrite?.release()
  for (const release of releaseReads) release()
  for (const fixture of fixtures) await fixture.browser.close()
  await documents.close()
  await new Promise((resolve) => server.close(resolve))
}
