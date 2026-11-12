import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'
import * as Y from 'yjs'
import { createStudio } from '../studio.mjs'
import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'

const TOOLCHAIN = 'leanprover/lean4:v4.34.1'
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(10)
  }
  throw new Error(`Timed out: ${message}`)
}
const encode = (update) => Buffer.from(update).toString('base64')
const decode = (update) => new Uint8Array(Buffer.from(update, 'base64'))

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-sharing-adversarial-'),
  )
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: TOOLCHAIN }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async run(root, args) {
      if (args[0] === 'lake' && args[1] === 'update')
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  let studio, origin
  const sockets = new Set()
  const start = async () => {
    studio = await createStudio({
      dataDir,
      runtime,
      modelDiscoverer: fixtureModelDiscovery,
      config: {
        models: [{ id: 'fixture-model' }],
        defaultModel: 'fixture-model',
        provider: { LEMEX_BASE_URL: 'https://provider.example/v1' },
        lemex: {},
        redact: String,
      },
      titleGenerator: async () => null,
    })
    await new Promise((resolve) =>
      studio.server.listen(0, '127.0.0.1', resolve),
    )
    origin = `http://127.0.0.1:${studio.server.address().port}`
  }
  await start()
  t.after(async () => {
    for (const ws of sockets) ws.terminate()
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const admin = {
    id: 'owner',
    token: (
      await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
    ).trim(),
  }
  const users = { admin }
  for (const name of ['Alice', 'Bob', 'Carol', 'Viewer', 'Outsider']) {
    const result = await studio.auth.createUser(admin, { name })
    users[name.toLowerCase()] = { id: result.user.id, token: result.token }
  }
  const project = await studio.workspaces.create(admin.id, {
    name: 'Adversarial shared project',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  await studio.workspaces.writeFile(
    project.id,
    admin.id,
    'Main.lean',
    'base text\n',
    (await studio.workspaces.readFile(project.id, admin.id, 'Main.lean')).hash,
  )
  for (const name of ['alice', 'bob', 'carol'])
    await studio.workspaces.setMember(
      project.id,
      admin.id,
      users[name].id,
      'editor',
    )
  await studio.workspaces.setMember(
    project.id,
    admin.id,
    users.viewer.id,
    'viewer',
  )
  const request = (endpoint, { actor = admin, body, method = 'GET' } = {}) =>
    fetch(origin + endpoint, {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const connect = async (
    actor,
    {
      id = project.id,
      name = 'Main.lean',
      open = true,
      doc = new Y.Doc(),
    } = {},
  ) => {
    const peer = { packets: [], doc, requestId: 0, id: null }
    const ws = new WebSocket(
      origin.replace('http:', 'ws:') + `/websocket/collaboration/${id}`,
      { headers: { Authorization: `Bearer ${actor.token}`, Origin: origin } },
    )
    sockets.add(ws)
    peer.ws = ws
    ws.on('error', () => {})
    ws.on('message', (bytes) => {
      const packet = JSON.parse(bytes.toString())
      if (peer.ignorePackets) return
      peer.packets.push(packet)
      if (packet.type === 'document') {
        peer.id = packet.documentId
        Y.applyUpdate(peer.doc, decode(packet.update))
      }
    })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => {
        res.resume()
        reject(
          Object.assign(new Error('Handshake denied'), {
            status: res.statusCode,
          }),
        )
      })
    })
    await until(
      () => peer.packets.some((item) => item.type === 'ready'),
      'collaboration ready',
    )
    if (open) {
      ws.send(JSON.stringify({ type: 'open', path: name }))
      await until(
        () =>
          peer.packets.some(
            (item) => item.type === 'document' && item.path === name,
          ),
        'document opened',
      )
    }
    peer.send = (body) => ws.send(JSON.stringify(body))
    peer.edit = (change) => {
      const vector = Y.encodeStateVector(peer.doc)
      change(peer.doc.getText('source'))
      const requestId = ++peer.requestId
      peer.send({
        type: 'update',
        path: name,
        documentId: peer.id,
        update: encode(Y.encodeStateAsUpdate(peer.doc, vector)),
        requestId,
      })
      return requestId
    }
    peer.ack = (requestId) =>
      until(
        () =>
          peer.packets.find(
            (item) =>
              item.ack === requestId ||
              (item.requestId === requestId && item.type === 'error'),
          ),
        `ack ${requestId}`,
      )
    return peer
  }
  const file = () =>
    studio.workspaces.readFile(project.id, admin.id, 'Main.lean')
  return {
    users,
    project,
    request,
    connect,
    file,
    dataDir,
    get studio() {
      return studio
    },
    get origin() {
      return origin
    },
    async restart() {
      for (const ws of sockets) ws.terminate()
      await studio.close()
      await start()
    },
  }
}

test('real WebSocket peers converge under seeded concurrent insert/delete/paste rounds and server restart', async (t) => {
  const f = await fixture(t)
  const peers = await Promise.all(
    ['alice', 'bob', 'carol'].map((name) => f.connect(f.users[name])),
  )
  let seed = 73129
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  for (let round = 0; round < 36; round++) {
    const ids = peers.map((peer, index) =>
      peer.edit((source) => {
        if (source.length > 30 && random() < 0.35)
          source.delete(
            Math.floor(random() * source.length),
            Math.min(3, source.length),
          )
        else
          source.insert(
            Math.floor(random() * (source.length + 1)),
            `[${round}:${index}:λ]${round % 9 === 0 ? 'pasted text\n'.repeat(30) : ''}`,
          )
      }),
    )
    const receipts = await Promise.all(
      peers.map((peer, index) => peer.ack(ids[index])),
    )
    assert(receipts.every((receipt) => receipt.type === 'document'))
    await until(async () => {
      const saved = (await f.file()).content
      return peers.every(
        (peer) => peer.doc.getText('source').toString() === saved,
      )
    }, `round ${round} convergence`)
  }
  const saved = await f.file()
  assert(saved.content.includes('λ'))
  await f.restart()
  assert.equal((await f.file()).content, saved.content)
  const reconnected = await f.connect(f.users.bob)
  assert.equal(reconnected.doc.getText('source').toString(), saved.content)
  for (const peer of [...peers, reconnected]) peer.doc.destroy()
})

test('real sockets reject viewer writes, unknown roots, malformed operations and unrelated project paths without poisoning later edits', async (t) => {
  const f = await fixture(t)
  const viewer = await f.connect(f.users.viewer)
  const requestId = viewer.edit((source) => source.insert(0, 'FORBIDDEN'))
  assert.equal((await viewer.ack(requestId)).status, 403)
  const alice = await f.connect(f.users.alice)
  const malicious = new Y.Doc()
  malicious.getMap('private-users').set('payload', 'hidden metadata')
  alice.send({
    type: 'update',
    path: 'Main.lean',
    documentId: alice.id,
    requestId: 1,
    update: encode(Y.encodeStateAsUpdate(malicious)),
  })
  assert.equal((await alice.ack(1)).status, 400)
  alice.send({
    type: 'update',
    path: 'Main.lean',
    documentId: alice.id,
    requestId: 2,
    update: '////',
  })
  assert.equal((await alice.ack(2)).status, 400)
  for (const name of [
    '../private/Main.lean',
    '/etc/passwd',
    '.env',
    '.lake/packages/X.lean',
    'lean-toolchain',
  ]) {
    const before = alice.packets.length
    alice.send({ type: 'open', path: name })
    const error = await until(
      () =>
        alice.packets.slice(before).find((packet) => packet.type === 'error'),
      `reject ${name}`,
    )
    assert([400, 403].includes(error.status))
  }
  alice.requestId = 2
  const good = alice.edit((source) => source.insert(0, 'VALID\n'))
  assert.equal((await alice.ack(good)).type, 'document')
  assert.equal((await f.file()).content, 'VALID\nbase text\n')
  assert.equal(
    (
      await f.request(`/api/projects/${f.project.id}/FILE/?path=Main.lean`, {
        actor: f.users.viewer,
        method: 'PUT',
        body: { content: 'BAD', expectedHash: null },
      })
    ).status,
    403,
  )
  await assert.rejects(f.connect(f.users.outsider), { status: 404 })
  malicious.destroy()
  viewer.doc.destroy()
  alice.doc.destroy()
})

test('revoking an account token invalidates an already-open collaborative socket before its next write', async (t) => {
  const f = await fixture(t)
  const alice = await f.connect(f.users.alice)
  await f.studio.auth.mutate(() => {
    f.studio.auth.users = f.studio.auth.users.filter(
      (user) => user.id !== f.users.alice.id,
    )
  })
  assert.equal(
    (await f.request(`/api/projects/${f.project.id}`, { actor: f.users.alice }))
      .status,
    401,
  )
  const requestId = alice.edit((source) =>
    source.insert(0, 'REVOKED_ACCOUNT\n'),
  )
  await until(
    () =>
      alice.ws.readyState === WebSocket.CLOSED ||
      alice.packets.some(
        (packet) => packet.requestId === requestId && packet.type === 'error',
      ),
    'account revocation',
  )
  assert.equal((await f.file()).content, 'base text\n')
  alice.doc.destroy()
})

test('simultaneous admin demotions preserve an admin and revoked links cannot rejoin after restart', async (t) => {
  const f = await fixture(t)
  await f.studio.workspaces.setMember(
    f.project.id,
    f.users.admin.id,
    f.users.alice.id,
    'admin',
  )
  const base = `/api/projects/${f.project.id}`
  const responses = await Promise.all([
    f.request(`${base}/sharing/members/${f.users.admin.id}`, {
      method: 'PUT',
      body: { role: 'editor' },
    }),
    f.request(`${base}/sharing/members/${f.users.alice.id}`, {
      actor: f.users.alice,
      method: 'PUT',
      body: { role: 'viewer' },
    }),
  ])
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  )
  const rows = f.studio.workspaces.db
    .prepare(
      "SELECT user FROM project_members WHERE project=? AND role='admin'",
    )
    .all(f.project.id)
  assert.equal(rows.length, 1)
  const admin = Object.values(f.users).find((user) => user.id === rows[0].user)
  const link = await (
    await f.request(`${base}/sharing/links`, {
      actor: admin,
      method: 'POST',
      body: { role: 'editor' },
    })
  ).json()
  assert.equal(
    (
      await f.request(`${base}/sharing/links/${link.id}`, {
        actor: admin,
        method: 'DELETE',
        body: {},
      })
    ).status,
    200,
  )
  await f.restart()
  assert.equal(
    (
      await f.request('/api/project-invitations/join', {
        actor: f.users.outsider,
        method: 'POST',
        body: { token: link.token },
      })
    ).status,
    404,
  )
})

test('one account cannot consume every live connection or document subscription', async (t) => {
  const f = await fixture(t)
  f.studio.projectDocuments.maxClientsPerActor = 2
  f.studio.projectDocuments.maxDocumentsPerActor = 2
  const first = await f.connect(f.users.alice)
  const second = await f.connect(f.users.alice)
  await assert.rejects(f.connect(f.users.alice), { status: 429 })
  const bob = await f.connect(f.users.bob)
  for (const name of ['Other.lean', 'Third.lean'])
    await f.studio.workspaces.writeFile(
      f.project.id,
      f.users.admin.id,
      name,
      '-- additional source\n',
      null,
    )
  first.send({ type: 'open', path: 'Other.lean' })
  await until(
    () =>
      first.packets.some(
        (packet) => packet.type === 'document' && packet.path === 'Other.lean',
      ),
    'second actor document',
  )
  second.send({ type: 'open', path: 'Third.lean' })
  await until(
    () =>
      second.packets.some(
        (packet) =>
          packet.type === 'error' &&
          packet.path === 'Third.lean' &&
          packet.status === 429,
      ),
    'account document limit',
  )
  bob.send({ type: 'open', path: 'Third.lean' })
  await until(
    () =>
      bob.packets.some(
        (packet) => packet.type === 'document' && packet.path === 'Third.lean',
      ),
    'other account admission',
  )
  for (const peer of [first, second, bob]) peer.doc.destroy()
})

test('an old live document cannot publish into a deleted and recreated file', async (t) => {
  const f = await fixture(t)
  const alice = await f.connect(f.users.alice)
  const vector = Y.encodeStateVector(alice.doc)
  alice.doc.getText('source').insert(0, 'OLD_DRAFT\n')
  const update = encode(Y.encodeStateAsUpdate(alice.doc, vector))
  const oldDocument = alice.id
  assert.equal(
    (
      await f.request(`/api/projects/${f.project.id}/trash`, {
        method: 'POST',
        body: { path: 'Main.lean' },
      })
    ).status,
    200,
  )
  await until(
    () =>
      alice.packets.some(
        (packet) => packet.type === 'error' && packet.path === 'Main.lean',
      ),
    'deleted file notice',
  )
  assert.equal(
    (
      await f.request(`/api/projects/${f.project.id}/file?path=Main.lean`, {
        method: 'PUT',
        body: { content: 'NEW_FILE\n', expectedHash: null },
      })
    ).status,
    200,
  )
  alice.send({
    type: 'update',
    path: 'Main.lean',
    documentId: oldDocument,
    requestId: 1,
    update,
  })
  const rejected = await alice.ack(1)
  assert.equal(rejected.type, 'error')
  assert.equal(rejected.status, 409)
  assert.equal((await f.file()).content, 'NEW_FILE\n')
  alice.doc.destroy()
})

test('credential rotation while a source write waits in the workspace queue prevents its commit', async (t) => {
  const f = await fixture(t)
  const alice = await f.connect(f.users.alice)
  let release
  f.studio.workspaces.locks.set(
    f.project.id,
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const requestId = alice.edit((source) => source.insert(0, 'ROTATED_KEY\n'))
  await until(
    () => f.studio.workspaces.locks.get(f.project.id) !== undefined,
    'queued source update',
  )
  await delay(30)
  await f.studio.auth.mutate(() => {
    const user = f.studio.auth.users.find(
      (entry) => entry.id === f.users.alice.id,
    )
    user.tokenHash = '0'.repeat(64)
  })
  release()
  await until(
    () =>
      alice.ws.readyState === WebSocket.CLOSED ||
      alice.packets.some(
        (packet) => packet.type === 'error' && packet.requestId === requestId,
      ),
    'rotated credential rejected',
  )
  assert.equal((await f.file()).content, 'base text\n')
  alice.doc.destroy()
})

test('real disconnect with a lost durable acknowledgement replays idempotently without duplicating or dropping offline edits', async (t) => {
  const f = await fixture(t)
  const alice = await f.connect(f.users.alice)
  const bob = await f.connect(f.users.bob)
  alice.ignorePackets = true
  alice.edit((source) => source.insert(0, 'ONCE_ONLY\n'))
  await until(
    async () => (await f.file()).content.startsWith('ONCE_ONLY\n'),
    'server durable save despite lost ACK',
  )
  alice.ws.terminate()
  await until(
    () => alice.ws.readyState === WebSocket.CLOSED,
    'offline socket closed',
  )
  alice.doc
    .getText('source')
    .insert(alice.doc.getText('source').length, 'OFFLINE_EDIT\n')
  const reconnected = await f.connect(f.users.alice, { doc: alice.doc })
  const replay = {
    type: 'update',
    path: 'Main.lean',
    documentId: reconnected.id,
    requestId: 1,
    update: encode(Y.encodeStateAsUpdate(alice.doc)),
  }
  reconnected.send(replay)
  assert.equal((await reconnected.ack(1)).type, 'document')
  reconnected.send({ ...replay, requestId: 2 })
  assert.equal((await reconnected.ack(2)).type, 'document')
  const saved = (await f.file()).content
  assert.equal(saved, 'ONCE_ONLY\nbase text\nOFFLINE_EDIT\n')
  await until(
    () => bob.doc.getText('source').toString() === saved,
    'remote peer sees all replayed edits',
  )
  assert.equal(saved.match(/ONCE_ONLY/g).length, 1)
  alice.doc.destroy()
  bob.doc.destroy()
})

test('burst backpressure closes only the overloaded actor while another editor remains writable and shutdown finishes', async (t) => {
  const f = await fixture(t)
  f.studio.projectDocuments.maxPendingPerActor = 4
  const alice = await f.connect(f.users.alice)
  const bob = await f.connect(f.users.bob)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  f.studio.workspaces.locks.set(f.project.id, gate)
  try {
    for (
      let index = 0;
      index < 20 && alice.ws.readyState === WebSocket.OPEN;
      index++
    )
      alice.edit((source) => source.insert(source.length, `[burst ${index}]`))
    await until(
      () => alice.ws.readyState !== WebSocket.OPEN,
      'overloaded actor is disconnected',
    )
  } finally {
    release()
  }
  await until(
    () => f.studio.projectDocuments.pendingBytes === 0,
    'bounded request bytes released',
  )
  await until(
    () => f.studio.projectDocuments.pendingPerActor.size === 0,
    'actor request admission released',
  )
  const bobId = bob.edit((source) => source.insert(0, 'RESPONSIVE_EDITOR\n'))
  assert.equal((await bob.ack(bobId)).type, 'document')
  await until(
    async () => (await f.file()).content.includes('RESPONSIVE_EDITOR'),
    'other editor stays writable',
  )
  const started = Date.now()
  await f.restart()
  assert(
    Date.now() - started < 5000,
    'shutdown/restart did not wait indefinitely for the overloaded socket',
  )
  alice.doc.destroy()
  bob.doc.destroy()
})

test('a live read waits through a short workspace replacement transaction rather than invalidating every peer', async (t) => {
  const f = await fixture(t)
  const alice = await f.connect(f.users.alice),
    bob = await f.connect(f.users.bob)
  const original = path.join(f.project.root, 'Main.lean')
  const staged = path.join(f.dataDir, 'transaction-source.lean')
  let release
  f.studio.workspaces.locks.set(
    f.project.id,
    new Promise((resolve) => {
      release = resolve
    }),
  )
  await fs.rename(original, staged)
  const before = bob.packets.length
  f.studio.projectDocuments.changed({
    projectId: f.project.id,
    kind: 'files',
    paths: ['Main.lean'],
  })
  try {
    await delay(30)
    assert.equal(
      bob.packets.slice(before).some((packet) => packet.type === 'error'),
      false,
    )
    await fs.rename(staged, original)
  } finally {
    release()
  }
  const record = [...f.studio.projectDocuments.documents.values()][0]
  await record.refreshTask
  assert.equal(record.invalidated, undefined)
  assert.equal(
    bob.packets.slice(before).some((packet) => packet.type === 'error'),
    false,
  )
  const request = bob.edit((source) => source.insert(0, 'AFTER_TRANSACTION\n'))
  assert.equal((await bob.ack(request)).type, 'document')
  assert.equal((await f.file()).content, 'AFTER_TRANSACTION\nbase text\n')
  alice.doc.destroy()
  bob.doc.destroy()
})

test('a malicious editor cannot forge another peer’s future clocks and poison later edits after revocation', async (t) => {
  const f = await fixture(t)
  const alice = await f.connect(f.users.alice),
    bob = await f.connect(f.users.bob)
  const first = bob.edit((source) => source.insert(0, 'BOB_FIRST\n'))
  assert.equal((await bob.ack(first)).type, 'document')
  const forged = new Y.Doc()
  Y.applyUpdate(forged, Y.encodeStateAsUpdate(bob.doc))
  const vector = Y.encodeStateVector(forged)
  forged.clientID = bob.doc.clientID
  forged
    .getText('source')
    .insert(forged.getText('source').length, 'FORGED_FUTURE\n')
  alice.send({
    type: 'update',
    path: 'Main.lean',
    documentId: alice.id,
    requestId: 1,
    update: encode(Y.encodeStateAsUpdate(forged, vector)),
  })
  assert.equal((await alice.ack(1)).status, 400)
  assert.equal((await f.file()).content.includes('FORGED_FUTURE'), false)
  assert.equal(
    (
      await f.request(
        `/api/projects/${f.project.id}/sharing/members/${f.users.alice.id}`,
        { method: 'DELETE', body: {} },
      )
    ).status,
    200,
  )
  const second = bob.edit((source) =>
    source.insert(source.length, 'BOB_SECOND\n'),
  )
  assert.equal((await bob.ack(second)).type, 'document')
  assert.equal((await f.file()).content, 'BOB_FIRST\nbase text\nBOB_SECOND\n')
  alice.doc.destroy()
  bob.doc.destroy()
  forged.destroy()
})

test('an editor cannot queue a deletion of another peer’s not-yet-created text', async (t) => {
  const f = await fixture(t)
  const alice = await f.connect(f.users.alice),
    bob = await f.connect(f.users.bob)
  const first = bob.edit((source) => source.insert(0, 'BOB\n'))
  await bob.ack(first)
  const forged = new Y.Doc()
  Y.applyUpdate(forged, Y.encodeStateAsUpdate(bob.doc))
  forged.clientID = bob.doc.clientID
  const position = forged.getText('source').length
  forged.getText('source').insert(position, 'FUTURE_BOB')
  const vector = Y.encodeStateVector(forged)
  forged.getText('source').delete(position, 'FUTURE_BOB'.length)
  alice.send({
    type: 'update',
    path: 'Main.lean',
    documentId: alice.id,
    requestId: 1,
    update: encode(Y.encodeStateAsUpdate(forged, vector)),
  })
  const receipt = await alice.ack(1)
  await f.request(
    `/api/projects/${f.project.id}/sharing/members/${f.users.alice.id}`,
    { method: 'DELETE', body: {} },
  )
  const next = bob.edit((source) => source.insert(source.length, 'FUTURE_BOB'))
  assert.equal((await bob.ack(next)).type, 'document')
  assert.equal(
    (await f.file()).content,
    'BOB\nbase text\nFUTURE_BOB',
    'No dormant deletion may erase future text after its author is revoked',
  )
  assert.equal(receipt.type, 'error')
  assert.equal(receipt.status, 400)
  alice.doc.destroy()
  bob.doc.destroy()
  forged.destroy()
})

test('an editor cannot queue hidden text dependent on another peer’s future clock', async (t) => {
  const f = await fixture(t)
  const alice = await f.connect(f.users.alice),
    bob = await f.connect(f.users.bob)
  const first = bob.edit((source) => source.insert(0, 'BOB\n'))
  await bob.ack(first)
  const forged = new Y.Doc()
  Y.applyUpdate(forged, Y.encodeStateAsUpdate(bob.doc))
  forged.clientID = bob.doc.clientID
  const position = forged.getText('source').length
  forged.getText('source').insert(position, 'Z')
  const vector = Y.encodeStateVector(forged)
  forged.clientID = alice.doc.clientID
  forged.getText('source').insert(position + 1, 'LATENT_TEXT')
  alice.send({
    type: 'update',
    path: 'Main.lean',
    documentId: alice.id,
    requestId: 1,
    update: encode(Y.encodeStateAsUpdate(forged, vector)),
  })
  const receipt = await alice.ack(1)
  await f.request(
    `/api/projects/${f.project.id}/sharing/members/${f.users.alice.id}`,
    { method: 'DELETE', body: {} },
  )
  const next = bob.edit((source) => source.insert(source.length, 'Z'))
  assert.equal((await bob.ack(next)).type, 'document')
  assert.equal(
    (await f.file()).content,
    'BOB\nbase text\nZ',
    'No dormant insertion may activate after its author is revoked',
  )
  assert.equal(receipt.type, 'error')
  assert.equal(receipt.status, 400)
  alice.doc.destroy()
  bob.doc.destroy()
  forged.destroy()
})

test('sharing metadata is reauthorized after asynchronous account refresh', async (t) => {
  const f = await fixture(t)
  await f.studio.workspaces.setMember(
    f.project.id,
    f.users.admin.id,
    f.users.alice.id,
    'admin',
  )
  let entered, release
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const refresh = f.studio.auth.refreshUsers.bind(f.studio.auth)
  let held = true
  f.studio.auth.refreshUsers = async () => {
    if (held) {
      held = false
      entered()
      await gate
    }
    return refresh()
  }
  const response = f.request(`/api/projects/${f.project.id}/sharing`, {
    actor: f.users.alice,
  })
  await started
  await f.studio.workspaces.removeMember(
    f.project.id,
    f.users.admin.id,
    f.users.alice.id,
  )
  release()
  const result = await response
  assert(
    [403, 404].includes(result.status),
    'A removed admin must not receive the cached member/link list after the await',
  )
})

test('an account deleted while joining waits cannot acquire persistent project membership', async (t) => {
  const f = await fixture(t)
  const link = await f.studio.workspaces.createShareLink(
    f.project.id,
    f.users.admin.id,
    'editor',
  )
  let release
  f.studio.workspaces.locks.set(
    f.project.id,
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const joined = f.request('/api/project-invitations/join', {
    actor: f.users.outsider,
    method: 'POST',
    body: { token: link.token },
  })
  await delay(30)
  await f.studio.auth.mutate(() => {
    f.studio.auth.users = f.studio.auth.users.filter(
      (user) => user.id !== f.users.outsider.id,
    )
  })
  release()
  const response = await joined
  assert([401, 404].includes(response.status))
  assert.equal(
    f.studio.workspaces.memberships.role(f.project.id, f.users.outsider.id),
    undefined,
    'An unauthorized queued join must not leave a membership row after returning an error',
  )
})

test('rotating an admin credential while a membership change waits prevents the pending grant', async (t) => {
  const f = await fixture(t)
  let release
  f.studio.workspaces.locks.set(
    f.project.id,
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const changing = f.request(
    `/api/projects/${f.project.id}/sharing/members/${f.users.outsider.id}`,
    { method: 'PUT', body: { role: 'admin' } },
  )
  await delay(30)
  await f.studio.auth.mutate(() => {
    f.studio.auth.users.find((user) => user.id === f.users.admin.id).tokenHash =
      '0'.repeat(64)
  })
  release()
  const response = await changing
  assert(
    [401, 404].includes(response.status),
    'The original revoked request credential must be rechecked inside the commit queue',
  )
  assert.equal(
    f.studio.workspaces.memberships.role(f.project.id, f.users.outsider.id),
    undefined,
  )
})
