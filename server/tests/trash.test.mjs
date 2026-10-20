import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { WorkspaceStore } from '../workspaces.mjs'
import { createStudio } from '../studio.mjs'
import { ChatStore } from '../chats.mjs'
import { storedDiskBytes } from '../trash-storage.mjs'

const TOOLCHAIN = 'leanprover/lean4:v4.34.1'

class FakeRuntime {
  children = []
  async init() {}
  info() {
    return { ready: true }
  }
  templates() {
    return [{ id: 'lean', toolchain: TOOLCHAIN, ready: true }]
  }
  templateRoot() {
    return null
  }
  async prepareToolchain() {}
  async run(root, args) {
    if (args[0] === 'git' && args.includes('init'))
      await fs.mkdir(path.join(root, '.git'), { recursive: true })
    if (args[0] === 'git' && args.includes('rev-parse'))
      return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'lake' && args[1] === 'update') {
      await fs.mkdir(path.join(root, '.lake'), { recursive: true })
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[]}',
      )
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  spawn() {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.kill = () => {
      if (child.killed) return
      child.killed = true
      queueMicrotask(() => {
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0)
      })
    }
    this.children.push(child)
    return child
  }
  async shutdown() {
    this.children.forEach((child) => child.kill())
  }
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-trash-')),
    runtime = new FakeRuntime()
  const config = {
    defaultModel: 'test',
    models: [{ id: 'test' }],
    provider: {},
    lemex: {},
    redact: String,
  }
  const studio = await createStudio({ dataDir, runtime, config })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await studio.workspaces.create('owner', {
    name: 'My proofs',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  const token = (
    await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')
  ).trim()
  const otherToken = 'bob-test-token'
  studio.auth.users.push({
    id: 'bob',
    name: 'Bob',
    tokenHash: createHash('sha256').update(otherToken).digest('hex'),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth', 'users.json'),
    JSON.stringify(studio.auth.users),
  )
  const url = `http://127.0.0.1:${studio.server.address().port}`
  const request = (endpoint, body = {}, access = token) =>
    fetch(url + endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  return {
    ...studio,
    store: studio.workspaces,
    project,
    runtime,
    dataDir,
    url,
    token,
    otherToken,
    request,
  }
}

test('file and binary folder deletion is recoverable without editing or truncating content', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const original = await store.readFile(project.id, 'owner', 'Main.lean')
  const deleted = await store.trash(project.id, 'owner', 'Main.lean')
  assert.equal(deleted.kind, 'file')
  assert.equal(deleted.recoverable, true)
  assert.equal(deleted.projectName, 'My proofs')
  assert.equal(deleted.name, 'Main.lean')
  await assert.rejects(store.readFile(project.id, 'owner', 'Main.lean'), {
    status: 404,
  })
  assert.equal(
    await fs.readFile(
      path.join(dataDir, 'trash', deleted.trashId, 'content'),
      'utf8',
    ),
    original.content,
  )
  assert.equal((await store.restore(deleted.trashId, 'owner')).restored, true)
  assert.equal(
    (await store.readFile(project.id, 'owner', 'Main.lean')).hash,
    original.hash,
  )
  await fs.mkdir(path.join(project.root, 'Examples', 'nested'), {
    recursive: true,
  })
  const bytes = Buffer.from([0, 128, 255, 1, 0])
  await fs.writeFile(
    path.join(project.root, 'Examples', 'nested', 'data.bin'),
    bytes,
  )
  await fs.writeFile(
    path.join(project.root, 'Examples', 'Proof.lean'),
    'example : True := by trivial\n',
  )
  const folder = await store.trash(project.id, 'owner', 'Examples')
  assert.equal(folder.kind, 'folder')
  await assert.rejects(fs.stat(path.join(project.root, 'Examples')), {
    code: 'ENOENT',
  })
  await store.restore(folder.trashId, 'owner')
  assert.deepEqual(
    await fs.readFile(
      path.join(project.root, 'Examples', 'nested', 'data.bin'),
    ),
    bytes,
  )
  assert.equal(
    await fs.readFile(
      path.join(project.root, 'Examples', 'Proof.lean'),
      'utf8',
    ),
    'example : True := by trivial\n',
  )
  assert.deepEqual(store.listTrash('owner'), [])
})

test('restore refuses collisions and other owners while preserving both old and new files', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const before = (await store.readFile(project.id, 'owner', 'Main.lean'))
    .content
  const receipt = await store.trash(project.id, 'owner', 'Main.lean')
  await store.writeFile(
    project.id,
    'owner',
    'Main.lean',
    'replacement text\n',
    null,
  )
  await assert.rejects(store.restore(receipt.trashId, 'owner'), { status: 409 })
  await assert.rejects(store.restore(receipt.trashId, 'bob'), { status: 404 })
  assert.equal(
    (await store.readFile(project.id, 'owner', 'Main.lean')).content,
    'replacement text\n',
  )
  assert.equal(
    await fs.readFile(
      path.join(dataDir, 'trash', receipt.trashId, 'content'),
      'utf8',
    ),
    before,
  )
  assert.equal(store.listTrash('owner').length, 1)
  assert.deepEqual(store.listTrash('bob'), [])
  await fs.mkdir(path.join(project.root, 'Folder'))
  await fs.writeFile(
    path.join(project.root, 'Folder', 'original.txt'),
    'original',
  )
  const folder = await store.trash(project.id, 'owner', 'Folder')
  await fs.mkdir(path.join(project.root, 'Folder'))
  await fs.writeFile(
    path.join(project.root, 'Folder', 'replacement.txt'),
    'replacement',
  )
  await assert.rejects(store.restore(folder.trashId, 'owner'), { status: 409 })
  assert.equal(
    await fs.readFile(
      path.join(project.root, 'Folder', 'replacement.txt'),
      'utf8',
    ),
    'replacement',
  )
})

test('trash denies traversal, credentials, readonly dependencies, and symlink escapes', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const outside = path.join(dataDir, 'outside.txt')
  await fs.writeFile(outside, 'outside data')
  await fs.symlink(outside, path.join(project.root, 'link.txt'))
  await fs.symlink(dataDir, path.join(project.root, 'escape'))
  for (const filename of [
    '',
    '.',
    '/',
    '..',
    '../outside.txt',
    '.git',
    '.git/config',
    '.lake',
    '.lake/packages/mathlib/Mathlib.lean',
    '.env',
    '.env.local',
    '.lemex',
    'escape/outside.txt',
    'link.txt',
  ])
    await assert.rejects(store.trash(project.id, 'owner', filename))
  await fs.mkdir(path.join(project.root, 'Protected'))
  await fs.writeFile(path.join(project.root, 'Protected', '.env'), 'private')
  await assert.rejects(store.trash(project.id, 'owner', 'Protected'), {
    status: 403,
  })
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside data')
  assert.equal(
    await fs.readFile(path.join(project.root, 'Protected', '.env'), 'utf8'),
    'private',
  )
  assert.equal(store.list('owner').length, 1)
})

test('project archive hides normal access and retains cache roots and failed project metadata', async (t) => {
  const { store, project, runtime } = await fixture(t)
  const cache = path.join(
    project.root,
    '.lake',
    'packages',
    'shared',
    'Source.lean',
  )
  await fs.mkdir(path.dirname(cache), { recursive: true })
  await fs.writeFile(cache, '-- Dependency cache\n')
  runtime.prepareToolchain = async () => {
    throw new Error('temporary preparation failure')
  }
  await store.prepare(project.id, 'owner')
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'owner').status, 'error')
  const receipt = await store.trash(project.id, 'owner')
  assert.equal(receipt.kind, 'project')
  assert.equal(receipt.path, null)
  assert.deepEqual(store.list('owner'), [])
  assert.throws(() => store.get(project.id, 'owner'), { status: 404 })
  await assert.rejects(store.readFile(project.id, 'owner', 'Main.lean'), {
    status: 404,
  })
  assert.equal(await fs.readFile(cache, 'utf8'), '-- Dependency cache\n')
  await assert.rejects(store.restore(receipt.trashId, 'bob'), { status: 404 })
  await store.restore(receipt.trashId, 'owner')
  assert.equal(store.get(project.id, 'owner').status, 'error')
  assert.equal(store.list('owner')[0].id, project.id)
  assert.equal((await store.restore(receipt.trashId, 'owner')).restored, true)
})

test('restart recovers trash receipts and interrupted move or restore metadata', async (t) => {
  const { store, project, dataDir, runtime } = await fixture(t)
  const original = (await store.readFile(project.id, 'owner', 'Main.lean'))
    .content
  const receipt = await store.trash(project.id, 'owner', 'Main.lean')
  const record = JSON.parse(
    store.db.prepare('SELECT data FROM trash WHERE id=?').get(receipt.trashId)
      .data,
  )
  record.state = 'moving'
  store.db
    .prepare('UPDATE trash SET data=? WHERE id=?')
    .run(JSON.stringify(record), receipt.trashId)
  store.close()
  store.db = null
  const restarted = await new WorkspaceStore({ dataDir, runtime }).init()
  try {
    assert.equal(restarted.listTrash('owner')[0].trashId, receipt.trashId)
    await restarted.restore(receipt.trashId, 'owner')
    record.state = 'restoring'
    restarted.db
      .prepare('UPDATE trash SET data=? WHERE id=?')
      .run(JSON.stringify(record), receipt.trashId)
  } finally {
    restarted.close()
  }
  const recovered = await new WorkspaceStore({ dataDir, runtime }).init()
  try {
    assert.deepEqual(recovered.listTrash('owner'), [])
    assert.equal(
      (await recovered.readFile(project.id, 'owner', 'Main.lean')).content,
      original,
    )
    assert.equal(
      (await recovered.restore(receipt.trashId, 'owner')).restored,
      true,
    )
  } finally {
    recovered.close()
  }
})

test('HTTP trash and restore enforce authentication, owners, and active check or agent guards', async (t) => {
  const { store, project, events, request, otherToken, url, token, runtime } =
    await fixture(t)
  const endpoint = `/api/projects/${project.id}/trash`
  assert.equal(
    (await request(endpoint, { path: 'Main.lean' }, null)).status,
    401,
  )
  assert.equal(
    (await request(endpoint, { path: 'Main.lean' }, otherToken)).status,
    404,
  )
  assert.equal((await request(endpoint, { path: null })).status, 400)
  await store.writeFile(
    project.id,
    'owner',
    'Restore.lean',
    '-- Keep this proof\n',
    null,
  )
  const receipt = await (
    await request(endpoint, { path: 'Restore.lean' })
  ).json()
  for (const kind of ['agent', 'check']) {
    const job = events.create('owner', { projectId: project.id, kind })
    assert.equal(
      (await request(`/api/trash/${receipt.trashId}/restore`)).status,
      409,
    )
    const moved = await request(endpoint, { path: 'Main.lean' })
    if (kind === 'agent') {
      assert.equal(moved.status, 200)
      assert.equal(events.getMetadata(job.id).status, 'cancelled')
      const item = await moved.json()
      await request(`/api/trash/${item.trashId}/restore`)
    } else {
      // A check with no live controller cannot confirm worker teardown.
      assert.equal(moved.status, 409)
    }
    events.update(job.id, { status: 'cancelled' })
  }
  assert.equal(
    (await request(`/api/trash/${receipt.trashId}/restore`, {}, otherToken))
      .status,
    404,
  )
  assert.equal(
    (await request(`/api/trash/${receipt.trashId}/restore`)).status,
    200,
  )
  const binary = await store.trash(project.id, 'owner', 'Restore.lean')
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  runtime.prepareToolchain = () => gate
  await store.prepare(project.id, 'owner')
  try {
    assert.equal(
      (await request(`/api/trash/${binary.trashId}/restore`)).status,
      409,
    )
  } finally {
    release()
    await store.jobs.get(project.id)
  }
  const listed = await (
    await fetch(`${url}/api/trash`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json()
  assert.equal(listed[0].trashId, binary.trashId)
  assert.equal(listed[0].projectName, 'My proofs')
  assert.equal(listed[0].name, 'Restore.lean')
})

test('restart removes only recognized empty folder restore reservations', async (t) => {
  const { store, project, dataDir, runtime } = await fixture(t)
  const receipts = []
  for (const name of ['Recognized', 'UserFiles', 'Unknown']) {
    await fs.mkdir(path.join(project.root, name))
    await fs.writeFile(
      path.join(project.root, name, 'Original.lean'),
      `-- ${name} original\n`,
    )
    const receipt = await store.trash(project.id, 'owner', name)
    await fs.mkdir(path.join(project.root, name))
    const reserved = await fs.lstat(path.join(project.root, name))
    const record = JSON.parse(
      store.db.prepare('SELECT data FROM trash WHERE id=?').get(receipt.trashId)
        .data,
    )
    record.state = 'restoring'
    if (name !== 'Unknown')
      record.reserved = { dev: reserved.dev, ino: reserved.ino }
    if (name === 'UserFiles')
      await fs.writeFile(
        path.join(project.root, name, 'User.lean'),
        '-- Keep user data\n',
      )
    store.db
      .prepare('UPDATE trash SET data=? WHERE id=?')
      .run(JSON.stringify(record), receipt.trashId)
    receipts.push(receipt)
  }
  store.close()
  store.db = null
  const restarted = await new WorkspaceStore({ dataDir, runtime }).init()
  try {
    await assert.rejects(fs.stat(path.join(project.root, 'Recognized')), {
      code: 'ENOENT',
    })
    await restarted.restore(receipts[0].trashId, 'owner')
    assert.equal(
      await fs.readFile(
        path.join(project.root, 'Recognized', 'Original.lean'),
        'utf8',
      ),
      '-- Recognized original\n',
    )
    for (const receipt of receipts.slice(1))
      await assert.rejects(restarted.restore(receipt.trashId, 'owner'), {
        status: 409,
      })
    assert.equal(
      await fs.readFile(
        path.join(project.root, 'UserFiles', 'User.lean'),
        'utf8',
      ),
      '-- Keep user data\n',
    )
    assert.equal(
      (await fs.stat(path.join(project.root, 'Unknown'))).isDirectory(),
      true,
    )
    assert.equal(restarted.listTrash('owner').length, 2)
  } finally {
    restarted.close()
  }
})

test('archiving a project closes its Lean socket and restore makes it accessible again', async (t) => {
  const { request, project, url, token, runtime } = await fixture(t)
  const ws = new WebSocket(
    url.replace('http:', 'ws:') + `/websocket/${project.id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  t.after(() => ws.terminate())
  await once(ws, 'open')
  const closed = once(ws, 'close')
  const archived = await request(`/api/projects/${project.id}/trash`)
  assert.equal(archived.status, 200)
  const receipt = await archived.json()
  assert.equal((await closed)[0], 1001)
  await new Promise(setImmediate)
  assert.equal(runtime.children[0].killed, true)
  assert.equal(
    (
      await fetch(`${url}/api/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    404,
  )
  assert.equal(
    (await request(`/api/trash/${receipt.trashId}/restore`)).status,
    200,
  )
  assert.equal(
    (
      await fetch(`${url}/api/projects/${project.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
    200,
  )
})

test('trash sizes measure allocated blocks without following links or counting hardlinks twice', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const receipt = await store.trash(project.id, 'owner', 'Main.lean')
  const container = path.join(dataDir, 'trash', receipt.trashId)
  const expected = await storedDiskBytes([
    { directory: path.dirname(container), name: path.basename(container) },
  ])
  assert.equal(receipt.sizeBytes, expected)
  assert(expected > 0)
  const record = JSON.parse(
    store.db.prepare('SELECT data FROM trash WHERE id=?').get(receipt.trashId)
      .data,
  )
  delete record.sizeBytes
  store.db
    .prepare('UPDATE trash SET data=? WHERE id=?')
    .run(JSON.stringify(record), receipt.trashId)
  assert.equal(store.listTrash('owner')[0].sizeBytes, null)
  assert.equal((await store.listTrashWithSizes('owner'))[0].sizeBytes, expected)

  const tree = path.join(dataDir, 'measured')
  await fs.mkdir(tree)
  await fs.writeFile(path.join(tree, 'proof'), 'proof')
  await fs.link(path.join(tree, 'proof'), path.join(tree, 'duplicate'))
  const outside = path.join(dataDir, 'outside.bin')
  await fs.writeFile(outside, Buffer.alloc(1024 * 1024))
  await fs.symlink(outside, path.join(tree, 'outside'))
  const allocated = (
    await Promise.all(
      ['', 'proof', 'outside'].map((name) => fs.lstat(path.join(tree, name))),
    )
  ).reduce((sum, stat) => sum + stat.blocks * 512, 0)
  assert.equal(
    await storedDiskBytes([{ directory: dataDir, name: 'measured' }]),
    allocated,
  )
})

test('delete forever removes only the owned trash item and protects restored data and concurrent restore', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const receipt = await store.trash(project.id, 'owner', 'Main.lean')
  await store.writeFile(
    project.id,
    'owner',
    'Main.lean',
    '-- Replacement proof\n',
    null,
  )
  await assert.rejects(store.deleteForever(receipt.trashId, 'bob'), {
    status: 404,
  })
  await assert.rejects(store.deleteForever(project.id, 'owner'), {
    status: 404,
  })
  await assert.rejects(store.deleteForever('../outside', 'owner'), {
    status: 400,
  })
  assert.equal(
    (await store.deleteForever(receipt.trashId, 'owner')).deleted,
    true,
  )
  await assert.rejects(fs.stat(path.join(dataDir, 'trash', receipt.trashId)), {
    code: 'ENOENT',
  })
  assert.equal(
    (await store.readFile(project.id, 'owner', 'Main.lean')).content,
    '-- Replacement proof\n',
  )
  await assert.rejects(store.restore(receipt.trashId, 'owner'), { status: 404 })

  const restored = await store.trash(project.id, 'owner', 'Main.lean')
  const outcomes = await Promise.allSettled([
    store.restore(restored.trashId, 'owner'),
    store.deleteForever(restored.trashId, 'owner'),
  ])
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[1].status, 'rejected')
  assert.equal(outcomes[1].reason.status, 409)
  assert.equal(
    (await store.readFile(project.id, 'owner', 'Main.lean')).content,
    '-- Replacement proof\n',
  )
  const deleted = await store.trash(project.id, 'owner', 'Main.lean')
  const reverse = await Promise.allSettled([
    store.deleteForever(deleted.trashId, 'owner'),
    store.restore(deleted.trashId, 'owner'),
  ])
  assert.equal(reverse[0].status, 'fulfilled')
  assert.equal(reverse[1].status, 'rejected')
  assert.equal(reverse[1].reason.status, 404)
})

test('permanent project deletion removes its history, snapshots, chats and runs while preserving other data', async (t) => {
  const { store, project, dataDir, request, chats, events, runtime } =
    await fixture(t)
  const other = await store.create('owner', {
    name: 'Other proofs',
    preset: 'lean',
  })
  await store.jobs.get(other.id)
  const chat = chats.create('owner', project.id, {
    title: 'Delete this history',
  })
  const job = events.create('owner', {
    projectId: project.id,
    chatId: chat.id,
    kind: 'agent',
  })
  chats.appendRun(chat.id, 'owner', job)
  events.append(job.id, 'message', 'Saved conversation')
  events.update(job.id, { status: 'completed' })
  await store.snapshot(project.id, 'owner', job.id)
  const otherRun = events.create('owner', {
    projectId: other.id,
    kind: 'check',
  })
  events.update(otherRun.id, { status: 'completed' })
  await store.snapshot(other.id, 'owner', otherRun.id)
  for (const id of [project.id, other.id]) {
    await fs.mkdir(path.join(dataDir, 'history', id), { recursive: true })
    await fs.writeFile(path.join(dataDir, 'history', id, 'saved'), id)
  }
  const file = await store.trash(project.id, 'owner', 'Main.lean')
  const outside = path.join(dataDir, 'outside.txt')
  await fs.writeFile(outside, 'Preserve external data')
  await fs.symlink(outside, path.join(project.root, 'external'))
  const archived = await store.trash(project.id, 'owner')
  const stopped = []
  runtime.stopProject = async (root) => {
    stopped.push(root)
  }
  const result = await request(`/api/trash/${archived.trashId}/delete-forever`)
  assert.equal(result.status, 200)
  assert.equal((await result.json()).deleted, true)
  assert(stopped.includes(project.root))
  assert(
    stopped.includes(path.join(dataDir, 'candidates', job.id, 'workspace')),
  )
  for (const deleted of [
    path.join(dataDir, 'projects', project.id),
    path.join(dataDir, 'history', project.id),
    path.join(dataDir, 'candidates', job.id),
    path.join(dataDir, 'trash', file.trashId),
    path.join(dataDir, 'trash', archived.trashId),
  ])
    await assert.rejects(fs.stat(deleted), { code: 'ENOENT' })
  assert.equal(await fs.readFile(outside, 'utf8'), 'Preserve external data')
  assert.equal(
    await fs.readFile(path.join(dataDir, 'history', other.id, 'saved'), 'utf8'),
    other.id,
  )
  assert(
    (
      await fs.stat(path.join(dataDir, 'candidates', otherRun.id))
    ).isDirectory(),
  )
  assert.equal(store.get(other.id, 'owner').name, 'Other proofs')
  assert.equal(events.getMetadata(otherRun.id, 'owner').status, 'completed')
  assert.throws(() => events.getMetadata(job.id, 'owner'), { status: 404 })
  assert.throws(() => chats.get(chat.id, 'owner'), { status: 404 })
  const recovered = new ChatStore({ dataDir, workspaces: store, events }).init()
  try {
    assert.deepEqual(recovered.listTrash('owner'), [])
  } finally {
    recovered.close()
  }
  assert.deepEqual(store.listTrash('owner'), [])
})

test('delete forever refuses unsafe trash directories and caches used by another workspace', async (t) => {
  const { store, project, dataDir, runtime } = await fixture(t)
  const receipt = await store.trash(project.id, 'owner', 'Main.lean')
  const original = path.join(dataDir, 'trash', receipt.trashId)
  const saved = path.join(dataDir, 'saved-trash')
  const outside = path.join(dataDir, 'outside')
  await fs.rename(original, saved)
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'content'), 'Preserve external content')
  await fs.symlink(outside, original)
  await assert.rejects(store.deleteForever(receipt.trashId, 'owner'), {
    status: 403,
  })
  await assert.rejects(store.restore(receipt.trashId, 'owner'), { status: 409 })
  assert.equal(store.listTrash('owner')[0].deleting, true)
  assert.equal(
    await fs.readFile(path.join(outside, 'content'), 'utf8'),
    'Preserve external content',
  )
  await fs.unlink(original)
  await fs.rename(saved, original)
  assert.equal(
    (await store.deleteForever(receipt.trashId, 'owner')).deleted,
    true,
  )
  const archived = await store.trash(project.id, 'owner')
  runtime.dependencies = new Map([['/another/workspace', project.root]])
  await assert.rejects(store.deleteForever(archived.trashId, 'owner'), {
    status: 409,
  })
  assert.equal(store.getTrash(archived.trashId, 'owner').recoverable, true)
  assert((await fs.stat(project.root)).isDirectory())
})

test('HTTP delete forever requires authentication, owner and archived receipt and removes chat transcripts', async (t) => {
  const { store, project, request, otherToken, chats, events } =
    await fixture(t)
  const receipt = await store.trash(project.id, 'owner', 'Main.lean')
  const endpoint = `/api/trash/${receipt.trashId}/delete-forever`
  assert.equal((await request(endpoint, {}, null)).status, 401)
  assert.equal((await request(endpoint, {}, otherToken)).status, 404)
  assert.equal((await request(endpoint, { unexpected: true })).status, 400)
  assert.equal(
    (await request(`/api/trash/${project.id}/delete-forever`)).status,
    404,
  )
  const active = events.create('owner', {
    projectId: project.id,
    kind: 'check',
  })
  assert.equal((await request(endpoint)).status, 409)
  events.update(active.id, { status: 'cancelled' })
  await store.restore(receipt.trashId, 'owner')
  assert.equal((await request(endpoint)).status, 409)
  const chat = chats.create('owner', project.id)
  const run = events.create('owner', {
    projectId: project.id,
    chatId: chat.id,
    kind: 'agent',
  })
  chats.appendRun(chat.id, 'owner', run)
  events.append(run.id, 'message', 'Delete this transcript')
  events.update(run.id, { status: 'completed' })
  const chatReceipt = chats.trash('owner', chat.id)
  assert(chatReceipt.sizeBytes > 0)
  assert.equal(
    (
      await request(
        `/api/trash/${chatReceipt.trashId}/delete-forever`,
        {},
        otherToken,
      )
    ).status,
    404,
  )
  assert.equal(
    (await request(`/api/trash/${chatReceipt.trashId}/delete-forever`)).status,
    200,
  )
  assert.throws(() => events.getMetadata(run.id, 'owner'), { status: 404 })
  chats.init()
  assert.deepEqual(chats.list('owner', project.id), [])
  assert.throws(() => chats.restore('owner', chatReceipt.trashId), {
    status: 404,
  })
})

test('project deletion measures and removes interrupted snapshots before their manifest exists', async (t) => {
  const { store, project, dataDir, runtime } = await fixture(t)
  const runId = 'interrupted-snapshot'
  const container = path.join(dataDir, 'candidates', runId)
  runtime.inheritDependencies = async () => {
    throw new Error('dependency registry write failed')
  }
  await assert.rejects(
    store.snapshot(project.id, 'owner', runId),
    /dependency registry write failed/,
  )
  assert.equal(
    await fs.readFile(path.join(container, 'workspace', 'Main.lean'), 'utf8'),
    (await store.readFile(project.id, 'owner', 'Main.lean')).content,
  )
  await assert.rejects(fs.stat(path.join(container, 'manifest.json')), {
    code: 'ENOENT',
  })
  const receipt = await store.trash(project.id, 'owner')
  assert.equal(
    receipt.sizeBytes,
    await storedDiskBytes([
      { directory: path.join(dataDir, 'projects'), name: project.id },
      { directory: path.join(dataDir, 'candidates'), name: runId },
      { directory: path.join(dataDir, 'trash'), name: receipt.trashId },
    ]),
  )
  assert.equal(
    (await store.deleteForever(receipt.trashId, 'owner')).deleted,
    true,
  )
  await assert.rejects(fs.stat(container), { code: 'ENOENT' })
})

test('HTTP deletion removes legacy incomplete candidates using owned run metadata and preserves unattributed source copies', async (t) => {
  const { store, project, dataDir, events, request, url, token } =
    await fixture(t)
  const run = events.create('owner', { projectId: project.id, kind: 'agent' })
  events.update(run.id, { status: 'failed' })
  for (const id of [run.id, 'unattributed']) {
    await fs.mkdir(path.join(dataDir, 'candidates', id, 'workspace'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(dataDir, 'candidates', id, 'workspace', 'Main.lean'),
      '-- Legacy partial source copy\n',
    )
  }
  const receipt = await (
    await request(`/api/projects/${project.id}/trash`)
  ).json()
  assert.equal(
    receipt.sizeBytes,
    await storedDiskBytes([
      { directory: path.join(dataDir, 'projects'), name: project.id },
      { directory: path.join(dataDir, 'candidates'), name: run.id },
      { directory: path.join(dataDir, 'trash'), name: receipt.trashId },
    ]),
  )
  const legacy = JSON.parse(
    store.db.prepare('SELECT data FROM trash WHERE id=?').get(receipt.trashId)
      .data,
  )
  delete legacy.sizeBytes
  store.db
    .prepare('UPDATE trash SET data=? WHERE id=?')
    .run(JSON.stringify(legacy), receipt.trashId)
  const listed = await fetch(`${url}/api/trash`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert.equal(listed.status, 200)
  assert.equal((await listed.json())[0].sizeBytes, receipt.sizeBytes)
  const deleted = await request(`/api/trash/${receipt.trashId}/delete-forever`)
  assert.equal(deleted.status, 200)
  await assert.rejects(fs.stat(path.join(dataDir, 'candidates', run.id)), {
    code: 'ENOENT',
  })
  assert.equal(
    await fs.readFile(
      path.join(
        dataDir,
        'candidates',
        'unattributed',
        'workspace',
        'Main.lean',
      ),
      'utf8',
    ),
    '-- Legacy partial source copy\n',
  )
})

test('trusted run IDs never override a candidate manifest or ownership marker for another project', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const other = await store.create('owner', {
    name: 'Other candidate owner',
    preset: 'lean',
  })
  await store.jobs.get(other.id)
  const runId = 'foreign-candidate'
  await store.snapshot(other.id, 'owner', runId)
  const receipt = await store.trash(project.id, 'owner')
  await assert.rejects(
    store.deleteForever(receipt.trashId, 'owner', { candidateRunIds: [runId] }),
    { status: 409 },
  )
  await fs.unlink(path.join(dataDir, 'candidates', runId, 'manifest.json'))
  await assert.rejects(
    store.deleteForever(receipt.trashId, 'owner', { candidateRunIds: [runId] }),
    { status: 409 },
  )
  assert.equal(store.getTrash(receipt.trashId, 'owner').recoverable, true)
  assert.equal(
    await fs.readFile(
      path.join(dataDir, 'candidates', runId, 'workspace', 'Main.lean'),
      'utf8',
    ),
    (await store.readFile(other.id, 'owner', 'Main.lean')).content,
  )
})

test('Delete All deletes confirmed projects, files, folders and chats while preserving live and newly trashed data', async (t) => {
  const f = await fixture(t)
  const archivedProject = await f.store.create('owner', {
    name: 'Archived batch project',
    preset: 'lean',
  })
  await f.store.jobs.get(archivedProject.id)
  const child = await f.store.trash(archivedProject.id, 'owner', 'Main.lean')
  const childChat = f.chats.trash(
    'owner',
    f.chats.create('owner', archivedProject.id).id,
  )
  const project = await f.store.trash(archivedProject.id, 'owner')
  await fs.mkdir(path.join(f.project.root, 'Old'))
  await fs.writeFile(
    path.join(f.project.root, 'Old', 'old.bin'),
    Buffer.from([1, 2, 3]),
  )
  const folder = await f.store.trash(f.project.id, 'owner', 'Old')
  const file = await f.store.trash(f.project.id, 'owner', 'Main.lean')
  const chat = f.chats.trash('owner', f.chats.create('owner', f.project.id).id)
  const selected = [child, childChat, folder, file, chat, project]
  await f.store.writeFile(
    f.project.id,
    'owner',
    'New.lean',
    '-- Preserve new trash\n',
    null,
  )
  const newer = await f.store.trash(f.project.id, 'owner', 'New.lean')
  await f.store.writeFile(
    f.project.id,
    'owner',
    'Main.lean',
    '-- Preserve live replacement\n',
    null,
  )
  const response = await f.request('/api/trash/delete-all', {
    trashIds: selected.map((item) => item.trashId),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(
    new Set(result.deletedTrashIds),
    new Set(selected.map((item) => item.trashId)),
  )
  assert.deepEqual(result.failures, [])
  assert.throws(() => f.store.get(archivedProject.id, 'owner'), { status: 404 })
  assert.throws(() => f.chats.getTrash(chat.trashId, 'owner'), { status: 404 })
  assert.deepEqual(
    f.store.listTrash('owner').map((item) => item.trashId),
    [newer.trashId],
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Main.lean')).content,
    '-- Preserve live replacement\n',
  )
  await f.store.restore(newer.trashId, 'owner')
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'New.lean')).content,
    '-- Preserve new trash\n',
  )
})

test('Delete All authenticates and validates every receipt before deleting any item', async (t) => {
  const f = await fixture(t)
  const original = await f.store.readFile(f.project.id, 'owner', 'Main.lean')
  const owned = await f.store.trash(f.project.id, 'owner', 'Main.lean')
  const other = await f.store.create('bob', {
    name: 'Other owner',
    preset: 'lean',
  })
  await f.store.jobs.get(other.id)
  const foreign = await f.store.trash(other.id, 'bob', 'Main.lean')
  assert.equal(
    (
      await f.request(
        '/api/trash/delete-all',
        { trashIds: [owned.trashId] },
        null,
      )
    ).status,
    401,
  )
  assert.equal(
    (
      await f.request('/api/trash/delete-all', {
        trashIds: [owned.trashId, foreign.trashId],
      })
    ).status,
    404,
  )
  for (const input of [
    {},
    { trashIds: 'all' },
    { trashIds: [null] },
    { trashIds: [owned.trashId, owned.trashId] },
    { trashIds: [owned.trashId], extra: true },
  ])
    assert.equal((await f.request('/api/trash/delete-all', input)).status, 400)
  assert.equal(f.store.getTrash(owned.trashId, 'owner').recoverable, true)
  assert.equal(f.store.getTrash(foreign.trashId, 'bob').recoverable, true)
  await f.store.restore(owned.trashId, 'owner')
  assert.equal(
    (
      await f.request(
        '/api/trash/delete-all',
        { trashIds: [foreign.trashId] },
        f.otherToken,
      )
    ).status,
    200,
  )
  assert.equal(
    (await f.request('/api/trash/delete-all', { trashIds: [owned.trashId] }))
      .status,
    409,
  )
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Main.lean')).hash,
    original.hash,
  )
})

test('Delete All reports blocked items, continues independent deletions and supports retry', async (t) => {
  const f = await fixture(t)
  const blocked = await f.store.trash(f.project.id, 'owner', 'Main.lean')
  const active = f.events.create('owner', {
    kind: 'check',
    projectId: f.project.id,
  })
  const other = await f.store.create('owner', {
    name: 'Independent deletion',
    preset: 'lean',
  })
  await f.store.jobs.get(other.id)
  const allowed = await f.store.trash(other.id, 'owner')
  const response = await f.request('/api/trash/delete-all', {
    trashIds: [blocked.trashId, allowed.trashId],
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.deepEqual(result.deletedTrashIds, [allowed.trashId])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].trashId, blocked.trashId)
  assert.match(result.failures[0].error, /Stop active/)
  assert.equal(f.store.getTrash(blocked.trashId, 'owner').recoverable, true)
  assert.equal(f.events.getMetadata(active.id, 'owner').status, 'queued')
  f.events.updateMetadata(active.id, { status: 'cancelled' })
  const retried = await f.request('/api/trash/delete-all', {
    trashIds: [blocked.trashId],
  })
  assert.equal(retried.status, 200)
  assert.deepEqual(await retried.json(), {
    deletedTrashIds: [blocked.trashId],
    failures: [],
  })
})

test('Delete All includes more than 100 file and chat receipts in its confirmation list', async (t) => {
  const f = await fixture(t)
  const original = await f.store.readFile(f.project.id, 'owner', 'Main.lean')
  for (let i = 0; i < 102; i++) {
    const filename = `Batch${i}.lean`
    await fs.writeFile(path.join(f.project.root, filename), '-- Old proof\n')
    await f.store.trash(f.project.id, 'owner', filename)
    f.chats.trash('owner', f.chats.create('owner', f.project.id).id)
  }
  const listed = await fetch(f.url + '/api/trash', {
    headers: { Authorization: `Bearer ${f.token}` },
  })
  assert.equal(listed.status, 200)
  const items = await listed.json()
  assert.equal(items.length, 204)
  assert.equal(items.filter((item) => item.kind === 'file').length, 102)
  assert.equal(items.filter((item) => item.kind === 'chat').length, 102)
  const response = await f.request('/api/trash/delete-all', {
    trashIds: items.map((item) => item.trashId),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.deletedTrashIds.length, 204)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(f.store.listTrash('owner'), [])
  assert.deepEqual(f.chats.listTrash('owner'), [])
  assert.equal(f.store.get(f.project.id, 'owner').status, 'ready')
  assert.equal(
    (await f.store.readFile(f.project.id, 'owner', 'Main.lean')).hash,
    original.hash,
  )
})
