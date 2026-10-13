import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceStore } from '../workspaces.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-live-'))
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args) {
      if (args[0] === 'git' && args.includes('init')) await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse')) return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true })
        await fs.writeFile(path.join(root, 'lake-manifest.json'), '{"packages":[]}')
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => { await Promise.all([...store.jobs.values()]); store.close(); await fs.rm(dataDir, { recursive: true, force: true }) })
  const project = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(project.id)
  const original = await store.readFile(project.id, 'alice', 'Main.lean')
  const snapshot = await store.snapshot(project.id, 'alice', 'live-test')
  const main = after => ({ path: 'Main.lean', before: original.content, after, beforeHash: original.hash })
  return { store, project, snapshot, original, main, dataDir, runtime }
}

test('live writes preserve the original baseline across incremental proof versions', async t => {
  const { store, project, snapshot, original, main } = await fixture(t)
  const first = await store.syncLive(snapshot, [main('theorem first : True := by trivial\n')])
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).content, first[0].after)
  const second = await store.syncLive(snapshot, [main('theorem second : True := by trivial\n')], first)
  assert.equal(second[0].before, original.content)
  assert.equal(second[0].beforeHash, original.hash)
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).content, second[0].after)
  assert.equal(await store.assertLive(snapshot, second), true)
  await assert.rejects(store.assertSnapshotCurrent(snapshot), { status: 409 })
  assert.ok(store.events(project.id, 'alice').some(event => event.type === 'live'))
});

test('cumulative live updates revert omitted edits and safely remove model-added files', async t => {
  const { store, project, snapshot, original, main, dataDir } = await fixture(t)
  const created = { path: 'Proofs/New.lean', before: null, beforeHash: null, after: 'theorem new_proof : True := by trivial\n' }
  const previous = await store.syncLive(snapshot, [main('theorem edited : True := by trivial\n'), created])
  assert.equal((await store.readFile(project.id, 'alice', created.path)).content, created.after)
  const reverted = await store.syncLive(snapshot, [], previous)
  assert.deepEqual(reverted, [])
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).hash, original.hash)
  await assert.rejects(store.readFile(project.id, 'alice', created.path), { status: 404 })
  assert.equal(await store.assertLive(snapshot, []), true)
  const transactions = await fs.readdir(path.join(dataDir, 'history', project.id))
  assert.equal(transactions.length, 2)
  const manifests = await Promise.all(transactions.map(transaction => fs.stat(path.join(dataDir, 'history', project.id, transaction, 'manifest.json'))))
  assert.ok(manifests.every(stat => stat.isFile()))
});

test('user edits halt both further live updates and Undo without overwriting saved work', async t => {
  const { store, project, snapshot, main } = await fixture(t)
  const previous = await store.syncLive(snapshot, [main('theorem model_version : True := by trivial\n')])
  const active = await store.readFile(project.id, 'alice', 'Main.lean')
  await store.writeFile(project.id, 'alice', 'Main.lean', '-- User work must survive\n', active.hash)
  await assert.rejects(store.syncLive(snapshot, [main('theorem new_model : True := by trivial\n')], previous), { status: 409 })
  await assert.rejects(store.undoLive(snapshot, previous), { status: 409 })
  await assert.rejects(store.verificationCopy(snapshot, previous, { liveChanges: previous }), { status: 409 })
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).content, '-- User work must survive\n')
});

test('live context protects configuration and symlinks while allowing unrelated Lean sources', async t => {
  const { store, project, snapshot, main } = await fixture(t)
  const previous = await store.syncLive(snapshot, [main('theorem live : True := by trivial\n')])
  const config = await store.readFile(project.id, 'alice', 'lakefile.toml')
  await store.writeFile(project.id, 'alice', 'lakefile.toml', config.content + '\n-- User changed configuration\n', config.hash)
  await assert.rejects(store.assertLive(snapshot, previous), { status: 409 })
  await store.writeFile(project.id, 'alice', 'lakefile.toml', config.content)
  await store.writeFile(project.id, 'alice', 'User.lean', '-- New user source\n', null)
  assert.equal(await store.assertLive(snapshot, previous), true)
  await fs.rm(path.join(project.root, 'User.lean'))
  await fs.symlink('/etc/passwd', path.join(project.root, 'link.lean'))
  await assert.rejects(store.assertLive(snapshot, previous), { status: 409 })
});

test('unrelated Lean edits, additions, and deletions survive further live writes and Undo', async t => {
  const { store, project, original, main } = await fixture(t)
  await store.writeFile(project.id, 'alice', 'Other.lean', 'theorem other : True := by trivial\n', null)
  await store.writeFile(project.id, 'alice', 'Remove.lean', '-- User may remove this\n', null)
  const snapshot = await store.snapshot(project.id, 'alice', 'live-user-context')
  const previous = await store.syncLive(snapshot, [main('theorem model : True := by trivial\n')])
  await store.writeFile(project.id, 'alice', 'Other.lean', '-- User improved the other proof\n')
  await store.writeFile(project.id, 'alice', 'User.lean', '-- User added another proof\n', null)
  await fs.rm(path.join(project.root, 'Remove.lean'))
  const next = await store.syncLive(snapshot, [main('theorem final_model : True := by trivial\n')], previous)
  assert.equal(await store.assertLive(snapshot, next), true)
  await assert.rejects(store.assertSnapshotCurrent(snapshot), { status: 409 })
  await assert.rejects(store.verificationCopy(snapshot, [main('theorem review : True := by trivial\n')]), { status: 409 })
  const verified = await store.verificationCopy(snapshot, next, { liveChanges: next })
  assert.equal(await fs.readFile(path.join(verified.root, 'Other.lean'), 'utf8'), '-- User improved the other proof\n')
  assert.equal(await fs.readFile(path.join(verified.root, 'User.lean'), 'utf8'), '-- User added another proof\n')
  await assert.rejects(fs.stat(path.join(verified.root, 'Remove.lean')), { code: 'ENOENT' })
  await store.undoLive(snapshot, next)
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).hash, original.hash)
  assert.equal((await store.readFile(project.id, 'alice', 'Other.lean')).content, '-- User improved the other proof\n')
  assert.equal((await store.readFile(project.id, 'alice', 'User.lean')).content, '-- User added another proof\n')
  await assert.rejects(store.readFile(project.id, 'alice', 'Remove.lean'), { status: 404 })
});

test('configuration pauses live updates but Undo restores only the touched proof', async t => {
  const { store, project, snapshot, original, main } = await fixture(t)
  const previous = await store.syncLive(snapshot, [main('theorem model : True := by trivial\n')])
  await store.writeFile(project.id, 'alice', 'README.md', 'User instructions changed\n', null)
  const config = await store.readFile(project.id, 'alice', 'lakefile.toml')
  await store.writeFile(project.id, 'alice', 'lakefile.toml', config.content + '\n# User config edit\n', config.hash)
  await assert.rejects(store.syncLive(snapshot, [main('theorem next : True := by trivial\n')], previous), { status: 409 })
  await assert.rejects(store.verificationCopy(snapshot, previous, { liveChanges: previous }), { status: 409 })
  await store.undoLive(snapshot, previous)
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).hash, original.hash)
  assert.equal((await store.readFile(project.id, 'alice', 'README.md')).content, 'User instructions changed\n')
  assert.equal((await store.readFile(project.id, 'alice', 'lakefile.toml')).content, config.content + '\n# User config edit\n')
});

test('unrelated regular documentation edits and additions remain visible in final live verification', async t => {
  const { store, project, main, original } = await fixture(t)
  await store.writeFile(project.id, 'alice', 'README.md', 'Original documentation\n', null)
  await store.writeFile(project.id, 'alice', 'OldNote.txt', 'An obsolete note\n', null)
  const snapshot = await store.snapshot(project.id, 'alice', 'live-doc-context')
  const previous = await store.syncLive(snapshot, [main('theorem model : True := by trivial\n')])
  await store.writeFile(project.id, 'alice', 'README.md', 'Updated user documentation\n')
  await store.writeFile(project.id, 'alice', 'NewNote.txt', 'Additional user context\n', null)
  await fs.rm(path.join(project.root, 'OldNote.txt'))
  const next = await store.syncLive(snapshot, [main('theorem final_model : True := by trivial\n')], previous)
  assert.equal(await store.assertLive(snapshot, next), true)
  const verified = await store.verificationCopy(snapshot, next, { liveChanges: next })
  assert.equal(await fs.readFile(path.join(verified.root, 'README.md'), 'utf8'), 'Updated user documentation\n')
  assert.equal(await fs.readFile(path.join(verified.root, 'NewNote.txt'), 'utf8'), 'Additional user context\n')
  await assert.rejects(fs.stat(path.join(verified.root, 'OldNote.txt')), { code: 'ENOENT' })
  await assert.rejects(store.verificationCopy(snapshot, next), { status: 409 })
  await store.undoLive(snapshot, next)
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).hash, original.hash)
  assert.equal((await store.readFile(project.id, 'alice', 'README.md')).content, 'Updated user documentation\n')
});

test('newly touched Lean paths cannot overwrite unrelated user files created during the run', async t => {
  const { store, project, snapshot, main } = await fixture(t)
  const previous = await store.syncLive(snapshot, [main('theorem model : True := by trivial\n')])
  await store.writeFile(project.id, 'alice', 'User.lean', '-- New user source\n', null)
  const added = { path: 'User.lean', before: null, beforeHash: null, after: '-- Model wants this path\n' }
  await assert.rejects(store.syncLive(snapshot, [...previous, added], previous), { status: 409 })
  await assert.rejects(store.verificationCopy(snapshot, [...previous, added], { liveChanges: previous }), { status: 409 })
  assert.equal((await store.readFile(project.id, 'alice', 'User.lean')).content, '-- New user source\n')
});

test('Undo restores original bytes and backs up model-added files', async t => {
  const { store, project, snapshot, original, main, dataDir } = await fixture(t)
  const added = { path: 'Added.lean', before: null, beforeHash: null, after: 'theorem added : True := by trivial\n' }
  const previous = await store.syncLive(snapshot, [main('theorem live : True := by trivial\n'), added])
  const undone = await store.undoLive(snapshot, previous)
  assert.equal(undone.applied, 2)
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).hash, original.hash)
  await assert.rejects(store.readFile(project.id, 'alice', 'Added.lean'), { status: 404 })
  assert.equal(await store.assertSnapshotCurrent(snapshot), true)
  const transactions = await fs.readdir(path.join(dataDir, 'history', project.id))
  const contents = []
  for (const transaction of transactions) {
    const directory = path.join(dataDir, 'history', project.id, transaction, 'before')
    for (const file of await fs.readdir(directory)) contents.push(await fs.readFile(path.join(directory, file), 'utf8'))
  }
  assert.ok(contents.includes(added.after))
});

test('verification copies handle already-live edits and the final candidate without changing saved files', async t => {
  const { store, project, snapshot, original, main } = await fixture(t)
  await fs.mkdir(path.join(snapshot.root, '.lake', 'build'), { recursive: true })
  await fs.writeFile(path.join(snapshot.root, '.lake', 'build', 'evil.olean'), 'poisoned candidate artifact')
  const added = { path: 'Temporary.lean', before: null, beforeHash: null, after: 'theorem temporary : True := by trivial\n' }
  const previous = await store.syncLive(snapshot, [main('theorem live : True := by trivial\n'), added])
  const proposed = [main('theorem final_result : True := by trivial\n')]
  const copy = await store.verificationCopy(snapshot, proposed, { liveChanges: previous })
  assert.notEqual(copy.root, snapshot.root)
  assert.notEqual(copy.root, project.root)
  assert.equal(await fs.readFile(path.join(copy.root, 'Main.lean'), 'utf8'), proposed[0].after)
  await assert.rejects(fs.stat(path.join(copy.root, 'Temporary.lean')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(copy.root, '.lake', 'build', 'evil.olean')), { code: 'ENOENT' })
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).content, previous[0].after)
  assert.equal((await store.readFile(project.id, 'alice', 'Temporary.lean')).content, added.after)
  assert.equal(copy.sourceRevision, snapshot.sourceRevision)
  assert.equal(previous[0].beforeHash, original.hash)
});

test('live edits reject unsafe paths, configuration, deletions, forged baselines, and duplicate paths', async t => {
  const { store, project, snapshot, original, main } = await fixture(t)
  for (const change of [
    { ...main('changed'), path: '.lake/packages/mathlib/Main.lean' },
    { ...main('changed'), path: '.git/config.lean' },
    { ...main('changed'), path: '.lemex/auth.lean' },
    { ...main('changed'), path: 'lakefile.lean' },
    { ...main('changed'), path: 'src/lakefile.lean' },
    { ...main('changed'), path: 'lean-toolchain' },
    { ...main('changed'), after: null },
    { ...main('changed'), before: 'forged original' },
    { ...main('changed'), beforeHash: null },
  ]) await assert.rejects(store.syncLive(snapshot, [change]))
  await assert.rejects(store.syncLive(snapshot, [main('one'), main('two')]))
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).hash, original.hash)
});

test('simultaneous live updates with the same previous state have only one successful writer', async t => {
  const { store, project, snapshot, main } = await fixture(t)
  const results = await Promise.allSettled([store.syncLive(snapshot, [main('first')]), store.syncLive(snapshot, [main('second')])])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1)
  const winner = results.find(result => result.status === 'fulfilled').value[0].after
  assert.equal((await store.readFile(project.id, 'alice', 'Main.lean')).content, winner)
});
