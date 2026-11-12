import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../workspaces.mjs'
import { syncBuiltinESMExports } from 'node:module'

const TOOLCHAIN = 'leanprover/lean4:v4.34.1'
async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-sharing-store-'),
  )
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: TOOLCHAIN }],
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
      return { code: 0, stdout: 'Lean version 4.34.1\n', stderr: '' }
    },
  }
  let store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', {
    preset: 'lean',
    name: 'Shared proofs',
  })
  await store.jobs.get(project.id)
  return {
    store,
    project,
    dataDir,
    runtime,
    async reopen() {
      store.close()
      store = await new WorkspaceStore({ dataDir, runtime }).init()
      return store
    },
  }
}

const bounded = (promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error('Operation did not finish without waiting for a worker.'),
          ),
        1500,
      )
      timer.unref()
    }),
  ])

test('durable project roles enforce file, metadata and sharing permissions', async (t) => {
  const f = await fixture(t),
    { project } = f
  await f.store.setMember(project.id, 'alice', 'bob', 'editor')
  await f.store.setMember(project.id, 'alice', 'eve', 'viewer')
  const store = await f.reopen()
  assert.equal(store.get(project.id, 'alice').accessRole, 'admin')
  assert.equal(store.list('bob')[0].accessRole, 'editor')
  assert.equal(store.list('eve')[0].accessRole, 'viewer')
  assert.deepEqual(store.list('stranger'), [])
  assert.throws(() => store.get(project.id, 'stranger'), { status: 404 })
  assert.equal(
    (await store.files(project.id, 'eve')).every((file) => file.readOnly),
    true,
  )
  const source = await store.readFile(project.id, 'eve', 'Main.lean')
  assert.equal(source.readOnly, true)
  await assert.rejects(
    store.writeFile(
      project.id,
      'eve',
      'Main.lean',
      '-- overwritten\n',
      source.hash,
    ),
    { status: 403 },
  )
  await assert.rejects(
    store.createFolder(project.id, 'eve', { path: 'Proofs' }),
    { status: 403 },
  )
  await assert.rejects(
    store.upload(project.id, 'eve', [{ path: 'Other.lean', content: '' }]),
    { status: 403 },
  )
  await assert.rejects(
    store.rename(project.id, 'bob', { name: 'Other name' }),
    { status: 403 },
  )
  await assert.rejects(store.trash(project.id, 'bob'), { status: 403 })
  await assert.rejects(store.setMember(project.id, 'bob', 'eve', 'editor'), {
    status: 403,
  })
  await store.writeFile(
    project.id,
    'bob',
    'Main.lean',
    '-- editor\n',
    source.hash,
  )
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    '-- editor\n',
  )
})

test('share links store hashes, can be revoked, and never downgrade existing access', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const editor = await store.createShareLink(project.id, 'alice', 'editor')
  const viewer = await store.createShareLink(project.id, 'alice', 'viewer')
  assert.equal(editor.token.length, 43)
  assert.equal(
    JSON.stringify(store.sharing(project.id, 'alice')).includes(editor.token),
    false,
  )
  assert.equal(
    store.db
      .prepare('SELECT token_hash FROM project_share_links WHERE id=?')
      .get(editor.id).token_hash.length,
    64,
  )
  assert.equal(
    (await store.joinShareLink('bob', editor.token)).accessRole,
    'editor',
  )
  assert.equal(
    (await store.joinShareLink('bob', viewer.token)).accessRole,
    'editor',
  )
  assert.equal(
    (await store.joinShareLink('alice', viewer.token)).accessRole,
    'admin',
  )
  await store.revokeShareLink(project.id, 'alice', editor.id)
  await assert.rejects(store.joinShareLink('carol', editor.token), {
    status: 404,
  })
  // Revoking a link prevents future joins; explicit membership removal revokes
  // accounts that have already joined.
  assert.equal(store.get(project.id, 'bob').accessRole, 'editor')
  await store.removeMember(project.id, 'alice', 'bob')
  assert.throws(() => store.get(project.id, 'bob'), { status: 404 })
  assert.ok((await fs.stat(path.join(dataDir, 'workspaces.sqlite'))).isFile())
})

test('queued writes recheck permissions and stale simultaneous saves preserve one durable winner', async (t) => {
  const { store, project } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const source = await store.readFile(project.id, 'bob', 'Main.lean')
  let release
  store.locks.set(
    project.id,
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const remove = store.removeMember(project.id, 'alice', 'bob')
  const pending = store.writeFile(
    project.id,
    'bob',
    'Main.lean',
    '-- revoked\n',
    source.hash,
  )
  release()
  await remove
  await assert.rejects(pending, { status: 404 })
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).hash,
    source.hash,
  )
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const outcomes = await Promise.allSettled([
    store.writeFile(
      project.id,
      'alice',
      'Main.lean',
      '-- alice\n',
      source.hash,
    ),
    store.writeFile(project.id, 'bob', 'Main.lean', '-- bob\n', source.hash),
  ])
  assert.equal(
    outcomes.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.equal(
    outcomes.find((result) => result.status === 'rejected').reason.status,
    409,
  )
  await assert.rejects(
    store.writeFile(project.id, 'bob', 'Main.lean', '-- unchecked\n'),
    { status: 400 },
  )
})

test('shared agent snapshots retain caller identity and cannot apply, mirror, verify or undo after revocation', async (t) => {
  const { store, project } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const snapshot = await store.snapshot(project.id, 'bob', 'bob-private-run')
  assert.equal(snapshot.owner, 'alice')
  assert.equal(snapshot.actor, 'bob')
  await fs.writeFile(path.join(snapshot.root, 'Main.lean'), '-- agent edit\n')
  const changes = await store.changes(snapshot)
  await store.syncLive(snapshot, changes)
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    '-- agent edit\n',
  )
  await store.setMember(project.id, 'alice', 'bob', 'viewer')
  for (const operation of [
    () => store.syncLive(snapshot, changes, changes),
    () => store.assertLive(snapshot, changes),
    () => store.undoLive(snapshot, changes),
    () => store.verificationCopy(snapshot, changes),
    () => store.assertSnapshotCurrent(snapshot),
    () => store.applyChanges(project.id, 'bob', changes, { snapshot }),
  ])
    await assert.rejects(operation(), { status: 403 })
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    '-- agent edit\n',
  )
})

test('membership changes do not wait for setup workers and revocation aborts the caller setup', async (t) => {
  const { store, project, runtime } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  let started, release
  const waiting = new Promise((resolve) => {
    started = resolve
  })
  const original = runtime.run
  runtime.run = async (root, args, options) => {
    if (args[0] === 'lake') {
      started()
      await new Promise((resolve, reject) => {
        release = resolve
        options.signal?.addEventListener(
          'abort',
          () => reject(options.signal.reason),
          { once: true },
        )
      })
    }
    return original(root, args, options)
  }
  await store.prepare(project.id, 'bob')
  await bounded(waiting)
  const setup = store.jobs.get(project.id)
  try {
    await bounded(store.removeMember(project.id, 'alice', 'bob'))
    assert.equal(
      store.preparationControllers.get(project.id)?.signal.aborted,
      true,
    )
  } finally {
    release?.()
    await setup
  }
  assert.equal(store.locks.has(project.id), false)
  assert.equal(store.get(project.id, 'alice').status, 'error')
})

test('admins can delegate full control, leave, and restore data without a special creator role', async (t) => {
  const f = await fixture(t),
    { project } = f
  await assert.rejects(f.store.removeMember(project.id, 'alice', 'alice'), {
    status: 409,
  })
  await assert.rejects(
    f.store.setMember(project.id, 'alice', 'alice', 'viewer'),
    { status: 409 },
  )
  await f.store.setMember(project.id, 'alice', 'bob', 'admin')
  await f.store.setMember(project.id, 'bob', 'alice', 'editor')
  assert.equal(f.store.get(project.id, 'alice').accessRole, 'editor')
  await assert.rejects(
    f.store.rename(project.id, 'alice', { name: 'No longer admin' }),
    { status: 403 },
  )
  await f.store.rename(project.id, 'bob', { name: 'Delegated project' })
  await f.store.removeMember(project.id, 'bob', 'alice')
  const store = await f.reopen()
  assert.deepEqual(store.list('alice'), [])
  assert.throws(() => store.get(project.id, 'alice'), { status: 404 })
  const source = await store.readFile(project.id, 'bob', 'Main.lean')
  await store.writeFile(
    project.id,
    'bob',
    'Main.lean',
    '-- delegated admin\n',
    source.hash,
  )
  const receipt = await store.trash(project.id, 'bob', 'Main.lean')
  assert.equal(store.listTrash('bob')[0].trashId, receipt.trashId)
  assert.deepEqual(store.listTrash('alice'), [])
  await store.restore(receipt.trashId, 'bob')
  assert.equal(
    (await store.readFile(project.id, 'bob', 'Main.lean')).content,
    '-- delegated admin\n',
  )
  const archived = await store.trash(project.id, 'bob')
  assert.equal(store.getTrash(archived.trashId, 'bob').projectId, project.id)
  await store.restore(archived.trashId, 'bob')
  const trash = await store.trash(project.id, 'bob')
  await store.deleteForever(trash.trashId, 'bob')
  assert.equal(
    store.db
      .prepare('SELECT COUNT(*) AS count FROM project_members WHERE project=?')
      .get(project.id).count,
    0,
  )
})

test('private terminal copies publish touched files with CAS and preserve conflicts for caller-only recovery', async (t) => {
  const { store, project } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const snapshot = await store.terminalSnapshot(
    project.id,
    'bob',
    'private-terminal',
  )
  assert.notEqual(snapshot.root, project.root)
  assert.equal(snapshot.purpose, 'terminal')
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    '-- terminal edit\n',
  )
  const first = await store.syncTerminal(snapshot)
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    '-- terminal edit\n',
  )
  const current = await store.readFile(project.id, 'alice', 'Main.lean')
  await store.writeFile(
    project.id,
    'alice',
    'Main.lean',
    '-- collaborator edit\n',
    current.hash,
  )
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    '-- terminal second edit\n',
  )
  await assert.rejects(store.syncTerminal(snapshot, first), { status: 409 })
  await store.retainTerminalSnapshot(
    snapshot,
    'Main.lean changed. Recover the private edit.',
  )
  assert.equal((await store.terminalRecoveries(project.id, 'bob')).length, 1)
  assert.deepEqual(await store.terminalRecoveries(project.id, 'alice'), [])
  await assert.rejects(
    store.terminalRecovery(project.id, 'alice', snapshot.runId),
    { status: 404 },
  )
  const recovered = await store.readTerminalRecoveryFile(
    project.id,
    'bob',
    snapshot.runId,
    'Main.lean',
  )
  assert.equal(recovered.content.toString(), '-- terminal second edit\n')
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    '-- collaborator edit\n',
  )
  await assert.rejects(
    store.readTerminalRecoveryFile(
      project.id,
      'bob',
      snapshot.runId,
      '../manifest.json',
    ),
    { status: 400 },
  )
  await store.cleanupTerminalSnapshot(snapshot, { finalize: true })
  assert.deepEqual(await store.terminalRecoveries(project.id, 'bob'), [])
})

test('open and finalizing terminal copies stay private and cannot be discarded during final publication', async (t) => {
  const { store, project } = await fixture(t)
  const snapshot = await store.terminalSnapshot(
    project.id,
    'alice',
    'finishing-copy',
  )
  assert.deepEqual(await store.personalTerminalRecoveries('alice'), [])
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    '-- final private edit\n',
  )
  let release, entered
  const pending = new Promise((resolve) => (release = resolve))
  const scanning = new Promise((resolve) => (entered = resolve))
  const changes = store.changes.bind(store)
  store.changes = async (...args) => {
    entered()
    await pending
    return changes(...args)
  }
  store.markTerminalFinalizing(snapshot)
  const publishing = store.syncTerminal(snapshot)
  await scanning
  try {
    // There is no worker left: the guard must cover the publication itself.
    assert.equal(store.runtime.children?.size || 0, 0)
    await assert.rejects(
      bounded(
        store.deleteTerminalRecovery(project.id, 'alice', snapshot.runId),
      ),
      { status: 409 },
    )
    await assert.rejects(
      store.terminalRecovery(project.id, 'alice', snapshot.runId),
      { status: 409 },
    )
    assert.deepEqual(await store.terminalRecoveries(project.id, 'alice'), [])
  } finally {
    release()
    await publishing
  }
  await store.retainTerminalSnapshot(snapshot, 'Keep the final private files.')
  const [recovery] = await store.personalTerminalRecoveries('alice')
  assert.equal(recovery.status, 'ready')
  assert.equal(recovery.projectName, project.name)
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    '-- final private edit\n',
  )
  await store.deleteTerminalRecovery(project.id, 'alice', snapshot.runId)
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    '-- final private edit\n',
  )
})

test('a replaced private terminal directory cannot publish missing files as shared deletions', async (t) => {
  const { store, project } = await fixture(t)
  const snapshot = await store.terminalSnapshot(
    project.id,
    'alice',
    'replaced-copy',
  )
  const original = await store.readFile(project.id, 'alice', 'Main.lean')
  const changes = store.changes.bind(store)
  store.changes = async (...args) => {
    await fs.rename(snapshot.root, snapshot.root + '-previous')
    await fs.mkdir(snapshot.root)
    return changes(...args)
  }
  await assert.rejects(store.syncTerminal(snapshot), { status: 409 })
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    original.content,
  )
  await store.cleanupTerminalSnapshot(snapshot, { finalize: true })
})

test('durable live terminal receipts become recoverable after restart and retain the original project name', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.store.terminalSnapshot(
    f.project.id,
    'alice',
    'interrupted-copy',
  )
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    '-- interrupted unpublished edit\n',
  )
  assert.deepEqual(await f.store.personalTerminalRecoveries('alice'), [])
  const store = await f.reopen()
  const [copy] = await store.personalTerminalRecoveries('alice')
  assert.equal(copy.status, 'interrupted')
  assert.equal(copy.projectName, f.project.name)
  assert.match(copy.message, /interrupted/)
  assert.equal(
    (
      await store.readTerminalRecoveryFile(
        f.project.id,
        'alice',
        copy.runId,
        'Main.lean',
      )
    ).content.toString(),
    '-- interrupted unpublished edit\n',
  )
  await assert.rejects(store.syncTerminal(snapshot), { status: 409 })
  await store.deleteTerminalRecovery(f.project.id, 'alice', copy.runId)
})

test('discard renames a finalized terminal copy before recursive removal starts', async (t) => {
  const { store, project } = await fixture(t)
  const snapshot = await store.terminalSnapshot(
    project.id,
    'alice',
    'renamed-discard',
  )
  await store.retainTerminalSnapshot(snapshot, 'Closed terminal copy.')
  const originalRemove = fs.rm
  let renamed = false
  t.mock.method(fs, 'rm', async (target, options) => {
    if (path.basename(target).startsWith('.terminal-discard-')) {
      renamed = true
      await assert.rejects(fs.stat(path.dirname(snapshot.root)), {
        code: 'ENOENT',
      })
      assert.equal(
        (await fs.stat(path.join(target, 'workspace'))).isDirectory(),
        true,
      )
    }
    return originalRemove(target, options)
  })
  syncBuiltinESMExports()
  try {
    await store.deleteTerminalRecovery(project.id, 'alice', snapshot.runId)
    assert.equal(renamed, true)
    assert.deepEqual(await store.personalTerminalRecoveries('alice'), [])
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
})

test('permanent project deletion preserves caller-private terminal recovery while removing agent candidates', async (t) => {
  const { store, project } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const agent = await store.snapshot(project.id, 'bob', 'purged-agent')
  const terminal = await store.terminalSnapshot(
    project.id,
    'bob',
    'purged-terminal',
  )
  await fs.writeFile(
    path.join(terminal.root, 'Main.lean'),
    '-- personal recovery after deletion\n',
  )
  await store.retainTerminalSnapshot(terminal, 'Keep my personal files.')
  const receipt = await store.trash(project.id, 'alice')
  await store.deleteForever(receipt.trashId, 'alice')
  await assert.rejects(fs.stat(agent.root), { code: 'ENOENT' })
  assert.equal(
    (await store.personalTerminalRecoveries('bob'))[0].projectName,
    project.name,
  )
  assert.deepEqual(await store.personalTerminalRecoveries('alice'), [])
  assert.equal(
    (
      await store.readTerminalRecoveryFile(
        project.id,
        'bob',
        terminal.runId,
        'Main.lean',
      )
    ).content.toString(),
    '-- personal recovery after deletion\n',
  )
  await store.deleteTerminalRecovery(project.id, 'bob', terminal.runId)
})

test('terminal copies allow setup edits and reject publication after permission revocation', async (t) => {
  const { store, project } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const snapshot = await store.terminalSnapshot(
    project.id,
    'bob',
    'terminal-setup',
  )
  await fs.appendFile(
    path.join(snapshot.root, 'lakefile.lean'),
    '\n-- terminal configuration\n',
  )
  const changes = await store.syncTerminal(snapshot)
  assert.equal(store.get(project.id, 'alice').needsPreparation, true)
  await fs.writeFile(path.join(snapshot.root, 'Main.lean'), '-- unpermitted\n')
  await store.setMember(project.id, 'alice', 'bob', 'viewer')
  await assert.rejects(store.syncTerminal(snapshot, changes), { status: 403 })
  await store.cleanupTerminalSnapshot(snapshot, { finalize: true })
})

test('verification rejects a copied imported context that changed and reverted during capture', async (t) => {
  const { store, project, runtime } = await fixture(t)
  const original = 'def trustedContext : Nat := 1\n'
  await store.writeFile(project.id, 'alice', 'Context.lean', original, null)
  const snapshot = await store.snapshot(project.id, 'alice', 'proof-context')
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    '-- proof proposal\n',
  )
  const changes = await store.changes(snapshot)
  runtime.inheritDependencies = async (source, target) => {
    await fs.writeFile(
      path.join(source, 'Context.lean'),
      'def trustedContext : Nat := 2\n',
    )
    await fs.writeFile(
      path.join(target, 'Context.lean'),
      'def trustedContext : Nat := 2\n',
    )
    await fs.writeFile(path.join(source, 'Context.lean'), original)
  }
  const candidates = await fs.readdir(store.snapshotsDir)
  await assert.rejects(store.verificationCopy(snapshot, changes), {
    status: 409,
  })
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Context.lean')).content,
    original,
  )
  assert.deepEqual(await fs.readdir(store.snapshotsDir), candidates)
})

test('capturing an agent copy does not block shared file saves', async (t) => {
  const { store, project, runtime } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  let captured, release
  const started = new Promise((resolve) => {
    captured = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  runtime.inheritDependencies = async () => {
    captured()
    await gate
  }
  const snapshotTask = store.snapshot(project.id, 'bob', 'slow-snapshot')
  await started
  try {
    const source = await store.readFile(project.id, 'alice', 'Main.lean')
    await bounded(
      store.writeFile(
        project.id,
        'alice',
        'Main.lean',
        '-- responsive save\n',
        source.hash,
      ),
    )
  } finally {
    release()
    await snapshotTask
  }
  assert.equal(
    (await store.readFile(project.id, 'bob', 'Main.lean')).content,
    '-- responsive save\n',
  )
})

test('terminal configuration commits use the same active-work admission as browser saves', async (t) => {
  const { store, project } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const snapshot = await store.terminalSnapshot(
    project.id,
    'bob',
    'busy-terminal-config',
  )
  const before = await store.readFile(project.id, 'alice', 'lean-toolchain')
  await fs.appendFile(
    path.join(snapshot.root, 'lean-toolchain'),
    '\n-- configuration update\n',
  )
  let called = false
  store.assertConfigurationIdle = (projectId, actor, options) => {
    called = true
    assert.equal(projectId, project.id)
    assert.equal(actor, 'bob')
    assert.equal(options.terminalRunId, snapshot.runId)
    throw Object.assign(
      new Error('Another collaborator is checking this project.'),
      { status: 409 },
    )
  }
  await assert.rejects(store.syncTerminal(snapshot), { status: 409 })
  assert.equal(called, true)
  assert.equal(
    (await store.readFile(project.id, 'alice', 'lean-toolchain')).hash,
    before.hash,
  )
  store.assertConfigurationIdle = undefined
  await store.cleanupTerminalSnapshot(snapshot, { finalize: true })
})

test('legacy project sharing migrates creators to admin without losing editor memberships', async (t) => {
  const f = await fixture(t)
  f.store.db.exec(`
    DROP TRIGGER project_initial_admin;
    DROP TABLE project_members;
    DROP TABLE workspace_migrations;
    CREATE TABLE project_members (project TEXT NOT NULL, user TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('editor','viewer')), PRIMARY KEY(project,user));
    CREATE INDEX project_members_user ON project_members(user);
  `)
  f.store.db
    .prepare("INSERT INTO project_members VALUES(?,?,'editor')")
    .run(f.project.id, 'bob')
  const store = await f.reopen()
  assert.equal(store.get(f.project.id, 'alice').accessRole, 'admin')
  assert.equal(store.get(f.project.id, 'bob').accessRole, 'editor')
  await store.setMember(f.project.id, 'alice', 'bob', 'admin')
  await store.removeMember(f.project.id, 'bob', 'alice')
  const reopened = await f.reopen()
  assert.throws(() => reopened.get(f.project.id, 'alice'), { status: 404 })
  assert.equal(reopened.get(f.project.id, 'bob').accessRole, 'admin')
})

test('generated terminal binaries remain private without blocking successive source publications', async (t) => {
  const { store, project } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const snapshot = await store.terminalSnapshot(
    project.id,
    'bob',
    'terminal-generated-output',
  )
  await fs.writeFile(
    path.join(snapshot.root, 'Generated.png'),
    Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]),
  )
  await fs.writeFile(
    path.join(snapshot.root, 'Draft.lean'),
    '-- first source\n',
  )
  await assert.rejects(store.changes(snapshot), { status: 409 })
  let unpublished
  const first = await store.syncTerminal(snapshot, [], {
    onUnpublished: (paths) => {
      unpublished = paths
    },
  })
  assert.deepEqual(unpublished, ['Generated.png'])
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Draft.lean')).content,
    '-- first source\n',
  )
  await assert.rejects(fs.stat(path.join(project.root, 'Generated.png')), {
    code: 'ENOENT',
  })
  await fs.writeFile(
    path.join(snapshot.root, 'Draft.lean'),
    '-- second source\n',
  )
  await store.syncTerminal(snapshot, first, {
    onUnpublished: (paths) => {
      unpublished = paths
    },
  })
  assert.deepEqual(unpublished, ['Generated.png'])
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Draft.lean')).content,
    '-- second source\n',
  )
  await store.retainTerminalSnapshot(
    snapshot,
    'Generated.png stays in this private copy.',
  )
  const binary = await store.readTerminalRecoveryFile(
    project.id,
    'bob',
    snapshot.runId,
    'Generated.png',
  )
  assert.equal(binary.content.length, 8)
  await store.cleanupTerminalSnapshot(snapshot, { finalize: true })
})

for (const filename of ['Draft.lean', 'Main.lean'])
  test(`a terminal file becoming noneditable preserves its last published version (${filename})`, async (t) => {
    const { store, project } = await fixture(t)
    const snapshot = await store.terminalSnapshot(
      project.id,
      'alice',
      `terminal-partial-${filename.replace('.', '-')}`,
    )
    await fs.writeFile(
      path.join(snapshot.root, filename),
      '-- last published text\n',
    )
    const previous = await store.syncTerminal(snapshot)
    assert.equal(
      (await store.readFile(project.id, 'alice', filename)).content,
      '-- last published text\n',
    )
    await fs.writeFile(
      path.join(snapshot.root, filename),
      Buffer.from([0xe2, 0x88]),
    )
    let unpublished
    const held = await store.syncTerminal(snapshot, previous, {
      onUnpublished: (paths) => {
        unpublished = paths
      },
    })
    assert.deepEqual(unpublished, [filename])
    assert.equal(
      (await store.readFile(project.id, 'alice', filename)).content,
      '-- last published text\n',
    )
    await fs.writeFile(path.join(snapshot.root, filename), '-- valid again\n')
    await store.syncTerminal(snapshot, held)
    assert.equal(
      (await store.readFile(project.id, 'alice', filename)).content,
      '-- valid again\n',
    )
    await store.cleanupTerminalSnapshot(snapshot, { finalize: true })
  })

test('terminal recovery storage is bounded and caller-only disposal frees admission without touching shared files', async (t) => {
  const { store, project, runtime } = await fixture(t)
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const copies = []
  for (let index = 0; index < 8; index++) {
    copies.push(
      await store.terminalSnapshot(
        project.id,
        'bob',
        `retained-terminal-${index}`,
      ),
    )
    await store.retainTerminalSnapshot(
      copies.at(-1),
      'Retained closed terminal.',
    )
  }
  await assert.rejects(
    store.terminalSnapshot(project.id, 'bob', 'over-capacity'),
    { status: 409 },
  )
  await assert.rejects(
    store.deleteTerminalRecovery(project.id, 'alice', copies[0].runId),
    { status: 404 },
  )
  runtime.children = new Set([{ workspaceRoot: copies[0].root }])
  await assert.rejects(
    store.deleteTerminalRecovery(project.id, 'bob', copies[0].runId),
    { status: 409 },
  )
  runtime.children.clear()
  await store.deleteTerminalRecovery(project.id, 'bob', copies[0].runId)
  assert.equal((await store.terminalRecoveries(project.id, 'bob')).length, 7)
  copies.push(
    await store.terminalSnapshot(
      project.id,
      'bob',
      'new-terminal-after-discard',
    ),
  )
  for (const copy of copies.slice(1))
    await store.cleanupTerminalSnapshot(copy, { finalize: true })
  assert.equal((await store.terminalRecoveries(project.id, 'bob')).length, 0)
  assert.ok((await store.readFile(project.id, 'alice', 'Main.lean')).hash)
})

test('verification retries a transient copied-context race without accepting the mismatched source', async (t) => {
  const { store, project, runtime } = await fixture(t)
  await store.writeFile(
    project.id,
    'alice',
    'Context.lean',
    '-- stable context\n',
    null,
  )
  const snapshot = await store.snapshot(
    project.id,
    'alice',
    'verification-retry',
  )
  let copies = 0
  runtime.inheritDependencies = async (_source, target) => {
    copies++
    if (copies === 1)
      await fs.writeFile(
        path.join(target, 'Context.lean'),
        '-- raced context\n',
      )
  }
  const verified = await store.verificationCopy(snapshot, [])
  assert.equal(copies, 2)
  assert.equal(
    await fs.readFile(path.join(verified.root, 'Context.lean'), 'utf8'),
    '-- stable context\n',
  )
})
