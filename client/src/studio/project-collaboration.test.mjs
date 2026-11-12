import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import * as Y from 'yjs'
import { createHash } from 'node:crypto'
import { ProjectDocuments } from '../../../server/project-documents.mjs'
import {
  replaceDocumentText,
  documentTextEdit,
  documentOffsetAfterEdit,
} from '../../../shared/document-text.mjs'
import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'
import { sourceFileByteLimit } from '../../../shared/source-limits.mjs'

function transpile(name, imports = {}) {
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL(name, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  )
  const module = { exports: {} }
  new Function('exports', 'module', 'require', outputText)(
    module.exports,
    module,
    (name) => {
      if (name in imports) return imports[name]
      throw new Error(`Unexpected module ${name}`)
    },
  )
  return module.exports
}
const { WorkspaceBuffers } = transpile('./workspaceBuffers.ts')
const { LocalDocumentHistory } = transpile('./localDocumentHistory.ts', {
  yjs: Y,
  '../../../shared/document-text.mjs': { documentTextEdit },
})
const hash = (content) => createHash('sha256').update(content).digest('hex')
const wire = (doc, content = doc.getText('source').toString(), extra = {}) => ({
  type: 'document',
  path: 'Main.lean',
  documentId: 'document-1',
  update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
  content,
  hash: hash(content),
  ...extra,
})

function deltaWire(doc, vector, extra = {}) {
  const message = wire(doc, undefined, extra)
  delete message.content
  message.update = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString(
    'base64',
  )
  return message
}

function openedWire(doc, socket = Socket.instances.at(-1)) {
  return wire(doc, undefined, {
    openRequestId: socket.sent
      .filter((message) => message.type === 'open')
      .at(-1)?.requestId,
  })
}

class Socket extends EventTarget {
  static OPEN = 1
  static instances = []
  readyState = 1
  bufferedAmount = 0
  sent = []
  constructor() {
    super()
    Socket.instances.push(this)
  }
  send(raw) {
    this.sent.push(JSON.parse(raw))
  }
  receive(message) {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(message) }),
    )
  }
  close(code = 1000) {
    this.readyState = 3
    const event = new Event('close')
    Object.defineProperty(event, 'code', { value: code })
    this.dispatchEvent(event)
  }
}
function fixture(t, initial = 'base source\n', options = {}) {
  const previous = {
    WebSocket: globalThis.WebSocket,
    location: globalThis.location,
  }
  globalThis.WebSocket = Socket
  globalThis.location = { protocol: 'http:', host: 'fixture.test' }
  Socket.instances = []
  const cleanups = []
  const refs = []
  const effects = []
  const states = []
  let refIndex = 0,
    effectIndex = 0,
    stateIndex = 0
  const react = {
    useCallback: (fn) => fn,
    useRef: (value) => {
      const index = refIndex++
      return (refs[index] ??= { current: value })
    },
    useState: (value) => {
      const index = stateIndex++
      if (!(index in states)) states[index] = value
      return [
        states[index],
        (update) => {
          states[index] =
            typeof update === 'function' ? update(states[index]) : update
        },
      ]
    },
    useEffect: (fn, dependencies) => {
      const index = effectIndex++
      const previous = effects[index]
      if (
        previous &&
        dependencies.every((value, i) => Object.is(value, previous[i]))
      )
        return
      cleanups[index]?.()
      effects[index] = dependencies
      cleanups[index] = fn()
    },
  }
  const { useProjectCollaboration } = transpile(
    './useProjectCollaboration.ts',
    {
      react,
      yjs: Y,
      './localDocumentHistory': { LocalDocumentHistory },
      './api': { sessionBoundUrl: (value) => value },
      '../../../shared/source-limits.mjs': { sourceFileByteLimit },
      '../../../shared/document-text.mjs': {
        replaceDocumentText: options.replaceDocumentText || replaceDocumentText,
      },
      '../../../shared/project-configuration.mjs': {
        PROJECT_CONFIGURATION_FILES,
      },
    },
  )
  const store = new WorkspaceBuffers()
  store.selectProject('project')
  store.setFile({
    path: 'Main.lean',
    content: options.draft ?? initial,
    savedContent: initial,
    hash: hash(initial),
    generation: 1,
  })
  let lastCanEdit = options.canEdit ?? true,
    lastEnabled = true
  const rerender = (canEdit = lastCanEdit, enabled = lastEnabled) => {
    lastCanEdit = canEdit
    lastEnabled = enabled
    refIndex = 0
    effectIndex = 0
    stateIndex = 0
    return useProjectCollaboration({
      store,
      scope: store.getSnapshot().scope,
      enabled,
      canEdit,
      onAccessChanged: options.onAccessChanged,
    })
  }
  const hook = rerender()
  const socket = Socket.instances.at(-1)
  const server = new Y.Doc()
  server.getText('source').insert(0, initial)
  if (!options.deferReady) {
    socket.receive({ type: 'ready' })
    socket.receive(openedWire(server, socket))
  }
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup?.()
    server.destroy()
    globalThis.WebSocket = previous.WebSocket
    globalThis.location = previous.location
  })
  return { store, socket, server, hook, rerender }
}

test('remote updates arriving before the send debounce preserve both local typing and remote text', async (t) => {
  const { store, socket, server, hook } = fixture(t)
  store.change('Main.lean', '-- local typed now\nbase source\n')
  // No timer has fired. The collaborator commits against the original state.
  const vector = Y.encodeStateVector(server)
  server
    .getText('source')
    .insert(server.getText('source').length, '-- remote\n')
  socket.receive(deltaWire(server, vector))
  assert.match(store.getSnapshot().file.content, /local typed now/)
  assert.match(store.getSnapshot().file.content, /remote/)
  assert.equal(
    store.getSnapshot().file.savedContent,
    'base source\n-- remote\n',
  )
  const request = socket.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.ok(request)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(request.update, 'base64')))
  socket.receive(wire(server, undefined, { ack: request.requestId }))
  assert.equal(await hook.flush(), true)
  assert.deepEqual(store.dirty(), [])
  assert.equal(
    store.getSnapshot().file.content,
    server.getText('source').toString(),
  )
})

test('lost acknowledgements retain the draft and prevent an unsafe fallback save', async (t) => {
  const { store, socket, hook } = fixture(t)
  store.change('Main.lean', '-- unsent draft\nbase source\n')
  // Force local capture and an outstanding request without acknowledging it.
  const flushing = hook.flush()
  socket.close(1006)
  await assert.rejects(flushing, /interrupted/)
  await assert.rejects(hook.flush(), /connection to return/)
  assert.match(store.getSnapshot().file.content, /unsent draft/)
  assert.equal(store.getSnapshot().file.savedContent, 'base source\n')
})

test('canonical shared acknowledgements preserve newer local typing', async (t) => {
  const { store, socket, server, hook } = fixture(t)
  store.change('Main.lean', 'first local\nbase source\n')
  const flushing = hook.flush()
  const first = socket.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(first.update, 'base64')))
  store.change('Main.lean', 'first local\nbase source\nsecond local\n')
  socket.receive(wire(server, undefined, { ack: first.requestId }))
  assert.match(store.getSnapshot().file.content, /second local/)
  const second = socket.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.notEqual(second.requestId, first.requestId)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(second.update, 'base64')))
  socket.receive(wire(server, undefined, { ack: second.requestId }))
  await flushing
  assert.deepEqual(store.dirty(), [])
})

test('configuration stays on REST saves after pending live document edits are acknowledged', async (t) => {
  const { store, socket, server, hook } = fixture(t)
  store.change('Main.lean', '-- pending source\nbase source\n')
  store.setFile({
    path: 'lakefile.lean',
    content: 'new configuration',
    savedContent: 'old configuration',
    hash: hash('old configuration'),
    generation: 2,
  })
  const flushing = hook.flush()
  const request = socket.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.equal(request.path, 'Main.lean')
  assert.ok(!socket.sent.some((message) => message.path === 'lakefile.lean'))
  Y.applyUpdate(server, new Uint8Array(Buffer.from(request.update, 'base64')))
  socket.receive(wire(server, undefined, { ack: request.requestId }))
  assert.equal(await flushing, false)
  assert.deepEqual(
    store.dirty().map((file) => file.path),
    ['lakefile.lean'],
  )
})

test('rejected persistence preserves its draft and allows an explicit reload to recover', async (t) => {
  for (const status of [409, 403])
    await t.test(`HTTP status ${status}`, async (t) => {
      const { store, socket, server, hook } = fixture(t)
      store.change('Main.lean', `-- retain failed ${status}\nbase source\n`)
      const flushing = hook.flush()
      const request = socket.sent
        .filter((message) => message.type === 'update')
        .at(-1)
      socket.receive({
        type: 'error',
        path: 'Main.lean',
        requestId: request.requestId,
        status,
        message: `Persist rejected ${status}; reload before retrying.`,
      })
      await assert.rejects(flushing, new RegExp(`Persist rejected ${status}`))
      assert.match(
        store.getSnapshot().file.content,
        new RegExp(`retain failed ${status}`),
      )
      assert.equal(store.getSnapshot().file.savedContent, 'base source\n')
      await assert.rejects(hook.flush(), /Persist rejected/)
      // The user's explicit reload is the only action that abandons these ops.
      store.setFile({
        ...store.getSnapshot().file,
        content: 'base source\n',
        savedContent: 'base source\n',
        generation: 2,
      })
      const recovered = hook.flush()
      socket.receive(openedWire(server, socket))
      assert.equal(await recovered, true)
      assert.deepEqual(store.dirty(), [])
    })
})

test('temporary capacity errors reconnect and replay unacknowledged edits', async (t) => {
  const { store, socket, server, hook } = fixture(t)
  store.change('Main.lean', '-- keep under pressure\nbase source\n')
  const flushing = hook.flush()
  const request = socket.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  socket.receive({
    type: 'error',
    path: 'Main.lean',
    requestId: request.requestId,
    status: 429,
    message: 'Temporarily busy.',
  })
  await assert.rejects(flushing, /Temporarily busy/)
  assert.match(store.getSnapshot().file.content, /keep under pressure/)
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reopened = Socket.instances.at(-1)
  assert.notEqual(reopened, socket)
  reopened.receive({ type: 'ready' })
  reopened.receive(openedWire(server, reopened))
  const replayed = reopened.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.ok(replayed)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(replayed.update, 'base64')))
  reopened.receive(wire(server, undefined, { ack: replayed.requestId }))
  assert.equal(await hook.flush(), true)
  assert.deepEqual(store.dirty(), [])
})

test('remote middle edits preserve distant source and track selection offsets', () => {
  const original = 'header\n\nexample : True := by trivial\n\nfooter\n'
  const next = original.replace('by trivial', 'by\n  trivial')
  const edit = documentTextEdit(original, next)
  assert.equal(
    original.slice(0, edit.start) +
      edit.insert +
      original.slice(edit.start + edit.deleteCount),
    next,
  )
  assert.ok(edit.deleteCount < original.length / 2)
  assert.equal(documentOffsetAfterEdit(3, edit), 3)
  assert.equal(
    documentOffsetAfterEdit(original.indexOf('footer'), edit),
    next.indexOf('footer'),
  )
  const emoji = documentTextEdit('A 👋 B', 'A 🌍 B')
  assert.equal(emoji.start, 2)
  assert.equal(emoji.deleteCount, 2)
})

test('offline typing in an initialized live file cannot fall back to a REST save and reconnect inserts it once', async (t) => {
  const { store, socket, server, hook } = fixture(t)
  socket.close(1006)
  store.change('Main.lean', 'Xbase source\n')
  await assert.rejects(hook.flush(), /connection to return/)
  assert.equal(store.getSnapshot().file.savedContent, 'base source\n')
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reconnect = Socket.instances.at(-1)
  assert.notEqual(reconnect, socket)
  reconnect.receive({ type: 'ready' })
  reconnect.receive(openedWire(server, reconnect))
  const updates = reconnect.sent.filter((message) => message.type === 'update')
  assert.equal(updates.length, 1)
  Y.applyUpdate(
    server,
    new Uint8Array(Buffer.from(updates[0].update, 'base64')),
  )
  reconnect.receive(wire(server, undefined, { ack: updates[0].requestId }))
  assert.equal(await hook.flush(), true)
  assert.equal(server.getText('source').toString(), 'Xbase source\n')
  assert.equal(store.getSnapshot().file.content, 'Xbase source\n')
})

test('retained buffers exceeding the live subscription limit use hash saving without reconnecting every file', async (t) => {
  const { store, socket, hook } = fixture(t)
  store.register(
    Array.from({ length: 21 }, (_, index) => ({
      path: `File${index}.lean`,
      content: '-- saved\n',
      hash: hash('-- saved\n'),
      unsaved: false,
    })),
  )
  assert.equal(await hook.flush(), true)
  const opens = socket.sent.filter((message) => message.type === 'open')
  const active = new Set(opens.map((message) => message.path))
  assert.equal(active.size, 16)
  const normal = [...store.getSnapshot().buffers.keys()].find(
    (path) => !active.has(path),
  )
  assert.ok(normal)
  store.change(normal, '-- normal hash save\n')
  assert.equal(await hook.flush(), false)
  assert.equal(Socket.instances.length, 1)
  assert.equal(socket.readyState, Socket.OPEN)
  assert.equal(
    store.getSnapshot().buffers.get(normal).content,
    '-- normal hash save\n',
  )
})

test('subscription capacity rejection falls back only that unopened file without closing other live documents', async (t) => {
  const { store, socket, hook } = fixture(t)
  store.setFile({
    path: 'Overflow.lean',
    content: '-- saved\n',
    savedContent: '-- saved\n',
    hash: hash('-- saved\n'),
    generation: 2,
  })
  await hook.flush()
  socket.receive({
    type: 'error',
    path: 'Overflow.lean',
    status: 429,
    message: 'Open at most 16 files.',
  })
  store.change('Overflow.lean', '-- retain ordinary save\n')
  assert.equal(await hook.flush(), false)
  assert.equal(socket.readyState, Socket.OPEN)
  assert.equal(Socket.instances.length, 1)
})

test('a policy close refreshes membership then reconnects an account that still has access', async (t) => {
  let refreshes = 0
  const { store, socket, server, hook } = fixture(t, 'base source\n', {
    onAccessChanged: async () => {
      refreshes++
    },
  })
  socket.close(1008)
  await new Promise((resolve) => setTimeout(resolve, 550))
  assert.equal(refreshes, 2)
  const reconnect = Socket.instances.at(-1)
  assert.notEqual(reconnect, socket)
  reconnect.receive({ type: 'ready' })
  reconnect.receive(openedWire(server, reconnect))
  store.change('Main.lean', 'promoted editor\nbase source\n')
  const flushing = hook.flush()
  const request = reconnect.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(request.update, 'base64')))
  reconnect.receive(wire(server, undefined, { ack: request.requestId }))
  assert.equal(await flushing, true)
})

test('reconnection discovers a membership change that occurred while no live socket was admitted', async (t) => {
  let role = 'admin'
  let displayedRole
  const { socket } = fixture(t, 'base source\n', {
    onAccessChanged: async () => {
      displayedRole = role
    },
  })
  assert.equal(displayedRole, 'admin')
  role = 'editor'
  socket.close(1008)
  assert.equal(displayedRole, 'editor')
  // No socket is connected to receive this second access event.
  role = 'admin'
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reconnect = Socket.instances.at(-1)
  assert.notEqual(reconnect, socket)
  reconnect.receive({ type: 'ready' })
  assert.equal(displayedRole, 'admin')
})

test('read-only reconnection preserves a dirty editor draft rather than replacing it with saved text', async (t) => {
  const { store } = fixture(t, 'base source\n', {
    canEdit: false,
    draft: 'PRIVATE_UNSAVED\nbase source\n',
  })
  assert.equal(
    store.getSnapshot().file.content,
    'PRIVATE_UNSAVED\nbase source\n',
  )
  assert.equal(store.getSnapshot().file.savedContent, 'base source\n')
})

test('collaborative undo and redo affect only local edits and consume empty undo without removing remote work', async (t) => {
  const { store, socket, server, hook } = fixture(t)
  const commitLast = async () => {
    const request = socket.sent
      .filter((message) => message.type === 'update')
      .at(-1)
    Y.applyUpdate(server, new Uint8Array(Buffer.from(request.update, 'base64')))
    socket.receive(wire(server, undefined, { ack: request.requestId }))
    assert.equal(await hook.flush(), true)
  }
  store.change('Main.lean', 'LOCAL_FOO\nbase source\n')
  const first = hook.flush()
  await commitLast()
  await first
  const remoteVector = Y.encodeStateVector(server)
  server
    .getText('source')
    .insert(server.getText('source').length, 'REMOTE_BAR\n')
  socket.receive(deltaWire(server, remoteVector))
  assert.equal(hook.undo('Main.lean'), true)
  await commitLast()
  assert.equal(server.getText('source').toString(), 'base source\nREMOTE_BAR\n')
  const count = socket.sent.filter(
    (message) => message.type === 'update',
  ).length
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(
    socket.sent.filter((message) => message.type === 'update').length,
    count,
  )
  assert.equal(store.getSnapshot().file.content, 'base source\nREMOTE_BAR\n')
  assert.equal(hook.redo('Main.lean'), true)
  await commitLast()
  assert.equal(
    server.getText('source').toString(),
    'LOCAL_FOO\nbase source\nREMOTE_BAR\n',
  )
})

test('an atomic diff-budget failure falls back only its file after discarding live identities', async (t) => {
  const { store, socket, hook } = fixture(t, 'base source\n', {
    replaceDocumentText(text, value) {
      if (value.includes('TOO_COMPLEX'))
        throw Object.assign(new Error('Live edit budget exceeded'), {
          code: 'DOCUMENT_DIFF_LIMIT',
        })
      return replaceDocumentText(text, value)
    },
  })
  store.change('Main.lean', 'TOO_COMPLEX\nbase source\n')
  assert.equal(await hook.flush(), false)
  assert.equal(
    socket.sent.filter((message) => message.type === 'update').length,
    0,
  )
  assert.equal(store.getSnapshot().file.content, 'TOO_COMPLEX\nbase source\n')
  assert.equal(store.getSnapshot().file.savedContent, 'base source\n')
  assert.equal(
    hook.undo('Main.lean'),
    true,
    'Do not fall through to an old native stack containing remote transactions',
  )
  assert.equal(store.getSnapshot().file.content, 'base source\n')
  assert.equal(hook.redo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, 'TOO_COMPLEX\nbase source\n')
  assert.equal(socket.readyState, Socket.OPEN)
})

test('ordinary-save fallback retains local undo through own saves and resets history at an authoritative replacement', async (t) => {
  const baseline = 'base source\nREMOTE_CONTEXT\n'
  const { store, socket, hook } = fixture(t, baseline, {
    replaceDocumentText(text, value) {
      if (value.includes('TOO_COMPLEX'))
        throw Object.assign(new Error('Live edit budget exceeded'), {
          code: 'DOCUMENT_DIFF_LIMIT',
        })
      return replaceDocumentText(text, value)
    },
  })
  const pasted = 'TOO_COMPLEX\n' + baseline
  store.change('Main.lean', pasted)
  assert.equal(await hook.flush(), false)
  const saved = store.getSnapshot().file
  store.saved([saved], [{ path: saved.path, hash: hash(pasted) }])
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, baseline)
  assert.equal(hook.redo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, pasted)

  const authoritative = 'REMOTE_REPLACEMENT\n'
  store.setFile({
    path: 'Main.lean',
    content: authoritative,
    savedContent: authoritative,
    hash: hash(authoritative),
    generation: 2,
  })
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, authoritative)
  store.change('Main.lean', authoritative + 'later local edit\n')
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, authoritative)
  assert.equal(hook.redo('Main.lean'), true)
  assert.equal(
    store.getSnapshot().file.content,
    authoritative + 'later local edit\n',
  )
  assert.equal(
    socket.sent.filter((message) => message.type === 'update').length,
    0,
  )
})

test('selective undo captures raw offline typing before applying earlier local history', async (t) => {
  const { store, socket, hook } = fixture(t)
  socket.close(1006)
  store.change('Main.lean', 'LOCAL_OFFLINE\nbase source\n')
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, 'base source\n')
  assert.equal(hook.redo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, 'LOCAL_OFFLINE\nbase source\n')
  await assert.rejects(hook.flush(), /connection to return/)
})

function serviceFixture(t, initial) {
  let content = initial
  const packets = []
  const workspaces = {
    get() {
      return { id: 'project', accessRole: 'editor' }
    },
    requireEditor() {
      return this.get()
    },
    subscribeChanges() {
      return () => {}
    },
    async readFile() {
      return { content, hash: hash(content) }
    },
    async writeFile(_id, _actor, _path, value, expectedHash, options) {
      options?.assertAuthorized?.()
      assert.equal(hash(content), expectedHash)
      content = value
      return { content, hash: hash(content) }
    },
  }
  const service = new ProjectDocuments({ workspaces })
  t.after(() => service.close())
  const client = {
    projectId: 'project',
    actor: 'account',
    paths: new Set(),
    vectors: new Map(),
    ws: {
      readyState: 1,
      bufferedAmount: 0,
      send(raw) {
        packets.push(JSON.parse(raw))
      },
    },
  }
  return {
    service,
    client,
    packets,
    source: () => content,
    restSave(value) {
      content = value
    },
    deliver(socket) {
      for (const packet of packets.splice(0)) socket.receive(packet)
    },
  }
}

async function admitServiceDocument(backend, socket) {
  socket.receive({ type: 'ready' })
  const open = socket.sent.filter((message) => message.type === 'open').at(-1)
  await backend.service.message(backend.client, open)
  backend.deliver(socket)
}

function lastDocumentUpdate(socket) {
  return socket.sent.filter((message) => message.type === 'update').at(-1)
}

async function rejectedDocumentUpdate(backend, update) {
  let rejection
  try {
    await backend.service.message(backend.client, update)
  } catch (error) {
    rejection = error
  }
  assert.ok(rejection, 'the actual document service rejects this update')
  return {
    type: 'error',
    path: update.path,
    requestId: update.requestId,
    status: rejection.status,
    message: rejection.message,
  }
}

test('a corrected source-limit rejection replays lost-ack edits and preserves concurrent saved source', async (t) => {
  const baseline = 'base source\n'
  const { store, socket, hook } = fixture(t, baseline, { deferReady: true })
  const backend = serviceFixture(t, baseline)
  await admitServiceDocument(backend, socket)
  const accepted = 'LOCAL_ACCEPTED\n' + baseline
  store.change('Main.lean', accepted)
  const flushing = hook.flush()
  await backend.service.message(backend.client, lastDocumentUpdate(socket))
  // Keep this successful durable ACK in flight while the next edit is rejected.
  store.change('Main.lean', accepted + 'x'.repeat(8 * 1024 * 1024))
  const rejectedFlush = hook.flush()
  const rejection = await rejectedDocumentUpdate(
    backend,
    lastDocumentUpdate(socket),
  )
  assert.equal(rejection.status, 413)
  const corrected = accepted + 'xx'
  store.change('Main.lean', corrected)
  socket.receive(rejection)
  await assert.rejects(flushing, /source file limit/)
  await assert.rejects(rejectedFlush, /source file limit/)
  backend.restSave(backend.source() + 'REMOTE_WHILE_RECONNECTING\n')
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reopened = Socket.instances.at(-1)
  assert.notEqual(reopened, socket)
  await admitServiceDocument(backend, reopened)
  const replay = lastDocumentUpdate(reopened)
  assert.ok(replay, 'a corrected draft is replayed without another keystroke')
  await backend.service.message(backend.client, replay)
  backend.deliver(reopened)
  assert.equal(await hook.flush(), true)
  assert.equal(
    backend.source().replace('REMOTE_WHILE_RECONNECTING\n', ''),
    corrected,
  )
  assert.equal(backend.source().split('REMOTE_WHILE_RECONNECTING\n').length, 2)
  assert.equal(store.getSnapshot().file.content, backend.source())
  assert.deepEqual(store.dirty(), [])
})

test('a small replacement of an oversized pasted line can retire to version-checked saving', async (t) => {
  const baseline = 'base source\n'
  const { store, socket, hook, rerender } = fixture(t, baseline, {
    deferReady: true,
  })
  const backend = serviceFixture(t, baseline)
  await admitServiceDocument(backend, socket)
  store.change('Main.lean', baseline + 'x'.repeat(8 * 1024 * 1024))
  const flushing = hook.flush()
  const rejection = await rejectedDocumentUpdate(
    backend,
    lastDocumentUpdate(socket),
  )
  assert.equal(rejection.status, 413)
  socket.receive(rejection)
  await assert.rejects(flushing, /source file limit/)
  const corrected = baseline + '-- valid replacement\n'
  store.change('Main.lean', corrected)
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reopened = Socket.instances.at(-1)
  await admitServiceDocument(backend, reopened)
  assert.equal(await hook.flush(), false)
  assert.match(rerender().issue, /normal version-checked saving/)
  assert.equal(lastDocumentUpdate(reopened), undefined)
  const snapshot = store.getSnapshot().file
  assert.equal(snapshot.content, corrected)
  assert.equal(
    snapshot.hash,
    hash(backend.source()),
    'fallback preserves the actual CAS baseline',
  )
  backend.restSave(snapshot.content)
  store.saved(
    [snapshot],
    [{ path: snapshot.path, hash: hash(snapshot.content) }],
  )
  assert.deepEqual(store.dirty(), [])
  assert.equal(backend.source(), corrected)
})

test('private Undo recovers an oversized UTF-8 paste without removing remote text', async (t) => {
  const baseline = 'base source\n'
  const { store, socket, hook } = fixture(t, baseline, { deferReady: true })
  const backend = serviceFixture(t, baseline)
  await admitServiceDocument(backend, socket)
  backend.restSave(baseline + 'REMOTE_BEFORE_PASTE\n')
  await backend.service.refresh(
    backend.service.documents.values().next().value,
    backend.client.actor,
  )
  backend.deliver(socket)
  const withRemote = store.getSnapshot().file.content
  const pasted = withRemote + '😀'.repeat(2 * 1024 * 1024)
  assert(pasted.length < sourceFileByteLimit('Main.lean'))
  store.change('Main.lean', pasted)
  const flushing = hook.flush()
  const rejection = await rejectedDocumentUpdate(
    backend,
    lastDocumentUpdate(socket),
  )
  assert.equal(rejection.status, 413)
  socket.receive(rejection)
  await assert.rejects(flushing, /source file limit/)
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, withRemote)
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reopened = Socket.instances.at(-1)
  await admitServiceDocument(backend, reopened)
  const replay = lastDocumentUpdate(reopened)
  assert.ok(replay)
  await backend.service.message(backend.client, replay)
  backend.deliver(reopened)
  assert.equal(await hook.flush(), true)
  assert.equal(backend.source(), withRemote)
  assert.equal(store.getSnapshot().file.content, withRemote)
})

test('a rejected live source waits for correction while receiving remote edits and ignores dependent errors on its closed connection', async (t) => {
  const baseline = 'base source\n'
  const { store, socket, hook, rerender } = fixture(t, baseline, {
    deferReady: true,
  })
  const backend = serviceFixture(t, baseline)
  await admitServiceDocument(backend, socket)
  store.change('Main.lean', baseline + '\0')
  const flushing = hook.flush()
  const rejection = await rejectedDocumentUpdate(
    backend,
    lastDocumentUpdate(socket),
  )
  assert.equal(rejection.status, 413)
  // Another already-sent delta can refer to the rejected insertion.
  store.change('Main.lean', baseline + '\0later')
  const dependentFlush = hook.flush()
  const dependentError = await rejectedDocumentUpdate(
    backend,
    lastDocumentUpdate(socket),
  )
  assert.equal(dependentError.status, 400)
  socket.receive(rejection)
  socket.receive(dependentError)
  await assert.rejects(flushing, /source file limit/)
  await assert.rejects(dependentFlush, /source file limit/)
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reopened = Socket.instances.at(-1)
  await admitServiceDocument(backend, reopened)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(
    lastDocumentUpdate(reopened),
    undefined,
    'invalid source is not replayed repeatedly',
  )
  assert.match(rerender().issue, /source file limit/)
  backend.restSave('REMOTE_AFTER_REJECTION\n' + baseline)
  await backend.service.refresh(
    backend.service.documents.values().next().value,
    backend.client.actor,
  )
  backend.deliver(reopened)
  assert.match(store.getSnapshot().file.content, /REMOTE_AFTER_REJECTION/)
  store.change(
    'Main.lean',
    store.getSnapshot().file.content.replace('\0later', '-- corrected\n'),
  )
  const correctedFlush = hook.flush()
  const replay = lastDocumentUpdate(reopened)
  assert.ok(replay)
  await backend.service.message(backend.client, replay)
  backend.deliver(reopened)
  assert.equal(await correctedFlush, true)
  assert.equal(
    backend.source(),
    'REMOTE_AFTER_REJECTION\n' + baseline + '-- corrected\n',
  )
  assert.equal(rerender().issue, null)
})

test('reload generations ignore queued deltas and stale full opens before accepting their own full baseline', async (t) => {
  const { store, socket, server, hook } = fixture(t)
  const staleOpen = openedWire(server, socket)
  const vector = Y.encodeStateVector(server)
  server
    .getText('source')
    .insert(server.getText('source').length, '-- remote\n')
  const canonical = server.getText('source').toString()
  store.setFile({
    ...store.getSnapshot().file,
    content: canonical,
    savedContent: canonical,
    hash: hash(canonical),
    generation: 2,
  })
  socket.receive(deltaWire(server, vector))
  socket.receive(deltaWire(server, vector))
  socket.receive(staleOpen)
  assert.equal(store.getSnapshot().file.content, canonical)
  assert.equal(
    socket.sent.filter((message) => message.type === 'update').length,
    0,
  )
  assert.notEqual(
    openedWire(server, socket).openRequestId,
    staleOpen.openRequestId,
  )
  socket.receive(openedWire(server, socket))
  socket.receive(staleOpen)
  assert.equal(store.getSnapshot().file.content, canonical)
  assert.equal(await hook.flush(), true)
  assert.equal(
    socket.sent.filter((message) => message.type === 'update').length,
    0,
  )
})

test('a pending initial HTTP save retires its path before live admission and keeps private undo', async (t) => {
  const baseline = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n'
  const draft = 'LOCAL\n' + baseline
  const { store, socket, hook, rerender } = fixture(t, baseline, {
    deferReady: true,
  })
  const backend = serviceFixture(t, baseline)
  store.change('Main.lean', draft)
  assert.equal(await hook.flush(), false)
  const snapshots = store.dirty()
  socket.receive({ type: 'ready' })
  const opening = socket.sent.find((message) => message.type === 'open')
  if (opening) {
    await backend.service.message(backend.client, opening)
    backend.deliver(socket)
  }
  backend.restSave(draft)
  store.saved(snapshots, [{ path: 'Main.lean', hash: hash(draft) }])
  for (const update of socket.sent.filter(
    (message) => message.type === 'update',
  ))
    await backend.service.message(backend.client, update)
  assert.equal(backend.source(), draft)
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, baseline)
  assert.equal(hook.redo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, draft)
  store.change('Main.lean', draft + 'later local\n')
  assert.equal(await hook.flush(), false)
  assert.equal(
    socket.sent.filter((message) => message.type === 'open').length,
    0,
  )
  rerender(false)
  const reader = Socket.instances.at(-1)
  reader.receive({ type: 'ready' })
  const editing = rerender(true)
  const editor = Socket.instances.at(-1)
  editor.receive({ type: 'ready' })
  assert.equal(
    editor.sent.filter((message) => message.type === 'open').length,
    0,
  )
  assert.equal(await editing.flush(), false)
  assert.equal(
    editing.undo('Main.lean'),
    true,
    'never expose a retired model native undo stack after reinitialization',
  )
})

test('over-capacity ordinary drafts stay on HTTP saving while a saved live slot becomes free', async (t) => {
  const { store, socket, hook } = fixture(t)
  store.register(
    Array.from({ length: 16 }, (_, index) => ({
      path: `File${index}.lean`,
      content: '-- saved\n',
      hash: hash('-- saved\n'),
      unsaved: false,
    })),
  )
  assert.equal(await hook.flush(), true)
  const opened = new Set(
    socket.sent
      .filter((message) => message.type === 'open')
      .map((message) => message.path),
  )
  const ordinary = [...store.getSnapshot().buffers.keys()].find(
    (path) => !opened.has(path),
  )
  assert.ok(ordinary)
  store.change(ordinary, '-- ordinary pending save\n')
  assert.equal(await hook.flush(), false)
  const snapshots = store.dirty()
  store.remove('Main.lean')
  assert.equal(await hook.flush(), false)
  assert.ok(
    !socket.sent.some(
      (message) => message.type === 'open' && message.path === ordinary,
    ),
  )
  store.saved(snapshots, [{ path: ordinary, hash: hash(snapshots[0].content) }])
  assert.equal(hook.undo(ordinary), true)
  assert.equal(store.getSnapshot().buffers.get(ordinary).content, '-- saved\n')
})

test('a permission-triggered new hook cannot expose native shared undo after initial capacity rejection', async (t) => {
  const { store, socket, server, rerender } = fixture(t)
  const vector = Y.encodeStateVector(server)
  server.getText('source').insert(server.getText('source').length, 'REMOTE\n')
  socket.receive(deltaWire(server, vector))
  rerender(false)
  const readOnlySocket = Socket.instances.at(-1)
  readOnlySocket.receive({ type: 'ready' })
  readOnlySocket.receive(openedWire(server, readOnlySocket))
  const editing = rerender(true)
  const editingSocket = Socket.instances.at(-1)
  editingSocket.receive({ type: 'ready' })
  editingSocket.receive({
    type: 'error',
    path: 'Main.lean',
    status: 429,
    message: 'Live capacity full.',
  })
  const before = store.getSnapshot().file.content
  assert.equal(
    editing.undo('Main.lean'),
    true,
    'consume undo instead of falling through to Monaco imported edits',
  )
  assert.equal(store.getSnapshot().file.content, before)
})

test('lost-ack replay fits the envelope even when private undo retains a large deleted baseline', async (t) => {
  const previous = 'a'.repeat(6 * 1024 * 1024)
  const next = 'b'.repeat(6 * 1024 * 1024)
  const { store, socket, server, hook } = fixture(t, previous)
  store.change('Main.lean', '')
  const deleting = hook.flush()
  const deletion = socket.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(deletion.update, 'base64')))
  socket.receive(wire(server, undefined, { ack: deletion.requestId }))
  await deleting
  store.change('Main.lean', next)
  const inserting = hook.flush()
  const insertion = socket.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.ok(insertion.update.length < 12 * 1024 * 1024)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(insertion.update, 'base64')))
  socket.close(1006)
  await assert.rejects(inserting, /interrupted/)
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reopened = Socket.instances.at(-1)
  reopened.receive({ type: 'ready' })
  reopened.receive(openedWire(server, reopened))
  const replay = reopened.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.ok(replay)
  assert.ok(
    replay.update.length < 12 * 1024 * 1024,
    `replay has ${replay.update.length} bytes`,
  )
  Y.applyUpdate(server, new Uint8Array(Buffer.from(replay.update, 'base64')))
  reopened.receive(wire(server, undefined, { ack: replay.requestId }))
  assert.equal(await hook.flush(), true)
  assert.equal(hash(server.getText('source').toString()), hash(next))
})

test('garbage-collected offline replay preserves causal ranges and local undo across several unacknowledged large replacements', async (t) => {
  const previous = 'a'.repeat(6 * 1024 * 1024)
  const sources = ['b', 'c', 'd'].map((letter) =>
    letter.repeat(6 * 1024 * 1024),
  )
  const { store, socket, hook } = fixture(t, previous, { deferReady: true })
  const backend = serviceFixture(t, previous)
  socket.receive({ type: 'ready' })
  await backend.service.message(
    backend.client,
    socket.sent.find((message) => message.type === 'open'),
  )
  backend.deliver(socket)
  socket.close(1006)
  for (const source of sources) {
    store.change('Main.lean', '')
    hook.undo('Main.lean')
    hook.redo('Main.lean')
    store.change('Main.lean', source)
    hook.undo('Main.lean')
    hook.redo('Main.lean')
    assert.equal(hash(store.getSnapshot().file.content), hash(source))
  }
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reopened = Socket.instances.at(-1)
  reopened.receive({ type: 'ready' })
  await backend.service.message(
    backend.client,
    reopened.sent.find((message) => message.type === 'open'),
  )
  backend.deliver(reopened)
  const replay = reopened.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.ok(replay)
  assert.ok(
    replay.update.length < 12 * 1024 * 1024,
    `replay has ${replay.update.length} bytes`,
  )
  await backend.service.message(backend.client, replay)
  backend.deliver(reopened)
  assert.equal(await hook.flush(), true)
  assert.equal(hash(backend.source()), hash(sources.at(-1)))
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, '')
  const undo = reopened.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  await backend.service.message(backend.client, undo)
  backend.deliver(reopened)
  assert.equal(await hook.flush(), true)
  assert.equal(backend.source(), '')
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(hash(store.getSnapshot().file.content), hash(sources.at(-2)))
})

test('a previously live draft waits for setup-recreated socket admission and keeps receiving concurrent edits', async (t) => {
  const { store, socket, server, rerender } = fixture(t)
  socket.close(1006)
  store.change('Main.lean', 'SETUP_DRAFT\nbase source\n')
  rerender(true, false)
  const resumed = rerender(true, true)
  const warming = Socket.instances.at(-1)
  await assert.rejects(resumed.flush(), /connection to return/)
  warming.receive({ type: 'ready' })
  warming.receive(openedWire(server, warming))
  const draft = warming.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.ok(draft)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(draft.update, 'base64')))
  warming.receive(wire(server, undefined, { ack: draft.requestId }))
  assert.equal(await resumed.flush(), true)
  const vector = Y.encodeStateVector(server)
  server.getText('source').insert(0, 'OTHER_EDITOR\n')
  warming.receive(deltaWire(server, vector))
  assert.match(store.getSnapshot().file.content, /OTHER_EDITOR/)
  store.change('Main.lean', store.getSnapshot().file.content + 'AFTER_SETUP\n')
  const flushing = resumed.flush()
  const later = warming.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.notEqual(later.requestId, draft.requestId)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(later.update, 'base64')))
  warming.receive(wire(server, undefined, { ack: later.requestId }))
  assert.equal(await flushing, true)
  assert.match(server.getText('source').toString(), /OTHER_EDITOR/)
  assert.match(server.getText('source').toString(), /SETUP_DRAFT/)
  assert.match(server.getText('source').toString(), /AFTER_SETUP/)
})

test('same-generation authoritative HTTP refreshes do not become duplicate local live edits', async (t) => {
  for (const order of ['delta-first', 'publish-first'])
    await t.test(order, async (t) => {
      const { store, socket, server, hook } = fixture(t)
      const originalGeneration = store.getSnapshot().file.generation
      const vector = Y.encodeStateVector(server)
      server
        .getText('source')
        .insert(server.getText('source').length, 'TERMINAL_EDIT\n')
      const canonical = server.getText('source').toString()
      store.setFile((previous) => ({
        ...previous,
        content: canonical,
        savedContent: canonical,
        hash: hash(canonical),
      }))
      if (order === 'publish-first') void hook.flush().catch(() => {})
      socket.receive(deltaWire(server, vector))
      assert.equal(store.getSnapshot().file.generation, originalGeneration)
      assert.equal(store.getSnapshot().file.content, canonical)
      assert.equal(
        socket.sent.filter((message) => message.type === 'update').length,
        0,
      )
      socket.receive(openedWire(server, socket))
      assert.equal(await hook.flush(), true)
      assert.equal(store.getSnapshot().file.content, canonical)
      assert.equal(
        socket.sent.filter((message) => message.type === 'update').length,
        0,
      )
    })
})

test('a removed clean file stays blocked until an explicit reload and file 404 does not refresh project access', async (t) => {
  let accessRefreshes = 0
  const { store, socket, server, hook } = fixture(t, 'base source\n', {
    onAccessChanged() {
      accessRefreshes++
    },
  })
  const removal = {
    type: 'error',
    path: 'Main.lean',
    status: 409,
    message: 'Shared file removed.',
  }
  socket.receive(removal)
  for (let index = 0; index < 5; index++) {
    store.register([
      {
        path: `Other${index}.lean`,
        content: '-- saved\n',
        hash: hash('-- saved\n'),
        unsaved: false,
      },
    ])
    await hook.flush().catch(() => {})
    socket.receive({ ...removal, status: 404 })
  }
  const opens = () =>
    socket.sent.filter(
      (message) => message.type === 'open' && message.path === 'Main.lean',
    )
  assert.equal(opens().length, 1)
  assert.equal(
    accessRefreshes,
    1,
    'only initial admission refreshes access for a file-level 404',
  )
  store.setFile({ ...store.getSnapshot().file, generation: 2 })
  assert.equal(await hook.flush(), true)
  assert.equal(opens().length, 2)
  socket.receive(openedWire(server, socket))
  store.change('Main.lean', 'RESTORED_FILE_EDIT\nbase source\n')
  const flushing = hook.flush()
  const update = socket.sent
    .filter((message) => message.type === 'update')
    .at(-1)
  assert.ok(update)
  Y.applyUpdate(server, new Uint8Array(Buffer.from(update.update, 'base64')))
  socket.receive(wire(server, undefined, { ack: update.requestId }))
  assert.equal(await flushing, true)
  assert.match(server.getText('source').toString(), /RESTORED_FILE_EDIT/)
})

test('ordinary-saving mode remains visible through successful live packets and reconnect until a new workspace visit', async (t) => {
  const { store, socket, server, hook, rerender } = fixture(
    t,
    'base source\n',
    { deferReady: true },
  )
  const draft = 'LOCAL_HTTP_SAVE\nbase source\n'
  store.change('Main.lean', draft)
  assert.equal(await hook.flush(), false)
  const saved = store.getSnapshot().file
  store.saved([saved], [{ path: saved.path, hash: hash(draft) }])
  replaceDocumentText(server.getText('source'), draft)
  assert.match(rerender().issue, /normal.*saving/)
  socket.receive({ type: 'ready' })
  assert.match(rerender().issue, /normal.*saving/)
  assert.match(
    rerender().issue,
    /Switch to another project and back, or reload this page/,
  )
  store.setFile({
    path: 'Other.lean',
    content: '-- other\n',
    savedContent: '-- other\n',
    hash: hash('-- other\n'),
    generation: 2,
  })
  assert.equal(await hook.flush(), true)
  const other = new Y.Doc()
  t.after(() => other.destroy())
  other.getText('source').insert(0, '-- other\n')
  const openOther = (connection) =>
    wire(other, undefined, {
      path: 'Other.lean',
      openRequestId: connection.sent
        .filter(
          (message) => message.type === 'open' && message.path === 'Other.lean',
        )
        .at(-1)?.requestId,
    })
  socket.receive(openOther(socket))
  const vector = Y.encodeStateVector(other)
  other
    .getText('source')
    .insert(other.getText('source').length, '-- remote other\n')
  socket.receive(deltaWire(other, vector, { path: 'Other.lean' }))
  assert.match(rerender().issue, /normal.*saving/)
  socket.close(1006)
  assert.match(rerender().issue, /interrupted/)
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reconnect = Socket.instances.at(-1)
  reconnect.receive({ type: 'ready' })
  reconnect.receive(openOther(reconnect))
  assert.match(rerender().issue, /normal.*saving/)
  store.setFile({
    ...saved,
    savedContent: draft,
    hash: hash(draft),
    generation: 3,
  })
  assert.equal(await hook.flush(), true)
  assert.match(rerender().issue, /normal.*saving/)
  assert.equal(
    reconnect.sent.filter(
      (message) => message.type === 'open' && message.path === 'Main.lean',
    ).length,
    0,
    'reloading the file does not silently rejoin live editing',
  )
  store.selectProject('other-project')
  rerender()
  assert.equal(rerender().issue, null)
  store.selectProject('project')
  store.setFile({
    ...saved,
    savedContent: draft,
    hash: hash(draft),
    generation: 4,
  })
  const nextVisit = rerender()
  const fresh = Socket.instances.at(-1)
  fresh.receive({ type: 'ready' })
  assert.equal(
    fresh.sent.filter(
      (message) => message.type === 'open' && message.path === 'Main.lean',
    ).length,
    1,
  )
  fresh.receive(openedWire(server, fresh))
  assert.equal(await nextVisit.flush(), true)
  assert.equal(rerender().issue, null)
})

test('dirty fallback-only reconnect restores ordinary-saving guidance before and after its next HTTP save', async (t) => {
  const { store, socket, hook, rerender } = fixture(t, 'base source\n', {
    deferReady: true,
  })
  store.change('Main.lean', 'FIRST_HTTP_EDIT\nbase source\n')
  assert.equal(await hook.flush(), false)
  let snapshot = store.getSnapshot().file
  store.saved(
    [snapshot],
    [{ path: snapshot.path, hash: hash(snapshot.content) }],
  )
  socket.receive({ type: 'ready' })
  assert.match(rerender().issue, /normal.*saving/)
  socket.close(1006)
  store.change(
    'Main.lean',
    store.getSnapshot().file.content + 'SECOND_HTTP_EDIT\n',
  )
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reconnect = Socket.instances.at(-1)
  reconnect.receive({ type: 'ready' })
  assert.equal(rerender().connected, true)
  assert.match(rerender().issue, /normal.*saving/)
  assert.match(
    rerender().issue,
    /Switch to another project and back, or reload this page/,
  )
  assert.equal(await hook.flush(), false)
  snapshot = store.getSnapshot().file
  store.saved(
    [snapshot],
    [{ path: snapshot.path, hash: hash(snapshot.content) }],
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.match(rerender().issue, /normal.*saving/)
  assert.doesNotMatch(rerender().issue, /interrupted|reconnecting/)
  assert.equal(
    reconnect.sent.filter((message) => message.type === 'open').length,
    0,
  )
})

test('ordinary-saving reconnect guidance does not replace a blocking shared-file failure', async (t) => {
  const { store, socket, server, hook, rerender } = fixture(t)
  store.register([
    {
      path: 'Main.lean',
      content: 'base source\n',
      hash: hash('base source\n'),
      unsaved: false,
    },
  ])
  store.setFile({
    path: 'Overflow.lean',
    content: '-- ordinary\n',
    savedContent: '-- ordinary\n',
    hash: hash('-- ordinary\n'),
    generation: 2,
  })
  assert.equal(await hook.flush(), true)
  socket.receive({
    type: 'error',
    path: 'Overflow.lean',
    status: 429,
    message: 'Live capacity full.',
  })
  store.change('Overflow.lean', '-- dirty ordinary draft\n')
  store.change('Main.lean', 'BLOCKED_LOCAL_DRAFT\nbase source\n')
  socket.receive({
    type: 'error',
    path: 'Main.lean',
    status: 409,
    message: 'Conflict retained across reconnect.',
  })
  socket.close(1006)
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reconnect = Socket.instances.at(-1)
  reconnect.receive({ type: 'ready' })
  reconnect.receive(openedWire(server, reconnect))
  assert.doesNotMatch(rerender().issue, /normal.*saving/)
  await assert.rejects(hook.flush(), /Conflict retained across reconnect/)
  assert.match(
    store.getSnapshot().buffers.get('Main.lean').content,
    /BLOCKED_LOCAL_DRAFT/,
  )
})

test('post-commit durability errors reconnect without duplicating accepted Yjs edits and keep private Undo separate from remote changes', async (t) => {
  const baseline = 'base source\n'
  const { store, socket, hook } = fixture(t, baseline, { deferReady: true })
  const backend = serviceFixture(t, baseline)
  await admitServiceDocument(backend, socket)
  const write = backend.service.workspaces.writeFile.bind(
    backend.service.workspaces,
  )
  let uncertain = true
  backend.service.workspaces.writeFile = async (...args) => {
    const saved = await write(...args)
    if (uncertain)
      throw Object.assign(
        new Error(
          'The updated file is visible, but storage could not confirm a durable save. Keep or download your draft, then retry.',
        ),
        { status: 503, sourceCommitted: true },
      )
    return saved
  }
  store.change('Main.lean', 'ALICE_LOCAL\n' + baseline)
  const flushing = hook.flush()
  const failed = assert.rejects(flushing, /could not confirm a durable save/)
  const request = lastDocumentUpdate(socket)
  const error = await rejectedDocumentUpdate(backend, request)
  assert.equal(
    backend.packets.some((packet) => packet.ack === request.requestId),
    false,
  )
  backend.deliver(socket)
  socket.receive(error)
  await failed
  assert.equal(store.getSnapshot().file.content, 'ALICE_LOCAL\n' + baseline)
  assert.equal(backend.source(), 'ALICE_LOCAL\n' + baseline)
  await assert.rejects(hook.flush(), /live connection to return/)
  const record = [...backend.service.documents.values()][0]
  await backend.service.queue(record, () =>
    backend.service.refresh(record, 'account'),
  )
  uncertain = false
  const remotePackets = []
  const remote = {
    projectId: 'project',
    actor: 'remote-account',
    paths: new Set(),
    vectors: new Map(),
    ws: {
      readyState: 1,
      bufferedAmount: 0,
      send(raw) {
        remotePackets.push(JSON.parse(raw))
      },
    },
  }
  await backend.service.message(remote, { type: 'open', path: 'Main.lean' })
  const remoteDoc = new Y.Doc()
  t.after(() => remoteDoc.destroy())
  const remoteOpen = remotePackets.find((packet) => packet.type === 'document')
  Y.applyUpdate(
    remoteDoc,
    new Uint8Array(Buffer.from(remoteOpen.update, 'base64')),
  )
  const remoteVector = Y.encodeStateVector(remoteDoc)
  remoteDoc
    .getText('source')
    .insert(remoteDoc.getText('source').length, 'BOB_REMOTE\n')
  await backend.service.message(remote, {
    type: 'update',
    path: 'Main.lean',
    documentId: remoteOpen.documentId,
    requestId: 1,
    update: Buffer.from(
      Y.encodeStateAsUpdate(remoteDoc, remoteVector),
    ).toString('base64'),
  })
  await new Promise((resolve) => setTimeout(resolve, 550))
  const reopened = Socket.instances.at(-1)
  assert.notEqual(reopened, socket)
  await admitServiceDocument(backend, reopened)
  const replay = lastDocumentUpdate(reopened)
  assert(
    replay,
    'The unacknowledged request is replayed even when its bytes are already visible',
  )
  await backend.service.message(backend.client, replay)
  backend.deliver(reopened)
  assert.equal(await hook.flush(), true)
  assert.equal(
    store.getSnapshot().file.content,
    'ALICE_LOCAL\n' + baseline + 'BOB_REMOTE\n',
  )
  assert.equal(backend.source(), 'ALICE_LOCAL\n' + baseline + 'BOB_REMOTE\n')
  assert.equal(hook.undo('Main.lean'), true)
  assert.equal(store.getSnapshot().file.content, baseline + 'BOB_REMOTE\n')
  await backend.service.message(backend.client, lastDocumentUpdate(reopened))
  backend.deliver(reopened)
  assert.equal(await hook.flush(), true)
  assert.equal(backend.source(), baseline + 'BOB_REMOTE\n')
})
