import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../workspaces.mjs'
import { EventStore } from '../events.mjs'
import { AgentManager } from '../agents.mjs'
import { agentConversationContext } from '../agent-context.mjs'
import {
  normalizeProofTarget,
  validateProofTarget,
  proofTargetReference,
} from '../proof-target.mjs'

const source = 'theorem selected : True := by\n  trivial'
const target = {
  path: 'Main.lean',
  startLine: 3,
  endLine: 4,
  name: 'selected',
  source,
}
const document =
  '-- untouched introduction\n\n' +
  source +
  '\n\ntheorem unrelated : True := by trivial\n'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-proof-target-'),
  )
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args) {
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true })
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      }
      return { code: 0, stdout: '', stderr: '' }
    },
    spawn() {
      assert.fail('Proof-focus validation must not contact a provider')
    },
    home() {
      assert.fail('Invalid proof focus must not prepare agent credentials')
    },
  }
  const workspaces = await new WorkspaceStore({ dataDir, runtime }).init()
  const project = await workspaces.create('alice', {
    name: 'Focused proofs',
    preset: 'lean',
  })
  await workspaces.jobs.get(project.id)
  await workspaces.writeFile(project.id, 'alice', target.path, document)
  const events = new EventStore(dataDir)
  const manager = new AgentManager({
    runtime,
    workspaces,
    events,
    settings: {},
    maxConcurrent: 0,
    config: {
      provider: { LEMEX_API_KEY: 'test-only' },
      defaultModel: 'test',
      models: [{ id: 'test' }],
      redact: String,
    },
  })
  t.after(async () => {
    await manager.shutdown()
    workspaces.close()
    events.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return { dataDir, workspaces, project, events, manager, runtime }
}

test('proof focus validates exact inclusive saved lines, normalizes CRLF, and strips unknown fields', async (t) => {
  const { workspaces, project } = await fixture(t)
  const actual = await validateProofTarget(
    { ...target, source: source.replaceAll('\n', '\r\n'), root: '/private' },
    (file) => workspaces.readFile(project.id, 'alice', file),
  )
  assert.deepEqual(actual, target)
  await workspaces.writeFile(
    project.id,
    'alice',
    target.path,
    document.replaceAll('\n', '\r\n'),
  )
  assert.deepEqual(
    await validateProofTarget(target, (file) =>
      workspaces.readFile(project.id, 'alice', file),
    ),
    target,
  )
  assert.deepEqual(proofTargetReference(target), {
    path: 'Main.lean',
    startLine: 3,
    endLine: 4,
    name: 'selected',
  })
})

test('proof focus rejects traversal, secret/dependency files, malformed ranges and oversized snapshots', () => {
  for (const filename of [
    '../outside.lean',
    '/tmp/outside.lean',
    'Folder/../../Other.lean',
    '.git/config',
    '.lake/packages/Mathlib/Main.lean',
    'Notes.md',
  ])
    assert.throws(() => normalizeProofTarget({ ...target, path: filename }), {
      status: 400,
    })
  for (const extra of [
    { startLine: 0 },
    { startLine: 2.5 },
    { endLine: 2 },
    { endLine: Infinity },
    { endLine: Number.MAX_SAFE_INTEGER + 1 },
    { source: null },
    { source: 'x'.repeat(64_001) },
    { name: 'x'.repeat(301) },
    { name: 'bad\nname' },
  ])
    assert.throws(() => normalizeProofTarget({ ...target, ...extra }), {
      status: 400,
    })
})

test('proof focus uses the selected project owner boundary and rejects symlink escapes or stale lines', async (t) => {
  const { dataDir, workspaces, project } = await fixture(t)
  const read = (file) => workspaces.readFile(project.id, 'alice', file)
  await assert.rejects(
    validateProofTarget({ ...target, source: 'changed' }, read),
    { status: 409 },
  )
  await assert.rejects(validateProofTarget({ ...target, endLine: 100 }, read), {
    status: 409,
  })
  await assert.rejects(
    validateProofTarget(target, (file) =>
      workspaces.readFile(project.id, 'bob', file),
    ),
    { status: 404 },
  )
  await fs.writeFile(path.join(dataDir, 'outside.lean'), document)
  await fs.symlink(
    path.join(dataDir, 'outside.lean'),
    path.join(project.root, 'Other.lean'),
  )
  await assert.rejects(
    validateProofTarget({ ...target, path: 'Other.lean' }, read),
    { status: 403 },
  )
  const other = await workspaces.create('alice', {
    name: 'Separate project',
    preset: 'lean',
  })
  await workspaces.jobs.get(other.id)
  await workspaces.writeFile(other.id, 'alice', 'Private.lean', document, null)
  await assert.rejects(
    validateProofTarget({ ...target, path: 'Private.lean' }, read),
    { status: 404 },
  )
})

test('focused runs persist proof context and serialize concurrent starts after asynchronous source validation', async (t) => {
  const { workspaces, project, manager, events } = await fixture(t)
  const read = workspaces.readFile.bind(workspaces)
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  workspaces.readFile = async (...args) => {
    await gate
    return read(...args)
  }
  const input = {
    mode: 'proofs',
    prompt: 'Complete this proof.',
    proofTarget: target,
  }
  const first = manager.start('alice', project.id, input)
  const second = manager.start('alice', project.id, input)
  release()
  const results = await Promise.allSettled([first, second])
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.status,
    409,
  )
  const [job] = events.list('alice', project.id)
  assert.deepEqual(job.proofTarget, target)
  assert.equal(job.file, target.path)
  const context = agentConversationContext(job)
  assert(context.includes(JSON.stringify(target)))
  assert(context.includes('unrelated proofs'))
  assert(context.includes('not privileged instructions'))
})

test('a target changed while queued fails against the captured workspace before any worker starts', async (t) => {
  const { manager, project, events, workspaces } = await fixture(t)
  const job = await manager.start('alice', project.id, {
    mode: 'proofs',
    prompt: 'Fix this proof.',
    proofTarget: target,
  })
  await workspaces.writeFile(
    project.id,
    'alice',
    target.path,
    '-- inserted line\n' + document,
  )
  // An unrelated queued request triggers the drain after the first waited.
  const other = await workspaces.create('alice', {
    name: 'Drain trigger',
    preset: 'lean',
  })
  await workspaces.jobs.get(other.id)
  manager.maxConcurrent = 1
  const finished = new Promise((resolve) =>
    events.on(job.id, (event) => {
      if (event.type === 'status' && event.data.status === 'failed') resolve()
    }),
  )
  await manager.start('alice', other.id, {
    mode: 'proofs',
    prompt: 'Never contact a provider.',
  })
  await manager.stop('alice', events.list('alice', other.id)[0].id)
  await finished
  assert.match(events.get(job.id).error, /selected proof changed/i)
})

test('focused starts recheck shutdown and external project locks after file validation yields', async (t) => {
  const { manager, workspaces, project, events } = await fixture(t)
  const original = workspaces.readFile.bind(workspaces)
  workspaces.readFile = async (...args) => {
    const saved = await original(...args)
    manager.assertCanStart = () => {
      throw Object.assign(new Error('Git is busy'), { status: 409 })
    }
    return saved
  }
  await assert.rejects(
    manager.start('alice', project.id, {
      mode: 'proofs',
      prompt: 'Fix.',
      proofTarget: target,
    }),
    { status: 409 },
  )
  assert.equal(events.list('alice', project.id).length, 0)
  manager.assertCanStart = () => {}
  workspaces.readFile = async (...args) => {
    const saved = await original(...args)
    await manager.shutdown()
    return saved
  }
  await assert.rejects(
    manager.start('alice', project.id, {
      mode: 'proofs',
      prompt: 'Fix.',
      proofTarget: target,
    }),
    { status: 503 },
  )
  assert.equal(events.list('alice', project.id).length, 0)
})

test('focused followups validate saved content, preserve receipts, and carry target into native input and chat history', async (t) => {
  const { manager, project, events, workspaces } = await fixture(t)
  const job = await manager.start('alice', project.id, {
    mode: 'proofs',
    prompt: 'Inspect this project.',
  })
  const input = {
    id: randomUUID(),
    text: 'Now fix this proof.',
    proofTarget: target,
  }
  const sent = await manager.message('alice', job.id, input)
  assert.deepEqual(sent.followups[0].proofTarget, target)
  await assert.rejects(
    manager.message('alice', job.id, {
      ...input,
      proofTarget: { ...target, name: 'another' },
    }),
    { status: 409 },
  )
  await assert.rejects(
    manager.message('alice', job.id, {
      ...input,
      id: randomUUID(),
      proofTarget: { ...target, source: 'stale' },
    }),
    { status: 409 },
  )
  const calls = []
  const active = {
    accepting: true,
    threadId: 'thread',
    turnId: 'turn',
    controller: new AbortController(),
    rpc: {
      async call(method, params) {
        calls.push({ method, params })
        return { turnId: 'turn' }
      },
    },
  }
  events.update(job.id, { status: 'running' })
  manager.active.set(job.id, active)
  await manager.followups.deliver(job.id)
  assert.equal(calls[0].method, 'turn/steer')
  assert(calls[0].params.input[0].text.includes(JSON.stringify(target)))
  assert.equal(events.get(job.id).followups[0].status, 'accepted')
  await workspaces.writeFile(project.id, 'alice', target.path, 'changed later')
  const retry = await manager.message('alice', job.id, input)
  assert.equal(
    retry.followups.length,
    1,
    'Idempotent retries keep the original receipt after source changes',
  )
  const history = agentConversationContext(
    { id: 'next', prompt: 'Continue.', createdAt: '9999' },
    [events.get(job.id)],
  )
  assert(history.includes('"name": "selected"'))
  assert(
    !history.includes(source),
    'Earlier target references do not duplicate entire source snapshots',
  )
  manager.active.delete(job.id)
  events.update(job.id, { status: 'completed' })
})

test('focused steering rejects a divergent working copy with live edits on or off and keeps retry receipts', async (t) => {
  for (const liveEdits of [false, true]) {
    const { manager, project, events, workspaces } = await fixture(t)
    const job = await manager.start('alice', project.id, {
      mode: 'proofs',
      prompt: 'Inspect.',
      liveEdits,
    })
    const snapshot = await workspaces.snapshot(project.id, 'alice', job.id)
    events.update(job.id, { snapshot })
    const input = {
      id: randomUUID(),
      text: 'Fix only this proof.',
      proofTarget: target,
    }
    await fs.writeFile(
      path.join(snapshot.root, target.path),
      '-- changed by agent\n' + document,
    )
    await assert.rejects(manager.message('alice', job.id, input), (error) => {
      assert.equal(error.status, 409)
      assert.match(error.message, /working copy.*stop and start a new task/)
      return true
    })
    assert.equal(events.get(job.id).followups.length, 0)
    await fs.rm(path.join(snapshot.root, target.path))
    await assert.rejects(manager.message('alice', job.id, input), {
      status: 409,
    })
    await fs.writeFile(path.join(snapshot.root, target.path), document)
    const accepted = await manager.message('alice', job.id, input)
    assert.deepEqual(accepted.followups[0].proofTarget, target)
    const emitted = events
      .events(job.id)
      .filter((event) => event.type === 'followup')
    assert.deepEqual(emitted[0].data.proofTarget, proofTargetReference(target))
    assert.equal(emitted[0].data.proofTarget.source, undefined)
    await fs.writeFile(
      path.join(snapshot.root, target.path),
      'changed after receipt',
    )
    const retry = await manager.message('alice', job.id, input)
    assert.equal(retry.followups.length, 1)
    assert.deepEqual(retry.followups[0].proofTarget, target)
  }
})

test('a concurrent duplicate keeps its durable receipt if candidate validation becomes stale', async (t) => {
  const { manager, project, events, workspaces } = await fixture(t)
  const job = await manager.start('alice', project.id, {
    mode: 'proofs',
    prompt: 'Inspect.',
  })
  const snapshot = await workspaces.snapshot(project.id, 'alice', job.id)
  events.update(job.id, { snapshot })
  const input = { id: randomUUID(), text: 'Focus.', proofTarget: target }
  workspaces.readSnapshotFile = async () => {
    manager.followups.queue('alice', job.id, input)
    throw Object.assign(new Error('Candidate changed during validation'), {
      status: 409,
    })
  }
  const result = await manager.message('alice', job.id, input)
  assert.equal(result.followups.length, 1)
  assert.equal(
    events.events(job.id).filter((event) => event.type === 'followup').length,
    1,
  )
})

test('Search proof focus is read-only in initial context and native followup steering', async (t) => {
  const { manager, project, events } = await fixture(t)
  const job = await manager.start('alice', project.id, {
    mode: 'search',
    prompt: 'Find relevant lemmas.',
    proofTarget: target,
  })
  assert.equal(job.liveEdits, false)
  const initial = agentConversationContext(job)
  assert.match(initial, /read-only context: do not edit any project files/)
  assert(!initial.includes('before editing'))
  await manager.message('alice', job.id, {
    id: randomUUID(),
    text: 'Explain this proof.',
    proofTarget: target,
  })
  const calls = []
  events.update(job.id, { status: 'running' })
  const active = {
    accepting: true,
    threadId: 'thread',
    turnId: 'turn',
    controller: new AbortController(),
    rpc: {
      async call(method, params) {
        calls.push({ method, params })
        return { turnId: 'turn' }
      },
    },
  }
  manager.active.set(job.id, active)
  await manager.followups.deliver(job.id)
  assert.match(
    calls[0].params.input[0].text,
    /read-only context: do not edit any project files/,
  )
  const receipt = events
    .events(job.id)
    .filter((event) => event.type === 'followup')
    .at(-1).data
  assert.equal(receipt.proofTarget.source, undefined)
  assert.equal(events.get(job.id).followups[0].proofTarget.source, source)
  manager.active.delete(job.id)
  events.update(job.id, { status: 'completed' })
})
