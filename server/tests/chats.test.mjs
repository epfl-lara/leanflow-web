import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ChatStore } from '../chats.mjs'
import { EventStore } from '../events.mjs'
import { createStudio } from '../studio.mjs'

async function fixture(t, titleGenerator) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-chats-'))
  const projects = new Map([
    ['p', { id: 'p', name: 'Proofs', owner: 'alice' }],
    ['q', { id: 'q', name: 'Other proofs', owner: 'alice' }],
    ['bob-p', { id: 'bob-p', name: 'Bob proofs', owner: 'bob' }],
  ])
  const workspaces = {
    get(id, owner) {
      const project = projects.get(id)
      if (!project || project.owner !== owner || project.archived)
        throw Object.assign(new Error('Project not found'), { status: 404 })
      return project
    },
  }
  const events = new EventStore(dataDir)
  let chats = new ChatStore({ dataDir, workspaces, events, titleGenerator })
  chats.init()
  t.after(async () => {
    chats.close()
    events.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const run = (chat, fields = {}) => {
    const job = events.create('alice', {
      kind: 'agent',
      projectId: chat.projectId,
      chatId: chat.id,
      prompt: 'First task',
      mode: 'repair',
      ...fields,
    })
    chats.appendRun(chat.id, 'alice', job)
    return job
  }
  return {
    get chats() {
      return chats
    },
    events,
    projects,
    dataDir,
    run,
    restart() {
      chats.close()
      chats = new ChatStore({ dataDir, workspaces, events, titleGenerator })
      chats.init()
      return chats
    },
  }
}

test('chat references retain authoritative run history and isolate owners and projects', async (t) => {
  const f = await fixture(t),
    chat = f.chats.create('alice', 'p')
  assert.equal(chat.title, 'New chat')
  assert.equal(chat.runCount, 0)
  const job = f.run(chat, {
    prompt: 'Repair  the\nfirst proof',
    snapshot: { root: '/private/snapshot' },
  })
  assert.equal(f.chats.get(chat.id, 'alice').title, 'Repair the first proof')
  f.events.update(job.id, {
    message: 'The repaired proof checks.',
    status: 'completed',
  })
  assert.equal(
    f.chats.history(chat.id, 'alice').runs[0].message,
    'The repaired proof checks.',
  )
  assert.equal(f.chats.get(chat.id, 'alice').status, 'completed')
  f.chats.appendRun(chat.id, 'alice', job)
  assert.equal(f.chats.get(chat.id, 'alice').runCount, 1)
  assert.throws(() => f.chats.get(chat.id, 'bob'), { status: 404 })
  assert.throws(() => f.chats.list('bob', 'p'), { status: 404 })
  const other = f.chats.create('alice', 'q')
  assert.throws(() => f.chats.appendRun(other.id, 'alice', job), {
    status: 404,
  })
  const sameProject = f.chats.create('alice', 'p')
  assert.throws(() => f.chats.appendRun(sameProject.id, 'alice', job), {
    status: 404,
  })
  const check = f.events.create('alice', { kind: 'check', projectId: 'p' })
  assert.throws(() => f.chats.appendRun(chat.id, 'alice', check), {
    status: 404,
  })
  const metadata = f.chats.db
    .prepare('SELECT data FROM chats WHERE id=?')
    .get(chat.id).data
  assert(!metadata.includes('repaired proof checks'))
  assert(!metadata.includes('/private/snapshot'))
  assert.equal(
    f.chats.db.prepare('SELECT COUNT(*) AS count FROM chat_runs').get().count,
    1,
  )
})

test('an older chat with a new turn remains visible beyond the recent-chat limit', async (t) => {
  const f = await fixture(t),
    old = f.chats.create('alice', 'p')
  for (let index = 0; index < 100; index++) f.chats.create('alice', 'p')
  f.chats.db
    .prepare("UPDATE chats SET data=json_set(data,'$.updatedAt',?)")
    .run('2020-01-01T00:00:00.000Z')
  const job = f.run(old, { prompt: 'Continue this older conversation.' })
  const listed = f.chats.list('alice', 'p')
  assert.equal(listed.length, 100)
  assert.equal(listed[0].id, old.id)
  assert.equal(listed[0].status, job.status)
  assert.equal(f.restart().list('alice', 'p')[0].id, old.id)
})

test('chat titles validate input and explicit names persist across new turns and restarts', async (t) => {
  const f = await fixture(t)
  for (const input of [
    null,
    [],
    { title: '' },
    { title: 'x'.repeat(121) },
    { title: 'bad\ntitle' },
  ])
    assert.throws(() => f.chats.create('alice', 'p', input), { status: 400 })
  const chat = f.chats.create('alice', 'p', { title: '  Geometry session  ' })
  const first = f.run(chat, {
    prompt: 'This prompt should not change the name.',
  })
  f.events.update(first.id, { status: 'completed', message: 'First result' })
  f.chats.rename(chat.id, 'alice', { title: 'Later name' })
  const second = f.run(chat, { prompt: 'Continue.', mode: 'prove' })
  f.events.update(second.id, { status: 'completed', message: 'Second result' })
  assert.throws(() => f.chats.rename(chat.id, 'bob', { title: 'Stolen' }), {
    status: 404,
  })
  assert.throws(() => f.chats.rename(chat.id, 'alice', { title: null }), {
    status: 400,
  })
  const restarted = f.restart()
  assert.equal(restarted.get(chat.id, 'alice').title, 'Later name')
  assert.equal(restarted.get(chat.id, 'alice').lastMode, 'prove')
  assert.deepEqual(
    restarted
      .history(chat.id, 'alice')
      .runs.map((run) => [run.id, run.message]),
    [
      [first.id, 'First result'],
      [second.id, 'Second result'],
    ],
  )
})

test('startup groups earlier agent tasks once without rewriting jobs or exposing archived projects', async (t) => {
  const f = await fixture(t)
  const jobs = [
    f.events.create('alice', {
      kind: 'agent',
      projectId: 'p',
      prompt: 'First earlier task',
    }),
    f.events.create('alice', {
      kind: 'agent',
      projectId: 'p',
      prompt: 'Second earlier task',
    }),
    f.events.create('alice', {
      kind: 'agent',
      projectId: 'q',
      prompt: 'Separate project',
    }),
    f.events.create('bob', {
      kind: 'agent',
      projectId: 'bob-p',
      prompt: 'Private Bob task',
    }),
    f.events.create('alice', {
      kind: 'agent',
      projectId: 'p',
      chatId: 'obsolete-chat',
      prompt: 'Recover orphan reference',
    }),
  ]
  jobs.forEach((job) => f.events.update(job.id, { status: 'completed' }))
  f.events.create('alice', { kind: 'check', projectId: 'p' })
  f.projects.get('q').archived = true
  const migrated = f.restart(),
    chat = migrated.list('alice', 'p')[0]
  assert.equal(chat.title, 'Earlier tasks')
  assert.equal(chat.runCount, 3)
  assert.deepEqual(
    migrated.history(chat.id, 'alice').runs.map((run) => run.id),
    [jobs[0].id, jobs[1].id, jobs[4].id],
  )
  assert.equal(migrated.list('bob', 'bob-p')[0].runCount, 1)
  assert.equal(f.events.get(jobs[0].id, 'alice').chatId, undefined)
  assert.equal(f.events.get(jobs[4].id, 'alice').chatId, 'obsolete-chat')
  assert.equal(f.restart().list('alice', 'p').length, 1)
  assert.equal(f.chats.get(chat.id, 'alice').runCount, 3)
  assert.equal(
    f.chats.db
      .prepare("SELECT COUNT(*) AS count FROM chats WHERE project='q'")
      .get().count,
    0,
  )
})

test('recoverable chat deletion preserves history and protects active chats and archived projects', async (t) => {
  const f = await fixture(t),
    chat = f.chats.create('alice', 'p', { title: 'Keep these proofs' })
  const job = f.run(chat)
  for (const status of ['queued', 'running', 'verifying']) {
    f.events.update(job.id, { status })
    assert.throws(() => f.chats.trash('alice', chat.id), { status: 409 })
  }
  f.events.update(job.id, { status: 'completed', message: 'Preserved answer' })
  const receipt = f.chats.trash('alice', chat.id)
  assert.equal(receipt.kind, 'chat')
  assert.equal(receipt.name, 'Keep these proofs')
  assert.equal(receipt.projectName, 'Proofs')
  assert.deepEqual(f.chats.list('alice', 'p'), [])
  assert.throws(() => f.chats.history(chat.id, 'alice'), { status: 404 })
  assert.throws(() => f.chats.restore('bob', receipt.trashId), { status: 404 })
  f.restart()
  assert.equal(f.chats.listTrash('alice')[0].trashId, receipt.trashId)
  f.projects.get('p').archived = true
  assert.throws(() => f.chats.restore('alice', receipt.trashId), {
    status: 404,
  })
  assert.equal(f.chats.listTrash('alice').length, 1)
  f.projects.get('p').archived = false
  assert.equal(f.chats.restore('alice', receipt.trashId).restored, true)
  assert.equal(
    f.chats.history(chat.id, 'alice').runs[0].message,
    'Preserved answer',
  )
  assert.deepEqual(f.chats.listTrash('alice'), [])
})

async function httpFixture(t, titleGenerator) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-chat-http-'))
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async shutdown() {},
    spawn() {
      assert.fail('HTTP chat tests must not launch workers')
    },
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
    },
  }
  const config = {
    defaultModel: 'test',
    models: [{ id: 'test' }],
    provider: { LEMEX_API_KEY: 'test-no-provider-call' },
    lemex: {},
    redact: String,
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    config,
    titleGenerator,
  })
  await studio.providers.save('owner', 'test-no-provider-call')
  studio.agents.maxConcurrent = 0
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await studio.workspaces.create('owner', {
    name: 'HTTP proofs',
    preset: 'lean',
  })
  await studio.workspaces.jobs.get(project.id)
  const token = (
      await fs.readFile(path.join(dataDir, 'auth', 'owner.token'), 'utf8')
    ).trim(),
    bobToken = 'bob-chat-token'
  studio.auth.users.push({
    id: 'bob',
    name: 'Bob',
    tokenHash: createHash('sha256').update(bobToken).digest('hex'),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth', 'users.json'),
    JSON.stringify(studio.auth.users),
  )
  const url = `http://127.0.0.1:${studio.server.address().port}`
  const request = (endpoint, { method = 'GET', body, access = token } = {}) =>
    fetch(url + endpoint, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        ...(access ? { Authorization: `Bearer ${access}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  return { ...studio, project, request, bobToken }
}

test('chat HTTP APIs enforce scope, create turns with attachments, and redact private workspace fields', async (t) => {
  const f = await httpFixture(t),
    endpoint = `/api/projects/${f.project.id}/chats`
  assert.equal((await f.request(endpoint, { access: null })).status, 401)
  assert.equal((await f.request(endpoint, { access: f.bobToken })).status, 404)
  const created = await f.request(endpoint, { method: 'POST', body: {} })
  assert.equal(created.status, 201)
  const chat = await created.json(),
    input = {
      mode: 'repair',
      prompt: 'Repair this theorem.',
      files: ['Main.lean'],
      liveEdits: false,
    }
  assert.equal(
    (
      await f.request(`/api/chats/${chat.id}/runs`, {
        method: 'POST',
        body: { ...input, chatId: 'other' },
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await f.request(`/api/chats/${chat.id}/runs`, {
        method: 'POST',
        body: { ...input, files: ['.env'] },
      })
    ).status,
    400,
  )
  const response = await f.request(`/api/chats/${chat.id}/runs`, {
    method: 'POST',
    body: input,
  })
  assert.equal(response.status, 202)
  const run = await response.json()
  assert.equal(run.chatId, chat.id)
  assert.equal(run.projectId, f.project.id)
  assert.deepEqual(run.files, ['Main.lean'])
  assert.equal(run.eventCursor, 2)
  f.events.update(run.id, {
    status: 'completed',
    message: 'Saved result',
    snapshot: { root: '/private/snapshot' },
    verificationRoot: '/private/verification',
  })
  const history = await (await f.request(`/api/chats/${chat.id}`)).json()
  assert.equal(history.chat.title, input.prompt)
  assert.equal(history.runs[0].message, 'Saved result')
  for (const key of ['owner', 'snapshot', 'verificationRoot'])
    assert.equal(key in history.runs[0], false)
  assert.equal(
    (await f.request(`/api/chats/${chat.id}`, { access: f.bobToken })).status,
    404,
  )
  const renamed = await f.request(`/api/chats/${chat.id}`, {
    method: 'PATCH',
    body: { title: 'Renamed session' },
  })
  assert.equal((await renamed.json()).title, 'Renamed session')
  const other = await f.workspaces.create('owner', { preset: 'lean' })
  await f.workspaces.jobs.get(other.id)
  assert.equal(
    (
      await f.request(`/api/projects/${other.id}/runs`, {
        method: 'POST',
        body: { ...input, chatId: chat.id },
      })
    ).status,
    404,
  )
})

test('run snapshots provide an owned cursor for gapless replay without repeating accumulated text', async (t) => {
  const f = await httpFixture(t)
  const job = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
  })
  f.events.update(job.id, { status: 'running' })
  f.events.append(job.id, 'message', 'Before snapshot.', 'message')
  f.events.append(job.id, 'reasoning', 'Earlier reasoning.', 'reasoning')
  const snapshot = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.equal(snapshot.message, 'Before snapshot.')
  assert.equal(snapshot.reasoning, 'Earlier reasoning.')
  assert.equal(snapshot.eventCursor, f.events.events(job.id).at(-1).seq)
  assert.equal((await f.request(`/api/jobs/${job.id}`)).status, 200)
  assert.equal(
    (await f.request(`/api/runs/${job.id}`, { access: f.bobToken })).status,
    404,
  )
  assert.throws(() => f.events.snapshot(job.id, 'bob'), { status: 404 })
  f.events.append(job.id, 'message', ' After snapshot.', 'message')
  f.events.update(job.id, { status: 'completed' })
  const subsequent = f.events.events(job.id, snapshot.eventCursor)
  const stream = await f.request(
    `/api/runs/${job.id}/events?after=${snapshot.eventCursor}`,
  )
  const reader = stream.body.getReader(),
    decoder = new TextDecoder()
  let received = '',
    replayed = []
  while (!replayed.some((event) => event.seq === subsequent.at(-1).seq)) {
    const chunk = await reader.read()
    assert.equal(chunk.done, false)
    received += decoder.decode(chunk.value)
    replayed = received
      .split('\n\n')
      .slice(0, -1)
      .flatMap((frame) =>
        frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6))),
      )
  }
  assert.deepEqual(replayed, subsequent)
  assert(replayed.every((event) => event.seq > snapshot.eventCursor))
  const next = f.events.event(job.id, 'activity', {
    text: 'Future live event.',
  })
  const live = decoder.decode((await reader.read()).value)
  assert(live.includes(`id: ${next.seq}\n`))
  await reader.cancel()
  const latest = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.equal(latest.message, 'Before snapshot. After snapshot.')
  assert.equal(latest.eventCursor, next.seq)
})

test('HTTP history retains reasoning step positions without trace bodies, including older saved runs', async (t) => {
  const f = await httpFixture(t),
    chat = f.chats.create('owner', f.project.id)
  const job = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
    chatId: chat.id,
  })
  f.chats.appendRun(chat.id, 'owner', job)
  f.events.append(job.id, 'message', 'First reply. 🔎', 'message')
  f.events.append(job.id, 'reasoning', 'Check the lemma.', 'reasoning')
  f.events.append(job.id, 'reasoningSummary', 'Checking.', 'reasoning-summary')
  f.events.append(job.id, 'message', 'Second reply.', 'message')
  f.events.append(job.id, 'reasoning', 'Try induction.', 'reasoning')
  f.events.update(job.id, { status: 'completed' })
  const full = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.equal(full.reasoningBlocks.length, 2)
  assert.equal(full.reasoningBlocks[0].messageOffset, 'First reply. 🔎'.length)
  assert.equal(
    full.reasoningBlocks[1].reasoningOffset,
    'Check the lemma.'.length,
  )
  const history = (await (await f.request(`/api/chats/${chat.id}`)).json())
    .runs[0]
  assert.deepEqual(history.reasoningBlocks, full.reasoningBlocks)
  assert.equal(history.reasoning, undefined)
  assert.equal(history.reasoningSummary, undefined)
  assert.equal(
    (await f.request(`/api/chats/${chat.id}`, { access: f.bobToken })).status,
    404,
  )
  // Simulate a record from the running server before timeline metadata existed.
  f.events.db
    .prepare(
      "UPDATE jobs SET payload=json_remove(payload,'$.reasoningBlocks') WHERE id=?",
    )
    .run(job.id)
  const reconstructed = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.deepEqual(reconstructed.reasoningBlocks, full.reasoningBlocks)
  f.events.append(job.id, 'message', 'Final reply.', 'message')
  const continued = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.deepEqual(continued.reasoningBlocks, full.reasoningBlocks)
})

test('earlier reasoning survives tail trimming and loads in bounded owned pages for older runs', async (t) => {
  const f = await httpFixture(t),
    chat = f.chats.create('owner', f.project.id)
  const job = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
    chatId: chat.id,
  })
  f.chats.appendRun(chat.id, 'owner', job)
  const earlier = 'EARLY_REASONING: ' + 'x'.repeat(249983) + '🔎' + ' ending.'
  f.events.append(job.id, 'reasoning', earlier, 'reasoning')
  f.events.append(
    job.id,
    'reasoningSummary',
    'Earlier summary.',
    'reasoning-summary',
  )
  f.events.append(job.id, 'message', 'The first check passed.', 'message')
  f.events.append(job.id, 'reasoning', 'y'.repeat(250001), 'reasoning')
  f.events.update(job.id, { status: 'completed' })
  const snapshot = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.equal(snapshot.reasoning.length, 250000)
  assert.equal(snapshot.reasoningBlocks.length, 2)
  assert.equal(snapshot.reasoningHistoryAvailable, true)
  // Older versions discarded early positions from metadata, but kept events.
  f.events.db
    .prepare(
      "UPDATE jobs SET payload=json_set(json_remove(payload,'$.reasoningHistoryAvailable'),'$.reasoningBlocks',json(?)) WHERE id=?",
    )
    .run(JSON.stringify(snapshot.reasoningBlocks.slice(-1)), job.id)
  const history = (await (await f.request(`/api/chats/${chat.id}`)).json())
    .runs[0]
  assert.deepEqual(history.reasoningBlocks, snapshot.reasoningBlocks)
  assert.equal(history.reasoningHistoryAvailable, true)
  assert.equal(history.reasoning, undefined)
  const base = `/api/runs/${job.id}/reasoning/${history.reasoningBlocks[0].id}`
  const first = await (await f.request(base)).json()
  assert.equal(first.reasoning.length, 250000)
  assert.equal(first.reasoningSummary, 'Earlier summary.')
  assert.equal(first.nextOffset, 250000)
  const last = await (
    await f.request(`${base}?offset=${first.nextOffset}`)
  ).json()
  assert.equal(first.reasoning + last.reasoning, earlier)
  assert.equal(last.reasoningSummary, '')
  assert.equal(last.nextOffset, null)
  assert.equal((await f.request(base, { access: f.bobToken })).status, 404)
  assert.equal(
    (await f.request(`/api/runs/${job.id}/reasoning/unknown`)).status,
    404,
  )
  for (const offset of ['-1', '1.5', 'Infinity', '500000', '', '1&offset=2'])
    assert.equal((await f.request(`${base}?offset=${offset}`)).status, 400)
  f.events.append(job.id, 'message', 'Another reply.', 'message')
  assert.deepEqual(
    f.events.snapshot(job.id).reasoningBlocks,
    snapshot.reasoningBlocks,
  )
  assert.equal(f.events.getMetadata(job.id).reasoningHistoryAvailable, true)
})

test('project run and check creation return initial snapshots with replay cursors', async (t) => {
  const f = await httpFixture(t)
  const response = await f.request(`/api/projects/${f.project.id}/runs`, {
    method: 'POST',
    body: { mode: 'repair', prompt: 'A queued task.' },
  })
  assert.equal(response.status, 202)
  const run = await response.json()
  assert.equal(run.status, 'queued')
  assert.equal(run.eventCursor, 2)
  const stopped = await (
    await f.request(`/api/runs/${run.id}/stop`, { method: 'POST', body: {} })
  ).json()
  assert.equal(stopped.status, 'cancelled')
  assert(stopped.eventCursor > run.eventCursor)
  assert.equal(stopped.eventCursor, f.events.events(run.id).at(-1).seq)
  const checkResponse = await f.request(`/api/projects/${f.project.id}/check`, {
    method: 'POST',
    body: { path: 'Main.lean' },
  })
  assert.equal(checkResponse.status, 202)
  const check = await checkResponse.json()
  assert.equal(check.kind, 'check')
  assert.equal(check.status, 'queued')
  assert.equal(check.eventCursor, 1)
})

test('run mutation responses wait for actions and return a fresh owned snapshot and cursor', async (t) => {
  const f = await httpFixture(t)
  for (const action of ['stop', 'undo', 'apply']) {
    const job = f.events.create('owner', {
      kind: 'agent',
      projectId: f.project.id,
      snapshot: { root: '/private' },
    })
    f.agents[action] = async (owner, id) => {
      f.events.get(id, owner)
      await Promise.resolve()
      const before = f.events.get(id, owner)
      f.events.append(id, 'message', `${action} finished.`, 'message')
      f.events.update(id, {
        status:
          action === 'stop'
            ? 'cancelled'
            : action === 'apply'
              ? 'applied'
              : 'completed',
        ...(action === 'undo' ? { liveUndone: true, liveRevision: 2 } : {}),
      })
      return before // The HTTP response must read the final state after the action.
    }
    assert.equal(
      (
        await f.request(`/api/runs/${job.id}/${action}`, {
          method: 'POST',
          body: {},
          access: f.bobToken,
        })
      ).status,
      404,
    )
    const response = await f.request(`/api/runs/${job.id}/${action}`, {
      method: 'POST',
      body: {},
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.message, `${action} finished.`)
    assert.equal(result.eventCursor, f.events.events(job.id).at(-1).seq)
    assert(result.eventCursor > 1)
    assert.equal(
      result.status,
      action === 'stop'
        ? 'cancelled'
        : action === 'apply'
          ? 'applied'
          : 'completed',
    )
    if (action === 'undo') {
      assert.equal(result.liveUndone, true)
      assert.equal(result.liveRevision, 2)
    }
    for (const field of ['owner', 'snapshot', 'verificationRoot'])
      assert.equal(field in result, false)
  }
})

test('project polling omits transcripts and chat polling omits traces and diffs while single runs remain complete', async (t) => {
  const f = await httpFixture(t),
    chat = f.chats.create('owner', f.project.id)
  const job = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
    chatId: chat.id,
    prompt: 'A saved request',
    files: ['Main.lean'],
    liveEdits: true,
  })
  const changes = [
    {
      path: 'Main.lean',
      before: 'Original source',
      after: 'Updated source',
      beforeHash: 'original-hash',
    },
  ]
  f.events.update(job.id, {
    status: 'completed',
    message: 'A saved answer',
    reasoning: 'r'.repeat(20_000),
    reasoningSummary: 'Summary',
    log: 'l'.repeat(20_000),
    changes,
    liveChanges: changes,
    liveRevision: 3,
    snapshot: { root: '/private/source' },
    verificationRoot: '/private/check',
    threadId: 'private-native-thread',
    verification: { kind: 'search', complete: true },
    optimization: { baseline: { available: true } },
  })
  f.chats.appendRun(chat.id, 'owner', job)
  const listed = (
    await (await f.request(`/api/projects/${f.project.id}/runs`)).json()
  )[0]
  const history = (await (await f.request(`/api/chats/${chat.id}`)).json())
    .runs[0]
  for (const item of [listed, history]) {
    assert.equal(item.id, job.id)
    assert.equal(item.status, 'completed')
    assert.equal(item.liveRevision, 3)
    assert.deepEqual(item.files, ['Main.lean'])
    assert.deepEqual(item.liveChangePaths, ['Main.lean'])
    assert.equal('liveChanges' in item, false)
    for (const field of [
      'owner',
      'snapshot',
      'verificationRoot',
      'threadId',
      'log',
      'reasoning',
      'reasoningSummary',
      'changes',
      'optimization',
    ])
      assert.equal(field in item, false, field)
  }
  assert.equal('prompt' in listed, false)
  assert.equal('message' in listed, false)
  assert.equal(history.prompt, 'A saved request')
  assert.equal(history.message, 'A saved answer')
  assert.equal('verification' in listed, false)
  assert.deepEqual(history.verification, { kind: 'search', complete: true })
  assert.equal(history.changeCount, 1)
  assert.equal(history.liveChangeCount, 1)
  assert.equal(history.reasoningChars, 20_000)
  assert.equal(history.reasoningSummaryChars, 7)
  assert.equal(history.eventCursor, f.events.snapshot(job.id).eventCursor)
  const full = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.equal(full.reasoning.length, 20_000)
  assert.equal(full.log.length, 20_000)
  assert.deepEqual(full.changes, changes)
  assert.deepEqual(full.liveChanges, changes)
  assert(Number.isSafeInteger(full.eventCursor))
  const nonlive = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
    liveEdits: false,
  })
  f.events.updateMetadata(nonlive.id, { status: 'completed', changes })
  const summary = (
    await (
      await f.request(`/api/projects/${f.project.id}/runs?summary=1`)
    ).json()
  ).find((value) => value.id === nonlive.id)
  assert.equal('liveRevision' in summary, false)
  assert.equal(summary.liveEdits, false)
  for (const field of ['owner', 'snapshot', 'verificationRoot'])
    assert.equal(field in full, false)
  assert.equal(
    f.chats.history(chat.id, 'owner').runs[0].reasoning.length,
    20_000,
  )
  assert.deepEqual(f.chats.history(chat.id, 'owner').runs[0].changes, [
    { path: 'Main.lean' },
  ])
})

test('user updates split saved and reconstructed reasoning even without a new reply', async (t) => {
  const f = await httpFixture(t)
  const job = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
  })
  f.events.append(job.id, 'reasoning', 'Before update.', 'reasoning')
  const entry = {
    id: 'timeline-update',
    text: 'Try induction.',
    status: 'accepted',
    createdAt: '2026-10-13T10:00:00Z',
    messageOffset: 0,
  }
  f.events.update(job.id, { followups: [entry] })
  f.events.event(job.id, 'followup', entry)
  f.events.append(job.id, 'reasoning', 'After update.', 'reasoning')
  f.events.event(job.id, 'followup', entry)
  f.events.append(job.id, 'reasoning', ' Still after.', 'reasoning')
  f.events.update(job.id, { status: 'completed' })
  const full = f.events.snapshot(job.id, 'owner')
  assert.deepEqual(
    full.reasoningBlocks.map((block) => block.afterFollowups),
    [0, 1],
  )
  assert.equal(
    full.reasoningBlocks[1].reasoningLength,
    'After update. Still after.'.length,
  )
  f.events.db
    .prepare(
      "UPDATE jobs SET payload=json_remove(payload,'$.reasoningBlocks') WHERE id=?",
    )
    .run(job.id)
  assert.deepEqual(
    f.events.snapshot(job.id, 'owner').reasoningBlocks,
    full.reasoningBlocks,
  )
})

test('HTTP project creation and uploads accept source bodies over 3 MiB while retaining source and ordinary API limits', async (t) => {
  const f = await httpFixture(t)
  const large = '--' + 'x'.repeat(1_700_000) + '\n'
  const files = [
    { path: 'lean-toolchain', content: 'leanprover/lean4:v4.34.1\n' },
    { path: 'lakefile.toml', content: 'name = "upload_check"\n' },
    { path: 'Main.lean', content: '#check Nat\n' },
    { path: 'LargeA.lean', content: large },
    { path: 'LargeB.lean', content: large },
  ]
  const createdResponse = await f.request('/api/projects', {
    method: 'POST',
    body: { name: 'Large HTTP upload', files, autoRepair: false },
  })
  assert.equal(
    createdResponse.status,
    201,
    await createdResponse.clone().text(),
  )
  const created = await createdResponse.json()
  await f.workspaces.jobs.get(created.id)
  assert.equal(
    (await f.workspaces.readFile(created.id, 'owner', 'LargeB.lean')).content,
    large,
  )
  const upload = await f.request(`/api/projects/${f.project.id}/upload`, {
    method: 'POST',
    body: {
      files: [
        { path: 'AddedA.lean', content: large },
        { path: 'AddedB.lean', content: large },
      ],
    },
  })
  assert.equal(upload.status, 200, await upload.clone().text())
  assert.equal(
    (await f.workspaces.readFile(f.project.id, 'owner', 'AddedA.lean')).content,
    large,
  )
  const tooLarge = await f.request('/api/projects', {
    method: 'POST',
    body: {
      files: Array.from({ length: 17 }, (_, index) => ({
        path: `Source${index}.lean`,
        content: 'x'.repeat(2_000_000),
      })),
    },
  })
  assert.equal(tooLarge.status, 413)
  assert.match((await tooLarge.json()).error, /32 MiB/)
  const ordinary = await f.request('/api/settings', {
    method: 'PUT',
    body: { extraInstructions: large + large },
  })
  assert.equal(
    ordinary.status,
    413,
    'Ordinary APIs retain the smaller parser limit',
  )
})

test('HTTP followups capture current saved attachments privately, remain idempotent, and fail pending receipts on Stop', async (t) => {
  const f = await httpFixture(t),
    chat = f.chats.create('owner', f.project.id)
  const job = await f.agents.start('owner', f.project.id, {
    mode: 'proofs',
    prompt: 'Repair Main.',
    chatId: chat.id,
  })
  const input = {
    id: '00112233-4455-4677-8899-aabbccddeeff',
    text: 'Use this saved file.',
    files: ['Main.lean'],
  }
  const endpoint = `/api/runs/${job.id}/messages`
  assert.equal(
    (
      await f.request(endpoint, {
        method: 'POST',
        access: f.bobToken,
        body: input,
      })
    ).status,
    404,
  )
  assert.equal(
    (await f.request(endpoint, { method: 'POST', body: { ...input, id: 1 } }))
      .status,
    400,
  )
  const response = await f.request(endpoint, { method: 'POST', body: input })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.followups[0].status, 'pending')
  assert.deepEqual(result.followups[0].files, ['Main.lean'])
  assert.equal('followupContexts' in result, false)
  const originalContext = f.events.get(job.id).followupContexts[input.id]
  assert.equal(
    JSON.parse(originalContext)[0].content,
    (await f.workspaces.readFile(f.project.id, 'owner', 'Main.lean')).content,
  )
  const before = await f.workspaces.readFile(f.project.id, 'owner', 'Main.lean')
  await f.workspaces.writeFile(
    f.project.id,
    'owner',
    'Main.lean',
    '#check Int\n',
    before.hash,
  )
  assert.equal(
    (await f.request(endpoint, { method: 'POST', body: input })).status,
    200,
  )
  assert.equal(
    f.events.get(job.id).followupContexts[input.id],
    originalContext,
    'Retry never recaptures a different saved context',
  )
  assert.equal(f.events.get(job.id).followups.length, 1)
  assert.equal(
    (
      await f.request(endpoint, {
        method: 'POST',
        body: { ...input, text: 'Different' },
      })
    ).status,
    409,
  )
  const stoppedResponse = await f.request(`/api/runs/${job.id}/stop`, {
    method: 'POST',
    body: {},
  })
  const stopped = await stoppedResponse.json()
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.followups[0].status, 'failed')
  assert.equal(
    (
      await f.request(endpoint, {
        method: 'POST',
        body: { ...input, id: '11112233-4455-4677-8899-aabbccddeeff' },
      })
    ).status,
    409,
  )
})

test('HTTP followup receipts preserve source previews without hydrating their rows', async (t) => {
  const f = await httpFixture(t)
  const job = await f.agents.start('owner', f.project.id, {
    mode: 'proofs',
    prompt: 'Repair Main.',
  })
  const change = {
    path: 'Main.lean',
    before: 'example : True := by\n',
    after: 'example : True := by trivial\n',
  }
  f.events.updateMetadata(job.id, { changes: [change], liveChanges: [change] })
  f.events.append(job.id, 'reasoning', 'Checking the saved proof.', 'reasoning')
  const rows = f.events.db
    .prepare('SELECT field,payload FROM job_changes WHERE job=?')
    .all(job.id)
  f.events.db
    .prepare("UPDATE job_changes SET payload='invalid source JSON' WHERE job=?")
    .run(job.id)
  const input = {
    id: '99112233-4455-4677-8899-aabbccddeeff',
    text: 'Keep the current proof preview.',
  }
  const endpoint = `/api/runs/${job.id}/messages`
  const response = await f.request(endpoint, { method: 'POST', body: input })
  assert.equal(response.status, 200)
  const receipt = await response.json()
  assert.equal(receipt.followups[0].status, 'pending')
  assert.equal(receipt.changeCount, 1)
  assert.equal(receipt.liveChangeCount, 1)
  assert.deepEqual(receipt.changePaths, ['Main.lean'])
  assert.deepEqual(receipt.liveChangePaths, ['Main.lean'])
  assert.equal('changes' in receipt, false)
  assert.equal('liveChanges' in receipt, false)
  assert.equal('followupContexts' in receipt, false)
  assert.equal(receipt.eventCursor, f.events.cursor(job.id))
  assert.equal(
    receipt.reasoningBlocks[0].reasoningLength,
    'Checking the saved proof.'.length,
  )
  const retry = await f.request(endpoint, { method: 'POST', body: input })
  assert.equal(retry.status, 200)
  assert.deepEqual((await retry.json()).followups, receipt.followups)
  assert.equal(
    (
      await f.request(endpoint, {
        method: 'POST',
        access: f.bobToken,
        body: input,
      })
    ).status,
    404,
  )
  for (const row of rows)
    f.events.db
      .prepare('UPDATE job_changes SET payload=? WHERE job=? AND field=?')
      .run(row.payload, job.id, row.field)
  const full = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.deepEqual(full.changes, [change])
  assert.deepEqual(full.liveChanges, [change])
})

test('owned run polling keeps large source rows lazy through file and status updates while explicit review stays complete', async (t) => {
  const f = await httpFixture(t)
  const job = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
    liveEdits: true,
  })
  const change = {
    path: 'Main.lean',
    before: 'x'.repeat(Math.floor(5.4 * 1024 * 1024)),
    after: 'y'.repeat(Math.floor(5.4 * 1024 * 1024)),
  }
  f.events.updateMetadata(job.id, {
    status: 'running',
    liveRevision: 1,
    changes: [change],
    liveChanges: [change],
  })
  f.events.append(
    job.id,
    'reasoning',
    'Checking the pinned proof.',
    'reasoning',
  )
  const rows = f.events.db
    .prepare('SELECT field,payload FROM job_changes WHERE job=?')
    .all(job.id)
  f.events.db
    .prepare(
      "UPDATE job_changes SET payload='unavailable proof source' WHERE job=?",
    )
    .run(job.id)
  const endpoint = `/api/runs/${job.id}?view=metadata`
  assert.equal((await f.request(endpoint, { access: f.bobToken })).status, 404)
  for (const status of ['running', 'verifying', 'completed']) {
    f.events.updateMetadata(job.id, { status, liveRevision: 2 })
    f.events.event(job.id, 'files-updated', {
      paths: ['Main.lean'],
      live: true,
    })
    const response = await f.request(endpoint)
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.equal(value.status, status)
    assert.equal(value.liveRevision, 2)
    assert.equal(value.eventCursor, f.events.cursor(job.id))
    assert.equal(value.changeCount, 1)
    assert.equal(value.liveChangeCount, 1)
    assert.deepEqual(value.changePaths, ['Main.lean'])
    assert.deepEqual(value.liveChangePaths, ['Main.lean'])
    assert.equal(value.reasoning, 'Checking the pinned proof.')
    assert.equal(
      value.reasoningBlocks[0].reasoningLength,
      value.reasoning.length,
    )
    assert.equal('changes' in value, false)
    assert.equal('liveChanges' in value, false)
    assert.equal('owner' in value, false)
    assert(Buffer.byteLength(JSON.stringify(value)) < 4096)
  }
  assert.equal((await f.request(`/api/runs/${job.id}`)).status, 500)
  for (const row of rows)
    f.events.db
      .prepare('UPDATE job_changes SET payload=? WHERE job=? AND field=?')
      .run(row.payload, job.id, row.field)
  const review = await (await f.request(`/api/runs/${job.id}`)).json()
  assert.deepEqual(review.changes, [change])
  assert.deepEqual(review.liveChanges, [change])
})

test('HTTP Trash merges chat and file recovery receipts and retains conversations after restore', async (t) => {
  const f = await httpFixture(t)
  const chat = f.chats.create('owner', f.project.id, {
    title: 'Saved conversation',
  })
  const job = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
    chatId: chat.id,
    prompt: 'Proof task',
  })
  f.chats.appendRun(chat.id, 'owner', job)
  assert.equal(
    (
      await f.request(`/api/chats/${chat.id}/trash`, {
        method: 'POST',
        body: {},
      })
    ).status,
    409,
  )
  f.events.update(job.id, { status: 'completed', message: 'Keep this message' })
  const fileReceipt = await f.workspaces.trash(
    f.project.id,
    'owner',
    'Main.lean',
  )
  const deletion = await f.request(`/api/chats/${chat.id}/trash`, {
    method: 'POST',
    body: {},
  })
  assert.equal(deletion.status, 200)
  const receipt = await deletion.json(),
    trash = await (await f.request('/api/trash')).json()
  assert.deepEqual(
    new Set(trash.map((entry) => entry.kind)),
    new Set(['chat', 'file']),
  )
  assert.equal((await f.request(`/api/chats/${chat.id}`)).status, 404)
  assert.equal(
    (
      await f.request(`/api/trash/${receipt.trashId}/restore`, {
        method: 'POST',
        body: {},
        access: f.bobToken,
      })
    ).status,
    404,
  )
  assert.equal(
    (
      await f.request(`/api/trash/${receipt.trashId}/restore`, {
        method: 'POST',
        body: {},
      })
    ).status,
    200,
  )
  assert.equal(
    (await (await f.request(`/api/chats/${chat.id}`)).json()).runs[0].message,
    'Keep this message',
  )
  assert.deepEqual(
    (await (await f.request('/api/trash')).json()).map(
      (entry) => entry.trashId,
    ),
    [fileReceipt.trashId],
  )
})

const titleTick = () => new Promise((resolve) => setImmediate(resolve))
const titleGate = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('first message receives a background title once, with prompt fallback and unchanged chat history', async (t) => {
  const gate = titleGate(),
    calls = []
  const f = await fixture(t, {
    available: true,
    generate: (messages) => {
      calls.push(messages)
      return gate.promise
    },
  })
  const chat = f.chats.create('alice', 'p')
  const run = f.run(chat, {
    prompt:
      'Please repair the proof of commutativity for natural number addition.',
  })
  assert.equal(
    f.events.get(run.id).status,
    'queued',
    'Naming never runs or delays the proof agent',
  )
  assert.equal(f.chats.get(chat.id, 'alice').titleStatus, 'pending')
  assert.match(f.chats.get(chat.id, 'alice').title, /^Please repair/)
  await titleTick()
  assert.deepEqual(calls, [[{ role: 'user', content: run.prompt }]])
  gate.resolve({
    title: 'Natural Addition Commutativity',
    model: 'deepseek-fixture',
  })
  await titleTick()
  assert.equal(
    f.chats.get(chat.id, 'alice').title,
    'Natural Addition Commutativity',
  )
  assert.equal(f.chats.get(chat.id, 'alice').titleSource, 'generated')
  assert.equal(f.chats.get(chat.id, 'alice').titleStatus, 'ready')
  f.run(chat, { prompt: 'Continue the same proof.' })
  await titleTick()
  assert.equal(calls.length, 1)
  assert.equal(f.chats.history(chat.id, 'alice').runs[0].id, run.id)
  f.restart()
  assert.equal(
    f.chats.get(chat.id, 'alice').title,
    'Natural Addition Commutativity',
  )
  assert.equal(calls.length, 1)
})

test('manual titles win late automatic results and cancelled requests never rename restored chats', async (t) => {
  const gates = []
  const f = await fixture(t, {
    available: true,
    generate: () => {
      const gate = titleGate()
      gates.push(gate)
      return gate.promise
    },
  })
  const chat = f.chats.create('alice', 'p')
  f.run(chat)
  await titleTick()
  f.chats.rename(chat.id, 'alice', { title: 'My precise name' })
  gates[0].resolve({ title: 'Late automatic title', model: 'deepseek-fixture' })
  await titleTick()
  assert.equal(f.chats.get(chat.id, 'alice').title, 'My precise name')
  assert.equal(f.chats.get(chat.id, 'alice').titleSource, 'manual')
  const second = f.chats.create('alice', 'p'),
    job = f.run(second)
  await titleTick()
  f.events.update(job.id, { status: 'completed' })
  const receipt = f.chats.trash('alice', second.id)
  f.chats.restore('alice', receipt.trashId)
  gates[1].resolve({
    title: 'Result from before deletion',
    model: 'deepseek-fixture',
  })
  await titleTick()
  assert.equal(f.chats.get(second.id, 'alice').title, 'First task')
  const explicit = f.chats.create('alice', 'p', {
    title: 'Named before first message',
  })
  f.run(explicit)
  await titleTick()
  assert.equal(
    gates.length,
    2,
    'Explicit names never start automatic generation',
  )
})

test('failed naming retains a usable title and never retries automatically on new messages or restart', async (t) => {
  let calls = 0
  const f = await fixture(t, {
    available: true,
    generate: async () => {
      calls++
      throw new Error('Provider unavailable')
    },
  })
  const chat = f.chats.create('alice', 'p')
  f.run(chat, { prompt: 'Optimize the induction proof' })
  await titleTick()
  assert.equal(
    f.chats.get(chat.id, 'alice').title,
    'Optimize the induction proof',
  )
  assert.equal(f.chats.get(chat.id, 'alice').titleStatus, 'unavailable')
  f.run(chat)
  f.restart()
  await titleTick()
  assert.equal(calls, 1)
  f.chats.rename(chat.id, 'alice', { title: 'Manual fallback' })
  assert.equal(f.chats.get(chat.id, 'alice').title, 'Manual fallback')
})

test('suggestions deduplicate and queue within limits, send bounded conversation text, and abort on shutdown', async (t) => {
  const calls = [],
    gates = []
  const f = await fixture(t, {
    available: true,
    generate: (messages, { signal }) => {
      const gate = titleGate()
      gates.push(gate)
      calls.push({ messages, signal })
      signal.addEventListener(
        'abort',
        () => gate.reject(new Error('Stopped')),
        { once: true },
      )
      return gate.promise
    },
  })
  const chats = Array.from({ length: 3 }, () =>
    f.chats.create('alice', 'p', { title: 'Explicit' }),
  )
  for (const chat of chats) {
    const job = f.run(chat, {
      prompt: 'p'.repeat(9000),
      file: 'PrivateFile.lean',
    })
    f.events.update(job.id, {
      status: 'completed',
      message: 'm'.repeat(9000),
      reasoning: 'PRIVATE_REASONING',
      log: 'PRIVATE_LOG',
    })
  }
  const requests = chats.map((chat) => f.chats.suggestTitle(chat.id, 'alice'))
  assert.equal(f.chats.suggestTitle(chats[0].id, 'alice'), requests[0])
  await titleTick()
  assert.equal(calls.length, 2)
  assert.equal(f.chats.titleQueue.length, 1)
  assert(!JSON.stringify(calls[0].messages).includes('PRIVATE_'))
  assert(!JSON.stringify(calls[0].messages).includes('PrivateFile'))
  assert(calls[0].messages.every((message) => message.content.length <= 2000))
  gates[0].resolve({ title: 'A suggested title', model: 'deepseek-fixture' })
  assert.equal((await requests[0]).title, 'A suggested title')
  await titleTick()
  assert.equal(calls.length, 3)
  assert.equal(
    f.chats.get(chats[0].id, 'alice').title,
    'Explicit',
    'Suggestion requires an explicit save',
  )
  const aborted = Promise.allSettled(requests.slice(1))
  f.chats.stopNaming()
  assert((await aborted).every((result) => result.status === 'rejected'))
  assert(calls.every((call) => call.signal.aborted || call === calls[0]))
})

test('suggestion HTTP endpoint is owned, read-only, usable during a run, and never accepts client-supplied context', async (t) => {
  const calls = []
  const f = await httpFixture(t, {
    available: true,
    generate: async (messages) => {
      calls.push(messages)
      return { title: 'Commutativity Proof', model: 'deepseek-fixture' }
    },
  })
  const chat = f.chats.create('owner', f.project.id, {
    title: 'Original title',
  })
  const endpoint = `/api/chats/${chat.id}/title`
  assert.equal(
    (await f.request(endpoint, { method: 'POST', body: {} })).status,
    400,
  )
  const run = f.events.create('owner', {
    kind: 'agent',
    projectId: f.project.id,
    chatId: chat.id,
    prompt: 'Prove addition commutative',
  })
  f.chats.appendRun(chat.id, 'owner', run)
  assert.equal(
    (
      await f.request(endpoint, {
        method: 'POST',
        body: {},
        access: f.bobToken,
      })
    ).status,
    404,
  )
  assert.equal(
    (await f.request(endpoint, { method: 'POST', body: {}, access: null }))
      .status,
    401,
  )
  const response = await f.request(endpoint, {
    method: 'POST',
    body: { prompt: 'Injected unrelated context', model: 'expensive-override' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    title: 'Commutativity Proof',
    model: 'deepseek-fixture',
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [{ role: 'user', content: run.prompt }])
  assert.equal(f.chats.get(chat.id, 'owner').title, 'Original title')
  const rename = await f.request(`/api/chats/${chat.id}`, {
    method: 'PATCH',
    body: { title: 'Chosen name during active run' },
  })
  assert.equal(rename.status, 200)
  assert.equal(f.events.get(run.id).status, 'queued')
  assert.equal(f.chats.history(chat.id, 'owner').runs[0].id, run.id)
})

test('HTTP focused runs and updates reject stale selections and return compact proof references in history', async (t) => {
  const f = await httpFixture(t)
  const chat = f.chats.create('owner', f.project.id)
  const source = 'theorem focused : True := by\n  trivial'
  await f.workspaces.writeFile(
    f.project.id,
    'owner',
    'Main.lean',
    '-- preamble\n' + source + '\n',
  )
  const proofTarget = {
    path: 'Main.lean',
    startLine: 2,
    endLine: 3,
    name: 'focused',
    source,
  }
  const input = {
    mode: 'proofs',
    prompt: 'Complete the selected proof.',
    proofTarget,
  }
  const endpoint = `/api/chats/${chat.id}/runs`
  const stale = await f.request(endpoint, {
    method: 'POST',
    body: { ...input, proofTarget: { ...proofTarget, source: 'old version' } },
  })
  assert.equal(stale.status, 409)
  assert.match((await stale.json()).error, /selected proof changed/i)
  assert.equal(f.events.list('owner', f.project.id).length, 0)
  const started = await f.request(endpoint, { method: 'POST', body: input })
  assert.equal(started.status, 202)
  const job = await started.json()
  assert.deepEqual(job.proofTarget, proofTarget)
  const update = {
    id: '6fac9dbe-771c-4fe6-908a-aac383ae6626',
    text: 'Optimize only this statement.',
    proofTarget,
  }
  const sent = await f.request(`/api/runs/${job.id}/messages`, {
    method: 'POST',
    body: update,
  })
  assert.equal(sent.status, 200)
  assert.deepEqual((await sent.json()).followups[0].proofTarget, proofTarget)
  const reference = {
    path: proofTarget.path,
    startLine: 2,
    endLine: 3,
    name: 'focused',
  }
  const history = (await (await f.request(`/api/chats/${chat.id}`)).json())
    .runs[0]
  assert.deepEqual(history.proofTarget, reference)
  assert.deepEqual(history.followups[0].proofTarget, reference)
  for (const suffix of ['', '?summary=1']) {
    const summary = (
      await (
        await f.request(`/api/projects/${f.project.id}/runs${suffix}`)
      ).json()
    )[0]
    assert.deepEqual(summary.proofTarget, reference)
    assert(!JSON.stringify(summary).includes(source))
  }
  await f.request(`/api/runs/${job.id}/stop`, { method: 'POST', body: {} })
  const direct = await f.request(`/api/projects/${f.project.id}/runs`, {
    method: 'POST',
    body: input,
  })
  assert.equal(direct.status, 202)
  assert.deepEqual((await direct.json()).proofTarget, proofTarget)
})
