import test from 'node:test'
import assert from 'node:assert/strict'
import promiseFs, * as fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { WorkspaceStore } from '../workspaces.mjs'
import { SaveEvents } from '../save-events.mjs'
import { ProjectDocuments } from '../project-documents.mjs'
import * as Y from 'yjs'
import { DatabaseSync } from 'node:sqlite'
import { createStudio } from '../studio.mjs'
import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-durable-save-'),
  )
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args) {
      if (args[0] === 'lake' && args.includes('update'))
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const cleanup = []
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  const project = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(project.id)
  t.after(async () => {
    for (const action of cleanup) await action()
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return {
    store,
    project,
    dataDir,
    before: await store.readFile(project.id, 'alice', 'Main.lean'),
    runtime,
    cleanup,
  }
}

function mockOpen(t, transform) {
  const original = promiseFs.open
  const mock = t.mock.method(promiseFs, 'open', async (...args) => {
    const handle = await original(...args)
    await transform(handle, ...args)
    return handle
  })
  syncBuiltinESMExports()
  return () => {
    mock.mock.restore()
    syncBuiltinESMExports()
  }
}

function ioError() {
  return Object.assign(
    new Error('Private host/source fixture must not leak.'),
    { code: 'ENOSPC' },
  )
}

test('a single-file ACK follows file fsync, atomic replacement and parent fsync while preserving mode', async (t) => {
  const { store, project, before } = await fixture(t)
  const filename = path.join(project.root, 'Main.lean')
  await fs.chmod(filename, 0o750)
  const order = []
  const restore = mockOpen(t, (handle, opened) => {
    const original = handle.sync.bind(handle)
    if (String(opened).includes('/.lemex-write-'))
      handle.sync = async () => {
        order.push('file-sync')
        await original()
      }
    else if (opened === project.root)
      handle.sync = async () => {
        order.push('parent-sync')
        await original()
      }
  })
  const rename = promiseFs.rename
  t.mock.method(promiseFs, 'rename', async (...args) => {
    order.push('rename')
    return rename(...args)
  })
  syncBuiltinESMExports()
  try {
    const saved = await store.writeFile(
      project.id,
      'alice',
      'Main.lean',
      '-- durable source\n',
      before.hash,
    )
    order.push('ack')
    assert.deepEqual(order, ['file-sync', 'rename', 'parent-sync', 'ack'])
    assert.equal(
      saved.hash,
      (await store.readFile(project.id, 'alice', 'Main.lean')).hash,
    )
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o750)
  } finally {
    restore()
  }
})

for (const phase of ['write', 'file-sync'])
  test(`a ${phase} failure leaves the source unchanged and removes its exclusive temporary file`, async (t) => {
    const { store, project, before } = await fixture(t)
    let hit = false
    const restore = mockOpen(t, (handle, filename) => {
      if (String(filename).includes('/.lemex-write-'))
        handle[phase === 'write' ? 'writeFile' : 'sync'] = async () => {
          hit = true
          throw ioError()
        }
    })
    try {
      await assert.rejects(
        store.writeFile(
          project.id,
          'alice',
          'Main.lean',
          '-- pending private draft\n',
          before.hash,
        ),
        (error) => {
          assert.equal(error.status, 503)
          assert.equal(error.sourceCommitted, false)
          assert.match(error.message, /original file is unchanged/)
          assert.doesNotMatch(error.message, /Private host|fixture/)
          return true
        },
      )
      assert.equal(hit, true)
      assert.deepEqual(
        await store.readFile(project.id, 'alice', 'Main.lean'),
        before,
      )
      assert(
        !(await fs.readdir(project.root)).some((name) =>
          name.startsWith('.lemex-write-'),
        ),
      )
    } finally {
      restore()
    }
  })

test('post-rename directory sync failure reports the visible commit truthfully, notifies peers, and exact retry never replaces it', async (t) => {
  const { store, project, before } = await fixture(t)
  const notifications = []
  store.subscribeChanges((event) => notifications.push(event))
  let fail = true
  const restore = mockOpen(t, (handle, filename) => {
    if (filename === project.root) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (fail) throw ioError()
        return sync()
      }
    }
  })
  const content = '-- keep this draft after failed durability confirmation\n'
  try {
    await assert.rejects(
      store.writeFile(project.id, 'alice', 'Main.lean', content, before.hash),
      (error) => {
        assert.equal(error.status, 503)
        assert.equal(error.sourceCommitted, true)
        assert.match(error.message, /updated file is visible/)
        assert.match(error.message, /Keep or download your draft/)
        assert.doesNotMatch(error.message, /unchanged|Private host/)
        return true
      },
    )
    assert.equal(
      (await store.readFile(project.id, 'alice', 'Main.lean')).content,
      content,
    )
    assert(
      notifications.some(
        (event) =>
          event.projectId === project.id && event.paths.includes('Main.lean'),
      ),
    )
    const inode = (await fs.stat(path.join(project.root, 'Main.lean'))).ino
    const rename = t.mock.method(promiseFs, 'rename', () =>
      assert.fail(
        'An exact retry must fsync the existing file, never replace it.',
      ),
    )
    syncBuiltinESMExports()
    fail = false
    const retried = await store.writeFile(
      project.id,
      'alice',
      'Main.lean',
      content,
      before.hash,
    )
    assert.equal(retried.content, content)
    assert.equal(
      retried.hash,
      (await store.readFile(project.id, 'alice', 'Main.lean')).hash,
    )
    assert.equal(
      (await fs.stat(path.join(project.root, 'Main.lean'))).ino,
      inode,
    )
    rename.mock.restore()
    syncBuiltinESMExports()
    await assert.rejects(
      store.writeFile(
        project.id,
        'alice',
        'Main.lean',
        '-- a different stale draft\n',
        before.hash,
      ),
      { status: 409 },
    )
    assert.equal(
      (await store.readFile(project.id, 'alice', 'Main.lean')).content,
      content,
    )
  } finally {
    restore()
  }
})

test('an exact retry refuses a file changed while fsync was pending', async (t) => {
  const { store, project, before } = await fixture(t)
  const content = '-- committed text\n'
  const saved = await store.writeFile(
    project.id,
    'alice',
    'Main.lean',
    content,
    before.hash,
  )
  let changed = false
  const restore = mockOpen(t, (handle, filename) => {
    if (
      String(filename).startsWith('/proc/self/fd/') &&
      String(filename).endsWith('/Main.lean')
    ) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync()
        changed = true
        await fs.writeFile(
          path.join(project.root, 'Main.lean'),
          '-- a later edit\n',
        )
      }
    }
  })
  try {
    await assert.rejects(
      store.writeFile(project.id, 'alice', 'Main.lean', content, before.hash),
      { status: 409 },
    )
    assert.equal(changed, true)
    assert.equal(
      (await store.readFile(project.id, 'alice', 'Main.lean')).content,
      '-- a later edit\n',
    )
    assert.notEqual(saved.hash, before.hash)
  } finally {
    restore()
  }
})

test('account revocation during staged fsync prevents replacement and keeps original source', async (t) => {
  const { store, project, before } = await fixture(t)
  let active = true
  const restore = mockOpen(t, (handle, filename) => {
    if (String(filename).includes('/.lemex-write-')) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync()
        active = false
      }
    }
  })
  try {
    await assert.rejects(
      store.writeFile(
        project.id,
        'alice',
        'Main.lean',
        '-- forbidden pending write\n',
        before.hash,
        {
          assertAuthorized() {
            if (!active)
              throw Object.assign(new Error('Account access changed.'), {
                status: 401,
              })
          },
        },
      ),
      { status: 401 },
    )
    assert.deepEqual(
      await store.readFile(project.id, 'alice', 'Main.lean'),
      before,
    )
  } finally {
    restore()
  }
})

test('activity database failure cannot fail a committed single save or batch apply or suppress notifications', async (t) => {
  const { store, project, before } = await fixture(t)
  const notifications = [],
    diagnostics = []
  store.subscribeChanges((event) => notifications.push(event))
  const prepare = store.db.prepare.bind(store.db)
  t.mock.method(store.db, 'prepare', (sql) => {
    if (sql.startsWith('INSERT INTO events')) throw ioError()
    return prepare(sql)
  })
  t.mock.method(console, 'warn', (...parts) => diagnostics.push(parts))
  const single = await store.writeFile(
    project.id,
    'alice',
    'Main.lean',
    '-- successful single\n',
    before.hash,
  )
  store.saveEvents.flush()
  const batch = await store.writeFiles(project.id, 'alice', [
    {
      path: 'Main.lean',
      content: '-- successful batch\n',
      expectedHash: single.hash,
    },
  ])
  assert.equal(batch.applied, 1)
  assert.equal(
    batch.files[0].hash,
    (await store.readFile(project.id, 'alice', 'Main.lean')).hash,
  )
  assert(
    notifications.filter((event) => event.paths.includes('Main.lean')).length >=
      2,
  )
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    '-- successful batch\n',
  )
  assert(diagnostics.length >= 1)
  assert.doesNotMatch(
    JSON.stringify(diagnostics),
    /Private host|source fixture|successful batch|successful single/,
  )
})

test('ordinary typing events coalesce per project and file with bounded pending memory', () => {
  const saved = []
  const log = new SaveEvents({
    append: (events) => saved.push(...events),
    maximum: 2,
  })
  for (let index = 0; index < 50; index++) log.record('project-a', 'Main.lean')
  log.record('project-b', 'Main.lean')
  log.record('project-c', 'Third.lean')
  assert.equal(saved.length, 0)
  assert.equal(log.pending.size, 2)
  log.flush()
  assert.deepEqual(saved, [
    { projectId: 'project-a', filename: 'Main.lean', count: 50 },
    { projectId: 'project-b', filename: 'Main.lean', count: 1 },
  ])
  assert.equal(log.pending.size, 0)
  log.close()
  log.record('project-a', 'Main.lean')
  assert.equal(log.pending.size, 0)
})

test('a bounded multi-file activity flush uses one SQLite commit and preserves project-scoped rows', async (t) => {
  const { store, project } = await fixture(t)
  const exec = store.db.exec.bind(store.db),
    statements = []
  t.mock.method(store.db, 'exec', (sql) => {
    statements.push(sql)
    return exec(sql)
  })
  for (let index = 0; index < 256; index++)
    store.saveEvents.record(project.id, `Proofs/File${index}.lean`)
  store.saveEvents.record(project.id, 'Proofs/Overflow.lean')
  assert.equal(store.saveEvents.pending.size, 256)
  store.saveEvents.flush()
  const saved = store
    .events(project.id, 'alice')
    .filter((event) => event.type === 'saved')
  assert.equal(saved.length, 256)
  assert.equal(
    statements.filter((sql) => sql.includes('BEGIN IMMEDIATE')).length,
    1,
  )
  assert.equal(statements.filter((sql) => sql === 'COMMIT').length, 1)
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
  assert.equal(store.saveEvents.pending.size, 0)
})

test('optional activity never waits for the durable journal writer or nests inside project metadata transactions', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const writer = new DatabaseSync(path.join(dataDir, 'workspaces.sqlite'))
  t.after(() => writer.close())
  writer.exec('BEGIN IMMEDIATE')
  store.saveEvents.record(project.id, 'Main.lean')
  const started = performance.now()
  store.saveEvents.flush()
  assert(
    performance.now() - started < 1000,
    'Optional audit must not wait on the five-second metadata timeout',
  )
  assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
  writer.exec('ROLLBACK')
  store.db.exec('BEGIN IMMEDIATE')
  store.saveEvents.record(project.id, 'Main.lean')
  store.saveEvents.flush()
  assert.equal(store.db.isTransaction, true)
  store.db.exec('COMMIT')
  assert.equal(
    store.events(project.id, 'alice').filter((event) => event.type === 'saved')
      .length,
    0,
  )
})

test('an unexpected audit callback or diagnostic failure never escapes a flush timer or close', async () => {
  let called = 0
  const log = new SaveEvents({
    delayMs: 1,
    append() {
      called++
      throw ioError()
    },
    onError() {
      throw new Error('Optional diagnostic unavailable')
    },
  })
  log.record('project', 'Main.lean')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(called, 1)
  assert.equal(log.pending.size, 0)
  log.record('project', 'Main.lean')
  assert.doesNotThrow(() => log.close())
  assert.equal(called, 2)
})

test('HTTP save uncertainty preserves the submitted draft text and exact stale retries confirm the same canonical bytes', async (t) => {
  const f = await fixture(t)
  const studio = await createStudio({
    dataDir: f.dataDir,
    runtime: f.runtime,
    modelDiscoverer: fixtureModelDiscovery,
    titleGenerator: async () => null,
    config: {
      defaultModel: 'fixture',
      models: [{ id: 'fixture' }],
      provider: {},
      lemex: {},
      redact: String,
    },
  })
  f.cleanup.push(() => studio.close())
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const project = await studio.workspaces.create('owner', { preset: 'lean' })
  await studio.workspaces.jobs.get(project.id)
  const source = await studio.workspaces.readFile(
    project.id,
    'owner',
    'Main.lean',
  )
  const origin = `http://127.0.0.1:${studio.server.address().port}`
  const token = (
    await fs.readFile(path.join(f.dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const draft = '-- a private draft that remains available for retry\n'
  const put = () =>
    fetch(`${origin}/api/projects/${project.id}/file?path=Main.lean`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: draft, expectedHash: source.hash }),
    })
  let fail = true
  const restore = mockOpen(t, (handle, filename) => {
    if (filename === project.root) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (fail) throw ioError()
        return sync()
      }
    }
  })
  try {
    const uncertain = await put()
    assert.equal(uncertain.status, 503)
    const error = await uncertain.json()
    assert.match(error.error, /updated file is visible/)
    assert.match(error.error, /Keep or download your draft/)
    assert.equal(
      (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean'))
        .content,
      draft,
    )
    fail = false
    const confirmed = await put()
    assert.equal(confirmed.status, 200)
    const saved = await confirmed.json()
    assert.equal(saved.content, draft)
    assert.equal(
      saved.hash,
      (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean')).hash,
    )
  } finally {
    restore()
  }
})

test('idempotent same-text retries still require a valid original hash when a version is supplied', async (t) => {
  const { store, project, before } = await fixture(t)
  for (const expectedHash of [0, {}, [], '', 'not-a-source-version'])
    await assert.rejects(
      store.writeFile(
        project.id,
        'alice',
        'Main.lean',
        before.content,
        expectedHash,
      ),
      { status: 400 },
    )
  assert.deepEqual(
    await store.readFile(project.id, 'alice', 'Main.lean'),
    before,
  )
})

test('a real post-commit sync failure keeps original Yjs identities, waits for durable ACK and preserves collaborator text through private Undo', async (t) => {
  const f = await fixture(t)
  await f.store.setMember(f.project.id, 'alice', 'bob', 'editor')
  const service = new ProjectDocuments({ workspaces: f.store })
  f.cleanup.push(() => service.close())
  const decode = (value) => new Uint8Array(Buffer.from(value, 'base64'))
  const encode = (value) => Buffer.from(value).toString('base64')
  async function open(actor) {
    const packets = []
    const client = {
      projectId: f.project.id,
      actor,
      paths: new Set(),
      vectors: new Map(),
      openRequests: new Map(),
      ws: {
        readyState: 1,
        bufferedAmount: 0,
        send(raw) {
          packets.push(JSON.parse(raw))
        },
        close() {
          this.readyState = 3
        },
        terminate() {
          this.readyState = 3
        },
      },
    }
    service.clients.add(client)
    await service.message(client, { type: 'open', path: 'Main.lean' })
    const packet = packets.find((value) => value.type === 'document')
    const doc = new Y.Doc()
    t.after(() => doc.destroy())
    Y.applyUpdate(doc, decode(packet.update))
    let consumed = 0
    return {
      client,
      packets,
      doc,
      id: packet.documentId,
      deliver() {
        for (const value of packets.slice(consumed))
          if (value.type === 'document')
            Y.applyUpdate(doc, decode(value.update))
        consumed = packets.length
      },
    }
  }
  const alice = await open('alice'),
    bob = await open('bob')
  const localOrigin = Symbol('private Alice edit')
  const undo = new Y.UndoManager(alice.doc.getText('source'), {
    trackedOrigins: new Set([localOrigin]),
  })
  t.after(() => undo.destroy())
  const vector = Y.encodeStateVector(alice.doc)
  alice.doc.transact(
    () => alice.doc.getText('source').insert(0, '-- ALICE_LOCAL\n'),
    localOrigin,
  )
  undo.stopCapturing()
  const request = {
    type: 'update',
    path: 'Main.lean',
    documentId: alice.id,
    requestId: 1,
    update: encode(Y.encodeStateAsUpdate(alice.doc, vector)),
  }
  let fail = true
  const restore = mockOpen(t, (handle, filename) => {
    if (filename === f.project.root) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (fail) throw ioError()
        return sync()
      }
    }
  })
  try {
    await assert.rejects(service.message(alice.client, request), {
      status: 503,
      sourceCommitted: true,
    })
    const record = [...service.documents.values()][0]
    assert.equal(record.clientOwners.get(alice.doc.clientID), 'alice')
    await record.refreshTask
    await record.queue
    assert.equal(record.pending, 0)
    assert.equal(service.pendingBytes, 0)
    assert.equal(record.bytes, Y.encodeStateAsUpdate(record.doc).byteLength)
    assert.equal(alice.packets.filter((packet) => packet.ack === 1).length, 0)
    alice.deliver()
    bob.deliver()
    assert.equal(
      alice.doc.getText('source').toString(),
      '-- ALICE_LOCAL\n' + f.before.content,
    )
    assert.equal(
      bob.doc.getText('source').toString(),
      alice.doc.getText('source').toString(),
    )
    const causalState = Y.encodeStateVector(record.doc)
    await service.queue(record, () => service.refresh(record, 'alice'))
    assert.deepEqual(Y.encodeStateVector(record.doc), causalState)
    await assert.rejects(service.message(alice.client, request), {
      status: 503,
      sourceCommitted: true,
    })
    assert.equal(alice.packets.filter((packet) => packet.ack === 1).length, 0)
    assert.deepEqual(Y.encodeStateVector(record.doc), causalState)
    fail = false
    const bobVector = Y.encodeStateVector(bob.doc)
    bob.doc
      .getText('source')
      .insert(bob.doc.getText('source').length, '-- BOB_REMOTE\n')
    await service.message(bob.client, {
      type: 'update',
      path: 'Main.lean',
      documentId: bob.id,
      requestId: 2,
      update: encode(Y.encodeStateAsUpdate(bob.doc, bobVector)),
    })
    alice.deliver()
    bob.deliver()
    const inode = (await fs.stat(path.join(f.project.root, 'Main.lean'))).ino
    await service.message(alice.client, request)
    assert.equal(alice.packets.filter((packet) => packet.ack === 1).length, 1)
    assert.equal(
      (await fs.stat(path.join(f.project.root, 'Main.lean'))).ino,
      inode,
    )
    alice.deliver()
    assert.equal(
      (await f.store.readFile(f.project.id, 'alice', 'Main.lean')).content,
      '-- ALICE_LOCAL\n' + f.before.content + '-- BOB_REMOTE\n',
    )
    const undoVector = Y.encodeStateVector(alice.doc)
    assert(undo.undo())
    assert.equal(
      alice.doc.getText('source').toString(),
      f.before.content + '-- BOB_REMOTE\n',
    )
    await service.message(alice.client, {
      type: 'update',
      path: 'Main.lean',
      documentId: alice.id,
      requestId: 3,
      update: encode(Y.encodeStateAsUpdate(alice.doc, undoVector)),
    })
    assert.equal(
      (await f.store.readFile(f.project.id, 'alice', 'Main.lean')).content,
      f.before.content + '-- BOB_REMOTE\n',
    )
    await record.refreshTask
    await record.queue
    assert.equal(record.pending, 0)
    assert.equal(service.pendingBytes, 0)
  } finally {
    restore()
  }
})
