import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import * as Y from 'yjs'
import { createHash } from 'node:crypto'
import {
  replaceDocumentText,
  documentTextEdit,
  documentOffsetAfterEdit,
} from '../../../shared/document-text.mjs'
import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'

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
  const react = {
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
    useEffect: (fn) => {
      cleanups.push(fn())
    },
  }
  const { useProjectCollaboration } = transpile(
    './useProjectCollaboration.ts',
    {
      react,
      yjs: Y,
      './localDocumentHistory': { LocalDocumentHistory },
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
  const scope = store.getSnapshot().scope
  const hook = useProjectCollaboration({
    store,
    scope,
    enabled: true,
    canEdit: options.canEdit ?? true,
    onAccessChanged: options.onAccessChanged,
  })
  const socket = Socket.instances.at(-1)
  const server = new Y.Doc()
  server.getText('source').insert(0, initial)
  socket.receive({ type: 'ready' })
  socket.receive(wire(server))
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup?.()
    server.destroy()
    globalThis.WebSocket = previous.WebSocket
    globalThis.location = previous.location
  })
  return { store, socket, server, hook }
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
  for (const status of [409, 413, 403])
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
      socket.receive(wire(server))
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
  reopened.receive(wire(server))
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
  reconnect.receive(wire(server))
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
  reconnect.receive(wire(server))
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
