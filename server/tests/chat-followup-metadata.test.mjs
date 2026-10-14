import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { ChatStore } from '../chats.mjs'
import { EventStore } from '../events.mjs'
import { FollowupInbox } from '../agent-followups.mjs'

const changes = [
  {
    path: 'Large.lean',
    before: '-- original source\n' + 'x'.repeat(2 * 1024 * 1024),
    after: '-- changed source\n' + 'y'.repeat(2 * 1024 * 1024),
    beforeHash: 'saved-source',
  },
]
const unavailableSource =
  'proof source deliberately unavailable to metadata consumers'

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-chat-metadata-'),
  )
  const events = new EventStore(directory)
  const projects = new Map([
    ['p', { id: 'p', owner: 'alice', name: 'Proofs' }],
    ['q', { id: 'q', owner: 'alice', name: 'Other proofs' }],
  ])
  const chats = new ChatStore({
    dataDir: directory,
    events,
    workspaces: {
      get(id, owner) {
        const project = projects.get(id)
        if (!project || project.owner !== owner)
          throw Object.assign(new Error('Project not found'), { status: 404 })
        return project
      },
    },
  }).init()
  const active = new Map()
  const inbox = new FollowupInbox({
    events,
    getActive: (id) => active.get(id),
    emit: (id, type, data) => events.event(id, type, data),
  })
  t.after(async () => {
    chats.close()
    events.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { directory, events, chats, active, inbox }
}

function hideSources(events, id) {
  events.updateMetadata(id, { changes, liveChanges: changes })
  const rows = events.db
    .prepare('SELECT field,payload FROM job_changes WHERE job=? ORDER BY field')
    .all(id)
  events.db
    .prepare('UPDATE job_changes SET payload=? WHERE job=?')
    .run(unavailableSource, id)
  assert.throws(() => events.get(id), SyntaxError)
  return () => {
    for (const row of rows)
      events.db
        .prepare('UPDATE job_changes SET payload=? WHERE job=? AND field=?')
        .run(row.payload, id, row.field)
  }
}

test('chat polling, linking and bounded history retain fields without hydrating proof sources', async (t) => {
  const { events, chats } = await fixture(t)
  const chat = chats.create('alice', 'p')
  const jobs = []
  for (let index = 0; index < 101; index++) {
    const job = events.create('alice', {
      kind: 'agent',
      projectId: 'p',
      chatId: chat.id,
      prompt: `Task ${index}`,
      mode: 'prove',
    })
    events.updateMetadata(job.id, {
      status: 'completed',
      message: `Answer ${index}`,
      reasoning: `Reasoning ${index}`,
      reasoningBlocks: [
        { id: `block-${index}`, field: 'reasoning', start: 0, end: 9 },
      ],
      changes: [
        { path: `Proof${index}.lean`, before: 'original', after: 'changed' },
      ],
      liveChanges: [
        { path: `Proof${index}.lean`, before: 'original', after: 'changed' },
      ],
      liveRevision: index,
    })
    events.db
      .prepare('UPDATE job_changes SET payload=? WHERE job=?')
      .run(unavailableSource, job.id)
    chats.appendRun(chat.id, 'alice', job)
    jobs.push(job)
  }
  assert.throws(() => events.get(jobs.at(-1).id), SyntaxError)
  const listed = chats.list('alice', 'p')[0]
  assert.equal(listed.runCount, 101)
  assert.equal(listed.lastRunId, jobs.at(-1).id)
  assert.equal(listed.status, 'completed')
  assert.equal(listed.lastMode, 'prove')
  assert.equal(chats.get(chat.id, 'alice').lastRunId, listed.lastRunId)
  const history = chats.history(chat.id, 'alice')
  assert.equal(history.runs.length, 100)
  assert.equal(history.runs[0].id, jobs[1].id)
  assert.equal(history.runs.at(-1).message, 'Answer 100')
  assert.equal(history.runs.at(-1).reasoning, 'Reasoning 100')
  assert.equal(history.runs.at(-1).liveRevision, 100)
  assert.deepEqual(history.runs.at(-1).changes, [{ path: 'Proof100.lean' }])
  assert.deepEqual(history.runs.at(-1).liveChanges, [{ path: 'Proof100.lean' }])
  assert.deepEqual(history.runs.at(-1).reasoningBlocks, [
    { id: 'block-100', field: 'reasoning', start: 0, end: 9 },
  ])
  assert.throws(() => chats.history(chat.id, 'bob'), { status: 404 })
  assert.throws(() => chats.appendRun(chat.id, 'bob', jobs.at(-1)), {
    status: 404,
  })
  const other = chats.create('alice', 'q')
  assert.throws(() => chats.appendRun(other.id, 'alice', jobs.at(-1)), {
    status: 404,
  })
})

test('chat trash and restore inspect run activity while proof source rows remain unavailable', async (t) => {
  const { events, chats } = await fixture(t)
  const chat = chats.create('alice', 'p', { title: 'Preserved chat' })
  const job = events.create('alice', {
    kind: 'agent',
    projectId: 'p',
    chatId: chat.id,
  })
  chats.appendRun(chat.id, 'alice', job)
  const restoreSources = hideSources(events, job.id)
  events.updateMetadata(job.id, { status: 'running' })
  assert.throws(() => chats.trash('alice', chat.id), { status: 409 })
  events.updateMetadata(job.id, { status: 'completed' })
  const receipt = chats.trash('alice', chat.id)
  assert.deepEqual(chats.list('alice', 'p'), [])
  events.updateMetadata(job.id, { status: 'verifying' })
  assert.throws(() => chats.restore('alice', receipt.trashId), { status: 409 })
  events.updateMetadata(job.id, { status: 'completed' })
  assert.equal(chats.restore('alice', receipt.trashId).restored, true)
  assert.equal(chats.history(chat.id, 'alice').runs[0].id, job.id)
  restoreSources()
  assert.deepEqual(events.get(job.id, 'alice').changes, changes)
  assert.deepEqual(events.snapshot(job.id, 'alice').liveChanges, changes)
})

test('followup queue, native ACK, durable duplicates and finish never hydrate or rewrite proof sources', async (t) => {
  const { events, active, inbox } = await fixture(t)
  const job = events.create('alice', {
    kind: 'agent',
    projectId: 'p',
    mode: 'proofs',
    followups: [],
  })
  events.updateMetadata(job.id, { status: 'running', message: 'a🙂b' })
  const restoreSources = hideSources(events, job.id)
  events.db.exec(
    "CREATE TRIGGER reject_source_update BEFORE UPDATE ON job_changes BEGIN SELECT RAISE(ABORT,'metadata must not rewrite proof sources'); END",
  )
  const calls = []
  active.set(job.id, {
    accepting: true,
    threadId: 'thread',
    turnId: 'turn',
    controller: new AbortController(),
    output: {
      flushBuffered: () => events.append(job.id, 'message', '!', 'message'),
    },
    rpc: {
      call: async (method, params) => {
        calls.push({ method, params })
        return { turnId: 'turn' }
      },
    },
  })
  const input = { id: randomUUID(), text: 'Keep the assumptions.' }
  const queued = inbox.queue('alice', job.id, input, 'Saved file context')
  assert.equal(queued.created, true)
  assert.equal(queued.job.followups[0].status, 'pending')
  assert.equal(queued.job.followups[0].messageOffset, 5)
  assert.deepEqual(queued.job.changes, [{ path: 'Large.lean' }])
  assert.throws(() => inbox.queue('bob', job.id, input), { status: 404 })
  await inbox.deliver(job.id)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'turn/steer')
  assert.equal(calls[0].params.clientUserMessageId, input.id)
  assert.match(calls[0].params.input[0].text, /Saved file context/)
  assert.equal(inbox.queue('alice', job.id, input).created, false)
  assert.equal(
    inbox.queue('alice', job.id, input).job.followups[0].status,
    'accepted',
  )
  const pending = { id: randomUUID(), text: 'Additional constraint.' }
  inbox.queue('alice', job.id, pending)
  active.get(job.id).accepting = false
  events.updateMetadata(job.id, { status: 'completed' })
  const finished = await inbox.finish(job.id, 'Run finished before delivery.')
  assert.deepEqual(
    finished.followups.map((entry) => entry.status),
    ['accepted', 'failed'],
  )
  assert.equal(inbox.queue('alice', job.id, pending).created, false)
  assert.throws(
    () => inbox.queue('alice', job.id, { id: randomUUID(), text: 'Too late.' }),
    { status: 409 },
  )
  assert.equal(calls.length, 1)
  assert(
    events.db
      .prepare('SELECT payload FROM job_changes WHERE job=?')
      .all(job.id)
      .every((row) => row.payload === unavailableSource),
  )
  events.db.exec('DROP TRIGGER reject_source_update')
  restoreSources()
  assert.deepEqual(events.get(job.id).changes, changes)
  assert.deepEqual(events.get(job.id).liveChanges, changes)
})

test('followup cancellation and restart receipts remain definitive without source hydration', async (t) => {
  const { events, active, inbox } = await fixture(t)
  const job = events.create('alice', {
    kind: 'agent',
    projectId: 'p',
    mode: 'proofs',
    followups: [],
  })
  events.updateMetadata(job.id, { status: 'running' })
  hideSources(events, job.id)
  const first = { id: randomUUID(), text: 'Try induction.' }
  const second = { id: randomUUID(), text: 'Preserve the namespace.' }
  inbox.queue('alice', job.id, first)
  inbox.queue('alice', job.id, second)
  let acknowledge
  const session = {
    accepting: true,
    threadId: 'thread',
    turnId: 'turn',
    controller: new AbortController(),
    rpc: {
      call: () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    },
  }
  active.set(job.id, session)
  const delivery = inbox.deliver(job.id)
  session.accepting = false
  session.controller.abort()
  events.updateMetadata(job.id, { status: 'cancelled' })
  acknowledge({ turnId: 'turn' })
  await delivery
  inbox.recover()
  const metadata = events.getMetadata(job.id, 'alice')
  assert.deepEqual(
    metadata.followups.map((entry) => entry.status),
    ['failed', 'failed'],
  )
  assert.match(metadata.followups[0].error, /acknowledged.*stopped/)
  assert.match(
    metadata.followups[1].error,
    /server restarted.*delivery could be confirmed/,
  )
  assert.equal(inbox.queue('alice', job.id, first).created, false)
  assert.equal(metadata.status, 'cancelled')
})
