import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createStudio } from '../studio.mjs'
import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'
import JSZip from 'jszip'
import { frame } from '../rpc.mjs'
import { loadCapacity } from '../capacity.mjs'

async function fixture(t, { capacity } = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'project-sharing-http-'),
  )
  const spawned = []
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async run(root, args) {
      if (args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'lake' && args[1] === 'update')
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      return {
        code: 0,
        stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '',
        stderr: '',
      }
    },
    spawn(root, args, options) {
      const child = new EventEmitter()
      const workerHome =
        args[0] === 'python3'
          ? path.join(dataDir, `home-${spawned.length}`)
          : undefined
      if (workerHome) mkdirSync(workerHome)
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        workerHome,
        kill() {
          if (this.killed) return
          this.killed = true
          this.emit('close', 0)
        },
      })
      spawned.push({ root, args, options, child })
      return child
    },
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    modelDiscoverer: fixtureModelDiscovery,
    ...(capacity ? { capacity } : {}),
    config: {
      models: [{ id: 'fixture-model' }],
      defaultModel: 'fixture-model',
      provider: { LEMEX_BASE_URL: 'https://provider.example/v1' },
      lemex: {},
      redact: String,
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const owner = {
    id: 'owner',
    token: (
      await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
    ).trim(),
  }
  const accounts = { owner }
  for (const name of ['Editor', 'Viewer', 'Outsider']) {
    const account = await studio.auth.createUser(owner, { name })
    accounts[name.toLowerCase()] = { id: account.user.id, token: account.token }
  }
  const origin = `http://127.0.0.1:${studio.server.address().port}`
  const request = (endpoint, { actor = owner, method = 'GET', body } = {}) =>
    fetch(origin + endpoint, {
      method,
      headers: {
        ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const project = await studio.workspaces.create(owner.id, {
    name: 'Shared proofs',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, owner.id).status, 'ready')
  const base = `/api/projects/${project.id}`
  const member = (actor, role) =>
    request(`${base}/sharing/members/${actor.id}`, {
      method: 'PUT',
      body: { role },
    })
  for (const [name, role] of [
    ['editor', 'editor'],
    ['viewer', 'viewer'],
  ])
    assert.equal((await member(accounts[name], role)).status, 200)
  return {
    ...studio,
    ...accounts,
    request,
    member,
    base,
    project,
    spawned,
    origin,
  }
}

test('older update recovery HTTP requires an idle Admin and preserves later edits', async (t) => {
  const f = await fixture(t)
  const original = await f.workspaces.readFile(
    f.project.id,
    f.owner.id,
    'Main.lean',
  )
  await f.workspaces.writeFile(
    f.project.id,
    f.owner.id,
    'Main.lean',
    '-- interrupted update\n',
    original.hash,
  )
  const id = `${Date.now()}-${randomUUID()}`
  const directory = path.join(f.workspaces.historyDir, f.project.id, id)
  await fs.mkdir(path.join(directory, 'before'), { recursive: true })
  await fs.writeFile(path.join(directory, 'before/0'), original.content)
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      projectId: f.project.id,
      owner: f.owner.id,
      createdAt: new Date().toISOString(),
      changes: [
        {
          path: 'Main.lean',
          beforeHash: original.hash,
          afterHash: createHash('sha256')
            .update('-- interrupted update\n')
            .digest('hex'),
        },
      ],
    }),
  )
  await f.workspaces.legacyRecovery.init([f.project])
  const base = `${f.base}/file-recovery/legacy`
  const endpoint = `${base}/${id}`
  const download = `${endpoint}/original?path=Main.lean`
  assert.equal(
    (await (await f.request(f.base)).json()).legacyFileRecoveryRequired,
    true,
  )
  for (const actor of [f.editor, f.viewer, f.outsider, null]) {
    const expected = actor === null ? 401 : actor === f.outsider ? 404 : 403
    assert.equal((await f.request(base, { actor })).status, expected)
    assert.equal((await f.request(download, { actor })).status, expected)
    assert.equal(
      (
        await f.request(endpoint, {
          actor,
          method: 'POST',
          body: { revision: 'a'.repeat(64), decision: 'keep-current' },
        })
      ).status,
      expected,
    )
  }
  const initial = await f.request(base)
  assert.equal(initial.status, 200)
  assert.equal(initial.headers.get('cache-control'), 'no-store')
  const {
    reviews: [review],
  } = await initial.json()
  for (const query of [
    'cursor=../secret',
    'recordId=../secret',
    'fileOffset=1.5',
    'fileOffset=12001',
    'fileOffset=1',
    'cursor=x&cursor=y',
    'unknown=1',
  ])
    assert.equal((await f.request(`${base}?${query}`)).status, 400)
  const originalDownload = await f.request(download)
  assert.equal(originalDownload.status, 200)
  assert.equal(await originalDownload.text(), original.content)
  assert.match(originalDownload.headers.get('content-disposition'), /Main.lean/)
  assert.equal(
    (await f.request(`${endpoint}/original?path=../secret`)).status,
    400,
  )
  for (const body of [
    null,
    [],
    { revision: review.revision, decision: 'restore', force: true },
    { revision: 'wrong', decision: 'restore' },
  ])
    assert.equal(
      (await f.request(endpoint, { method: 'POST', body })).status,
      400,
    )
  const active = f.events.create(f.editor.id, {
    kind: 'agent',
    projectId: f.project.id,
  })
  f.events.updateMetadata(active.id, { status: 'running' })
  assert.equal(
    (
      await f.request(endpoint, {
        method: 'POST',
        body: { revision: review.revision, decision: 'restore' },
      })
    ).status,
    409,
  )
  assert.equal(f.events.getMetadata(active.id).status, 'running')
  f.events.updateMetadata(active.id, { status: 'completed' })
  await fs.writeFile(
    path.join(f.project.root, 'Main.lean'),
    '-- later user edit\n',
  )
  assert.equal(
    (
      await f.request(endpoint, {
        method: 'POST',
        body: { revision: review.revision, decision: 'restore' },
      })
    ).status,
    409,
  )
  const {
    reviews: [fresh],
  } = await (await f.request(base)).json()
  assert.equal(fresh.canRestore, false)
  const kept = await f.request(endpoint, {
    method: 'POST',
    body: { revision: fresh.revision, decision: 'keep-current' },
  })
  assert.equal(kept.status, 200)
  const result = await kept.json()
  assert.equal(result.root, undefined)
  assert.equal(result.fileRecoveryRequired, undefined)
  assert.equal(result.status, 'ready')
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'Main.lean'), 'utf8'),
    '-- later user edit\n',
  )
  assert.equal(
    await fs.readFile(path.join(directory, 'before/0'), 'utf8'),
    original.content,
  )
})

test('legacy preview admission bounds active reads across projects and retains cancelled work until it settles', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.member(f.editor, 'admin')).status, 200)
  const other = await f.workspaces.create(f.owner.id, {
    name: 'Other preview project',
    preset: 'lean',
    autoRepair: false,
  })
  await f.workspaces.jobs.get(other.id)
  assert.equal(
    (
      await f.request(
        `/api/projects/${other.id}/sharing/members/${f.outsider.id}`,
        { method: 'PUT', body: { role: 'admin' } },
      )
    ).status,
    200,
  )
  const endpoint = `${f.base}/file-recovery/legacy`
  const otherEndpoint = `/api/projects/${other.id}/file-recovery/legacy`
  const held = []
  let closing = false
  let holdNew = true
  const original = f.workspaces.legacyRecovery.list.bind(
    f.workspaces.legacyRecovery,
  )
  t.mock.method(f.workspaces.legacyRecovery, 'list', async (...args) => {
    if (closing || !holdNew) return original(...args)
    const waiting = { signal: args[1].signal, release: null, settled: false }
    held.push(waiting)
    try {
      await new Promise((resolve) => {
        waiting.release = resolve
      })
      return await original(...args)
    } finally {
      waiting.settled = true
    }
  })
  const until = async (condition, label) => {
    const deadline = Date.now() + 3000
    while (!condition()) {
      assert.ok(Date.now() < deadline, label)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const controller = new AbortController()
  const requests = []
  try {
    const first = fetch(f.origin + endpoint, {
      headers: { Authorization: `Bearer ${f.owner.token}` },
      signal: controller.signal,
    })
    requests.push(first)
    const cancelled = assert.rejects(first, { name: 'AbortError' })
    await until(() => held.length === 1, 'first preview starts')
    const duplicate = await f.request(otherEndpoint)
    assert.equal(duplicate.status, 429)
    assert.equal(duplicate.headers.get('retry-after'), '1')
    assert.match((await duplicate.json()).error, /Wait briefly.*retry/)
    const second = f.request(endpoint, { actor: f.editor })
    requests.push(second)
    await until(() => held.length === 2, 'second Admin preview starts')
    assert.equal(
      (await f.request(otherEndpoint, { actor: f.outsider })).status,
      429,
    )
    assert.equal((await f.request(endpoint, { actor: f.viewer })).status, 403)
    assert.equal((await f.request(endpoint, { actor: null })).status, 401)
    const source = await f.workspaces.readFile(
      f.project.id,
      f.owner.id,
      'Main.lean',
    )
    const saved = await f.request(`${f.base}/file?path=Main.lean`, {
      actor: f.editor,
      method: 'PUT',
      body: {
        content: '-- ordinary save during previews\n',
        expectedHash: source.hash,
      },
    })
    assert.equal(saved.status, 200)
    assert.equal(
      (await saved.json()).content,
      '-- ordinary save during previews\n',
    )
    controller.abort()
    await cancelled
    await until(
      () => held[0].signal.aborted,
      'server observes disconnected preview',
    )
    assert.equal(held[0].settled, false)
    assert.equal((await f.request(endpoint)).status, 429)
    assert.equal(
      (await f.request(otherEndpoint, { actor: f.outsider })).status,
      429,
    )
    holdNew = false
    held[0].release()
    await until(() => held[0].settled, 'cancelled filesystem work settles')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      (await f.request(otherEndpoint, { actor: f.outsider })).status,
      200,
    )
    assert.equal((await f.request(endpoint)).status, 200)
    held[1].release()
    assert.equal((await second).status, 200)
    assert.equal((await f.request(endpoint, { actor: f.editor })).status, 200)
    assert.equal(held.length, 2)
    assert.equal(f.workspaces.get(f.project.id, f.owner.id).status, 'ready')
    assert.equal(f.workspaces.get(other.id, f.owner.id).status, 'ready')
  } finally {
    closing = true
    controller.abort()
    for (const waiting of held) waiting.release?.()
    await Promise.allSettled(requests)
  }
})

test('sharing grants project roles, bounds account discovery, and keeps private data private', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request(f.base, { actor: null })).status, 401)
  assert.equal((await f.request(f.base, { actor: f.outsider })).status, 404)
  const shared = await (await f.request(f.base, { actor: f.editor })).json()
  assert.equal(shared.accessRole, 'editor')
  assert.equal(shared.root, undefined)
  assert.equal((await f.request('/api/accounts/search?q=e')).status, 400)
  const accounts = await (await f.request('/api/accounts/search?q=edit')).json()
  assert.deepEqual(accounts, [{ id: f.editor.id, name: 'Editor' }])
  assert.equal(
    (await f.request(`${f.base}/sharing`, { actor: f.viewer })).status,
    403,
  )
  assert.equal((await f.member(f.editor, 'owner')).status, 400)

  const chat = await (
    await f.request(`${f.base}/chats`, {
      method: 'POST',
      body: { title: 'Private task' },
    })
  ).json()
  assert.equal(
    (await f.request(`/api/chats/${chat.id}`, { actor: f.editor })).status,
    404,
  )
  assert.deepEqual(
    await (await f.request(`${f.base}/chats`, { actor: f.editor })).json(),
    [],
  )
  const run = f.events.create(f.owner.id, {
    kind: 'agent',
    projectId: f.project.id,
    prompt: 'Private prompt',
  })
  for (const suffix of ['', '/events?transport=poll'])
    assert.equal(
      (await f.request(`/api/runs/${run.id}${suffix}`, { actor: f.editor }))
        .status,
      404,
    )
  f.events.updateMetadata(run.id, { status: 'completed' })
  await f.providers.save(f.owner.id, 'fixture-owner-private-provider-key')
  assert.equal(
    (await (await f.request('/api/provider', { actor: f.editor })).json())
      .configured,
    false,
  )
})

test('project participants are visible to every member without granting sharing access', async (t) => {
  const f = await fixture(t)
  const created = await f.request(`${f.base}/sharing/links`, {
    method: 'POST',
    body: { role: 'editor' },
  })
  assert.equal(created.status, 201)
  const link = await created.json()
  const expected = {
    members: [f.owner, f.editor, f.viewer]
      .map(({ id }) => ({
        userId: id,
        role:
          id === f.owner.id
            ? 'admin'
            : id === f.editor.id
              ? 'editor'
              : 'viewer',
        name: f.auth.users.find((user) => user.id === id).name,
      }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  }
  for (const actor of [f.owner, f.editor, f.viewer]) {
    const response = await f.request(`${f.base}/participants`, { actor })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
  }
  for (const actor of [f.editor, f.viewer]) {
    assert.equal((await f.request(`${f.base}/sharing`, { actor })).status, 403)
    assert.equal(
      (
        await f.request(`${f.base}/sharing/members/${f.outsider.id}`, {
          actor,
          method: 'PUT',
          body: { role: 'viewer' },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await f.request(`${f.base}/sharing/members/${f.owner.id}`, {
          actor,
          method: 'DELETE',
          body: {},
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await f.request(`${f.base}/sharing/links`, {
          actor,
          method: 'POST',
          body: { role: 'viewer' },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await f.request(`${f.base}/sharing/links/${link.id}`, {
          actor,
          method: 'DELETE',
          body: {},
        })
      ).status,
      403,
    )
  }
  assert.equal(
    (await f.request(`${f.base}/participants`, { actor: null })).status,
    401,
  )
  assert.equal(
    (await f.request(`${f.base}/participants`, { actor: f.outsider })).status,
    404,
  )
  assert.equal(
    (
      await f.request(`${f.base}/sharing/members/${f.viewer.id}`, {
        method: 'DELETE',
        body: {},
      })
    ).status,
    200,
  )
  assert.equal(
    (await f.request(`${f.base}/participants`, { actor: f.viewer })).status,
    404,
  )
})

test('sharing links require sign-in, store role-specific grants, and revoke future joins', async (t) => {
  const f = await fixture(t)
  const created = await f.request(`${f.base}/sharing/links`, {
    method: 'POST',
    body: { role: 'viewer' },
  })
  assert.equal(created.status, 201)
  const link = await created.json()
  const management = await (await f.request(`${f.base}/sharing`)).json()
  assert(!JSON.stringify(management).includes(link.token))
  const endpoint = '/api/project-invitations/join'
  assert.equal(
    (
      await f.request(endpoint, {
        method: 'POST',
        actor: null,
        body: { token: link.token },
      })
    ).status,
    401,
  )
  const joined = await f.request(endpoint, {
    method: 'POST',
    actor: f.outsider,
    body: { token: link.token },
  })
  assert.equal(joined.status, 200)
  assert.equal((await joined.json()).accessRole, 'viewer')
  assert.equal(
    (
      await f.request(`${f.base}/sharing/links/${link.id}`, {
        method: 'DELETE',
        body: {},
      })
    ).status,
    200,
  )
  const revoked = await f.request(endpoint, {
    method: 'POST',
    actor: f.editor,
    body: { token: link.token },
  })
  assert.equal(revoked.status, 404)
  assert.equal((await f.request(f.base, { actor: f.outsider })).status, 200)
})

test('viewer writes and owner controls are rejected while editor saves retain stale-write protection', async (t) => {
  const f = await fixture(t)
  const file = await f.workspaces.readFile(
    f.project.id,
    f.owner.id,
    'Main.lean',
  )
  const save = (actor, content) =>
    f.request(`${f.base}/file?path=Main.lean`, {
      actor,
      method: 'PUT',
      body: { content, expectedHash: file.hash },
    })
  assert.equal((await save(f.viewer, '-- rejected')).status, 403)
  assert.equal(
    (await save(f.editor, file.content + '\n-- shared edit\n')).status,
    200,
  )
  assert.equal((await save(f.owner, '-- stale')).status, 409)
  for (const endpoint of ['/rename', '/trash'])
    assert.equal(
      (
        await f.request(f.base + endpoint, {
          actor: f.editor,
          method: 'POST',
          body: {},
        })
      ).status,
      403,
      endpoint,
    )
  for (const endpoint of [
    '/prepare',
    '/environment',
    '/prepare/stop',
    '/terminal/stop',
    '/git',
  ])
    assert.equal(
      (
        await f.request(f.base + endpoint, {
          actor: f.viewer,
          method: 'POST',
          body: {},
        })
      ).status,
      403,
      endpoint,
    )
  assert.equal(
    (await f.request(`${f.base}/git`, { actor: f.viewer })).status,
    403,
  )
  assert.equal(
    (
      await f.request(`${f.base}/runs`, {
        actor: f.viewer,
        method: 'POST',
        body: { mode: 'search', prompt: 'Edit files' },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request(`${f.base}/chats`, {
        actor: f.viewer,
        method: 'POST',
        body: {},
      })
    ).status,
    201,
  )
})

test('editor terminals use the initiating account’s private Git credentials and identity', async (t) => {
  const f = await fixture(t)
  const credentialActors = [],
    identityActors = []
  f.gitConnections.credentials = async (actor) => {
    credentialActors.push(actor)
    return { username: 'editor-user', token: 'fixture-editor-git-key' }
  }
  f.gitConnections.get = async (actor) => {
    identityActors.push(actor)
    return {
      identity: { name: 'Editor identity', email: 'editor@example.test' },
    }
  }
  const ws = new WebSocket(
    f.origin.replace('http:', 'ws:') + `/websocket/terminal/${f.project.id}`,
    {
      headers: { Authorization: `Bearer ${f.editor.token}` },
    },
  )
  await once(ws, 'open')
  t.after(() => ws.terminate())
  for (let attempt = 0; !f.spawned.length && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const worker = f.spawned[0]
  assert.notEqual(worker.root, f.project.root)
  assert.equal(worker.options.freshHome, true)
  assert.equal(worker.options.cleanHome, true)
  assert.equal(worker.options.repositoryRoot, undefined)
  for (
    let attempt = 0;
    !worker.child.stdin.readableLength && attempt < 100;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  const setup = JSON.parse(worker.child.stdin.read().toString().trim())
  assert.equal(setup.identity.name, 'Editor identity')
  assert.deepEqual(identityActors, [f.editor.id])
  const socket = net.createConnection(
    path.join(worker.child.workerHome, '.git-credentials.sock'),
  )
  await once(socket, 'connect')
  socket.write(
    JSON.stringify({
      protocol: 'https',
      host: 'git.example',
      path: 'project.git',
    }) + '\n',
  )
  const [reply] = await once(socket, 'data')
  assert.equal(JSON.parse(reply.toString()).token, 'fixture-editor-git-key')
  assert.deepEqual(credentialActors, [f.editor.id])
  socket.destroy()
  const response = await f.request(`${f.base}/terminal/stop`, {
    actor: f.editor,
    method: 'POST',
    body: {},
  })
  assert.equal(response.status, 200)
})

test('a delayed terminal close stops only its opening and preserves a newly opened shell', async (t) => {
  const f = await fixture(t)
  const oldId = 'ef18e241-1427-4d3d-a164-452ddc8ef51d'
  const newId = '1b7e35cf-0965-414e-a564-b43b19e8e292'
  const open = async (openingId, count) => {
    const ws = new WebSocket(
      f.origin.replace('http:', 'ws:') +
        `/websocket/terminal/${f.project.id}?openingId=${openingId}`,
      { headers: { Authorization: `Bearer ${f.editor.token}` } },
    )
    t.after(() => ws.terminate())
    await once(ws, 'open')
    for (let attempt = 0; f.spawned.length < count && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(f.spawned.length, count)
    return ws
  }
  const old = await open(oldId, 1)
  const delayed = http.request(f.origin + `${f.base}/terminal/stop`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${f.editor.token}`,
      'Content-Type': 'application/json',
    },
  })
  t.after(() => delayed.destroy())
  const stopped = new Promise((resolve, reject) => {
    delayed.once('response', (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    delayed.once('error', reject)
  })
  // Authenticate the original close request, but let its JSON arrive only
  // after the old socket has closed and a different opening has started.
  delayed.write('{"openingId":')
  const closed = once(old, 'close')
  old.close()
  await closed
  for (
    let attempt = 0;
    f.workspaces.terminalCopies.size && attempt < 100;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(f.workspaces.terminalCopies.size, 0)
  const current = await open(newId, 2)
  const worker = f.spawned.at(-1).child
  delayed.end(JSON.stringify(oldId) + '}')
  assert.equal(await stopped, 200)
  assert.equal(current.readyState, WebSocket.OPEN)
  assert.notEqual(worker.killed, true)
  for (const [actor, body, status] of [
    [f.owner, { openingId: newId }, 200],
    [f.editor, { openingId: 'invalid' }, 400],
    [f.editor, { openingId: newId, extra: true }, 400],
  ]) {
    assert.equal(
      (
        await f.request(`${f.base}/terminal/stop`, {
          actor,
          method: 'POST',
          body,
        })
      ).status,
      status,
    )
    assert.notEqual(worker.killed, true)
  }
  let input = ''
  worker.stdin.on('data', (chunk) => (input += chunk))
  current.send(JSON.stringify({ type: 'input', data: 'still running\n' }))
  for (
    let attempt = 0;
    !input.includes('still running') && attempt < 100;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.match(input, /still running/)
  const currentClosed = once(current, 'close')
  assert.equal(
    (
      await f.request(`${f.base}/terminal/stop`, {
        actor: f.editor,
        method: 'POST',
        body: { openingId: newId },
      })
    ).status,
    200,
  )
  await currentClosed
  assert.equal(worker.killed, true)
})

test('scoped terminal close cancels its pending private capture before a worker starts', async (t) => {
  const f = await fixture(t)
  const openingId = '9cefb82d-cc9b-4820-8bbe-c7e433ee6b5e'
  let entered, release
  const started = new Promise((resolve) => (entered = resolve))
  const waiting = new Promise((resolve) => (release = resolve))
  const original = f.workspaces.terminalSnapshot.bind(f.workspaces)
  f.workspaces.terminalSnapshot = async (...args) => {
    entered()
    await waiting
    return original(...args)
  }
  t.after(() => release())
  const ws = new WebSocket(
    f.origin.replace('http:', 'ws:') +
      `/websocket/terminal/${f.project.id}?openingId=${openingId}`,
    { headers: { Authorization: `Bearer ${f.editor.token}` } },
  )
  t.after(() => ws.terminate())
  await once(ws, 'open')
  await started
  const closed = once(ws, 'close')
  const stop = f.request(`${f.base}/terminal/stop`, {
    actor: f.editor,
    method: 'POST',
    body: { openingId },
  })
  await closed
  release()
  assert.equal((await stop).status, 200)
  assert.equal(f.spawned.length, 0)
  assert.deepEqual(
    await f.workspaces.personalTerminalRecoveries(f.editor.id),
    [],
  )
})

for (const failure of ['worker cleanup', 'recovery publication']) {
  test(
    `scoped terminal close retries a disconnected opening after repeated ${failure} failures`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t)
      const oldId = '7732e63c-ee1a-4e4a-a397-477f96f2adb6'
      const refusedId = '64b64493-0fd6-4bcf-a050-f11ee2fac197'
      let attempts = 0
      const unavailable = () =>
        Object.assign(new Error('Terminal cleanup unavailable; retry.'), {
          status: 503,
        })
      if (failure === 'worker cleanup') {
        const spawn = f.runtime.spawn.bind(f.runtime)
        t.mock.method(f.runtime, 'spawn', (...args) => {
          const child = spawn(...args)
          child.cleanupWorker = async () => {
            if (++attempts <= 2) throw unavailable()
          }
          child.workerStopped = new Promise((resolve) =>
            child.once('close', resolve),
          ).then(() => child.cleanupWorker())
          child.workerStopped.catch(() => {})
          return child
        })
      } else {
        const retain = f.workspaces.retainTerminalSnapshot.bind(f.workspaces)
        t.mock.method(
          f.workspaces,
          'retainTerminalSnapshot',
          async (...args) => {
            if (!args[2]?.active && ++attempts <= 2) throw unavailable()
            return retain(...args)
          },
        )
        const spawn = f.runtime.spawn.bind(f.runtime)
        t.mock.method(f.runtime, 'spawn', (...args) => {
          const child = spawn(...args)
          child.cleanupWorker = async () => {}
          return child
        })
      }
      try {
        const ws = new WebSocket(
          f.origin.replace('http:', 'ws:') +
            `/websocket/terminal/${f.project.id}?openingId=${oldId}`,
          { headers: { Authorization: `Bearer ${f.editor.token}` } },
        )
        t.after(() => ws.terminate())
        await once(ws, 'open')
        for (
          let attempt = 0;
          (!f.spawned.length || !f.spawned[0].child.stdin.readableLength) &&
          attempt < 100;
          attempt++
        )
          await new Promise((resolve) => setTimeout(resolve, 5))
        assert.equal(f.spawned.length, 1)
        if (failure === 'recovery publication')
          await fs.writeFile(
            path.join(f.spawned[0].root, 'private-generated.bin'),
            Buffer.from([0, 1, 2, 3]),
          )
        const closed = once(ws, 'close')
        const firstStop = await f.request(`${f.base}/terminal/stop`, {
          actor: f.editor,
          method: 'POST',
          body: { openingId: oldId },
        })
        assert.equal(firstStop.status, 503, await firstStop.clone().text())
        await firstStop.text()
        await closed
        assert.equal(attempts, 2)
        const refused = await new Promise((resolve, reject) => {
          const socket = new WebSocket(
            f.origin.replace('http:', 'ws:') +
              `/websocket/terminal/${f.project.id}?openingId=${refusedId}`,
            { headers: { Authorization: `Bearer ${f.editor.token}` } },
          )
          socket.on('error', reject)
          socket.once('unexpected-response', (_request, response) => {
            response.resume()
            resolve(response.statusCode)
          })
        })
        assert.equal(refused, 429)
        assert.equal(
          (await f.request(`${f.base}/prepare`, { method: 'POST', body: {} }))
            .status,
          409,
        )
        const retry = await f.request(`${f.base}/terminal/stop`, {
          actor: f.editor,
          method: 'POST',
          body: { openingId: refusedId },
        })
        assert.equal(retry.status, 200, await retry.clone().text())
        assert.equal(attempts, 3)
        assert.equal(
          (await f.request(`${f.base}/prepare`, { method: 'POST', body: {} }))
            .status,
          200,
        )
        await f.workspaces.jobs.get(f.project.id)
        if (failure === 'recovery publication') {
          const copies = await (
            await f.request('/api/terminal-recoveries', { actor: f.editor })
          ).json()
          assert.equal(copies.length, 1)
          assert.equal(
            (
              await f.request(
                `${f.base}/terminal-recoveries/${copies[0].runId}/download`,
                { actor: f.editor },
              )
            ).status,
            200,
          )
        }
      } finally {
        // A failed assertion must also release the fixture's private Git
        // broker when the deliberately failed finalizer retained its session.
        for (let attempt = 0; attempt < 2; attempt++) {
          const stopped = await f.request(`${f.base}/terminal/stop`, {
            actor: f.editor,
            method: 'POST',
            body: {},
          })
          await stopped.text()
          if (stopped.ok) break
        }
      }
    },
  )
}

test('scoped terminal close preserves other live tabs for the same account and other members', async (t) => {
  const f = await fixture(t, {
    capacity: loadCapacity({
      STUDIO_MAX_TERMINALS: '4',
      STUDIO_MAX_TERMINALS_PER_PROJECT: '4',
    }),
  })
  const ids = [
    '6048ae8e-e1e0-4c2c-ae6c-70b72f8b2069',
    '83e43fb8-9f3d-49dd-903e-e5e5b2d31bcc',
    '00127dfc-6088-4535-b031-b94ec26250c8',
  ]
  const sockets = []
  for (const [index, actor] of [f.editor, f.editor, f.owner].entries()) {
    const ws = new WebSocket(
      f.origin.replace('http:', 'ws:') +
        `/websocket/terminal/${f.project.id}?openingId=${ids[index]}`,
      { headers: { Authorization: `Bearer ${actor.token}` } },
    )
    t.after(() => ws.terminate())
    await once(ws, 'open')
    for (let attempt = 0; f.spawned.length <= index && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(f.spawned.length, index + 1)
    sockets.push(ws)
  }
  const stale = await f.request(`${f.base}/terminal/stop`, {
    actor: f.editor,
    method: 'POST',
    body: { openingId: '335330e8-f3b2-4a3c-b59a-5dd33527850b' },
  })
  assert.equal(stale.status, 200)
  assert(f.spawned.every(({ child }) => !child.killed))
  const firstClosed = once(sockets[0], 'close')
  assert.equal(
    (
      await f.request(`${f.base}/terminal/stop`, {
        actor: f.editor,
        method: 'POST',
        body: { openingId: ids[0] },
      })
    ).status,
    200,
  )
  await firstClosed
  for (const index of [1, 2]) {
    assert.equal(sockets[index].readyState, WebSocket.OPEN)
    assert.notEqual(f.spawned[index].child.killed, true)
    let input = ''
    f.spawned[index].child.stdin.on('data', (chunk) => (input += chunk))
    sockets[index].send(
      JSON.stringify({ type: 'input', data: 'other live tab\n' }),
    )
    for (
      let attempt = 0;
      !input.includes('other live tab') && attempt < 100;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.match(input, /other live tab/)
  }
})

test('terminal opening query identifiers reject malformed or ambiguous scope', async (t) => {
  const f = await fixture(t)
  const valid = 'e892208a-9174-413d-aa60-9a08f581ce8d'
  for (const query of [
    '?openingId=invalid',
    `?openingId=${valid}&openingId=${valid}`,
    `?openingId=${valid}&extra=true`,
  ]) {
    const status = await new Promise((resolve, reject) => {
      const ws = new WebSocket(
        f.origin.replace('http:', 'ws:') +
          `/websocket/terminal/${f.project.id}${query}`,
        { headers: { Authorization: `Bearer ${f.editor.token}` } },
      )
      ws.on('error', reject)
      ws.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode)
      })
    })
    assert.equal(status, 400)
  }
  assert.equal(f.spawned.length, 0)
})

test('project lifecycle refuses another member’s work without cancelling it', async (t) => {
  const f = await fixture(t)
  const job = f.events.create(f.editor.id, {
    kind: 'agent',
    projectId: f.project.id,
  })
  for (const endpoint of ['/prepare', '/trash']) {
    const response = await f.request(f.base + endpoint, {
      method: 'POST',
      body: {},
    })
    assert.equal(response.status, 409, endpoint)
    assert.equal(f.events.getMetadata(job.id).status, 'queued')
  }
  assert.equal((await f.request(f.base)).status, 200)
  f.events.updateMetadata(job.id, { status: 'completed' })
})

test('a queued assistant run rechecks editor access before using any worker', async (t) => {
  const f = await fixture(t)
  f.agents.maxConcurrent = 0
  await f.providers.save(f.editor.id, 'fixture-editor-private-provider-key')
  const queued = await f.request(`${f.base}/runs`, {
    actor: f.editor,
    method: 'POST',
    body: {
      mode: 'search',
      prompt: 'Explain Main.lean',
      model: 'fixture-model',
    },
  })
  assert.equal(queued.status, 202, await queued.clone().text())
  const run = await queued.json()
  await f.workspaces.setMember(f.project.id, f.owner.id, f.editor.id, 'viewer')
  f.agents.maxConcurrent = 1
  f.agents.providerReady()
  for (
    let attempt = 0;
    f.events.getMetadata(run.id).status !== 'failed' && attempt < 100;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(f.events.getMetadata(run.id).status, 'failed')
  assert.equal(f.spawned.length, 0)
  assert.equal(
    (
      await f.request(`/api/runs/${run.id}/apply`, {
        actor: f.editor,
        method: 'POST',
        body: {},
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request(`/api/runs/${run.id}/undo`, {
        actor: f.editor,
        method: 'POST',
        body: {},
      })
    ).status,
    403,
  )
})

test('shared Lean sessions mount sources read-only and close immediately when access changes', async (t) => {
  const f = await fixture(t)
  const ws = new WebSocket(
    f.origin.replace('http:', 'ws:') + `/websocket/${f.project.id}`,
    {
      headers: { Authorization: `Bearer ${f.viewer.token}` },
    },
  )
  await once(ws, 'open')
  t.after(() => ws.terminate())
  assert.equal(f.spawned.length, 1)
  assert.equal(f.spawned[0].options.readOnlyWorkspace, true)
  assert.equal(f.spawned[0].options.writeLakeCache, true)
  assert.equal(f.spawned[0].options.cleanHome, true)
  const closed = once(ws, 'close')
  assert.equal(
    (
      await f.request(`${f.base}/sharing/members/${f.viewer.id}`, {
        method: 'DELETE',
        body: {},
      })
    ).status,
    200,
  )
  assert.equal((await closed)[0], 1008)
  assert.equal((await f.request(f.base, { actor: f.viewer })).status, 404)
})

test('shared nested projects cannot disclose or publish their parent repository', async (t) => {
  const f = await fixture(t)
  const nested = path.join(f.project.root, 'shared')
  await fs.mkdir(nested)
  await fs.writeFile(
    path.join(f.project.root, 'private.txt'),
    'Private sibling material',
  )
  for (const filename of ['Main.lean', 'lean-toolchain', 'lakefile.toml'])
    await fs.copyFile(
      path.join(f.project.root, filename),
      path.join(nested, filename),
    )
  const stored = {
    ...f.workspaces.get(f.project.id, f.owner.id),
    root: nested,
    subdirectory: 'shared',
  }
  delete stored.log
  delete stored.accessRole
  f.workspaces.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(stored), f.project.id)
  let gitCalls = 0
  const run = f.runtime.run.bind(f.runtime)
  f.runtime.run = (...args) => {
    gitCalls++
    return run(...args)
  }
  const get = await f.request(`${f.base}/git`, { actor: f.editor })
  assert.equal(get.status, 403)
  assert.match((await get.json()).error, /outside this project folder/)
  assert.equal((await f.request(`${f.base}/git`)).status, 403)
  await f.workspaces.setMember(f.project.id, f.owner.id, f.viewer.id, 'admin')
  assert.equal(
    (await f.request(`${f.base}/git`, { actor: f.viewer })).status,
    403,
  )
  for (const action of [
    'commit',
    'branch',
    'preview-push',
    'push',
    'enable-publishing',
  ])
    assert.equal(
      (
        await f.request(`${f.base}/git`, {
          actor: f.editor,
          method: 'POST',
          body: { action },
        })
      ).status,
      403,
      action,
    )
  await assert.rejects(f.publisher.metadata(f.editor.id, f.project.id), {
    status: 403,
  })
  assert.equal(gitCalls, 0)
  const downloaded = await f.request(`${f.base}/download`, { actor: f.viewer })
  assert.equal(downloaded.status, 200)
  const zip = await JSZip.loadAsync(await downloaded.arrayBuffer())
  assert(zip.file('Main.lean'))
  assert.equal(zip.file('private.txt'), null)
  assert.equal(
    (
      await f.request(`${f.base}/download?path=../private.txt`, {
        actor: f.viewer,
      })
    ).status,
    400,
  )
  assert.equal(gitCalls, 0)
})

test('revocation stops the member’s private jobs and prevents an already-read download from escaping', async (t) => {
  const f = await fixture(t)
  f.agents.maxConcurrent = 0
  await f.providers.save(f.editor.id, 'fixture-editor-private-provider-key')
  const run = await (
    await f.request(`${f.base}/runs`, {
      actor: f.editor,
      method: 'POST',
      body: {
        mode: 'search',
        prompt: 'Explain Main.lean',
        model: 'fixture-model',
      },
    })
  ).json()
  const other = f.events.create(f.owner.id, {
    kind: 'agent',
    projectId: f.project.id,
  })
  let release, entered
  const held = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const read = f.workspaces.readDownloadFile.bind(f.workspaces)
  f.workspaces.readDownloadFile = async (...args) => {
    const content = await read(...args)
    entered()
    await held
    return content
  }
  const download = f.request(`${f.base}/download?path=Main.lean`, {
    actor: f.editor,
  })
  await started
  assert.equal(
    (
      await f.request(`${f.base}/sharing/members/${f.editor.id}`, {
        method: 'DELETE',
        body: {},
      })
    ).status,
    200,
  )
  assert.equal(f.events.getMetadata(run.id).status, 'cancelled')
  assert.equal(f.agents.queue.includes(run.id), false)
  assert.equal(f.events.getMetadata(other.id).status, 'queued')
  release()
  assert.equal((await download).status, 404)
  f.events.updateMetadata(other.id, { status: 'completed' })
})

test('private terminal file conflicts retain a caller-only downloadable recovery', async (t) => {
  const f = await fixture(t)
  const ws = new WebSocket(
    f.origin.replace('http:', 'ws:') + `/websocket/terminal/${f.project.id}`,
    {
      headers: { Authorization: `Bearer ${f.editor.token}` },
    },
  )
  const messages = []
  ws.on('message', (data) => messages.push(data.toString()))
  t.after(() => ws.terminate())
  await once(ws, 'open')
  for (let attempt = 0; !f.spawned.length && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const worker = f.spawned[0]
  assert.notEqual(worker.root, f.project.root)
  const original = await f.workspaces.readFile(
    f.project.id,
    f.owner.id,
    'Main.lean',
  )
  await f.workspaces.writeFile(
    f.project.id,
    f.owner.id,
    'Main.lean',
    original.content + '\n-- browser version\n',
    original.hash,
  )
  await fs.writeFile(
    path.join(worker.root, 'Main.lean'),
    original.content + '\n-- terminal version\n',
  )
  for (
    let attempt = 0;
    !messages.some((message) => message.includes('File updates paused')) &&
    attempt < 200;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert(messages.some((message) => message.includes('File updates paused')))
  assert.match(
    (await f.workspaces.readFile(f.project.id, f.owner.id, 'Main.lean'))
      .content,
    /browser version/,
  )
  assert.equal(
    (
      await f.request(`${f.base}/terminal/stop`, {
        actor: f.editor,
        method: 'POST',
        body: {},
      })
    ).status,
    200,
  )
  const recoveries = await (
    await f.request(`${f.base}/terminal-recoveries`, { actor: f.editor })
  ).json()
  assert.equal(recoveries.length, 1)
  const endpoint = `${f.base}/terminal-recoveries/${recoveries[0].runId}/download`
  assert.equal((await f.request(endpoint, { actor: f.viewer })).status, 404)
  const download = await f.request(endpoint, { actor: f.editor })
  assert.equal(download.status, 200)
  const zip = await JSZip.loadAsync(await download.arrayBuffer())
  assert.match(await zip.file('Main.lean').async('text'), /terminal version/)
})

test('permanent shared project deletion removes all members’ private histories without touching other projects', async (t) => {
  const f = await fixture(t)
  const chats = [],
    runs = []
  for (const actor of [f.owner, f.editor, f.viewer]) {
    const chat = f.chats.create(actor.id, f.project.id)
    const run = f.events.create(actor.id, {
      projectId: f.project.id,
      chatId: chat.id,
      kind: 'agent',
      prompt: `Private ${actor.id}`,
    })
    f.chats.appendRun(chat.id, actor.id, run)
    f.events.updateMetadata(run.id, { status: 'completed' })
    chats.push({ actor, chat })
    runs.push(run)
  }
  const other = await f.workspaces.create(f.editor.id, {
    name: 'Unrelated project',
    files: [{ path: 'notes.txt', content: 'Keep these notes' }],
  })
  await f.workspaces.jobs.get(other.id)
  const untouched = f.chats.create(f.editor.id, other.id)
  const archive = await f.request(`${f.base}/trash`, {
    method: 'POST',
    body: {},
  })
  assert.equal(archive.status, 200)
  const receipt = await archive.json()
  const deleted = await f.request(
    `/api/trash/${receipt.trashId}/delete-forever`,
    { method: 'POST', body: {} },
  )
  assert.equal(deleted.status, 200, await deleted.clone().text())
  for (const { actor, chat } of chats)
    assert.throws(() => f.chats.get(chat.id, actor.id), { status: 404 })
  for (const run of runs)
    assert.throws(() => f.events.getMetadata(run.id, run.owner), {
      status: 404,
    })
  assert.equal(f.chats.get(untouched.id, f.editor.id).id, untouched.id)
})

test('admins can demote or remove themselves after delegation without keeping creator privileges', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.member(f.editor, 'admin')).status, 200)
  const endpoint = `${f.base}/sharing/members/${f.owner.id}`
  const demoted = await f.request(endpoint, {
    method: 'PUT',
    body: { role: 'viewer' },
  })
  assert.equal(demoted.status, 200, await demoted.clone().text())
  assert.deepEqual(await demoted.json(), { members: [], links: [] })
  assert.equal(f.workspaces.get(f.project.id, f.owner.id).accessRole, 'viewer')
  assert.equal((await f.request(`${f.base}/sharing`)).status, 403)
  assert.equal((await f.member(f.viewer, 'admin')).status, 403)
  assert.equal(
    (
      await f.request(endpoint, {
        actor: f.editor,
        method: 'PUT',
        body: { role: 'admin' },
      })
    ).status,
    200,
  )
  const removed = await f.request(endpoint, { method: 'DELETE', body: {} })
  assert.equal(removed.status, 200, await removed.clone().text())
  assert.deepEqual(await removed.json(), { members: [], links: [] })
  assert.equal((await f.request(f.base)).status, 404)
  assert.equal(
    (await f.request(`${f.base}/sharing`, { actor: f.editor })).status,
    200,
  )
  const archived = await f.request(`${f.base}/trash`, {
    actor: f.editor,
    method: 'POST',
    body: {},
  })
  assert.equal(archived.status, 200)
  const receipt = await archived.json()
  assert.equal(
    (
      await f.request(`/api/trash/${receipt.trashId}/delete-forever`, {
        actor: f.editor,
        method: 'POST',
        body: {},
      })
    ).status,
    200,
  )
})

test('viewer checks use read-only sources and private homes; TeX compiles only captured project inputs', async (t) => {
  const f = await fixture(t)
  await f.providers.save(f.owner.id, 'fixture-owner-private-key')
  const calls = []
  const run = f.runtime.run.bind(f.runtime)
  f.runtime.run = (root, args, options) => {
    calls.push({ root, args, options })
    return run(root, args, options)
  }
  const response = await f.request(`${f.base}/check`, {
    actor: f.viewer,
    method: 'POST',
    body: {},
  })
  assert.equal(response.status, 202)
  const job = await response.json()
  for (
    let attempt = 0;
    !['completed', 'failed'].includes(f.events.getMetadata(job.id).status) &&
    attempt < 100;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(f.events.getMetadata(job.id).status, 'completed')
  assert(calls.length > 0)
  for (const call of calls) {
    assert.equal(call.options.readOnlyWorkspace, true)
    assert.equal(call.options.freshHome, true)
    assert.equal(call.options.cleanHome, true)
  }
  await fs.writeFile(
    path.join(f.project.root, 'main.tex'),
    '\\documentclass{article}\\begin{document}Shared\\end{document}',
  )
  await fs.writeFile(
    path.join(f.project.root, '.env'),
    'PRIVATE_OWNER_KEY=fixture-owner-private-key',
  )
  f.runtime.texInfo = async () => ({ available: true, engines: ['pdflatex'] })
  let capture
  f.runtime.runTex = async (source, output, options) => {
    capture = source
    assert.notEqual(source, f.project.root)
    assert.equal(
      await fs.stat(path.join(source, '.env')).catch(() => null),
      null,
    )
    assert.match(
      await fs.readFile(path.join(source, 'main.tex'), 'utf8'),
      /Shared/,
    )
    assert(!JSON.stringify(options).includes('fixture-owner-private-key'))
    options.onSpawn?.()
    await fs.writeFile(path.join(output, 'document.pdf'), '%PDF-1.7\n%%EOF\n')
    await fs.writeFile(
      path.join(output, 'result.json'),
      '{"schema":1,"success":true,"diagnostics":[]}',
    )
    return { code: 0, stdout: '', stderr: '' }
  }
  const compiled = await f.request(`${f.base}/tex/build`, {
    actor: f.viewer,
    method: 'POST',
    body: { rootFile: 'main.tex' },
  })
  assert.equal(compiled.status, 202)
  const tex = await compiled.json()
  for (
    let attempt = 0;
    !['completed', 'failed'].includes(f.events.getMetadata(tex.id).status) &&
    attempt < 100;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert(capture)
  assert.equal(f.events.getMetadata(tex.id).status, 'completed')
  assert.equal(
    (await f.request(`${f.base}/tex/builds/${tex.id}`, { actor: f.owner }))
      .status,
    404,
  )
})

test('removing editor access cancels only that member’s active check outside the workspace lock', async (t) => {
  const f = await fixture(t)
  let entered, signal
  const started = new Promise((resolve) => {
    entered = resolve
  })
  f.runtime.run = async (_root, _args, options) => {
    signal = options.signal
    entered()
    await new Promise((resolve) =>
      signal.addEventListener('abort', resolve, { once: true }),
    )
    return { code: 130, stdout: '', stderr: '' }
  }
  const check = await (
    await f.request(`${f.base}/check`, {
      actor: f.editor,
      method: 'POST',
      body: {},
    })
  ).json()
  await started
  const response = await f.member(f.editor, 'viewer')
  assert.equal(response.status, 200)
  assert.equal(signal.aborted, true)
  assert.equal(f.events.getMetadata(check.id).status, 'cancelled')
})

for (const kind of ['agent', 'check']) {
  test(`terminal configuration publication preserves active ${kind} work and retains its private recovery`, async (t) => {
    const f = await fixture(t)
    const ws = new WebSocket(
      f.origin.replace('http:', 'ws:') + `/websocket/terminal/${f.project.id}`,
      {
        headers: { Authorization: `Bearer ${f.editor.token}` },
      },
    )
    const messages = []
    ws.on('message', (data) => messages.push(data.toString()))
    t.after(() => ws.terminate())
    await once(ws, 'open')
    for (let attempt = 0; !f.spawned.length && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    const worker = f.spawned[0]
    const pin = await f.workspaces.readFile(
      f.project.id,
      f.owner.id,
      'lean-toolchain',
    )
    const other = f.events.create(f.owner.id, { kind, projectId: f.project.id })
    f.events.updateMetadata(other.id, { status: 'running' })
    await fs.writeFile(
      path.join(worker.root, 'lean-toolchain'),
      'leanprover/lean4:v4.35.0\n',
    )
    for (
      let attempt = 0;
      !messages.some((message) => message.includes('File updates paused')) &&
      attempt < 200;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert(messages.some((message) => message.includes('File updates paused')))
    assert.deepEqual(
      await f.workspaces.readFile(f.project.id, f.owner.id, 'lean-toolchain'),
      pin,
    )
    assert.equal(f.events.getMetadata(other.id).status, 'running')
    assert.equal(
      (
        await f.request(`${f.base}/terminal/stop`, {
          actor: f.editor,
          method: 'POST',
          body: {},
        })
      ).status,
      200,
    )
    const recoveries = await (
      await f.request(`${f.base}/terminal-recoveries`, { actor: f.editor })
    ).json()
    assert.equal(recoveries.length, 1)
    const download = await f.request(
      `${f.base}/terminal-recoveries/${recoveries[0].runId}/download`,
      { actor: f.editor },
    )
    const zip = await JSZip.loadAsync(await download.arrayBuffer())
    assert.equal(
      await zip.file('lean-toolchain').async('text'),
      'leanprover/lean4:v4.35.0\n',
    )
    f.events.updateMetadata(other.id, { status: 'completed' })
  })
}

test('a terminal configuration commit closes affected Lean sessions without waiting on worker shutdown inside the source lock', async (t) => {
  const f = await fixture(t)
  const lean = new WebSocket(
    f.origin.replace('http:', 'ws:') + `/websocket/${f.project.id}`,
    {
      headers: { Authorization: `Bearer ${f.viewer.token}` },
    },
  )
  t.after(() => lean.terminate())
  await once(lean, 'open')
  const terminal = new WebSocket(
    f.origin.replace('http:', 'ws:') + `/websocket/terminal/${f.project.id}`,
    {
      headers: { Authorization: `Bearer ${f.editor.token}` },
    },
  )
  t.after(() => terminal.terminate())
  await once(terminal, 'open')
  for (let attempt = 0; f.spawned.length < 2 && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const closed = once(lean, 'close')
  await fs.writeFile(
    path.join(f.spawned[1].root, 'lean-toolchain'),
    'leanprover/lean4:v4.35.0\n',
  )
  const stop = await f.request(`${f.base}/terminal/stop`, {
    actor: f.editor,
    method: 'POST',
    body: {},
  })
  assert.equal(stop.status, 200)
  assert.equal((await closed)[0], 1012)
  assert.equal(
    f.workspaces.get(f.project.id, f.owner.id).needsPreparation,
    true,
  )
})

for (const transport of ['lean', 'terminal']) {
  test(
    `account deletion revokes an existing ${transport} connection before further input or private output`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t)
      const endpoint =
        transport === 'lean'
          ? `/websocket/${f.project.id}`
          : `/websocket/terminal/${f.project.id}`
      const ws = new WebSocket(f.origin.replace('http:', 'ws:') + endpoint, {
        headers: { Authorization: `Bearer ${f.editor.token}` },
      })
      t.after(() => ws.terminate())
      const messages = []
      ws.on('message', (data, binary) => {
        messages.push(data.toString())
        if (binary && ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'ack', bytes: data.length }))
      })
      await once(ws, 'open')
      for (let attempt = 0; !f.spawned.length && attempt < 100; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      const worker = f.spawned.at(-1).child
      // Revocation may close the socket while the account mutation is still
      // persisting. Subscribe first so a prompt close cannot escape the test.
      const closed = once(ws, 'close')
      await f.auth.mutate(() => {
        f.auth.users = f.auth.users.filter((user) => user.id !== f.editor.id)
      })
      // Both server-initiated private output and client input must stop using the
      // credential captured at the original WebSocket handshake.
      if (transport === 'lean') {
        worker.stdout.write(
          frame({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: {
              uri: 'file:///workspace/Main.lean',
              diagnostics: [],
              marker: 'PRIVATE_AFTER_ACCOUNT_REMOVAL',
            },
          }),
        )
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {},
          }),
        )
      } else {
        worker.stdout.write('PRIVATE_AFTER_ACCOUNT_REMOVAL')
        ws.send(JSON.stringify({ type: 'input', data: 'printf unpermitted\n' }))
      }
      assert.equal((await closed)[0], 1008)
      assert.equal(worker.killed, true)
      assert.equal(
        messages.some((message) =>
          message.includes('PRIVATE_AFTER_ACCOUNT_REMOVAL'),
        ),
        false,
      )
      assert.equal((await f.request(f.base, { actor: f.editor })).status, 401)
    },
  )
}

test(
  'an authenticated real event stream closes before new run output after account removal',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    const job = f.events.create(f.editor.id, {
      kind: 'agent',
      projectId: f.project.id,
    })
    const controller = new AbortController()
    t.after(() => controller.abort())
    const response = await fetch(`${f.origin}/api/runs/${job.id}/events`, {
      headers: { Authorization: `Bearer ${f.editor.token}` },
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.equal(first.done, false)
    await f.auth.mutate(() => {
      f.auth.users = f.auth.users.filter((user) => user.id !== f.editor.id)
    })
    f.events.event(job.id, 'message', { text: 'PRIVATE_AFTER_ACCOUNT_REMOVAL' })
    let output = ''
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += new TextDecoder().decode(chunk.value)
    }
    assert.equal(output.includes('PRIVATE_AFTER_ACCOUNT_REMOVAL'), false)
    assert.equal(f.events.listenerCount(job.id), 0)
  },
)

test(
  'promoting an editor and repeating a grant preserves existing collaborative, Lean and terminal sessions',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    const sockets = []
    for (const endpoint of [
      `/websocket/collaboration/${f.project.id}`,
      `/websocket/${f.project.id}`,
      `/websocket/terminal/${f.project.id}`,
    ]) {
      const ws = new WebSocket(f.origin.replace('http:', 'ws:') + endpoint, {
        headers: { Authorization: `Bearer ${f.editor.token}` },
      })
      sockets.push(ws)
      t.after(() => ws.terminate())
      ws.on('message', (data, binary) => {
        if (binary && ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'ack', bytes: data.length }))
      })
      await once(ws, 'open')
    }
    for (let attempt = 0; f.spawned.length < 2 && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await f.member(f.editor, 'admin')).status, 200)
    assert.equal((await f.member(f.editor, 'admin')).status, 200)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      sockets.every((ws) => ws.readyState === 1),
      true,
    )
    assert.equal(
      f.spawned.every(({ child }) => !child.killed),
      true,
    )
    assert.equal(
      f.workspaces.get(f.project.id, f.editor.id).accessRole,
      'admin',
    )
  },
)

test('unknown private recoveries return a safe not-found response without disclosing server paths', async (t) => {
  const f = await fixture(t)
  const response = await f.request(
    `${f.base}/terminal-recoveries/missing-copy/download`,
    { actor: f.editor },
  )
  assert.equal(response.status, 404)
  const text = await response.text()
  assert.equal(text.includes(f.workspaces.dataDir), false)
  assert.equal(text.includes('ENOENT'), false)
})

test('account recovery listing finds only personal terminal copies after project access is removed', async (t) => {
  const f = await fixture(t)
  const own = await f.workspaces.terminalSnapshot(
    f.project.id,
    f.editor.id,
    'editor-personal-recovery',
  )
  await f.workspaces.retainTerminalSnapshot(own, 'Keep my unpublished files.')
  const foreign = await f.workspaces.terminalSnapshot(
    f.project.id,
    f.owner.id,
    'admin-personal-recovery',
  )
  await f.workspaces.retainTerminalSnapshot(foreign, 'Another account copy.')
  await f.workspaces.removeMember(f.project.id, f.owner.id, f.editor.id)
  assert.equal(
    (await f.request('/api/terminal-recoveries', { actor: null })).status,
    401,
  )
  const response = await f.request('/api/terminal-recoveries', {
    actor: f.editor,
  })
  assert.equal(response.status, 200)
  const copies = await response.json()
  assert.equal(copies.length, 1)
  assert.equal(copies[0].projectId, f.project.id)
  assert.equal(copies[0].runId, own.runId)
  assert.deepEqual(Object.keys(copies[0]).sort(), [
    'createdAt',
    'message',
    'projectId',
    'projectName',
    'runId',
    'status',
  ])
  assert.equal((await f.request(f.base, { actor: f.editor })).status, 404)
  assert.deepEqual(
    await (
      await f.request('/api/terminal-recoveries', { actor: f.viewer })
    ).json(),
    [],
  )
  const adminCopies = await (await f.request('/api/terminal-recoveries')).json()
  assert.deepEqual(
    adminCopies.map((copy) => copy.runId),
    [foreign.runId],
  )
  const endpoint = `${f.base}/terminal-recoveries/${own.runId}`
  const binding = `expectedUserId=${encodeURIComponent(f.editor.id)}`
  const archive = await f.request(`${endpoint}/download?${binding}`, {
    actor: f.editor,
  })
  assert.equal(archive.status, 200)
  const zip = await JSZip.loadAsync(await archive.arrayBuffer())
  assert(zip.file('Main.lean'))
  const individual = await f.request(
    `${endpoint}/download?path=Main.lean&${binding}`,
    { actor: f.editor },
  )
  assert.equal(individual.status, 200)
  assert.equal(
    await individual.text(),
    await zip.file('Main.lean').async('string'),
  )
  const listing = await f.request(`${endpoint}/files?${binding}`, {
    actor: f.editor,
  })
  assert.equal(listing.status, 200)
  assert((await listing.json()).files.some((file) => file.path === 'Main.lean'))
  for (const suffix of ['download', 'download?path=Main.lean', 'files']) {
    const separator = suffix.includes('?') ? '&' : '?'
    const response = await f.request(
      `${endpoint}/${suffix}${separator}${binding}`,
      {
        actor: f.owner,
      },
    )
    assert.equal(response.status, 401)
  }
  assert.equal(
    (
      await f.request(`${endpoint}/download?unexpected=1&${binding}`, {
        actor: f.editor,
      })
    ).status,
    400,
  )
  assert.equal(
    (await f.request(`${endpoint}/download`, { actor: f.editor })).status,
    200,
  )
  assert.equal(
    (await f.request(`${endpoint}/download`, { actor: f.owner })).status,
    404,
  )
  assert.equal(
    (await f.request(endpoint, { actor: f.editor, method: 'DELETE', body: {} }))
      .status,
    200,
  )
  assert.deepEqual(
    await (
      await f.request('/api/terminal-recoveries', { actor: f.editor })
    ).json(),
    [],
  )
})

test('recovery HTTP hides active copies and keeps named private downloads after project deletion', async (t) => {
  const f = await fixture(t)
  const copy = await f.workspaces.terminalSnapshot(
    f.project.id,
    f.editor.id,
    'private-after-project-purge',
  )
  const endpoint = `${f.base}/terminal-recoveries/${copy.runId}`
  assert.deepEqual(
    await (
      await f.request('/api/terminal-recoveries', { actor: f.editor })
    ).json(),
    [],
  )
  assert.equal(
    (await f.request(`${endpoint}/download`, { actor: f.editor })).status,
    409,
  )
  assert.equal(
    (await f.request(endpoint, { actor: f.editor, method: 'DELETE', body: {} }))
      .status,
    409,
  )
  await fs.writeFile(
    path.join(copy.root, 'Main.lean'),
    '-- personal copy survives project deletion\n',
  )
  await f.workspaces.retainTerminalSnapshot(copy, 'Download my private files.')
  const archived = await f.request(`${f.base}/trash`, {
    method: 'POST',
    body: {},
  })
  assert.equal(archived.status, 200)
  const { trashId } = await archived.json()
  const purged = await f.request(`/api/trash/${trashId}/delete-forever`, {
    method: 'POST',
    body: {},
  })
  assert.equal(purged.status, 200, await purged.clone().text())
  const copies = await (
    await f.request('/api/terminal-recoveries', { actor: f.editor })
  ).json()
  assert.equal(copies.length, 1)
  assert.equal(copies[0].projectName, f.project.name)
  assert.equal(copies[0].status, 'ready')
  const response = await f.request(`${endpoint}/download`, { actor: f.editor })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition'), /terminal/)
  assert.equal(
    response.headers.get('content-disposition').includes(copy.runId),
    false,
  )
  const zip = await JSZip.loadAsync(await response.arrayBuffer())
  const main = Object.keys(zip.files).find(
    (filename) => filename.endsWith('/Main.lean') || filename === 'Main.lean',
  )
  assert.ok(main)
  assert.equal(
    await zip.file(main).async('string'),
    '-- personal copy survives project deletion\n',
  )
  assert.equal((await f.request(`${endpoint}/download`)).status, 404)
  assert.equal(
    (await f.request(endpoint, { actor: f.editor, method: 'DELETE', body: {} }))
      .status,
    200,
  )
})

test('individual recovery downloads preserve small edits when an oversized file prevents a ZIP', async (t) => {
  const f = await fixture(t)
  const oversized = await fs.open(path.join(f.project.root, 'large.bin'), 'w')
  await oversized.truncate(33 * 1024 * 1024)
  await oversized.close()
  const copy = await f.workspaces.terminalSnapshot(
    f.project.id,
    f.editor.id,
    'large-recovery',
  )
  const endpoint = `${f.base}/terminal-recoveries/${copy.runId}`
  assert.equal(
    (await f.request(`${endpoint}/files`, { actor: f.editor })).status,
    409,
  )
  assert.equal(
    (
      await f.request(`${endpoint}/download?path=Main.lean`, {
        actor: f.editor,
      })
    ).status,
    409,
  )
  const content =
    '-- small private edit preserved despite large unchanged file\n'
  await fs.writeFile(path.join(copy.root, 'Main.lean'), content)
  for (const directory of [
    '.cache',
    '.runtime',
    '.data',
    '.venv',
    '__pycache__',
    '.lake',
    'node_modules',
  ]) {
    await fs.mkdir(path.join(copy.root, directory), { recursive: true })
    await fs.writeFile(
      path.join(copy.root, directory, 'omitted.txt'),
      'private generated content',
    )
  }
  await fs.writeFile(path.join(copy.root, '.env'), 'private secret')
  await fs.symlink(
    path.join(copy.root, 'Main.lean'),
    path.join(copy.root, 'linked.lean'),
  )
  await f.workspaces.retainTerminalSnapshot(copy, 'Recover individual files.')
  const zip = await f.request(`${endpoint}/download`, { actor: f.editor })
  assert.equal(zip.status, 413)
  const zipError = (await zip.json()).error
  assert.match(zipError, /individual files/)
  assert.doesNotMatch(zipError, /Git repository/)
  await f.workspaces.removeMember(f.project.id, f.owner.id, f.editor.id)
  const listingResponse = await f.request(`${endpoint}/files`, {
    actor: f.editor,
  })
  assert.equal(listingResponse.status, 200)
  const listing = await listingResponse.json()
  assert.equal(listing.fileByteLimit, 32 * 1024 * 1024)
  assert.deepEqual(
    listing.files.find((file) => file.path === 'large.bin'),
    {
      path: 'large.bin',
      size: 33 * 1024 * 1024,
      downloadable: false,
    },
  )
  assert.deepEqual(
    listing.files.find((file) => file.path === 'Main.lean'),
    {
      path: 'Main.lean',
      size: Buffer.byteLength(content),
      downloadable: true,
    },
  )
  assert.equal(
    listing.files.some(
      (file) =>
        ['.env', 'linked.lean'].includes(file.path) ||
        ['.cache', '.runtime', '.data', '.venv', '__pycache__', '.lake'].some(
          (directory) => file.path.startsWith(directory + '/'),
        ) ||
        file.path.startsWith('node_modules/'),
    ),
    false,
  )
  let entered, release
  const started = new Promise((resolve) => (entered = resolve))
  const waiting = new Promise((resolve) => (release = resolve))
  const originalRead = f.workspaces.readTerminalRecoveryFile.bind(f.workspaces)
  t.mock.method(f.workspaces, 'readTerminalRecoveryFile', async (...args) => {
    entered()
    await waiting
    return originalRead(...args)
  })
  const downloading = f.request(`${endpoint}/download?path=Main.lean`, {
    actor: f.editor,
  })
  await started
  try {
    const busy = await f.request(`${endpoint}/files`, { actor: f.editor })
    assert.equal(busy.status, 429)
    assert.equal(busy.headers.get('retry-after'), '1')
    await busy.text()
  } finally {
    release()
  }
  const small = await downloading
  assert.equal(small.status, 200)
  assert.match(small.headers.get('content-disposition'), /Main\.lean/)
  assert.equal(await small.text(), content)
  t.mock.restoreAll()
  assert.equal(
    (await f.request(`${endpoint}/files`, { actor: f.editor })).status,
    200,
  )
  const large = await f.request(`${endpoint}/download?path=large.bin`, {
    actor: f.editor,
  })
  assert.equal(large.status, 413)
  assert.match((await large.json()).error, /32 MiB.*administrator/)
  for (const filename of [
    '../Main.lean',
    '.env',
    '.cache/omitted.txt',
    'linked.lean',
  ]) {
    const response = await f.request(
      `${endpoint}/download?path=${encodeURIComponent(filename)}`,
      { actor: f.editor },
    )
    assert([400, 403].includes(response.status))
    await response.text()
  }
  for (const actor of [f.owner, f.viewer, f.outsider]) {
    assert.equal((await f.request(`${endpoint}/files`, { actor })).status, 404)
    assert.equal(
      (await f.request(`${endpoint}/download?path=Main.lean`, { actor }))
        .status,
      404,
    )
  }
})

test(
  'a durable permission change responds while revoked terminal cleanup is still pending',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    const ws = new WebSocket(
      f.origin.replace('http:', 'ws:') + `/websocket/terminal/${f.project.id}`,
      {
        headers: { Authorization: `Bearer ${f.editor.token}` },
      },
    )
    t.after(() => ws.terminate())
    await once(ws, 'open')
    for (let attempt = 0; !f.spawned.length && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    const worker = f.spawned[0].child
    let stopped = false
    worker.once('close', () => {
      stopped = true
    })
    worker.kill = function () {
      this.killed = true
    }
    try {
      const response = await f.request(
        `${f.base}/sharing/members/${f.editor.id}`,
        {
          method: 'PUT',
          body: { role: 'viewer' },
        },
      )
      assert.equal(response.status, 200)
      assert.equal(
        f.workspaces.memberships.role(f.project.id, f.editor.id),
        'viewer',
      )
      assert.equal(worker.killed, true)
      assert.equal(stopped, false)
    } finally {
      worker.emit('close', 0)
    }
  },
)

test('removing an ordinary file preserves other members read-only Lean sessions', async (t) => {
  const f = await fixture(t)
  await f.workspaces.writeFile(
    f.project.id,
    f.owner.id,
    'Other.lean',
    'example : True := by trivial\n',
    null,
  )
  const ws = new WebSocket(
    f.origin.replace('http:', 'ws:') + `/websocket/${f.project.id}`,
    { headers: { Authorization: `Bearer ${f.viewer.token}` } },
  )
  t.after(() => ws.terminate())
  await once(ws, 'open')
  const removed = await f.request(`${f.base}/trash`, {
    actor: f.editor,
    method: 'POST',
    body: { path: 'Other.lean' },
  })
  assert.equal(removed.status, 200)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ws.readyState, 1)
  assert.equal(!!f.spawned[0].child.killed, false)
})

test('a file deletion refuses another member setup without aborting it', async (t) => {
  const f = await fixture(t)
  const controller = new AbortController()
  f.workspaces.preparationActors.set(f.project.id, f.owner.id)
  f.workspaces.preparationControllers.set(f.project.id, controller)
  f.workspaces.jobs.set(f.project.id, Promise.resolve())
  try {
    const removed = await f.request(`${f.base}/trash`, {
      actor: f.editor,
      method: 'POST',
      body: { path: 'Main.lean', stopActive: true },
    })
    assert.equal(removed.status, 409)
    assert.equal(controller.signal.aborted, false)
    assert.ok(
      (await f.workspaces.readFile(f.project.id, f.owner.id, 'Main.lean'))
        .content,
    )
  } finally {
    f.workspaces.jobs.delete(f.project.id)
    f.workspaces.preparationActors.delete(f.project.id)
    f.workspaces.preparationControllers.delete(f.project.id)
  }
})

test('last-admin protection ignores accounts that no longer exist', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.member(f.editor, 'admin')).status, 200)
  await f.auth.mutate(() => {
    f.auth.users = f.auth.users.filter((user) => user.id !== f.editor.id)
  })
  const response = await f.request(`${f.base}/sharing/members/${f.owner.id}`, {
    method: 'PUT',
    body: { role: 'viewer' },
  })
  assert.equal(response.status, 409)
  assert.equal(f.workspaces.get(f.project.id, f.owner.id).accessRole, 'admin')
})

test('account discovery is rate limited per user without blocking other accounts', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 30; index++)
    assert.equal((await f.request('/api/accounts/search?q=edit')).status, 200)
  const limited = await f.request('/api/accounts/search?q=edit')
  assert.equal(limited.status, 429)
  assert(Number(limited.headers.get('retry-after')) > 0)
  assert.equal(
    (await f.request('/api/accounts/search?q=edit', { actor: f.viewer }))
      .status,
    200,
  )
})

test('stale cookie clients cannot read private chats, write files, or start runs without an account binding', async (t) => {
  const f = await fixture(t)
  const login = await f.request('/api/login', {
    actor: null,
    method: 'POST',
    body: { token: f.editor.token },
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const privateChat = f.chats.create(f.editor.id, f.project.id, {
    title: 'BETA_PRIVATE_CHAT_SENTINEL',
  })
  const source = await f.workspaces.readFile(
    f.project.id,
    f.editor.id,
    'Main.lean',
  )
  const privateRun = f.events.create(f.editor.id, {
    kind: 'agent',
    projectId: f.project.id,
    chatId: privateChat.id,
    prompt: 'BETA_PRIVATE_PROMPT_SENTINEL',
  })
  f.events.updateMetadata(privateRun.id, { status: 'completed' })
  const admitted = []
  // Record real route admission without starting a worker or contacting a provider.
  f.agents.start = async (actor, projectId, input) => {
    admitted.push({ actor, projectId, prompt: input.prompt })
    const run = f.events.create(actor, { ...input, kind: 'agent', projectId })
    f.events.updateMetadata(run.id, {
      status: 'failed',
      error: 'Fixture execution stopped.',
    })
    return f.events.getMetadata(run.id, actor)
  }
  const cookieRequest = (
    endpoint,
    { method = 'GET', body, headers = {} } = {},
  ) =>
    fetch(f.origin + endpoint, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        Cookie: cookie,
        Origin: f.origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  for (const [endpoint, method = 'GET', body] of [
    [`${f.base}/chats`],
    [`/api/chats/${privateChat.id}`],
    [
      `${f.base}/chats`,
      'POST',
      { title: 'Stale tab must not create this chat' },
    ],
    [
      `/api/chats/${privateChat.id}/runs`,
      'POST',
      { prompt: 'ALPHA_PRIVATE_DRAFT' },
    ],
    [
      `${f.base}/file?path=Main.lean`,
      'PUT',
      { content: '-- ALPHA_PRIVATE_EDIT\n', expectedHash: source.hash },
    ],
    [
      `/api/runs/${privateRun.id}/messages`,
      'POST',
      { text: 'ALPHA_PRIVATE_FOLLOWUP' },
    ],
    [`${f.base}/download?path=Main.lean`],
    ['/api/terminal-recoveries'],
    [`/api/runs/${privateRun.id}/events`],
    [`/api/runs/${privateRun.id}/events?transport=poll`],
    ['/api/logout', 'POST', {}],
  ]) {
    const response = await cookieRequest(endpoint, { method, body })
    if (response.status !== 428) await response.body?.cancel()
    assert.equal(response.status, 428, `${method} ${endpoint}`)
    assert.equal(response.headers.get('set-cookie'), null)
    const message = (await response.json()).error
    assert.match(message, /older workspace version/)
    assert.match(message, /unsaved editor drafts.*unsent messages.*reloading/)
    assert.match(message, /Signing in again will not update this tab/)
    assert(!message.includes('BETA_PRIVATE'))
  }
  for (const authorization of ['Basic stale-client', 'Bearer malformed!']) {
    const response = await cookieRequest(`${f.base}/chats`, {
      headers: { Authorization: authorization },
    })
    assert.equal(response.status, 428)
  }
  assert.deepEqual(admitted, [])
  assert.equal(
    (await f.workspaces.readFile(f.project.id, f.editor.id, 'Main.lean'))
      .content,
    source.content,
  )
  assert.deepEqual(
    f.chats.list(f.editor.id, f.project.id).map((chat) => chat.id),
    [privateChat.id],
  )
  const bootstrap = await cookieRequest('/api/session')
  assert.equal(bootstrap.status, 200)
  assert.equal((await bootstrap.json()).user.id, f.editor.id)
  const boundHeaders = { 'X-Leanflow-User': f.editor.id }
  const bound = await cookieRequest(`${f.base}/chats`, {
    headers: boundHeaders,
  })
  assert.equal(bound.status, 200)
  assert.equal((await bound.json())[0].title, 'BETA_PRIVATE_CHAT_SENTINEL')
  const save = await cookieRequest(`${f.base}/file?path=Main.lean`, {
    method: 'PUT',
    headers: boundHeaders,
    body: {
      content: source.content + '-- bound save\n',
      expectedHash: source.hash,
    },
  })
  assert.equal(save.status, 200)
  const boundRun = await cookieRequest(`/api/chats/${privateChat.id}/runs`, {
    method: 'POST',
    headers: boundHeaders,
    body: { prompt: 'BOUND_EDITOR_PROMPT' },
  })
  assert.equal(boundRun.status, 202)
  const bearer = await cookieRequest(`/api/chats/${privateChat.id}/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${f.editor.token}` },
    body: { prompt: 'LEGACY_BEARER_PROMPT' },
  })
  assert.equal(bearer.status, 202)
  assert.deepEqual(admitted, [
    {
      actor: f.editor.id,
      projectId: f.project.id,
      prompt: 'BOUND_EDITOR_PROMPT',
    },
    {
      actor: f.editor.id,
      projectId: f.project.id,
      prompt: 'LEGACY_BEARER_PROMPT',
    },
  ])
  const ordinaryLogin = await cookieRequest('/api/login', {
    method: 'POST',
    body: { token: f.owner.token },
  })
  assert.equal(ordinaryLogin.status, 200)
  assert.equal((await ordinaryLogin.json()).user.id, f.owner.id)
  const anonymousLogout = await f.request('/api/logout', {
    actor: null,
    method: 'POST',
    body: {},
  })
  assert.equal(anonymousLogout.status, 200)
  assert.match(anonymousLogout.headers.get('set-cookie'), /Max-Age=0/)
})

test('file recovery retries require an idle project Admin and preserve work in other projects', async (t) => {
  const f = await fixture(t)
  const before = await f.workspaces.readFile(
    f.project.id,
    f.owner.id,
    'Main.lean',
  )
  const originalRename = fs.rename
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (String(destination).endsWith('/applied.json'))
      throw new Error('Fixture commit marker unavailable')
    if (
      String(destination).endsWith('/Main.lean') &&
      path.basename(await fs.realpath(path.dirname(String(source)))) ===
        'before'
    )
      throw new Error('Fixture rollback storage unavailable')
    return originalRename(source, destination)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(
      f.workspaces.applyChanges(f.project.id, f.owner.id, [
        {
          path: 'Main.lean',
          beforeHash: before.hash,
          after: '-- interrupted source\n',
        },
      ]),
      { status: 503 },
    )
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(
    f.workspaces.get(f.project.id, f.owner.id).fileRecoveryRequired,
    true,
  )
  const endpoint = `${f.base}/file-recovery/retry`
  for (const actor of [f.editor, f.viewer])
    assert.equal(
      (await f.request(endpoint, { actor, method: 'POST', body: {} })).status,
      403,
    )
  assert.equal(
    (await f.request(endpoint, { actor: f.outsider, method: 'POST', body: {} }))
      .status,
    404,
  )
  for (const body of [null, [], { restart: true }])
    assert.equal(
      (await f.request(endpoint, { method: 'POST', body })).status,
      400,
    )
  const active = f.events.create(f.editor.id, {
    kind: 'agent',
    projectId: f.project.id,
  })
  f.events.updateMetadata(active.id, { status: 'running' })
  const refused = await f.request(endpoint, { method: 'POST', body: {} })
  assert.equal(refused.status, 409)
  assert.match(
    (await refused.json()).error,
    /Another collaborator has active work/,
  )
  assert.equal(f.events.getMetadata(active.id).status, 'running')
  assert.equal(
    (await f.workspaces.readFile(f.project.id, f.owner.id, 'Main.lean'))
      .content,
    '-- interrupted source\n',
  )
  f.events.updateMetadata(active.id, { status: 'completed' })
  f.agents.active.set(active.id, Promise.resolve())
  try {
    const finishing = await f.request(endpoint, { method: 'POST', body: {} })
    assert.equal(finishing.status, 409)
    assert.match(
      (await finishing.json()).error,
      /Project work is still finishing/,
    )
    assert.equal(f.agents.active.has(active.id), true)
  } finally {
    f.agents.active.delete(active.id)
  }
  const healthy = await f.workspaces.create(f.owner.id, {
    preset: 'lean',
    name: 'Healthy recovery sibling',
  })
  await f.workspaces.jobs.get(healthy.id)
  const healthyRun = f.events.create(f.owner.id, {
    kind: 'agent',
    projectId: healthy.id,
  })
  f.events.updateMetadata(healthyRun.id, { status: 'running' })
  await f.workspaces.writeFile(
    healthy.id,
    f.owner.id,
    'Healthy.lean',
    '-- healthy project remains usable\n',
    null,
  )
  const recovered = await f.request(endpoint, { method: 'POST', body: {} })
  assert.equal(recovered.status, 200)
  const project = await recovered.json()
  assert.equal(project.id, f.project.id)
  assert.equal(project.status, 'ready')
  assert.equal(project.fileRecoveryRequired, undefined)
  assert.equal(project.root, undefined)
  assert.equal(
    (await f.workspaces.readFile(f.project.id, f.owner.id, 'Main.lean'))
      .content,
    before.content,
  )
  assert.equal(f.events.getMetadata(healthyRun.id).status, 'running')
  assert.equal(
    (await f.workspaces.readFile(healthy.id, f.owner.id, 'Healthy.lean'))
      .content,
    '-- healthy project remains usable\n',
  )
  assert.equal(f.workspaces.get(healthy.id, f.owner.id).status, 'ready')
  f.events.updateMetadata(healthyRun.id, { status: 'completed' })
})
