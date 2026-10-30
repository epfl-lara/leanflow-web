import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LiveMirror } from '../agent-live.mjs'
import { AgentManager } from '../agents.mjs'
import { EventStore } from '../events.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

const snapshot = { root: '/candidate', projectId: 'p', owner: 'alice' }
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(t, workspaceOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-live-test-'))
  const events = new EventStore(root)
  t.after(() => {
    events.close()
    return fs.rm(root, { recursive: true, force: true })
  })
  const calls = []
  const workspaces = {
    get: (id) => ({ id, status: 'ready' }),
    assertLive: async (...args) => {
      calls.push(['assert', ...args])
    },
    applyChanges: async (...args) => {
      calls.push(['apply', ...args])
    },
    undoLive: async (...args) => {
      calls.push(['undo', ...args])
      return { applied: true, files: [{ path: 'Main.lean', hash: 'restored' }] }
    },
    ...workspaceOverrides,
  }
  const manager = new AgentManager({
    events,
    workspaces,
    maxConcurrent: 0,
    runtime: {},
    settings: {},
    config: {
      provider: { LEMEX_API_KEY: 'fake' },
      models: [{ id: 'model' }],
      defaultModel: 'model',
      redact: String,
    },
  })
  return { manager, events, calls }
}
test('mirrors only plaintext Lean sources, serializes polling, and skips unchanged states', async () => {
  let changes = [
    { path: 'Main.lean', before: 'old', after: 'new' },
    { path: 'New.lean', before: null, after: 'new theorem' },
    { path: 'Delete.lean', before: 'old', after: null },
    { path: 'lakefile.lean', before: 'old', after: 'unsafe' },
    { path: 'Nested/lakefile.lean', before: 'old', after: 'unsafe' },
    { path: '.lake/packages/A.lean', before: 'old', after: 'unsafe' },
    { path: 'README.md', before: 'old', after: 'other' },
  ]
  const gate = deferred(),
    writes = [],
    updates = []
  const mirror = new LiveMirror({
    snapshot,
    workspaces: {
      changes: async () => changes,
      syncLive: async (_snapshot, current, previous) => {
        writes.push({ current, previous })
        if (writes.length === 1) await gate.promise
        return current
      },
    },
    onChanges: (current, paths) => updates.push({ current, paths }),
  })
  const first = mirror.poll(),
    same = mirror.poll()
  assert.equal(first, same, 'Concurrent ticks must share the pending operation')
  gate.resolve()
  await first
  assert.deepEqual(
    writes[0].current.map((change) => change.path),
    ['Main.lean', 'New.lean'],
  )
  assert.deepEqual(updates[0].paths, ['Main.lean', 'New.lean'])
  await mirror.poll()
  assert.equal(writes.length, 1)
  changes = []
  await mirror.poll()
  assert.deepEqual(
    writes[1].previous.map((change) => change.path),
    ['Main.lean', 'New.lean'],
  )
  assert.deepEqual(updates[1].paths, ['Main.lean', 'New.lean'])
  assert.deepEqual(mirror.liveChanges, [])
  await mirror.stop()
})

test('a saved-context conflict pauses mirroring without retrying or replacing user edits', async () => {
  let writes = 0
  const conflicts = [],
    updates = []
  const mirror = new LiveMirror({
    snapshot,
    workspaces: {
      changes: async () => [{ path: 'Main.lean', before: 'old', after: 'new' }],
      syncLive: async () => {
        writes++
        throw Object.assign(
          new Error('Project changed during assistant run.'),
          { status: 409 },
        )
      },
    },
    onConflict: (error) => conflicts.push(error),
    onChanges: (...args) => updates.push(args),
  })
  await mirror.poll()
  await mirror.poll()
  await mirror.stop({ flush: true })
  assert.equal(writes, 1)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].status, 409)
  assert.deepEqual(updates, [])
  assert(mirror.paused)
})

test('general live mirroring includes text deletions while keeping configuration and Lean deletions protected', async () => {
  const writes = [],
    updates = []
  const candidates = [
    { path: 'Notes.md', before: 'old', after: 'new' },
    { path: 'Old.txt', before: 'old', after: null },
    { path: 'Main.lean', before: 'old', after: 'new' },
    { path: 'Delete.lean', before: 'old', after: null },
    { path: 'lakefile.toml', before: 'old', after: 'changed' },
    { path: 'Nested/lean-toolchain', before: 'old', after: 'changed' },
    { path: '.lake/packages/A.lean', before: 'old', after: 'changed' },
  ]
  const mirror = new LiveMirror({
    snapshot,
    allowProjectFiles: true,
    workspaces: {
      changes: async () => candidates,
      syncLive: async (_snapshot, changes, _previous, options) => {
        assert.equal(options.allowProjectFiles, true)
        writes.push(changes)
        return changes
      },
    },
    onChanges: (_changes, paths) => updates.push(paths),
  })
  await mirror.poll()
  await mirror.stop()
  assert.deepEqual(
    writes[0].map((change) => change.path),
    ['Notes.md', 'Old.txt', 'Main.lean'],
  )
  assert.deepEqual(updates[0], ['Notes.md', 'Old.txt', 'Main.lean'])
})

test('temporary candidate collection errors produce one notice and retry without a saved-context conflict', async () => {
  let attempts = 0,
    writes = 0
  const notices = [],
    conflicts = []
  const mirror = new LiveMirror({
    snapshot,
    workspaces: {
      changes: async () => {
        attempts++
        if (attempts < 3)
          throw Object.assign(
            new Error('Scratch file changed while reading.'),
            { status: 409 },
          )
        return [{ path: 'Main.lean', before: 'old', after: 'new' }]
      },
      syncLive: async (_snapshot, changes) => {
        writes++
        return changes
      },
    },
    onNotice: (error, phase) => notices.push([error.message, phase]),
    onConflict: (error) => conflicts.push(error),
  })
  await mirror.poll()
  await mirror.poll()
  await mirror.poll()
  await mirror.stop()
  assert.equal(attempts, 3)
  assert.equal(writes, 1)
  assert.deepEqual(notices, [
    ['Scratch file changed while reading.', 'candidate'],
  ])
  assert.deepEqual(conflicts, [])
  assert.equal(mirror.paused, false)
})

test('Stop awaits an in-flight saved write and permits no writes after it returns', async () => {
  const entered = deferred(),
    release = deferred(),
    controller = new AbortController()
  let writes = 0,
    updates = 0
  const mirror = new LiveMirror({
    snapshot,
    signal: controller.signal,
    workspaces: {
      changes: async () => [{ path: 'Main.lean', before: 'old', after: 'new' }],
      syncLive: async (_snapshot, changes) => {
        writes++
        entered.resolve()
        await release.promise
        return changes
      },
    },
    onChanges: () => updates++,
  })
  const pending = mirror.poll()
  await entered.promise
  controller.abort()
  let stopped = false
  const stop = mirror.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  assert.equal(stopped, false)
  release.resolve()
  await Promise.all([pending, stop])
  assert.equal(updates, 1)
  await mirror.poll()
  await mirror.stop({ flush: true })
  assert.equal(writes, 1)
  assert.equal(updates, 1)
})

test('final flush mirrors the latest completed candidate after the timer is stopped', async () => {
  const writes = []
  const mirror = new LiveMirror({
    snapshot,
    workspaces: {
      changes: async () => [
        { path: 'Main.lean', before: 'old', after: 'checked' },
      ],
      syncLive: async (_snapshot, current) => {
        writes.push(current)
        return current
      },
    },
  })
  mirror.start()
  await mirror.stop({ flush: true })
  assert.equal(writes.length, 1)
  assert.equal(mirror.liveChanges[0].after, 'checked')
})

test('Ask & Search defaults to review first and allows an explicit live-edit choice', async (t) => {
  const { manager } = await fixture(t)
  const input = { mode: 'prove', prompt: 'Prove the theorem.' }
  assert.equal((await manager.start('alice', 'p1', input)).liveEdits, true)
  assert.equal(
    (await manager.start('alice', 'p2', { ...input, liveEdits: false }))
      .liveEdits,
    false,
  )
  assert.equal(
    (
      await manager.start('alice', 'search-live', {
        mode: 'search',
        prompt: 'Update the notes.',
        liveEdits: true,
      })
    ).liveEdits,
    true,
  )
  assert.equal(
    (
      await manager.start('alice', 'search-review', {
        mode: 'search',
        prompt: 'Update the notes.',
        liveEdits: false,
      })
    ).liveEdits,
    false,
  )
  assert.equal(
    (await manager.start('alice', 'p3', { ...input, mode: 'search' }))
      .liveEdits,
    false,
  )
  for (const liveEdits of [null, 1, 'true'])
    await assert.rejects(
      () => manager.start('alice', 'p4', { ...input, liveEdits }),
      {
        status: 400,
      },
    )
  await manager.shutdown()
})

test('accepting verified live edits validates current saved state without replaying the baseline', async (t) => {
  const { manager, events, calls } = await fixture(t)
  const changes = [{ path: 'Main.lean', before: 'old', after: 'checked' }]
  const job = events.create('alice', {
    kind: 'agent',
    projectId: 'p',
    snapshot,
    liveEdits: true,
    liveChanges: changes,
  })
  events.update(job.id, {
    status: 'completed',
    changes,
    verification: { complete: true },
  })
  assert.equal((await manager.apply('alice', job.id)).status, 'applied')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'assert')
  assert.deepEqual(calls[0][1], snapshot)
  assert.deepEqual(calls[0][2], changes)
  assert.equal((await manager.apply('alice', job.id)).status, 'applied')
})

test('accepting reviewed Lean changes rebuilds saved imports before refreshing the editor', async (t) => {
  const { manager, events, calls } = await fixture(t, {
    refreshEditorImports: async (projectId, owner) => {
      assert.equal(calls.at(-1)[0], 'apply')
      calls.push(['imports', projectId, owner])
      return { ready: true, message: 'Project imports are ready.' }
    },
  })
  const job = events.create('alice', {
    kind: 'agent',
    projectId: 'p',
    snapshot,
    liveEdits: false,
  })
  events.update(job.id, {
    status: 'completed',
    changes: [
      { path: 'New.lean', before: null, after: 'example : True := by trivial' },
    ],
    verification: { complete: true },
  })
  assert.equal((await manager.apply('alice', job.id)).status, 'applied')
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['apply', 'imports'],
  )
  assert.deepEqual(
    events.events(job.id).find((event) => event.type === 'files-updated').data,
    { paths: ['New.lean'], live: false, reason: 'imports' },
  )
  assert.equal(events.get(job.id).liveRevision, 1)
})

test('Undo is guarded by owner and stopped state, delegates protected restoration, and emits updates', async (t) => {
  const { manager, events, calls } = await fixture(t)
  const changes = [{ path: 'Main.lean', before: 'old', after: 'candidate' }]
  const job = events.create('alice', {
    kind: 'agent',
    projectId: 'p',
    snapshot,
    liveChanges: changes,
  })
  await assert.rejects(manager.undo('alice', job.id), { status: 409 })
  events.update(job.id, { status: 'cancelled' })
  manager.active.set(job.id, {})
  await assert.rejects(manager.undo('alice', job.id), { status: 409 })
  manager.active.delete(job.id)
  await assert.rejects(manager.undo('bob', job.id), { status: 404 })
  assert.equal((await manager.undo('alice', job.id)).liveUndone, true)
  assert.equal(events.get(job.id).liveRevision, 1)
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['undo'],
  )
  assert.deepEqual(
    events.events(job.id).find((event) => event.type === 'files-updated').data,
    { paths: ['Main.lean'], live: true, reason: 'undo' },
  )
  assert.equal((await manager.undo('alice', job.id)).liveUndone, true)
  assert.equal(calls.length, 1)
  events.update(job.id, {
    status: 'completed',
    changes,
    verification: { complete: true },
  })
  await assert.rejects(manager.apply('alice', job.id), { status: 409 })
})

test('Stop cancels the native process before waiting for live mirroring', async (t) => {
  const { manager, events } = await fixture(t)
  const job = events.create('alice', { kind: 'agent', projectId: 'p' })
  const controller = new AbortController(),
    release = deferred()
  const calls = []
  manager.active.set(job.id, {
    controller,
    rpc: { close: () => calls.push('native-close') },
    mirror: {
      stop: async () => {
        calls.push('mirror-stop')
        await release.promise
      },
    },
  })
  const stop = manager.stop('alice', job.id)
  assert(controller.signal.aborted)
  assert.equal(events.get(job.id).status, 'stopping')
  assert.deepEqual(calls, ['native-close', 'mirror-stop'])
  release.resolve()
  assert.equal((await stop).status, 'cancelled')
  manager.active.delete(job.id)
})

test('starting a new run waits for the cancelled run to finish live writes and active teardown', async (t) => {
  const { manager, events } = await fixture(t)
  const job = events.create('alice', { kind: 'agent', projectId: 'p' })
  const controller = new AbortController(),
    entered = deferred(),
    release = deferred()
  let saved = 'old'
  const mirror = new LiveMirror({
    snapshot,
    signal: controller.signal,
    workspaces: {
      changes: async () => [{ path: 'Main.lean', before: 'old', after: 'new' }],
      syncLive: async (_snapshot, changes) => {
        entered.resolve()
        await release.promise
        saved = changes[0].after
        return changes
      },
    },
  })
  manager.active.set(job.id, { controller, mirror })
  const pending = mirror.poll()
  await entered.promise
  let stopped = false
  const stop = manager.stop('alice', job.id).then(() => {
    stopped = true
  })
  assert.equal(events.get(job.id).status, 'stopping')
  assert.equal(stopped, false)
  assert.equal(saved, 'old')
  const input = { mode: 'prove', prompt: 'Continue the proof.' }
  await assert.rejects(() => manager.start('alice', 'p', input), {
    status: 409,
  })
  assert.equal(
    events.list('alice', 'p').length,
    1,
    'Rejected start must not create a queued job',
  )
  assert.equal(
    (await manager.start('alice', 'other', input)).projectId,
    'other',
  )
  release.resolve()
  await Promise.all([pending, stop])
  assert.equal(saved, 'new')
  assert.equal(stopped, true)
  await assert.rejects(() => manager.start('alice', 'p', input), {
    status: 409,
  })
  // The execution finally block removes the active entry after all teardown.
  manager.active.delete(job.id)
  assert.equal((await manager.start('alice', 'p', input)).status, 'queued')
  await manager.shutdown()
})

test('starting a run is rejected after manager shutdown begins', async (t) => {
  const { manager, events } = await fixture(t)
  await manager.shutdown()
  await assert.rejects(
    () =>
      manager.start('alice', 'p', {
        mode: 'prove',
        prompt: 'Prove the theorem.',
      }),
    { status: 503 },
  )
  assert.equal(events.list('alice', 'p').length, 0)
})

test('Undo of an older chat cannot modify saved sources while another project task is queued or stopping', async (t) => {
  const { manager, events, calls } = await fixture(t)
  const old = events.create('alice', {
    kind: 'agent',
    projectId: 'p',
    snapshot,
    liveChanges: [{ path: 'Main.lean', before: 'old', after: 'new' }],
  })
  events.update(old.id, { status: 'completed' })
  const running = events.create('alice', { kind: 'agent', projectId: 'p' })
  await assert.rejects(manager.undo('alice', old.id), { status: 409 })
  assert.equal(calls.length, 0)
  events.update(running.id, { status: 'cancelled' })
  manager.active.set(running.id, {})
  await assert.rejects(manager.undo('alice', old.id), { status: 409 })
  assert.equal(calls.length, 0)
  manager.active.delete(running.id)
  assert.equal((await manager.undo('alice', old.id)).liveUndone, true)
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['undo'],
  )
})

test('the controller and real workspace store preserve the original baseline across live updates and Undo', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lemex-live-integration-'),
  )
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    run: async (cwd, args) => {
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(cwd, '.lake'), { recursive: true })
        await fs.writeFile(
          path.join(cwd, 'lake-manifest.json'),
          JSON.stringify({ packages: [] }),
        )
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const store = await new WorkspaceStore({ dataDir: root, runtime }).init()
  const events = new EventStore(root)
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    events.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const project = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(project.id)
  const original = await store.readFile(project.id, 'alice', 'Main.lean')
  const snapshot = await store.snapshot(project.id, 'alice', 'integration')
  const job = events.create('alice', {
    kind: 'agent',
    projectId: project.id,
    snapshot,
    liveEdits: true,
    liveRevision: 0,
  })
  const mirror = new LiveMirror({
    snapshot,
    workspaces: store,
    onChanges(liveChanges, paths) {
      events.update(job.id, {
        liveChanges,
        liveRevision: (events.get(job.id).liveRevision || 0) + 1,
      })
      events.event(job.id, 'files-updated', { paths, live: true })
    },
  })
  const first = 'theorem live_example : True := by\n  trivial\n'
  const final = 'theorem live_example : True := by\n  exact True.intro\n'
  await fs.writeFile(path.join(snapshot.root, 'Main.lean'), first)
  await mirror.poll()
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    first,
  )
  await fs.writeFile(path.join(snapshot.root, 'Main.lean'), final)
  await mirror.stop({ flush: true })
  const live = events.get(job.id)
  assert.equal(live.liveRevision, 2)
  assert.equal(live.liveChanges[0].before, original.content)
  assert.equal(live.liveChanges[0].after, final)
  const clean = await store.verificationCopy(
    snapshot,
    await store.changes(snapshot),
    { liveChanges: live.liveChanges },
  )
  assert.equal(
    await fs.readFile(path.join(clean.root, 'Main.lean'), 'utf8'),
    final,
  )
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    final,
  )
  events.update(job.id, { status: 'cancelled' })
  const manager = new AgentManager({
    events,
    workspaces: store,
    runtime,
    settings: {},
    config: { redact: String },
  })
  await manager.undo('alice', job.id)
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    original.content,
  )
  assert.equal(events.get(job.id).liveRevision, 3)
  assert.equal(events.get(job.id).liveUndone, true)
  assert.deepEqual(
    events
      .events(job.id)
      .filter((event) => event.type === 'files-updated')
      .map((event) => event.data.paths),
    [['Main.lean'], ['Main.lean'], ['Main.lean']],
  )
})
