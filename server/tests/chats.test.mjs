import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ChatStore } from '../chats.mjs'
import { EventStore } from '../events.mjs'
import { createStudio } from '../studio.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-chats-'))
  const projects = new Map([
    ['p', { id: 'p', name: 'Proofs', owner: 'alice' }],
    ['q', { id: 'q', name: 'Other proofs', owner: 'alice' }],
    ['bob-p', { id: 'bob-p', name: 'Bob proofs', owner: 'bob' }],
  ])
  const workspaces = { get(id, owner) { const project = projects.get(id); if (!project || project.owner !== owner || project.archived) throw Object.assign(new Error('Project not found'), { status: 404 }); return project } }
  const events = new EventStore(dataDir)
  let chats = new ChatStore({ dataDir, workspaces, events }); chats.init()
  t.after(async () => { chats.close(); events.close(); await fs.rm(dataDir, { recursive: true, force: true }) })
  const run = (chat, fields = {}) => {
    const job = events.create('alice', { kind: 'agent', projectId: chat.projectId, chatId: chat.id, prompt: 'First task', mode: 'repair', ...fields })
    chats.appendRun(chat.id, 'alice', job)
    return job
  }
  return { get chats() { return chats }, events, projects, dataDir, run, restart() { chats.close(); chats = new ChatStore({ dataDir, workspaces, events }); chats.init(); return chats } }
}

test('chat references retain authoritative run history and isolate owners and projects', async t => {
  const f = await fixture(t), chat = f.chats.create('alice', 'p')
  assert.equal(chat.title, 'New chat'); assert.equal(chat.runCount, 0)
  const job = f.run(chat, { prompt: 'Repair  the\nfirst proof', snapshot: { root: '/private/snapshot' } })
  assert.equal(f.chats.get(chat.id, 'alice').title, 'Repair the first proof')
  f.events.update(job.id, { message: 'The repaired proof checks.', status: 'completed' })
  assert.equal(f.chats.history(chat.id, 'alice').runs[0].message, 'The repaired proof checks.')
  assert.equal(f.chats.get(chat.id, 'alice').status, 'completed')
  f.chats.appendRun(chat.id, 'alice', job)
  assert.equal(f.chats.get(chat.id, 'alice').runCount, 1)
  assert.throws(() => f.chats.get(chat.id, 'bob'), { status: 404 })
  assert.throws(() => f.chats.list('bob', 'p'), { status: 404 })
  const other = f.chats.create('alice', 'q')
  assert.throws(() => f.chats.appendRun(other.id, 'alice', job), { status: 404 })
  const sameProject = f.chats.create('alice', 'p')
  assert.throws(() => f.chats.appendRun(sameProject.id, 'alice', job), { status: 404 })
  const check = f.events.create('alice', { kind: 'check', projectId: 'p' })
  assert.throws(() => f.chats.appendRun(chat.id, 'alice', check), { status: 404 })
  const metadata = f.chats.db.prepare('SELECT data FROM chats WHERE id=?').get(chat.id).data
  assert(!metadata.includes('repaired proof checks')); assert(!metadata.includes('/private/snapshot'))
  assert.equal(f.chats.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get().count, 1)
})

test('an older chat with a new turn remains visible beyond the recent-chat limit', async t => {
  const f = await fixture(t), old = f.chats.create('alice', 'p')
  for (let index = 0; index < 100; index++) f.chats.create('alice', 'p')
  f.chats.db.prepare("UPDATE chats SET data=json_set(data,'$.updatedAt',?)").run('2020-01-01T00:00:00.000Z')
  const job = f.run(old, { prompt: 'Continue this older conversation.' })
  const listed = f.chats.list('alice', 'p')
  assert.equal(listed.length, 100)
  assert.equal(listed[0].id, old.id)
  assert.equal(listed[0].status, job.status)
  assert.equal(f.restart().list('alice', 'p')[0].id, old.id)
})

test('chat titles validate input and explicit names persist across new turns and restarts', async t => {
  const f = await fixture(t)
  for (const input of [null, [], { title: '' }, { title: 'x'.repeat(121) }, { title: 'bad\ntitle' }]) assert.throws(() => f.chats.create('alice', 'p', input), { status: 400 })
  const chat = f.chats.create('alice', 'p', { title: '  Geometry session  ' })
  const first = f.run(chat, { prompt: 'This prompt should not change the name.' })
  f.events.update(first.id, { status: 'completed', message: 'First result' })
  f.chats.rename(chat.id, 'alice', { title: 'Later name' })
  const second = f.run(chat, { prompt: 'Continue.', mode: 'prove' })
  f.events.update(second.id, { status: 'completed', message: 'Second result' })
  assert.throws(() => f.chats.rename(chat.id, 'bob', { title: 'Stolen' }), { status: 404 })
  assert.throws(() => f.chats.rename(chat.id, 'alice', { title: null }), { status: 400 })
  const restarted = f.restart()
  assert.equal(restarted.get(chat.id, 'alice').title, 'Later name')
  assert.equal(restarted.get(chat.id, 'alice').lastMode, 'prove')
  assert.deepEqual(restarted.history(chat.id, 'alice').runs.map(run => [run.id, run.message]), [[first.id, 'First result'], [second.id, 'Second result']])
})

test('startup groups earlier agent tasks once without rewriting jobs or exposing archived projects', async t => {
  const f = await fixture(t)
  const jobs = [
    f.events.create('alice', { kind: 'agent', projectId: 'p', prompt: 'First earlier task' }),
    f.events.create('alice', { kind: 'agent', projectId: 'p', prompt: 'Second earlier task' }),
    f.events.create('alice', { kind: 'agent', projectId: 'q', prompt: 'Separate project' }),
    f.events.create('bob', { kind: 'agent', projectId: 'bob-p', prompt: 'Private Bob task' }),
    f.events.create('alice', { kind: 'agent', projectId: 'p', chatId: 'obsolete-chat', prompt: 'Recover orphan reference' }),
  ]
  jobs.forEach(job => f.events.update(job.id, { status: 'completed' }))
  f.events.create('alice', { kind: 'check', projectId: 'p' })
  f.projects.get('q').archived = true
  const migrated = f.restart(), chat = migrated.list('alice', 'p')[0]
  assert.equal(chat.title, 'Earlier tasks'); assert.equal(chat.runCount, 3)
  assert.deepEqual(migrated.history(chat.id, 'alice').runs.map(run => run.id), [jobs[0].id, jobs[1].id, jobs[4].id])
  assert.equal(migrated.list('bob', 'bob-p')[0].runCount, 1)
  assert.equal(f.events.get(jobs[0].id, 'alice').chatId, undefined)
  assert.equal(f.events.get(jobs[4].id, 'alice').chatId, 'obsolete-chat')
  assert.equal(f.restart().list('alice', 'p').length, 1)
  assert.equal(f.chats.get(chat.id, 'alice').runCount, 3)
  assert.equal(f.chats.db.prepare("SELECT COUNT(*) AS count FROM chats WHERE project='q'").get().count, 0)
})

test('recoverable chat deletion preserves history and protects active chats and archived projects', async t => {
  const f = await fixture(t), chat = f.chats.create('alice', 'p', { title: 'Keep these proofs' })
  const job = f.run(chat)
  for (const status of ['queued', 'running', 'verifying']) {
    f.events.update(job.id, { status })
    assert.throws(() => f.chats.trash('alice', chat.id), { status: 409 })
  }
  f.events.update(job.id, { status: 'completed', message: 'Preserved answer' })
  const receipt = f.chats.trash('alice', chat.id)
  assert.equal(receipt.kind, 'chat'); assert.equal(receipt.name, 'Keep these proofs'); assert.equal(receipt.projectName, 'Proofs')
  assert.deepEqual(f.chats.list('alice', 'p'), [])
  assert.throws(() => f.chats.history(chat.id, 'alice'), { status: 404 })
  assert.throws(() => f.chats.restore('bob', receipt.trashId), { status: 404 })
  f.restart()
  assert.equal(f.chats.listTrash('alice')[0].trashId, receipt.trashId)
  f.projects.get('p').archived = true
  assert.throws(() => f.chats.restore('alice', receipt.trashId), { status: 404 })
  assert.equal(f.chats.listTrash('alice').length, 1)
  f.projects.get('p').archived = false
  assert.equal(f.chats.restore('alice', receipt.trashId).restored, true)
  assert.equal(f.chats.history(chat.id, 'alice').runs[0].message, 'Preserved answer')
  assert.deepEqual(f.chats.listTrash('alice'), [])
})

async function httpFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-chat-http-'))
  const runtime = {
    async init() {}, info: () => ({ ready: true }), templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }], templateRoot: () => null,
    async prepareToolchain() {}, async shutdown() {}, spawn() { assert.fail('HTTP chat tests must not launch workers') },
    async run(root, args) {
      if (args[0] === 'git' && args.includes('init')) await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse')) return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true }); await fs.writeFile(path.join(root, 'lake-manifest.json'), '{"packages":[]}')
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const config = { defaultModel: 'test', models: [{ id: 'test' }], provider: { LEMEX_API_KEY: 'test-no-provider-call' }, lemex: {}, redact: String }
  const studio = await createStudio({ dataDir, runtime, config }); studio.agents.maxConcurrent = 0
  await new Promise(resolve => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await studio.close(); await fs.rm(dataDir, { recursive: true, force: true }) })
  const project = await studio.workspaces.create('owner', { name: 'HTTP proofs', preset: 'lean' }); await studio.workspaces.jobs.get(project.id)
  const token = (await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')).trim(), bobToken = 'bob-chat-token'
  studio.auth.users.push({ id: 'bob', name: 'Bob', tokenHash: createHash('sha256').update(bobToken).digest('hex') })
  await fs.writeFile(path.join(dataDir, 'auth', 'users.json'), JSON.stringify(studio.auth.users))
  const url = `http://127.0.0.1:${studio.server.address().port}`
  const request = (endpoint, { method = 'GET', body, access = token } = {}) => fetch(url + endpoint, { method, signal: AbortSignal.timeout(5000), headers: { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { ...studio, project, request, bobToken }
}

test('chat HTTP APIs enforce scope, create turns with attachments, and redact private workspace fields', async t => {
  const f = await httpFixture(t), endpoint = `/api/projects/${f.project.id}/chats`
  assert.equal((await f.request(endpoint, { access: null })).status, 401)
  assert.equal((await f.request(endpoint, { access: f.bobToken })).status, 404)
  const created = await f.request(endpoint, { method: 'POST', body: {} }); assert.equal(created.status, 201)
  const chat = await created.json(), input = { mode: 'repair', prompt: 'Repair this theorem.', files: ['Main.lean'], liveEdits: false }
  assert.equal((await f.request(`/api/chats/${chat.id}/runs`, { method: 'POST', body: { ...input, chatId: 'other' } })).status, 400)
  assert.equal((await f.request(`/api/chats/${chat.id}/runs`, { method: 'POST', body: { ...input, files: ['.env'] } })).status, 400)
  const response = await f.request(`/api/chats/${chat.id}/runs`, { method: 'POST', body: input }); assert.equal(response.status, 202)
  const run = await response.json()
  assert.equal(run.chatId, chat.id); assert.equal(run.projectId, f.project.id); assert.deepEqual(run.files, ['Main.lean'])
  f.events.update(run.id, { status: 'completed', message: 'Saved result', snapshot: { root: '/private/snapshot' }, verificationRoot: '/private/verification' })
  const history = await (await f.request(`/api/chats/${chat.id}`)).json()
  assert.equal(history.chat.title, input.prompt); assert.equal(history.runs[0].message, 'Saved result')
  for (const key of ['owner', 'snapshot', 'verificationRoot']) assert.equal(key in history.runs[0], false)
  assert.equal((await f.request(`/api/chats/${chat.id}`, { access: f.bobToken })).status, 404)
  const renamed = await f.request(`/api/chats/${chat.id}`, { method: 'PATCH', body: { title: 'Renamed session' } }); assert.equal((await renamed.json()).title, 'Renamed session')
  const other = await f.workspaces.create('owner', { preset: 'lean' }); await f.workspaces.jobs.get(other.id)
  assert.equal((await f.request(`/api/projects/${other.id}/runs`, { method: 'POST', body: { ...input, chatId: chat.id } })).status, 404)
})

test('HTTP Trash merges chat and file recovery receipts and retains conversations after restore', async t => {
  const f = await httpFixture(t)
  const chat = f.chats.create('owner', f.project.id, { title: 'Saved conversation' })
  const job = f.events.create('owner', { kind: 'agent', projectId: f.project.id, chatId: chat.id, prompt: 'Proof task' }); f.chats.appendRun(chat.id, 'owner', job)
  assert.equal((await f.request(`/api/chats/${chat.id}/trash`, { method: 'POST', body: {} })).status, 409)
  f.events.update(job.id, { status: 'completed', message: 'Keep this message' })
  const fileReceipt = await f.workspaces.trash(f.project.id, 'owner', 'Main.lean')
  const deletion = await f.request(`/api/chats/${chat.id}/trash`, { method: 'POST', body: {} }); assert.equal(deletion.status, 200)
  const receipt = await deletion.json(), trash = await (await f.request('/api/trash')).json()
  assert.deepEqual(new Set(trash.map(entry => entry.kind)), new Set(['chat', 'file']))
  assert.equal((await f.request(`/api/chats/${chat.id}`)).status, 404)
  assert.equal((await f.request(`/api/trash/${receipt.trashId}/restore`, { method: 'POST', body: {}, access: f.bobToken })).status, 404)
  assert.equal((await f.request(`/api/trash/${receipt.trashId}/restore`, { method: 'POST', body: {} })).status, 200)
  assert.equal((await (await f.request(`/api/chats/${chat.id}`)).json()).runs[0].message, 'Keep this message')
  assert.deepEqual((await (await f.request('/api/trash')).json()).map(entry => entry.trashId), [fileReceipt.trashId])
})
