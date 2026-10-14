import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { createStudio } from '../studio.mjs'
import { WorkspaceStore } from '../workspaces.mjs'
import {
  configurationDigest,
  readDependencyConfiguration,
} from '../shared-dependencies.mjs'

const TOOLCHAIN = 'leanprover/lean4:v4.35.0-rc4'
const REVISION = '1'.repeat(40)

async function fixture(t, { deferPreparation = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-single-file-'))
  const template = path.join(dataDir, 'mathlib-template')
  await fs.mkdir(path.join(template, '.lake/packages/mathlib'), {
    recursive: true,
  })
  await fs.writeFile(path.join(template, 'lean-toolchain'), TOOLCHAIN + '\n')
  await fs.writeFile(
    path.join(template, 'lakefile.toml'),
    'name = "ProofWorkspace"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n',
  )
  const manifest = JSON.stringify({
    packages: [{ name: 'mathlib', type: 'git', rev: REVISION }],
  })
  await fs.writeFile(path.join(template, 'lake-manifest.json'), manifest)
  await fs.writeFile(
    path.join(template, 'Main.lean'),
    'import Mathlib\nexample : True := by trivial\n',
  )
  await fs.writeFile(
    path.join(template, '.lake/packages/mathlib/Mathlib.lean'),
    '-- prepared library\n',
  )
  const runtime = {
    ready: true,
    failEnvironment: false,
    calls: [],
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates() {
      return [{ id: 'mathlib', toolchain: TOOLCHAIN, ready: this.ready }]
    },
    templateRoot() {
      return this.ready ? template : null
    },
    async prepareToolchain() {},
    preparedPresetEnvironment() {
      return this.ready && !this.failEnvironment
        ? {
            root: template,
            configuration: configurationDigest(
              readDependencyConfiguration(template),
            ),
            toolchain: TOOLCHAIN,
          }
        : null
    },
    async run(root, args, options = {}) {
      this.calls.push({ root, args, options })
      if (args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: 'No commits yet' }
      return {
        code: this.failEnvironment && options.input ? 1 : 0,
        stdout: '',
        stderr: '',
      }
    },
  }
  let finishPreparation = () => {}
  if (deferPreparation) {
    let state = 'verifying'
    const prepare = new Promise((resolve) => {
      finishPreparation = () => {
        state = 'ready'
        resolve()
      }
    })
    const prepared = runtime.preparedPresetEnvironment.bind(runtime)
    runtime.preparedPresetEnvironment = () =>
      state === 'ready' ? prepared() : null
    runtime.preparePresetEnvironment = () => prepare
    runtime.templates = () => [
      {
        id: 'mathlib',
        toolchain: TOOLCHAIN,
        ready: true,
        playgroundReady: state === 'ready',
        playgroundState: state,
      },
    ]
    runtime.shutdown = async () => finishPreparation()
  }
  let providerCalls = 0
  const studio = await createStudio({
    dataDir,
    runtime,
    config: {
      provider: {},
      models: [],
      redact: String,
      lemex: { configured: false },
    },
    titleGenerator: async () => {
      providerCalls++
      throw new Error('No provider calls allowed')
    },
  })
  studio.workspaces.setupRepair = async () => {
    providerCalls++
    throw new Error('No provider calls allowed')
  }
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const otherToken = 'single-file-fixture-bob'
  studio.auth.users.push({
    id: 'bob',
    name: 'Bob',
    tokenHash: createHash('sha256').update(otherToken).digest('hex'),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth/users.json'),
    JSON.stringify(studio.auth.users),
  )
  const request = (endpoint, body, access = token, method = 'POST') =>
    fetch(`http://127.0.0.1:${studio.server.address().port}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        'Content-Type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(5000),
    })
  async function create(input = {}) {
    const response = await request('/api/projects', {
      kind: 'single-file',
      ...input,
    })
    assert.equal(response.status, 201, await response.clone().text())
    const project = await response.json()
    assert.equal(project.root, undefined)
    await studio.workspaces.jobs.get(project.id)
    return studio.workspaces.get(project.id, 'owner')
  }
  return {
    ...studio,
    dataDir,
    runtime,
    template,
    manifest,
    request,
    create,
    otherToken,
    providerCalls: () => providerCalls,
    finishPreparation,
  }
}

test('single files use the exact prepared Mathlib environment and remain private and durable', async (t) => {
  const f = await fixture(t)
  const project = await f.create()
  assert.equal(project.status, 'ready')
  assert.equal(project.kind, 'single-file')
  assert.notEqual(project.protected, true)
  assert.equal(project.toolchain, TOOLCHAIN)
  assert.deepEqual(project.libraries, ['mathlib'])
  assert.equal(project.autoRepair, false)
  assert.match(
    (await f.workspaces.readFile(project.id, 'owner', 'Main.lean')).content,
    /^import Mathlib\n/,
  )
  assert.equal(
    await fs.readFile(path.join(project.root, 'lake-manifest.json'), 'utf8'),
    f.manifest,
  )
  assert.deepEqual(f.workspaces.list('bob'), [])
  assert.equal(
    (
      await f.request(
        `/api/projects/${project.id}`,
        undefined,
        f.otherToken,
        'GET',
      )
    ).status,
    404,
  )
  assert.equal(
    (
      await f.request(
        `/api/projects/${project.id}/file?path=Main.lean`,
        undefined,
        f.otherToken,
        'GET',
      )
    ).status,
    404,
  )
  assert.equal(f.providerCalls(), 0)
})

test('uploaded incomplete proofs survive template setup and retries without automatic provider repair', async (t) => {
  const f = await fixture(t)
  const content = 'import Mathlib\n\nexample (n : ℕ) : n = n := by\n  sorry\n'
  f.runtime.failEnvironment = true
  const project = await f.create({ file: { path: 'MyProof.lean', content } })
  assert.equal(project.name, 'MyProof.lean')
  assert.equal(project.status, 'error')
  assert.equal(
    (await f.workspaces.readFile(project.id, 'owner', 'Main.lean')).content,
    content,
  )
  assert.equal(f.providerCalls(), 0)
  await assert.rejects(
    f.workspaces.writeFile(
      project.id,
      'owner',
      'lakefile.toml',
      'changed',
      undefined,
    ),
    { status: 409 },
  )
  f.runtime.failEnvironment = false
  const edited = content + '-- preserved during retry\n'
  const original = await f.workspaces.readFile(project.id, 'owner', 'Main.lean')
  await f.workspaces.writeFile(
    project.id,
    'owner',
    'Main.lean',
    edited,
    original.hash,
  )
  await f.workspaces.prepare(project.id, 'owner')
  await f.workspaces.jobs.get(project.id)
  assert.equal(f.workspaces.get(project.id, 'owner').status, 'ready')
  assert.equal(
    (await f.workspaces.readFile(project.id, 'owner', 'Main.lean')).content,
    edited,
  )
  assert.equal(
    await fs.readFile(path.join(f.template, 'Main.lean'), 'utf8'),
    'import Mathlib\nexample : True := by trivial\n',
  )
})

test('a failed playground can become a project without losing its file', async (t) => {
  const f = await fixture(t)
  f.runtime.failEnvironment = true
  const project = await f.create()
  const source = await f.workspaces.readFile(project.id, 'owner', 'Main.lean')
  const response = await f.request(`/api/projects/${project.id}/convert`)
  assert.equal(response.status, 200)
  const converted = await response.json()
  assert.equal(converted.kind, 'project')
  assert.equal(converted.status, 'error')
  assert.equal(converted.needsPreparation, true)
  assert.equal(
    (await f.workspaces.readFile(project.id, 'owner', 'Main.lean')).hash,
    source.hash,
  )
  await f.workspaces.writeFile(
    project.id,
    'owner',
    'lakefile.toml',
    'name = "ProofWorkspace"\n',
    null,
  )
})

test('saving single files preserves conflict and containment checks', async (t) => {
  const f = await fixture(t)
  const project = await f.create()
  const source = await f.workspaces.readFile(project.id, 'owner', 'Main.lean')
  await f.workspaces.writeFile(
    project.id,
    'owner',
    'Main.lean',
    'import Mathlib\nexample : True := by trivial\n',
    source.hash,
  )
  await assert.rejects(
    f.workspaces.writeFile(
      project.id,
      'owner',
      'Main.lean',
      'stale',
      source.hash,
    ),
    { status: 409 },
  )
  await assert.rejects(
    f.workspaces.writeFile(project.id, 'owner', '../escape.lean', '', null),
    { status: 400 },
  )
  await assert.rejects(
    f.workspaces.writeFile(
      project.id,
      'owner',
      '.lake/packages/mathlib/Mathlib.lean',
      '',
      null,
    ),
    { status: 400 },
  )
})

test('playgrounds can be renamed, converted, deleted and restored while retaining owner and active-run guards', async (t) => {
  const f = await fixture(t)
  const project = await f.create()
  const original = await f.workspaces.readFile(project.id, 'owner', 'Main.lean')
  const chat = f.chats.create('owner', project.id, {})
  const run = f.events.create('owner', {
    kind: 'agent',
    projectId: project.id,
    chatId: chat.id,
  })
  f.events.update(run.id, { status: 'running' })
  const trash = () => f.request(`/api/projects/${project.id}/trash`, {})
  assert.equal((await trash()).status, 409)
  assert.equal(
    (
      await f.request(
        `/api/projects/${project.id}/rename`,
        { name: 'My proof' },
        f.otherToken,
      )
    ).status,
    404,
  )
  const renamed = await f.request(`/api/projects/${project.id}/rename`, {
    name: 'My proof',
  })
  assert.equal(renamed.status, 200)
  assert.equal((await renamed.json()).name, 'My proof')
  assert.equal(
    (await f.workspaces.readFile(project.id, 'owner', 'Main.lean')).hash,
    original.hash,
  )
  assert.equal(f.events.snapshot(run.id, 'owner').status, 'running')
  for (const name of ['', '   ', 'x'.repeat(121), 'bad\0name', null])
    assert.equal(
      (await f.request(`/api/projects/${project.id}/rename`, { name })).status,
      400,
    )
  assert.equal(
    (await f.request(`/api/projects/${project.id}/convert`, {}, f.otherToken))
      .status,
    404,
  )
  const converted = await f.request(`/api/projects/${project.id}/convert`, {})
  assert.equal(converted.status, 200)
  const value = await converted.json()
  assert.equal(value.kind, 'project')
  assert.notEqual(value.protected, true)
  assert.equal(value.id, project.id)
  assert.equal(value.toolchain, TOOLCHAIN)
  f.events.update(run.id, { status: 'completed' })
  const deleted = await trash()
  assert.equal(deleted.status, 200)
  const receipt = await deleted.json()
  assert.equal(f.workspaces.list('owner').length, 0)
  assert.throws(() => f.workspaces.get(project.id, 'owner'), { status: 404 })
  await f.workspaces.restore(receipt.trashId, 'owner')
  assert.equal(f.workspaces.get(project.id, 'owner').name, 'My proof')
  assert.equal(
    (await f.workspaces.readFile(project.id, 'owner', 'Main.lean')).hash,
    original.hash,
  )
  assert.equal(f.chats.get(chat.id, 'owner').projectId, project.id)
  assert.equal(
    await fs.readFile(path.join(f.template, 'Main.lean'), 'utf8'),
    'import Mathlib\nexample : True := by trivial\n',
  )
})

test('prepared playground creation returns ready immediately without Lean import, build, or toolchain commands', async (t) => {
  const f = await fixture(t)
  const response = await f.request('/api/projects', { kind: 'single-file' })
  assert.equal(response.status, 201)
  assert.equal((await response.json()).status, 'ready')
  assert.equal(
    f.runtime.calls.some((call) => call.args[0] === 'lake'),
    false,
  )
  assert.equal(f.providerCalls(), 0)
  const [second, third] = await Promise.all([f.create(), f.create()])
  assert.deepEqual(
    new Set(f.workspaces.list('owner').map((project) => project.name)),
    new Set(['Scratch.lean', 'Scratch2.lean', 'Scratch3.lean']),
  )
  assert.equal(
    (await f.request(`/api/projects/${third.id}/rename`, { name: second.name }))
      .status,
    409,
  )
})

test('restart gives legacy private playgrounds distinct names and enables deletion without editing code', async (t) => {
  const f = await fixture(t)
  const projects = [await f.create(), await f.create()]
  const sourceHashes = await Promise.all(
    projects.map((p) =>
      f.workspaces
        .readFile(p.id, 'owner', 'Main.lean')
        .then((file) => file.hash),
    ),
  )
  for (const project of projects) {
    project.name = 'Untitled.lean'
    project.protected = true
    f.workspaces.db
      .prepare('UPDATE projects SET data=? WHERE id=?')
      .run(JSON.stringify(project), project.id)
  }
  const reopened = await new WorkspaceStore({
    dataDir: f.dataDir,
    runtime: f.runtime,
  }).init()
  try {
    assert.deepEqual(
      new Set(reopened.list('owner').map((project) => project.name)),
      new Set(['Scratch.lean', 'Scratch2.lean']),
    )
    for (const [index, project] of projects.entries()) {
      assert.notEqual(reopened.get(project.id, 'owner').protected, true)
      assert.equal(
        (await reopened.readFile(project.id, 'owner', 'Main.lean')).hash,
        sourceHashes[index],
      )
    }
  } finally {
    reopened.close()
  }
})

test('restarted and legacy failed playgrounds can save their proof and retry opening', async (t) => {
  const f = await fixture(t)
  const projects = [await f.create(), await f.create()]
  for (const [index, project] of projects.entries()) {
    project.status = index === 0 ? 'preparing' : 'error'
    project.needsPreparation = false
    f.workspaces.db
      .prepare('UPDATE projects SET data=? WHERE id=?')
      .run(JSON.stringify(project), project.id)
  }
  const reopened = await new WorkspaceStore({
    dataDir: f.dataDir,
    runtime: f.runtime,
  }).init()
  try {
    for (const project of projects) {
      assert.equal(reopened.get(project.id, 'owner').needsPreparation, true)
      const source = await reopened.readFile(project.id, 'owner', 'Main.lean')
      const content = source.content + '-- saved after restart\n'
      await reopened.writeFile(
        project.id,
        'owner',
        'Main.lean',
        content,
        source.hash,
      )
      await reopened.prepare(project.id, 'owner')
      await reopened.jobs.get(project.id)
      assert.equal(reopened.get(project.id, 'owner').status, 'ready')
      assert.equal(
        (await reopened.readFile(project.id, 'owner', 'Main.lean')).content,
        content,
      )
    }
  } finally {
    reopened.close()
  }
})

test('playground setup files cannot change through uploads, assistant changes or deletion', async (t) => {
  const f = await fixture(t)
  const project = await f.create()
  const source = await f.workspaces.readFile(
    project.id,
    'owner',
    'lakefile.toml',
  )
  await assert.rejects(
    f.workspaces.trash(project.id, 'owner', 'lakefile.toml'),
    { status: 409 },
  )
  await assert.rejects(
    f.workspaces.upload(project.id, 'owner', [
      { path: 'lakefile.lean', content: 'import Lake\n' },
    ]),
    { status: 409 },
  )
  await assert.rejects(
    f.workspaces.applyChanges(project.id, 'owner', [
      { path: 'lakefile.toml', beforeHash: source.hash, after: 'changed' },
    ]),
    { status: 409 },
  )
  assert.equal(
    (await f.workspaces.readFile(project.id, 'owner', 'lakefile.toml')).hash,
    source.hash,
  )
  assert.equal(f.workspaces.get(project.id, 'owner').status, 'ready')
})

test('single-file requests reject custom environments, unsafe sources and unavailable Mathlib before creating a workspace', async (t) => {
  const f = await fixture(t)
  for (const input of [
    { kind: 'unknown' },
    { file: null },
    { file: { path: '../Bad.lean', content: '' } },
    { file: { path: 'Folder/Bad.lean', content: '' } },
    { file: { path: 'bad.txt', content: '' } },
    { file: { path: 'Bad.lean', content: '\0' } },
    { file: { path: 'Bad.lean', content: '\ud800' } },
    { repository: 'https://github.com/owner/repo' },
    { files: [{ path: 'Main.lean', content: '' }] },
    { toolchain: 'leanprover/lean4:v4.34.1' },
    { libraries: ['lean'] },
    { autoRepair: true },
  ]) {
    const response = await f.request('/api/projects', {
      kind: 'single-file',
      ...input,
    })
    assert.ok([400, 415].includes(response.status), JSON.stringify(input))
  }
  assert.equal(
    (
      await f.request('/api/projects', {
        kind: 'single-file',
        file: { path: 'Big.lean', content: 'x'.repeat(8 * 1024 * 1024 + 1) },
      })
    ).status,
    413,
  )
  f.runtime.ready = false
  const unavailable = await f.request('/api/projects', { kind: 'single-file' })
  assert.equal(unavailable.status, 503)
  assert.match(
    (await unavailable.json()).error,
    /Mathlib Playground is not prepared/,
  )
  assert.deepEqual(f.workspaces.list('owner'), [])
  assert.equal(f.providerCalls(), 0)
})

test('server remains available while prepared Mathlib verification is running', async (t) => {
  const f = await fixture(t, { deferPreparation: true })
  const status = await f.request('/api/playground', undefined, undefined, 'GET')
  assert.equal(status.status, 200)
  assert.equal((await status.json()).state, 'verifying')
  assert.equal(
    (await f.request('/api/projects', { kind: 'single-file' })).status,
    503,
  )
  assert.equal(f.workspaces.list('owner').length, 0)
  f.finishPreparation()
  assert.equal(
    (
      await (
        await f.request('/api/playground', undefined, undefined, 'GET')
      ).json()
    ).state,
    'ready',
  )
  assert.equal((await f.create()).status, 'ready')
})

test('delete, create and restore keep default playground names distinct', async (t) => {
  const f = await fixture(t)
  const first = await f.create()
  const receipt = await f.workspaces.trash(first.id, 'owner')
  const second = await f.create()
  assert.equal(first.name, 'Scratch.lean')
  assert.equal(second.name, 'Scratch2.lean')
  await f.workspaces.restore(receipt.trashId, 'owner')
  assert.equal(
    new Set(f.workspaces.list('owner').map((project) => project.name)).size,
    2,
  )
})

test('large single-file uploads retain the prepared Mathlib environment and hash-checked saves', async (t) => {
  const f = await fixture(t)
  const source = 'import Mathlib\n-- ' + 'a'.repeat(5_400_000) + '\n'
  const project = await f.create({
    file: { path: 'Large.lean', content: source },
  })
  assert.equal(project.status, 'ready')
  assert.equal(project.kind, 'single-file')
  assert.equal(project.toolchain, TOOLCHAIN)
  const file = await f.workspaces.readFile(project.id, 'owner', 'Main.lean')
  const hash = (content) => createHash('sha256').update(content).digest('hex')
  assert.equal(file.hash, hash(source))
  const saved = await f.request(
    `/api/projects/${project.id}/file?path=Main.lean`,
    { content: source + '-- saved\n', expectedHash: file.hash },
    undefined,
    'PUT',
  )
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.equal((await saved.json()).hash, hash(source + '-- saved\n'))
  const conflict = await f.request(
    `/api/projects/${project.id}/file?path=Main.lean`,
    { content: source, expectedHash: file.hash },
    undefined,
    'PUT',
  )
  assert.equal(conflict.status, 409)
  assert.equal(
    (await f.workspaces.readFile(project.id, 'owner', 'Main.lean')).hash,
    hash(source + '-- saved\n'),
  )
  assert.equal(
    await fs.readFile(path.join(project.root, 'lean-toolchain'), 'utf8'),
    TOOLCHAIN + '\n',
  )
  assert.equal(
    await fs.readFile(path.join(project.root, 'lake-manifest.json'), 'utf8'),
    f.manifest,
  )
  assert.equal(f.providerCalls(), 0)
})

test('playground terminals select their own root and Main.lean after a different workspace was opened', async (t) => {
  const f = await fixture(t)
  const previous = await f.create({
    name: 'Previous full project',
    kind: 'project',
  })
  const first = await f.create({
    file: { path: 'Scratch.lean', content: '-- first playground\n' },
  })
  const second = await f.create({
    file: { path: 'Scratch2.lean', content: '-- second playground\n' },
  })
  const spawned = []
  f.runtime.spawn = (root, args, options) => {
    const child = new EventEmitter()
    Object.assign(child, {
      root,
      args,
      options,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    child.kill = () => {
      if (child.killed) return
      child.killed = true
      queueMicrotask(() => child.emit('close', 0))
    }
    spawned.push(child)
    return child
  }
  for (const project of [previous, first, second, first]) {
    const source = await f.request(
      `/api/projects/${project.id}/file?path=Main.lean`,
      undefined,
      undefined,
      'GET',
    )
    assert.equal(source.status, 200)
    const saved = await source.json()
    const endpoint = new URL(`/websocket/terminal/${project.id}`, source.url)
    endpoint.protocol = 'ws:'
    const token = (
      await fs.readFile(path.join(f.dataDir, 'auth/owner.token'), 'utf8')
    ).trim()
    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
    })
    t.after(() => socket.terminate())
    await new Promise((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const child = spawned.at(-1)
    assert.equal(child.root, project.root)
    assert.equal(
      await fs.readFile(path.join(child.root, 'Main.lean'), 'utf8'),
      saved.content,
    )
    if (project.kind === 'single-file')
      assert.equal(
        saved.content,
        project.id === first.id
          ? '-- first playground\n'
          : '-- second playground\n',
      )
    const closed = new Promise((resolve) => socket.once('close', resolve))
    const stop = await f.request(
      `/api/projects/${project.id}/terminal/stop`,
      {},
    )
    assert.equal(stop.status, 200)
    await closed
    assert.equal(child.killed, true)
  }
  assert.deepEqual(
    spawned.map((child) => child.root),
    [previous.root, first.root, second.root, first.root],
  )
  assert.equal(f.providerCalls(), 0)
})
