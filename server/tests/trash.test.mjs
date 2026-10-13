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

const TOOLCHAIN = 'leanprover/lean4:v4.34.1'

class FakeRuntime {
  children = []
  async init() {}
  info() { return { ready: true } }
  templates() { return [{ id: 'lean', toolchain: TOOLCHAIN, ready: true }] }
  templateRoot() { return null }
  async prepareToolchain() {}
  async run(root, args) {
    if (args[0] === 'git' && args.includes('init')) await fs.mkdir(path.join(root, '.git'), { recursive: true })
    if (args[0] === 'git' && args.includes('rev-parse')) return { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'lake' && args[1] === 'update') {
      await fs.mkdir(path.join(root, '.lake'), { recursive: true })
      await fs.writeFile(path.join(root, 'lake-manifest.json'), '{"packages":[]}')
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  spawn() {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false
    child.kill = () => { if (child.killed) return; child.killed = true; queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0) }) }
    this.children.push(child)
    return child
  }
  async shutdown() { this.children.forEach(child => child.kill()) }
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-trash-')), runtime = new FakeRuntime()
  const config = { defaultModel: 'test', models: [{ id: 'test' }], provider: {}, lemex: {}, redact: String }
  const studio = await createStudio({ dataDir, runtime, config })
  await new Promise(resolve => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await studio.close(); await fs.rm(dataDir, { recursive: true, force: true }) })
  const project = await studio.workspaces.create('owner', { name: 'My proofs', preset: 'lean' })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  const token = (await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')).trim()
  const otherToken = 'bob-test-token'
  studio.auth.users.push({ id: 'bob', name: 'Bob', tokenHash: createHash('sha256').update(otherToken).digest('hex') })
  await fs.writeFile(path.join(dataDir, 'auth', 'users.json'), JSON.stringify(studio.auth.users))
  const url = `http://127.0.0.1:${studio.server.address().port}`
  const request = (endpoint, body = {}, access = token) => fetch(url + endpoint, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { ...(access ? { Authorization: `Bearer ${access}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { ...studio, store: studio.workspaces, project, runtime, dataDir, url, token, otherToken, request }
}

test('file and binary folder deletion is recoverable without editing or truncating content', async t => {
  const { store, project, dataDir } = await fixture(t)
  const original = await store.readFile(project.id, 'owner', 'Main.lean')
  const deleted = await store.trash(project.id, 'owner', 'Main.lean')
  assert.equal(deleted.kind, 'file'); assert.equal(deleted.recoverable, true)
  assert.equal(deleted.projectName, 'My proofs'); assert.equal(deleted.name, 'Main.lean')
  await assert.rejects(store.readFile(project.id, 'owner', 'Main.lean'), { status: 404 })
  assert.equal(await fs.readFile(path.join(dataDir, 'trash', deleted.trashId, 'content'), 'utf8'), original.content)
  assert.equal((await store.restore(deleted.trashId, 'owner')).restored, true)
  assert.equal((await store.readFile(project.id, 'owner', 'Main.lean')).hash, original.hash)
  await fs.mkdir(path.join(project.root, 'Examples', 'nested'), { recursive: true })
  const bytes = Buffer.from([0, 128, 255, 1, 0])
  await fs.writeFile(path.join(project.root, 'Examples', 'nested', 'data.bin'), bytes)
  await fs.writeFile(path.join(project.root, 'Examples', 'Proof.lean'), 'example : True := by trivial\n')
  const folder = await store.trash(project.id, 'owner', 'Examples')
  assert.equal(folder.kind, 'folder')
  await assert.rejects(fs.stat(path.join(project.root, 'Examples')), { code: 'ENOENT' })
  await store.restore(folder.trashId, 'owner')
  assert.deepEqual(await fs.readFile(path.join(project.root, 'Examples', 'nested', 'data.bin')), bytes)
  assert.equal(await fs.readFile(path.join(project.root, 'Examples', 'Proof.lean'), 'utf8'), 'example : True := by trivial\n')
  assert.deepEqual(store.listTrash('owner'), [])
});

test('restore refuses collisions and other owners while preserving both old and new files', async t => {
  const { store, project, dataDir } = await fixture(t)
  const before = (await store.readFile(project.id, 'owner', 'Main.lean')).content
  const receipt = await store.trash(project.id, 'owner', 'Main.lean')
  await store.writeFile(project.id, 'owner', 'Main.lean', 'replacement text\n', null)
  await assert.rejects(store.restore(receipt.trashId, 'owner'), { status: 409 })
  await assert.rejects(store.restore(receipt.trashId, 'bob'), { status: 404 })
  assert.equal((await store.readFile(project.id, 'owner', 'Main.lean')).content, 'replacement text\n')
  assert.equal(await fs.readFile(path.join(dataDir, 'trash', receipt.trashId, 'content'), 'utf8'), before)
  assert.equal(store.listTrash('owner').length, 1)
  assert.deepEqual(store.listTrash('bob'), [])
  await fs.mkdir(path.join(project.root, 'Folder'))
  await fs.writeFile(path.join(project.root, 'Folder', 'original.txt'), 'original')
  const folder = await store.trash(project.id, 'owner', 'Folder')
  await fs.mkdir(path.join(project.root, 'Folder'))
  await fs.writeFile(path.join(project.root, 'Folder', 'replacement.txt'), 'replacement')
  await assert.rejects(store.restore(folder.trashId, 'owner'), { status: 409 })
  assert.equal(await fs.readFile(path.join(project.root, 'Folder', 'replacement.txt'), 'utf8'), 'replacement')
});

test('trash denies traversal, credentials, readonly dependencies, and symlink escapes', async t => {
  const { store, project, dataDir } = await fixture(t)
  const outside = path.join(dataDir, 'outside.txt')
  await fs.writeFile(outside, 'outside data')
  await fs.symlink(outside, path.join(project.root, 'link.txt'))
  await fs.symlink(dataDir, path.join(project.root, 'escape'))
  for (const filename of ['', '.', '/', '..', '../outside.txt', '.git', '.git/config', '.lake', '.lake/packages/mathlib/Mathlib.lean', '.env', '.env.local', '.lemex', 'escape/outside.txt', 'link.txt']) await assert.rejects(store.trash(project.id, 'owner', filename))
  await fs.mkdir(path.join(project.root, 'Protected'))
  await fs.writeFile(path.join(project.root, 'Protected', '.env'), 'private')
  await assert.rejects(store.trash(project.id, 'owner', 'Protected'), { status: 403 })
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside data')
  assert.equal(await fs.readFile(path.join(project.root, 'Protected', '.env'), 'utf8'), 'private')
  assert.equal(store.list('owner').length, 1)
});

test('project archive hides normal access and retains cache roots and failed project metadata', async t => {
  const { store, project, runtime } = await fixture(t)
  const cache = path.join(project.root, '.lake', 'packages', 'shared', 'Source.lean')
  await fs.mkdir(path.dirname(cache), { recursive: true }); await fs.writeFile(cache, '-- Dependency cache\n')
  runtime.prepareToolchain = async () => { throw new Error('temporary preparation failure') }
  await store.prepare(project.id, 'owner'); await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'owner').status, 'error')
  const receipt = await store.trash(project.id, 'owner')
  assert.equal(receipt.kind, 'project'); assert.equal(receipt.path, null)
  assert.deepEqual(store.list('owner'), [])
  assert.throws(() => store.get(project.id, 'owner'), { status: 404 })
  await assert.rejects(store.readFile(project.id, 'owner', 'Main.lean'), { status: 404 })
  assert.equal(await fs.readFile(cache, 'utf8'), '-- Dependency cache\n')
  await assert.rejects(store.restore(receipt.trashId, 'bob'), { status: 404 })
  await store.restore(receipt.trashId, 'owner')
  assert.equal(store.get(project.id, 'owner').status, 'error')
  assert.equal(store.list('owner')[0].id, project.id)
  assert.equal((await store.restore(receipt.trashId, 'owner')).restored, true)
});

test('restart recovers trash receipts and interrupted move or restore metadata', async t => {
  const { store, project, dataDir, runtime } = await fixture(t)
  const original = (await store.readFile(project.id, 'owner', 'Main.lean')).content
  const receipt = await store.trash(project.id, 'owner', 'Main.lean')
  const record = JSON.parse(store.db.prepare('SELECT data FROM trash WHERE id=?').get(receipt.trashId).data)
  record.state = 'moving'; store.db.prepare('UPDATE trash SET data=? WHERE id=?').run(JSON.stringify(record), receipt.trashId)
  store.close(); store.db = null
  const restarted = await new WorkspaceStore({ dataDir, runtime }).init()
  try {
    assert.equal(restarted.listTrash('owner')[0].trashId, receipt.trashId)
    await restarted.restore(receipt.trashId, 'owner')
    record.state = 'restoring'; restarted.db.prepare('UPDATE trash SET data=? WHERE id=?').run(JSON.stringify(record), receipt.trashId)
  } finally { restarted.close() }
  const recovered = await new WorkspaceStore({ dataDir, runtime }).init()
  try {
    assert.deepEqual(recovered.listTrash('owner'), [])
    assert.equal((await recovered.readFile(project.id, 'owner', 'Main.lean')).content, original)
    assert.equal((await recovered.restore(receipt.trashId, 'owner')).restored, true)
  } finally { recovered.close() }
});

test('HTTP trash and restore enforce authentication, owners, and active check or agent guards', async t => {
  const { store, project, events, request, otherToken, url, token, runtime } = await fixture(t)
  const endpoint = `/api/projects/${project.id}/trash`
  assert.equal((await request(endpoint, { path: 'Main.lean' }, null)).status, 401)
  assert.equal((await request(endpoint, { path: 'Main.lean' }, otherToken)).status, 404)
  assert.equal((await request(endpoint, { path: null })).status, 400)
  await store.writeFile(project.id, 'owner', 'Restore.lean', '-- Keep this proof\n', null)
  const receipt = await (await request(endpoint, { path: 'Restore.lean' })).json()
  for (const kind of ['agent', 'check']) {
    const job = events.create('owner', { projectId: project.id, kind })
    assert.equal((await request(endpoint, { path: 'Main.lean' })).status, 409)
    assert.equal((await request(`/api/trash/${receipt.trashId}/restore`)).status, 409)
    events.update(job.id, { status: 'cancelled' })
  }
  assert.equal((await request(`/api/trash/${receipt.trashId}/restore`, {}, otherToken)).status, 404)
  assert.equal((await request(`/api/trash/${receipt.trashId}/restore`)).status, 200)
  const binary = await store.trash(project.id, 'owner', 'Restore.lean')
  let release
  const gate = new Promise(resolve => { release = resolve })
  runtime.prepareToolchain = () => gate
  await store.prepare(project.id, 'owner')
  try {
    assert.equal((await request(endpoint)).status, 409)
    assert.equal((await request(`/api/trash/${binary.trashId}/restore`)).status, 409)
  } finally { release(); await store.jobs.get(project.id) }
  const listed = await (await fetch(`${url}/api/trash`, { headers: { Authorization: `Bearer ${token}` } })).json()
  assert.equal(listed[0].trashId, binary.trashId)
  assert.equal(listed[0].projectName, 'My proofs'); assert.equal(listed[0].name, 'Restore.lean')
});

test('restart removes only recognized empty folder restore reservations', async t => {
  const { store, project, dataDir, runtime } = await fixture(t)
  const receipts = []
  for (const name of ['Recognized', 'UserFiles', 'Unknown']) {
    await fs.mkdir(path.join(project.root, name))
    await fs.writeFile(path.join(project.root, name, 'Original.lean'), `-- ${name} original\n`)
    const receipt = await store.trash(project.id, 'owner', name)
    await fs.mkdir(path.join(project.root, name))
    const reserved = await fs.lstat(path.join(project.root, name))
    const record = JSON.parse(store.db.prepare('SELECT data FROM trash WHERE id=?').get(receipt.trashId).data)
    record.state = 'restoring'
    if (name !== 'Unknown') record.reserved = { dev: reserved.dev, ino: reserved.ino }
    if (name === 'UserFiles') await fs.writeFile(path.join(project.root, name, 'User.lean'), '-- Keep user data\n')
    store.db.prepare('UPDATE trash SET data=? WHERE id=?').run(JSON.stringify(record), receipt.trashId)
    receipts.push(receipt)
  }
  store.close(); store.db = null
  const restarted = await new WorkspaceStore({ dataDir, runtime }).init()
  try {
    await assert.rejects(fs.stat(path.join(project.root, 'Recognized')), { code: 'ENOENT' })
    await restarted.restore(receipts[0].trashId, 'owner')
    assert.equal(await fs.readFile(path.join(project.root, 'Recognized', 'Original.lean'), 'utf8'), '-- Recognized original\n')
    for (const receipt of receipts.slice(1)) await assert.rejects(restarted.restore(receipt.trashId, 'owner'), { status: 409 })
    assert.equal(await fs.readFile(path.join(project.root, 'UserFiles', 'User.lean'), 'utf8'), '-- Keep user data\n')
    assert.equal((await fs.stat(path.join(project.root, 'Unknown'))).isDirectory(), true)
    assert.equal(restarted.listTrash('owner').length, 2)
  } finally { restarted.close() }
});

test('archiving a project closes its Lean socket and restore makes it accessible again', async t => {
  const { request, project, url, token, runtime } = await fixture(t)
  const ws = new WebSocket(url.replace('http:', 'ws:') + `/websocket/${project.id}`, { headers: { Authorization: `Bearer ${token}` } })
  t.after(() => ws.terminate())
  await once(ws, 'open')
  const closed = once(ws, 'close')
  const archived = await request(`/api/projects/${project.id}/trash`)
  assert.equal(archived.status, 200)
  const receipt = await archived.json()
  assert.equal((await closed)[0], 1001)
  await new Promise(setImmediate)
  assert.equal(runtime.children[0].killed, true)
  assert.equal((await fetch(`${url}/api/projects/${project.id}`, { headers: { Authorization: `Bearer ${token}` } })).status, 404)
  assert.equal((await request(`/api/trash/${receipt.trashId}/restore`)).status, 200)
  assert.equal((await fetch(`${url}/api/projects/${project.id}`, { headers: { Authorization: `Bearer ${token}` } })).status, 200)
});
