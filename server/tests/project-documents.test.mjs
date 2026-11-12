import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { ProjectDocuments } from '../project-documents.mjs'
import { replaceDocumentText } from '../../shared/document-text.mjs'

const sha = (value) => createHash('sha256').update(value).digest('hex')
const enc = (value) => Buffer.from(value).toString('base64')
const dec = (value) => new Uint8Array(Buffer.from(value, 'base64'))
const forbidden = () =>
  Object.assign(new Error('Project not found'), { status: 404 })
class Socket extends EventEmitter {
  readyState = 1
  bufferedAmount = 0
  packets = []
  send(value) {
    this.packets.push(JSON.parse(value))
  }
  close(code, reason) {
    this.code = code
    this.reason = reason
    this.readyState = 3
    this.emit('close')
  }
  terminate() {
    this.close(1006)
  }
  ping() {}
}
function fixture(t, options = {}) {
  const files = new Map([['Main.lean', 'example : True := by trivial\n']])
  const roles = new Map([
    ['alice', 'owner'],
    ['bob', 'editor'],
    ['viewer', 'viewer'],
  ])
  const listeners = new Set()
  const emit = (paths = ['Main.lean'], kind = 'files', extra = {}) => {
    for (const listener of listeners)
      listener({ projectId: 'shared', paths, kind, ...extra })
  }
  const store = {
    get(id, actor) {
      if (id !== 'shared' || !roles.has(actor)) throw forbidden()
      return {
        id,
        accessRole: roles.get(actor),
        ...(options.root ? { root: options.root } : {}),
      }
    },
    requireEditor(id, actor) {
      const project = this.get(id, actor)
      if (project.accessRole === 'viewer')
        throw Object.assign(new Error('Editor access required'), {
          status: 403,
        })
      return project
    },
    subscribeChanges(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async readFile(id, actor, name) {
      this.get(id, actor)
      const content = options.root
        ? await fs.readFile(path.join(options.root, name), 'utf8')
        : files.get(name)
      if (content === undefined) throw forbidden()
      return { content, hash: sha(content) }
    },
    async writeFile(id, actor, name, content, expectedHash) {
      this.requireEditor(id, actor)
      await options.beforeWrite?.(name, content)
      this.requireEditor(id, actor)
      if (sha(files.get(name)) !== expectedHash)
        throw Object.assign(new Error('File changed'), { status: 409 })
      files.set(name, content)
      emit([name])
      return { content, hash: sha(content) }
    },
  }
  const service = new ProjectDocuments({ workspaces: store, ...options })
  t.after(() => service.close())
  async function client(actor) {
    const ws = new Socket()
    service.connect(ws, 'shared', actor)
    const client = [...service.clients].find((entry) => entry.ws === ws)
    await service.message(client, { type: 'open', path: 'Main.lean' })
    const packet = ws.packets.filter((item) => item.type === 'document').at(-1)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, dec(packet.update))
    t.after(() => doc.destroy())
    return { client, ws, doc, id: packet.documentId }
  }
  return { files, roles, store, service, client, emit }
}
function documentPackets(entry) {
  const canonical = new Y.Doc()
  try {
    return entry.ws.packets
      .filter((item) => item.type === 'document')
      .map((packet) => {
        Y.applyUpdate(canonical, dec(packet.update))
        return { ...packet, content: canonical.getText('source').toString() }
      })
  } finally {
    canonical.destroy()
  }
}

function update(entry, requestId, edit) {
  const vector = Y.encodeStateVector(entry.doc)
  edit(entry.doc.getText('source'))
  return {
    type: 'update',
    path: 'Main.lean',
    documentId: entry.id,
    requestId,
    update: enc(Y.encodeStateAsUpdate(entry.doc, vector)),
  }
}

function cursor(entry, anchor, head = anchor, extra = {}) {
  return {
    type: 'presence',
    path: 'Main.lean',
    documentId: entry.id,
    anchor,
    head,
    ...extra,
  }
}

const latestPresence = (entry) =>
  entry.ws.packets.filter((packet) => packet.type === 'presence').at(-1)?.peers

async function untilPresence(entry, check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const peers = latestPresence(entry)
    if (peers && check(peers)) return peers
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail('The expected collaborator cursor did not arrive.')
}

test('shared cursors expose trusted names and selections to same-file peers including viewers', async (t) => {
  const f = fixture(t, { displayName: (actor) => `Account ${actor}` })
  const alice = await f.client('alice')
  const bob = await f.client('bob')
  const viewer = await f.client('viewer')
  const before = f.files.get('Main.lean')
  await f.service.message(
    alice.client,
    cursor(alice, 2, 8, { name: 'Forged name', userId: 'bob' }),
  )
  const peers = await untilPresence(bob, (peers) => peers.length === 1)
  assert.deepEqual(peers, [
    {
      clientId: alice.client.presenceId,
      userId: 'alice',
      name: 'Account alice',
      path: 'Main.lean',
      documentId: alice.id,
      anchor: 2,
      head: 8,
    },
  ])
  assert.equal(typeof peers[0].clientId, 'string')
  assert.deepEqual(
    await untilPresence(viewer, (peers) => peers.length === 1),
    peers,
  )
  assert.deepEqual(latestPresence(alice), [])
  assert.equal(
    f.files.get('Main.lean'),
    before,
    'Cursor movement never saves a file',
  )
})

test('shared cursors reject viewers, stale document IDs, unopened files and invalid offsets', async (t) => {
  const f = fixture(t)
  const alice = await f.client('alice')
  const viewer = await f.client('viewer')
  await assert.rejects(f.service.message(viewer.client, cursor(viewer, 1)), {
    status: 403,
  })
  for (const extra of [
    { anchor: -1 },
    { head: 1.5 },
    { head: f.files.get('Main.lean').length + 1 },
    { anchor: '2' },
  ])
    await assert.rejects(
      f.service.message(alice.client, cursor(alice, 1, 1, extra)),
      { status: 400 },
    )
  for (const extra of [{ documentId: 'expired' }, { path: 'Unopened.lean' }])
    await assert.rejects(
      f.service.message(alice.client, cursor(alice, 1, 1, extra)),
      { status: 409 },
    )
  assert.deepEqual(latestPresence(viewer), [])
})

test('collaborator positions follow inserted text and disappear when cleared, closed or disconnected', async (t) => {
  const f = fixture(t)
  const alice = await f.client('alice')
  const bob = await f.client('bob')
  await f.service.message(alice.client, cursor(alice, 2, 8))
  await untilPresence(bob, (peers) => peers[0]?.head === 8)
  await f.service.message(
    bob.client,
    update(bob, 1, (text) => text.insert(0, '-- ')),
  )
  await untilPresence(
    bob,
    (peers) => peers[0]?.anchor === 5 && peers[0]?.head === 11,
  )
  await f.service.message(alice.client, { type: 'presence', path: null })
  assert.deepEqual(latestPresence(bob), [])
  await f.service.message(alice.client, cursor(alice, 1))
  await untilPresence(bob, (peers) => peers.length === 1)
  await f.service.message(alice.client, { type: 'close', path: 'Main.lean' })
  assert.deepEqual(latestPresence(bob), [])
  await f.service.message(alice.client, { type: 'open', path: 'Main.lean' })
  await f.service.message(alice.client, cursor(alice, 1))
  await untilPresence(bob, (peers) => peers.length === 1)
  alice.ws.close(1000)
  assert.deepEqual(latestPresence(bob), [])
})

test('cursor snapshots are scoped to subscribed files and disappear after access changes or file moves', async (t) => {
  const f = fixture(t)
  f.files.set('Other.lean', '-- other\n')
  const alice = await f.client('alice')
  const bob = await f.client('bob')
  const viewer = await f.client('viewer')
  await f.service.message(viewer.client, { type: 'close', path: 'Main.lean' })
  await f.service.message(viewer.client, { type: 'open', path: 'Other.lean' })
  await f.service.message(alice.client, cursor(alice, 1))
  await untilPresence(bob, (peers) => peers.length === 1)
  assert.deepEqual(latestPresence(viewer), [])
  f.roles.set('alice', 'viewer')
  f.emit([], 'access')
  assert.deepEqual(latestPresence(bob), [])
  f.roles.set('alice', 'owner')
  await f.service.message(alice.client, cursor(alice, 1))
  await untilPresence(bob, (peers) => peers.length === 1)
  f.emit(['Main.lean', 'Moved.lean'], 'files', {
    removedPaths: ['Main.lean'],
    moves: [{ from: 'Main.lean', to: 'Moved.lean' }],
  })
  assert.deepEqual(latestPresence(bob), [])
})

test('clearing a cursor cancels an older cursor packet queued behind a file operation', async (t) => {
  const f = fixture(t)
  const alice = await f.client('alice')
  const bob = await f.client('bob')
  const record = f.service.documents.get(f.service.key('shared', 'Main.lean'))
  let release
  const hold = f.service.queue(
    record,
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0))
  const publishing = f.service.message(alice.client, cursor(alice, 1))
  await f.service.message(alice.client, { type: 'presence', path: null })
  release()
  await Promise.all([hold, publishing])
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(latestPresence(bob), [])
})

test('cursor updates cannot cross project boundaries or reach revoked members', async (t) => {
  const f = fixture(t)
  const alice = await f.client('alice')
  const bob = await f.client('bob')
  const get = f.store.get.bind(f.store)
  f.store.get = (projectId, actor) =>
    projectId === 'unrelated'
      ? { id: projectId, accessRole: 'editor' }
      : get(projectId, actor)
  const otherSocket = new Socket()
  f.service.connect(otherSocket, 'unrelated', 'bob')
  const other = [...f.service.clients].find((entry) => entry.ws === otherSocket)
  await f.service.message(other, { type: 'open', path: 'Main.lean' })
  await f.service.message(alice.client, cursor(alice, 1))
  await untilPresence(bob, (peers) => peers.length === 1)
  assert.deepEqual(latestPresence({ ws: otherSocket }), [])
  const count = bob.ws.packets.length
  f.roles.delete('bob')
  f.emit([], 'access')
  assert.equal(bob.ws.code, 1008)
  await f.service.message(alice.client, cursor(alice, 3))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(bob.ws.packets.length, count)
  assert.deepEqual(latestPresence({ ws: otherSocket }), [])
})

test('expired authentication removes a published cursor and presence errors cannot become document errors', async (t) => {
  const active = new Set(['alice', 'bob'])
  const f = fixture(t, {
    isAuthenticated: (_request, actor) => active.has(actor),
  })
  const alice = await f.client('alice')
  const bob = await f.client('bob')
  await f.service.message(alice.client, cursor(alice, 1))
  await untilPresence(bob, (peers) => peers.length === 1)
  alice.ws.emit('message', Buffer.from(JSON.stringify(cursor(alice, -1))))
  for (let attempt = 0; attempt < 100; attempt++) {
    if (alice.ws.packets.some((packet) => packet.type === 'presence-error'))
      break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(
    alice.ws.packets.filter((packet) => packet.type === 'presence-error')
      .length,
    1,
  )
  assert.equal(
    alice.ws.packets.filter((packet) => packet.type === 'error').length,
    0,
  )
  active.delete('alice')
  await assert.rejects(f.service.message(alice.client, cursor(alice, 2)), {
    status: 401,
  })
  assert.deepEqual(latestPresence(bob), [])
})

test('concurrent clients merge same-file edits and publish only durable canonical states', async (t) => {
  const { service, client, files } = fixture(t)
  const alice = await client('alice'),
    bob = await client('bob')
  const first = update(alice, 1, (text) => text.insert(0, '-- Alice 👋\n'))
  const second = update(bob, 1, (text) => text.insert(text.length, '-- Bob\n'))
  await Promise.all([
    service.message(alice.client, first),
    service.message(bob.client, second),
  ])
  for (const entry of [alice, bob]) {
    for (const packet of documentPackets(entry)) {
      assert.equal(sha(packet.content), packet.hash)
      Y.applyUpdate(entry.doc, dec(packet.update))
    }
    assert.equal(entry.doc.getText('source').toString(), files.get('Main.lean'))
    assert.equal(entry.ws.packets.filter((item) => item.ack === 1).length, 1)
  }
  assert.match(files.get('Main.lean'), /Alice 👋/)
  assert.match(files.get('Main.lean'), /Bob/)
})

test('setup conflicts are temporary and the same live draft publishes after project status resumes', async (t) => {
  const { service, client, store, files, emit } = fixture(t)
  const alice = await client('alice')
  const before = files.get('Main.lean')
  const request = update(alice, 1, (text) =>
    text.insert(0, '-- retained draft\n'),
  )
  store.jobs = new Map([['shared', Promise.resolve()]])
  emit([], 'project')
  await assert.rejects(service.message(alice.client, request), { status: 503 })
  assert.equal(files.get('Main.lean'), before)
  store.jobs.clear()
  emit([], 'project')
  await service.message(alice.client, request)
  assert.equal(files.get('Main.lean'), '-- retained draft\n' + before)
  assert.equal(
    alice.ws.packets.filter((packet) => packet.type === 'project').length,
    2,
  )
  assert.equal(alice.ws.packets.filter((packet) => packet.ack === 1).length, 1)
})

test('viewers, revoked members and foreign document identities cannot persist edits', async (t) => {
  const { service, client, roles, files, emit } = fixture(t)
  const viewer = await client('viewer'),
    bob = await client('bob')
  const before = files.get('Main.lean')
  await assert.rejects(
    service.message(
      viewer.client,
      update(viewer, 1, (text) => text.insert(0, 'bad')),
    ),
    { status: 403 },
  )
  const forged = update(bob, 1, (text) => text.insert(0, 'bad'))
  await assert.rejects(
    service.message(bob.client, { ...forged, documentId: 'different' }),
    { status: 409 },
  )
  roles.delete('bob')
  emit([], 'access')
  assert.equal(bob.ws.code, 1008)
  await assert.rejects(service.message(bob.client, forged), { status: 404 })
  assert.equal(files.get('Main.lean'), before)
})

test('external agent writes are broadcast and CAS races preserve the external change', async (t) => {
  let race = true,
    context
  const value = fixture(t, {
    beforeWrite: async () => {
      if (!race) return
      race = false
      context.files.set(
        'Main.lean',
        context.files.get('Main.lean') + '-- external agent\n',
      )
    },
  })
  context = value
  const alice = await value.client('alice')
  await value.service.message(
    alice.client,
    update(alice, 1, (text) => text.insert(0, '-- user\n')),
  )
  assert.match(value.files.get('Main.lean'), /-- user/)
  assert.match(value.files.get('Main.lean'), /-- external agent/)
  value.files.set(
    'Main.lean',
    value.files.get('Main.lean') + '-- second agent\n',
  )
  value.emit()
  await [...value.service.documents.values()][0].refreshTask
  assert.match(documentPackets(alice).at(-1).content, /second agent/)
})

test('revocation while an edit waits in its document queue is checked before writing', async (t) => {
  let release, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let held = true
  const value = fixture(t, {
    beforeWrite: async () => {
      if (!held) return
      held = false
      entered()
      await new Promise((resolve) => {
        release = resolve
      })
    },
  })
  const alice = await value.client('alice'),
    bob = await value.client('bob')
  const first = value.service.message(
    alice.client,
    update(alice, 1, (text) => text.insert(0, '-- owner\n')),
  )
  await started
  const second = value.service.message(
    bob.client,
    update(bob, 1, (text) => text.insert(0, '-- revoked\n')),
  )
  value.roles.delete('bob')
  release()
  await first
  await assert.rejects(second, { status: 404 })
  assert.doesNotMatch(value.files.get('Main.lean'), /revoked/)
})

test('malformed or oversized hidden document state never reaches saved sources', async (t) => {
  const value = fixture(t, { maxDocumentBytes: 512 })
  const bob = await value.client('bob')
  const before = value.files.get('Main.lean')
  bob.doc.getMap('private').set('payload', 'x'.repeat(1024))
  await assert.rejects(
    value.service.message(bob.client, {
      type: 'update',
      path: 'Main.lean',
      documentId: bob.id,
      requestId: 1,
      update: enc(Y.encodeStateAsUpdate(bob.doc)),
    }),
    { status: 400 },
  )
  await assert.rejects(
    value.service.message(bob.client, {
      type: 'update',
      path: '../private.lean',
      documentId: bob.id,
      requestId: 2,
      update: '====',
    }),
  )
  assert.equal(value.files.get('Main.lean'), before)
})

test('terminal writes reach open live documents without a workspace save notification', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-doc-watch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'Main.lean'), 'initial source')
  const value = fixture(t, { root })
  const alice = await value.client('alice')
  await fs.writeFile(path.join(root, 'Main.lean'), 'terminal changed source')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll)
      reject(new Error('terminal change was not published'))
    }, 4000)
    const poll = setInterval(() => {
      if (
        !documentPackets(alice).some(
          (packet) => packet.content === 'terminal changed source',
        )
      )
        return
      clearTimeout(timer)
      clearInterval(poll)
      resolve()
    }, 20)
  })
})

test('minimal text replacement keeps Unicode boundaries and unchanged identities', () => {
  const doc = new Y.Doc()
  const text = doc.getText('source')
  text.insert(0, 'hello 👋 world')
  replaceDocumentText(text, 'hello 🌍 world')
  assert.equal(text.toString(), 'hello 🌍 world')
  doc.destroy()
})

test('document capacity is bounded and unused documents can be reclaimed', async (t) => {
  const value = fixture(t, { maxDocuments: 1 })
  value.files.set('Other.lean', '-- another file')
  const alice = await value.client('alice')
  await assert.rejects(
    value.service.message(alice.client, { type: 'open', path: 'Other.lean' }),
    { status: 429 },
  )
  assert.equal(value.service.documents.size, 1)
  alice.ws.close()
  const ws = new Socket()
  value.service.connect(ws, 'shared', 'bob')
  const bob = [...value.service.clients].find((entry) => entry.ws === ws)
  await value.service.message(bob, { type: 'open', path: 'Other.lean' })
  assert.equal(value.service.documents.size, 1)
  assert.equal([...value.service.documents.values()][0].path, 'Other.lean')
})

test('shutdown drains a pending durable write without holding or reentering its document queue', async (t) => {
  let release, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const value = fixture(t, {
    beforeWrite: async () => {
      entered()
      await new Promise((resolve) => {
        release = resolve
      })
    },
  })
  const alice = await value.client('alice')
  const writing = value.service.message(
    alice.client,
    update(alice, 1, (text) => text.insert(0, '-- durable\n')),
  )
  await started
  let closed = false
  const closing = value.service.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false)
  release()
  await writing
  await closing
  assert.equal(closed, true)
  assert.match(value.files.get('Main.lean'), /durable/)
  assert.equal(value.service.documents.size, 0)
})

test('a small edit in a large document broadcasts a small incremental packet', async (t) => {
  const value = fixture(t)
  value.files.set('Main.lean', '-- original source\n'.repeat(100_000))
  const alice = await value.client('alice')
  await value.service.message(
    alice.client,
    update(alice, 1, (text) => text.insert(0, '-- small edit\n')),
  )
  const packet = alice.ws.packets.find((item) => item.ack === 1)
  assert.ok(packet)
  assert.equal(packet.content, undefined)
  assert.ok(JSON.stringify(packet).length < 1024)
  assert.match(documentPackets(alice).at(-1).content, /small edit/)
})

test('project configuration cannot enter the automatic collaboration write path', async (t) => {
  const value = fixture(t)
  const alice = await value.client('alice')
  for (const name of [
    'lean-toolchain',
    'lakefile.lean',
    'lakefile.toml',
    'lake-manifest.json',
  ]) {
    value.files.set(name, 'configuration')
    await assert.rejects(
      value.service.message(alice.client, { type: 'open', path: name }),
      { status: 403 },
    )
  }
  assert.equal(value.service.documents.size, 1)
})

test('post-commit notifications coalesce behind active writes without filling the update queue', async (t) => {
  const value = fixture(t)
  const alice = await value.client('alice')
  const record = [...value.service.documents.values()][0]
  let release, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const held = value.service.queue(
    record,
    () =>
      new Promise((resolve) => {
        release = resolve
        entered()
      }),
  )
  await started
  for (let index = 0; index < 100; index++) value.emit()
  assert.equal(record.pending, 1)
  release()
  await held
  await record.refreshTask
  assert.equal(record.pending, 0)
  assert.equal(
    alice.ws.packets.filter((packet) => packet.type === 'error').length,
    0,
  )
})

test('revoking a reader during background I/O does not invalidate the file for remaining collaborators', async (t) => {
  const value = fixture(t)
  const alice = await value.client('alice'),
    bob = await value.client('bob')
  const record = [...value.service.documents.values()][0]
  let entered, release
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const read = value.store.readFile.bind(value.store)
  let held = true
  value.store.readFile = async (...args) => {
    if (held && args[1] === 'alice') {
      held = false
      entered()
      await gate
    }
    return read(...args)
  }
  value.files.set(
    'Main.lean',
    value.files.get('Main.lean') + '-- another edit\n',
  )
  value.emit()
  await started
  value.roles.delete('alice')
  value.emit([], 'access')
  release()
  for (
    let attempt = 0;
    attempt < 100 &&
    record.doc.getText('source').toString() !== value.files.get('Main.lean');
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(alice.ws.code, 1008)
  assert.equal(record.invalidated, undefined)
  assert.equal(
    record.doc.getText('source').toString(),
    value.files.get('Main.lean'),
  )
  assert.equal(
    bob.ws.packets.some((packet) => packet.type === 'error'),
    false,
  )
  assert.equal(bob.ws.readyState, 1)
})

test('a transient guarded source-read conflict retries without broadcasting a blocking document error', async (t) => {
  const value = fixture(t)
  const alice = await value.client('alice'),
    bob = await value.client('bob')
  const record = [...value.service.documents.values()][0]
  const read = value.store.readFile.bind(value.store)
  let failures = 1
  value.store.readFile = (...args) => {
    if (failures-- > 0)
      throw Object.assign(new Error('File path changed during access'), {
        status: 409,
      })
    return read(...args)
  }
  value.files.set('Main.lean', '-- durable replacement\n')
  value.emit()
  await record.refreshTask
  assert.equal(
    record.doc.getText('source').toString(),
    '-- durable replacement\n',
  )
  for (const peer of [alice, bob]) {
    assert.equal(
      peer.ws.packets.some((packet) => packet.type === 'error'),
      false,
    )
    assert.equal(peer.ws.readyState, 1)
  }
})

test('an authoritative complex replacement rotates document identity without losing the saved source or poisoning peers', async (t) => {
  const value = fixture(t)
  value.files.set('Main.lean', 'a'.repeat(640001))
  const alice = await value.client('alice')
  const record = [...value.service.documents.values()][0]
  const old = record.id
  value.files.set('Main.lean', 'b'.repeat(640001))
  value.emit()
  await record.refreshTask
  assert.notEqual(record.id, old)
  assert.equal(record.doc.getText('source').toString(), 'b'.repeat(640001))
  assert.equal(
    alice.ws.packets.some((packet) => packet.type === 'error'),
    false,
  )
  const fresh = alice.ws.packets
    .filter((packet) => packet.type === 'document')
    .at(-1)
  assert.equal(fresh.content, 'b'.repeat(640001))
  await assert.rejects(
    value.service.message(alice.client, {
      ...update(alice, 1, (text) => text.insert(0, 'STALE')),
      documentId: old,
    }),
    { status: 409 },
  )
})

test('an update whose refresh replaces the document cannot publish operations from its old identity', async (t) => {
  const value = fixture(t)
  value.files.set('Main.lean', '')
  const alice = await value.client('alice')
  const stale = update(alice, 1, (text) => text.insert(0, 'STALE ROOT INSERT'))
  const record = [...value.service.documents.values()][0]
  // The insertion was authored against the empty file, so it has no causal
  // dependency on the source that will be replaced during request admission.
  value.files.set('Main.lean', 'a'.repeat(640001))
  await value.service.queue(record, () =>
    value.service.refresh(record, 'alice'),
  )
  assert.equal(record.id, alice.id)
  const replacement = 'b'.repeat(640001)
  value.files.set('Main.lean', replacement)
  let writes = 0
  const write = value.store.writeFile.bind(value.store)
  value.store.writeFile = (...args) => {
    writes++
    return write(...args)
  }

  await assert.rejects(value.service.message(alice.client, stale), {
    status: 409,
  })

  assert.notEqual(record.id, alice.id)
  assert.equal(value.files.get('Main.lean'), replacement)
  assert.equal(record.doc.getText('source').toString(), replacement)
  assert.equal(writes, 0)
  assert.equal(
    alice.ws.packets.some((packet) => packet.ack === 1),
    false,
  )
})

test('a close cancels an awaiting open before it can reattach or send a stale baseline', async (t) => {
  const value = fixture(t)
  const read = value.store.readFile.bind(value.store)
  let release, started
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const reading = new Promise((resolve) => {
    started = resolve
  })
  value.store.readFile = async (...args) => {
    started()
    await gate
    return read(...args)
  }
  const ws = new Socket()
  value.service.connect(ws, 'shared', 'alice')
  const client = [...value.service.clients].find((entry) => entry.ws === ws)
  const opening = value.service.message(client, {
    type: 'open',
    path: 'Main.lean',
    requestId: 1,
  })
  await reading
  await value.service.message(client, { type: 'close', path: 'Main.lean' })
  release()
  await opening
  assert.equal(client.paths.has('Main.lean'), false)
  assert.equal(
    [...value.service.documents.values()][0].clients.has(client),
    false,
  )
  assert.deepEqual(
    ws.packets.filter((packet) => packet.type === 'document'),
    [],
  )
  assert.equal(client.openRequests.size, 0)
})

test('close followed by a newer open admits only the newest requested baseline', async (t) => {
  const value = fixture(t)
  const read = value.store.readFile.bind(value.store)
  let release, started
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const reading = new Promise((resolve) => {
    started = resolve
  })
  value.store.readFile = async (...args) => {
    started()
    await gate
    return read(...args)
  }
  const ws = new Socket()
  value.service.connect(ws, 'shared', 'alice')
  const client = [...value.service.clients].find((entry) => entry.ws === ws)
  const oldOpen = value.service.message(client, {
    type: 'open',
    path: 'Main.lean',
    requestId: 1,
  })
  await reading
  await value.service.message(client, { type: 'close', path: 'Main.lean' })
  const newOpen = value.service.message(client, {
    type: 'open',
    path: 'Main.lean',
    requestId: 2,
  })
  release()
  await Promise.all([oldOpen, newOpen])
  const packets = ws.packets.filter((packet) => packet.type === 'document')
  assert.equal(packets.length, 1)
  assert.equal(packets[0].openRequestId, 2)
  assert.equal(packets[0].content, value.files.get('Main.lean'))
  assert.equal(client.paths.has('Main.lean'), true)
  assert.equal(client.openRequests.size, 0)
})

test('an older client without an open request identifier can still cancel its pending subscription', async (t) => {
  const value = fixture(t)
  const read = value.store.readFile.bind(value.store)
  let release, started
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const reading = new Promise((resolve) => {
    started = resolve
  })
  value.store.readFile = async (...args) => {
    started()
    await gate
    return read(...args)
  }
  const ws = new Socket()
  value.service.connect(ws, 'shared', 'alice')
  const client = [...value.service.clients].find((entry) => entry.ws === ws)
  const opening = value.service.message(client, {
    type: 'open',
    path: 'Main.lean',
  })
  await reading
  await value.service.message(client, { type: 'close', path: 'Main.lean' })
  release()
  await opening
  assert.equal(client.paths.has('Main.lean'), false)
  assert.deepEqual(
    ws.packets.filter((packet) => packet.type === 'document'),
    [],
  )
})

test('a moved file is announced with its destination, and the old live document rejects stale writes', async (t) => {
  const f = fixture(t)
  const alice = await f.client('alice'),
    bob = await f.client('bob')
  const stale = update(alice, 1, (text) => text.insert(0, '-- stale\n'))
  const content = f.files.get('Main.lean')
  f.files.set('Moved.lean', content)
  f.files.delete('Main.lean')
  const moves = [{ from: 'Main.lean', to: 'Moved.lean' }]
  f.emit(['Main.lean', 'Moved.lean'], 'files', {
    removedPaths: ['Main.lean'],
    moves,
  })
  for (const entry of [alice, bob]) {
    assert.deepEqual(
      entry.ws.packets.filter((packet) => packet.type === 'files'),
      [
        {
          type: 'files',
          paths: ['Main.lean', 'Moved.lean'],
          removedPaths: ['Main.lean'],
          moves,
        },
      ],
    )
    assert.equal(
      entry.ws.packets.some((packet) => packet.type === 'error'),
      false,
      'peers are not told the file was removed',
    )
  }
  // The retired document still refuses writes, so the old path is never recreated.
  await assert.rejects(f.service.message(alice.client, stale), { status: 409 })
  assert.equal(f.files.has('Main.lean'), false)
  // The destination opens as an ordinary new document with the same source.
  await f.service.message(alice.client, { type: 'open', path: 'Moved.lean' })
  const opened = alice.ws.packets
    .filter(
      (packet) => packet.type === 'document' && packet.path === 'Moved.lean',
    )
    .at(-1)
  assert.equal(opened.hash, sha(content))
})

test('deleting a live file keeps the removal error for collaborators', async (t) => {
  const f = fixture(t)
  const alice = await f.client('alice')
  f.files.delete('Main.lean')
  f.emit(['Main.lean'], 'files', { removedPaths: ['Main.lean'] })
  const errors = alice.ws.packets.filter((packet) => packet.type === 'error')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].status, 409)
  assert.match(errors[0].message, /removed or moved/)
})
