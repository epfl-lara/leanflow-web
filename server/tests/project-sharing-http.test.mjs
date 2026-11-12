import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createStudio } from '../studio.mjs'
import { fixtureModelDiscovery } from './fixtures/model-discovery.mjs'
import JSZip from 'jszip'
import { frame } from '../rpc.mjs'

async function fixture(t) {
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
