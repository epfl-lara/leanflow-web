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
  const emit = (paths = ['Main.lean'], kind = 'files') => {
    for (const listener of listeners)
      listener({ projectId: 'shared', paths, kind })
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
