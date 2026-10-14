import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceStore, validateRepository } from '../workspaces.mjs'

const TOOLCHAIN = 'leanprover/lean4:v4.34.1'

function fakeRuntime(overrides = {}) {
  return {
    calls: [],
    templates: () => [{ id: 'lean', toolchain: TOOLCHAIN }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args, options) {
      this.calls.push({ root, args, options })
      options.onOutput?.('command output\n')
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true })
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          JSON.stringify({ packages: [] }),
        )
      }
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('status'))
        return {
          code: 0,
          stdout: '## No commits yet on main\0?? Main.lean\0',
          stderr: '',
        }
      if (args[0] === 'git' && args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: 'No commit yet' }
      return { code: 0, stdout: 'Lean version 4.34.1\n', stderr: '' }
    },
    ...overrides,
  }
}

async function fixture(t, runtime = fakeRuntime()) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-workspaces-'))
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', {
    preset: 'lean',
    name: 'My Lean project',
  })
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  return { store, project, dataDir, runtime }
}

test('creates a durable scoped project with isolated runtime commands', async (t) => {
  const { store, project, dataDir, runtime } = await fixture(t)
  assert.equal(store.list('alice').length, 1)
  assert.deepEqual(store.list('bob'), [])
  assert.throws(() => store.get(project.id, 'bob'), { status: 404 })
  await assert.rejects(store.files(project.id, 'bob'), { status: 404 })
  assert.equal(store.get(project.id, 'alice').toolchain, TOOLCHAIN)
  assert.ok(
    store.events(project.id, 'alice').some((event) => event.type === 'ready'),
  )
  assert.ok(runtime.calls.every((call) => call.root === project.root))
  assert.ok(
    runtime.calls.every((call) => !call.args.some((arg) => arg.includes('&&'))),
  )
  assert.ok(
    runtime.calls
      .filter((call) => call.args[1] === 'update')
      .every((call) => call.options.network === 'bridge'),
  )
  assert.ok((await fs.stat(path.join(dataDir, 'workspaces.sqlite'))).isFile())
  const git = await store.gitStatus(project.id, 'alice')
  assert.equal(git.repository, true)
  assert.equal(git.branch, 'main')
  assert.equal(git.revision, null)
  assert.ok(
    runtime.calls
      .filter((call) => call.args.includes('diff'))
      .every((call) => !call.args.includes('HEAD')),
  )
  assert.equal(
    await fs.readFile(path.join(project.root, '.gitignore'), 'utf8'),
    '.lake/\n',
  )
})

test('external terminal configuration changes require preparation while source-only edits preserve readiness', async (t) => {
  const { store, project } = await fixture(t)
  assert.throws(() => store.configurationFingerprint(project.id, 'bob'), {
    status: 404,
  })
  const baseline = store.configurationFingerprint(project.id, 'alice')
  await fs.appendFile(
    path.join(project.root, 'Main.lean'),
    '\n-- source edit\n',
  )
  assert.equal(
    await store.refreshExternalConfiguration(project.id, 'alice', baseline),
    false,
  )
  await fs.unlink(path.join(project.root, 'lean-toolchain'))
  assert.equal(
    await store.refreshExternalConfiguration(project.id, 'alice', baseline),
    true,
  )
  assert.equal(store.get(project.id, 'alice').status, 'error')
  assert.equal(store.get(project.id, 'alice').needsPreparation, true)
})

test('terminal-made non-regular dependency configuration cannot block fingerprinting', async (t) => {
  const { store, project } = await fixture(t)
  const { spawnSync } = await import('node:child_process')
  const filename = path.join(project.root, 'lean-toolchain')
  await fs.unlink(filename)
  assert.equal(spawnSync('mkfifo', [filename]).status, 0)
  const moduleUrl = new URL('../shared-dependencies.mjs', import.meta.url).href
  const checked = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {readDependencyConfiguration} from ${JSON.stringify(moduleUrl)};
    try { readDependencyConfiguration(process.argv[1]); process.exit(1) }
    catch(error) { if (!/Invalid dependency configuration file/.test(error.message)) throw error }
  `,
      project.root,
    ],
    { timeout: 3000 },
  )
  assert.equal(checked.error, undefined)
  assert.equal(checked.status, 0)
})

test('guards traversal, secret files, dependency writes, and symlink escapes', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const secret = path.join(dataDir, 'host-secret')
  await fs.writeFile(secret, 'hidden')
  await fs.symlink(secret, path.join(project.root, 'outside.lean'))
  await fs.symlink(dataDir, path.join(project.root, 'escape'))
  for (const file of [
    '../host-secret',
    '/etc/passwd',
    'a/../../host-secret',
    'a\\b',
    '.git/config',
    '.lemex/auth.json',
    '.env',
    '.env.local',
    'key.pem',
    'escape/host-secret',
    'outside.lean',
  ]) {
    await assert.rejects(store.readFile(project.id, 'alice', file))
    await assert.rejects(store.writeFile(project.id, 'alice', file, 'changed'))
  }
  await fs.mkdir(path.join(project.root, '.lake', 'packages', 'mathlib'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(project.root, '.lake', 'packages', 'mathlib', 'Mathlib.lean'),
    'theorem dep : True := by trivial\n',
  )
  const dep = '.lake/packages/mathlib/Mathlib.lean'
  assert.equal(
    (await store.readFile(project.id, 'alice', dep)).content,
    'theorem dep : True := by trivial\n',
  )
  await assert.rejects(store.writeFile(project.id, 'alice', dep, 'changed'), {
    status: 400,
  })
  const files = await store.files(project.id, 'alice')
  assert.ok(files.some((file) => file.path === dep && file.readOnly))
  assert.ok(
    !files.some(
      (file) => file.path.includes('outside') || file.path.includes('escape'),
    ),
  )
})

test('saves new files and rejects stale concurrent saves', async (t) => {
  const { store, project } = await fixture(t)
  const created = await store.writeFile(
    project.id,
    'alice',
    'Proofs/New.lean',
    'example : True := by trivial\n',
    null,
  )
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Proofs/New.lean')).hash,
    created.hash,
  )
  await assert.rejects(
    store.writeFile(project.id, 'alice', 'Proofs/New.lean', 'overwrite', null),
    { status: 409 },
  )
  const writes = await Promise.allSettled([
    store.writeFile(
      project.id,
      'alice',
      'Proofs/New.lean',
      'first',
      created.hash,
    ),
    store.writeFile(
      project.id,
      'alice',
      'Proofs/New.lean',
      'second',
      created.hash,
    ),
  ])
  assert.equal(writes.filter((write) => write.status === 'fulfilled').length, 1)
  assert.equal(
    writes.filter(
      (write) => write.status === 'rejected' && write.reason.status === 409,
    ).length,
    1,
  )
})

test('creates and lists empty nested folders without running commands or changing the Lean environment', async (t) => {
  const { store, project, runtime } = await fixture(t)
  const configuration = store.configurationFingerprint(project.id, 'alice')
  const calls = runtime.calls.length
  assert.deepEqual(
    await store.createFolder(project.id, 'alice', { path: 'Proofs/Nested' }),
    { path: 'Proofs/Nested' },
  )
  assert.deepEqual(await store.folders(project.id, 'alice'), [
    'Proofs',
    'Proofs/Nested',
  ])
  assert.deepEqual(
    await fs.readdir(path.join(project.root, 'Proofs/Nested')),
    [],
  )
  assert.equal(
    (await fs.stat(path.join(project.root, 'Proofs/Nested'))).mode & 0o777,
    0o700,
  )
  assert.equal(
    (await store.files(project.id, 'alice')).some(
      (file) => file.path === 'Proofs/Nested',
    ),
    false,
  )
  await store.writeFile(
    project.id,
    'alice',
    'Proofs/Nested/Extra.lean',
    '',
    null,
  )
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Proofs/Nested/Extra.lean'))
      .content,
    '',
  )
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  assert.equal(
    store.configurationFingerprint(project.id, 'alice'),
    configuration,
  )
  assert.equal(runtime.calls.length, calls)
})

test('folder creation preserves existing files and folders and rejects concurrent duplicates', async (t) => {
  const { store, project } = await fixture(t)
  const source = await store.readFile(project.id, 'alice', 'Main.lean')
  await assert.rejects(
    store.createFolder(project.id, 'alice', { path: 'Main.lean' }),
    { status: 409 },
  )
  assert.deepEqual(
    await store.readFile(project.id, 'alice', 'Main.lean'),
    source,
  )
  const results = await Promise.allSettled([
    store.createFolder(project.id, 'alice', { path: 'Empty' }),
    store.createFolder(project.id, 'alice', { path: 'Empty' }),
  ])
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.equal(
    results.filter(
      (result) => result.status === 'rejected' && result.reason.status === 409,
    ).length,
    1,
  )
  await assert.rejects(
    store.writeFile(project.id, 'alice', 'Empty', 'overwrite', null),
  )
  assert.deepEqual(await fs.readdir(path.join(project.root, 'Empty')), [])
})

test('folders remain owner scoped and reject traversal, protected paths and symlink parents', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const outside = path.join(dataDir, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(project.root, 'escape'))
  await fs.mkdir(path.join(project.root, '.lake/packages/mathlib/Hidden'), {
    recursive: true,
  })
  await fs.mkdir(path.join(project.root, '.git/Hidden'), { recursive: true })
  await fs.mkdir(path.join(project.root, 'unavailable\\folder'))
  await assert.rejects(store.folders(project.id, 'bob'), { status: 404 })
  await assert.rejects(
    store.createFolder(project.id, 'bob', { path: 'Unauthorized' }),
    { status: 404 },
  )
  for (const input of [null, [], {}, { path: 12 }, { path: '' }])
    await assert.rejects(store.createFolder(project.id, 'alice', input), {
      status: 400,
    })
  for (const filename of [
    '../outside',
    '/tmp/outside',
    'a/../../outside',
    'a\\b',
    '.git/New',
    '.lemex/New',
    '.env',
    '.env.local/New',
    'node_modules/New',
    '.lake/packages/mathlib/New',
    'lean-toolchain',
    'lakefile.toml',
    'Main.lean/Nested',
    'escape/New',
  ]) {
    await assert.rejects(
      store.createFolder(project.id, 'alice', { path: filename }),
      filename,
    )
  }
  assert.deepEqual(await fs.readdir(outside), [])
  assert.deepEqual(await store.folders(project.id, 'alice'), [])
  assert.equal(
    (await fs.stat(path.join(project.root, 'lean-toolchain'))).isFile(),
    true,
  )
})

test('folder listing and creation reject a workspace root replaced by a symlink', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const original = path.join(dataDir, 'original-root')
  const outside = path.join(dataDir, 'outside-root')
  await fs.mkdir(path.join(outside, 'Private'), { recursive: true })
  await fs.rename(project.root, original)
  await fs.symlink(outside, project.root)
  await assert.rejects(store.folders(project.id, 'alice'), { status: 409 })
  await assert.rejects(
    store.createFolder(project.id, 'alice', { path: 'New' }),
    { status: 409 },
  )
  assert.deepEqual(await fs.readdir(outside), ['Private'])
})

test('creating folders or files under setup file names preserves the project environment', async (t) => {
  const { store, project } = await fixture(t)
  const configuration = store.configurationFingerprint(project.id, 'alice')
  for (const name of [
    'lean-toolchain',
    'lakefile.toml',
    'lakefile.lean',
    'lake-manifest.json',
  ]) {
    await assert.rejects(
      store.createFolder(project.id, 'alice', { path: name }),
      { status: 400 },
    )
    await assert.rejects(
      store.createFolder(project.id, 'alice', { path: `${name}/Sub` }),
      { status: 400 },
    )
    await assert.rejects(
      store.writeFile(project.id, 'alice', `${name}/Notes.md`, '', null),
      { status: 400 },
    )
  }
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  assert.equal(
    store.configurationFingerprint(project.id, 'alice'),
    configuration,
  )
  await assert.rejects(fs.stat(path.join(project.root, 'lakefile.lean')), {
    code: 'ENOENT',
  })
  assert.deepEqual(await store.folders(project.id, 'alice'), [])
})

test('proof snapshots omit repository history, hooks and nested gitdir files while retaining the source revision', async (t) => {
  const runtime = fakeRuntime()
  const run = runtime.run.bind(runtime)
  runtime.run = (root, args, options) =>
    args[0] === 'git' && args.includes('rev-parse')
      ? Promise.resolve({ code: 0, stdout: 'a'.repeat(40), stderr: '' })
      : run(root, args, options)
  const { store, project } = await fixture(t, runtime)
  await fs.mkdir(path.join(project.root, '.git/hooks'), { recursive: true })
  await fs.writeFile(
    path.join(project.root, '.git/hooks/pre-commit'),
    '#!/bin/sh\necho private-hook\n',
  )
  await fs.writeFile(
    path.join(project.root, '.git/config'),
    '[credential]\nhelper = private-helper\n',
  )
  await fs.mkdir(path.join(project.root, 'Nested'))
  await fs.writeFile(
    path.join(project.root, 'Nested/.git'),
    'gitdir: /private/other-checkout\n',
  )
  await fs.writeFile(
    path.join(project.root, 'Nested/Proof.lean'),
    'example : True := by trivial\n',
  )
  const snapshot = await store.snapshot(project.id, 'alice', 'no-git-metadata')
  assert.equal(snapshot.sourceRevision, 'a'.repeat(40))
  for (const filename of ['.git', 'Nested/.git'])
    await assert.rejects(fs.lstat(path.join(snapshot.root, filename)), {
      code: 'ENOENT',
    })
  assert.equal(
    await fs.readFile(path.join(snapshot.root, 'Nested/Proof.lean'), 'utf8'),
    'example : True := by trivial\n',
  )
  assert.equal(
    await fs.readFile(path.join(snapshot.root, '.gitignore'), 'utf8'),
    '.lake/\n',
  )
  assert.match(
    await fs.readFile(path.join(project.root, '.git/config'), 'utf8'),
    /private-helper/,
  )
})

test('snapshot keeps a protected baseline and apply checks every base before any write', async (t) => {
  const { store, project } = await fixture(t)
  await store.writeFile(
    project.id,
    'alice',
    'Second.lean',
    'second original\n',
    null,
  )
  const snapshot = await store.snapshot(project.id, 'alice', 'run-one')
  const original = await store.readFile(project.id, 'alice', 'Main.lean')
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await fs.writeFile(
    path.join(snapshot.root, 'Second.lean'),
    'second candidate\n',
  )
  snapshot.files.length = 0 // The server reads the persisted manifest, not input.
  const changes = await store.changes(snapshot)
  assert.equal(changes.length, 2)
  assert.equal(
    changes.find((change) => change.path === 'Main.lean').beforeHash,
    original.hash,
  )
  const second = await store.readFile(project.id, 'alice', 'Second.lean')
  await store.writeFile(
    project.id,
    'alice',
    'Second.lean',
    'concurrent edit\n',
    second.hash,
  )
  await assert.rejects(store.applyChanges(project.id, 'alice', changes), {
    status: 409,
  })
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).hash,
    original.hash,
  )
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Second.lean')).content,
    'concurrent edit\n',
  )
  await assert.rejects(store.snapshot(project.id, 'alice', 'run-one'), {
    status: 409,
  })
})

test('acceptance rejects changes to unpatched context files, new files, and binary context', async (t) => {
  const { store, project } = await fixture(t)
  await store.writeFile(
    project.id,
    'alice',
    'Context.lean',
    'def supportingFact : Nat := 1\n',
    null,
  )
  await fs.writeFile(
    path.join(project.root, 'context.bin'),
    Buffer.from([0, 1, 2]),
  )
  const snapshot = await store.snapshot(project.id, 'alice', 'full-context')
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  const changes = await store.changes(snapshot)
  assert.equal(changes.length, 1)
  assert.equal(await store.assertSnapshotCurrent(snapshot), true)
  const beforeMain = await store.readFile(project.id, 'alice', 'Main.lean')
  const context = await store.readFile(project.id, 'alice', 'Context.lean')
  await store.writeFile(
    project.id,
    'alice',
    'Context.lean',
    'def supportingFact : Nat := 2\n',
    context.hash,
  )
  await assert.rejects(
    store.applyChanges(project.id, 'alice', changes, { snapshot }),
    { status: 409 },
  )
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).hash,
    beforeMain.hash,
  )
  await store.writeFile(project.id, 'alice', 'Context.lean', context.content)
  await fs.writeFile(
    path.join(project.root, 'Added.lean'),
    '-- new import context\n',
  )
  await assert.rejects(store.assertSnapshotCurrent(snapshot), { status: 409 })
  await fs.rm(path.join(project.root, 'Added.lean'))
  await fs.writeFile(
    path.join(project.root, 'context.bin'),
    Buffer.from([0, 1, 3]),
  )
  await assert.rejects(store.assertSnapshotCurrent(snapshot), { status: 409 })
  await fs.writeFile(
    path.join(project.root, 'context.bin'),
    Buffer.from([0, 1, 2]),
  )
  assert.equal(
    (await store.applyChanges(project.id, 'alice', changes, { snapshot }))
      .applied,
    1,
  )
})

test('independent verification copies saved sources and trusted artifacts into a separate root', async (t) => {
  const { store, project } = await fixture(t)
  await fs.mkdir(path.join(project.root, '.lake', 'build'), { recursive: true })
  await fs.writeFile(
    path.join(project.root, '.lake', 'build', 'trusted.olean'),
    'trusted original artifact',
  )
  await fs.writeFile(
    path.join(project.root, '.git', 'config'),
    'trusted original git config',
  )
  const original = await store.readFile(project.id, 'alice', 'Main.lean')
  const snapshot = await store.snapshot(project.id, 'alice', 'untrusted-run')
  await assert.rejects(fs.stat(path.join(snapshot.root, '.git')), {
    code: 'ENOENT',
  })
  const proposed = 'example : True := by trivial\n'
  await fs.writeFile(path.join(snapshot.root, 'Main.lean'), proposed)
  await fs.writeFile(
    path.join(snapshot.root, '.lake', 'build', 'trusted.olean'),
    'poisoned artifact',
  )
  await fs.writeFile(
    path.join(snapshot.root, '.lake', 'build', 'evil.olean'),
    'new poisoned artifact',
  )
  await fs.mkdir(path.join(snapshot.root, '.git'))
  await fs.writeFile(
    path.join(snapshot.root, '.git', 'config'),
    'poisoned git config',
  )
  await fs.mkdir(path.join(snapshot.root, '.lemex'), { recursive: true })
  await fs.writeFile(
    path.join(snapshot.root, '.lemex', 'config.toml'),
    'poisoned agent config',
  )
  const changes = await store.changes(snapshot)
  const verification = await store.verificationCopy(snapshot, changes)
  assert.notEqual(verification.root, snapshot.root)
  assert.notEqual(verification.root, project.root)
  assert.equal(
    await fs.readFile(path.join(verification.root, 'Main.lean'), 'utf8'),
    proposed,
  )
  assert.equal(
    await fs.readFile(
      path.join(verification.root, '.lake', 'build', 'trusted.olean'),
      'utf8',
    ),
    'trusted original artifact',
  )
  await assert.rejects(fs.stat(path.join(verification.root, '.git')), {
    code: 'ENOENT',
  })
  await assert.rejects(
    fs.stat(path.join(verification.root, '.lake', 'build', 'evil.olean')),
    { code: 'ENOENT' },
  )
  await assert.rejects(fs.stat(path.join(verification.root, '.lemex')), {
    code: 'ENOENT',
  })
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).hash,
    original.hash,
  )
  await assert.rejects(
    store.verificationCopy(snapshot, [
      { path: 'lakefile.lean', beforeHash: null, after: 'import Lake' },
    ]),
    { status: 409 },
  )
  await store.writeFile(
    project.id,
    'alice',
    'Unrelated.lean',
    '-- added context\n',
    null,
  )
  await assert.rejects(
    store.verificationCopy(snapshot, changes),
    (error) =>
      error.status === 409 &&
      error.message.includes('changed during the assistant run') &&
      !error.message.includes('Cannot apply'),
  )
})

test('applies new, edited and deleted files while preserving backups', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  await store.writeFile(
    project.id,
    'alice',
    'Delete.lean',
    'keep this original\n',
    null,
  )
  const snapshot = await store.snapshot(project.id, 'alice', 'run-apply')
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await fs.writeFile(
    path.join(snapshot.root, 'Created.lean'),
    'example : 1 = 1 := rfl\n',
  )
  await fs.rm(path.join(snapshot.root, 'Delete.lean'))
  const changes = await store.changes(snapshot)
  const result = await store.applyChanges(project.id, 'alice', changes)
  assert.equal(result.applied, 3)
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Created.lean')).content,
    'example : 1 = 1 := rfl\n',
  )
  await assert.rejects(store.readFile(project.id, 'alice', 'Delete.lean'), {
    status: 404,
  })
  const transactions = await fs.readdir(
    path.join(dataDir, 'history', project.id),
  )
  const backups = await fs.readdir(
    path.join(dataDir, 'history', project.id, transactions[0], 'before'),
  )
  assert.equal(backups.length, 2)
  const contents = await Promise.all(
    backups.map((file) =>
      fs.readFile(
        path.join(
          dataDir,
          'history',
          project.id,
          transactions[0],
          'before',
          file,
        ),
        'utf8',
      ),
    ),
  )
  assert.ok(contents.includes('keep this original\n'))
})

test('candidate symlink replacements and manifest escapes are rejected', async (t) => {
  const { store, project, dataDir } = await fixture(t)
  const snapshot = await store.snapshot(project.id, 'alice', 'run-symlink')
  await fs.rm(path.join(snapshot.root, 'Main.lean'))
  await fs.symlink('/etc/passwd', path.join(snapshot.root, 'Main.lean'))
  await assert.rejects(store.changes(snapshot), { status: 409 })
  await assert.rejects(store.changes({ ...snapshot, root: dataDir }), {
    status: 403,
  })
  await assert.rejects(
    store.applyChanges(project.id, 'alice', [
      { path: 'Main.lean', after: 'changed', beforeHash: null },
      { path: 'Main.lean', after: 'duplicate', beforeHash: null },
    ]),
  )
})

test('existing manifests are preserved and preparation failures can be retried', async (t) => {
  let failOnce = true
  const runtime = fakeRuntime({
    async prepareToolchain() {
      if (failOnce) {
        failOnce = false
        throw new Error('temporary toolchain download failure')
      }
    },
  })
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-retry-'))
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'error')
  await fs.writeFile(
    path.join(project.root, 'lake-manifest.json'),
    '{"packages":[],"pinned":"keep"}',
  )
  assert.equal((await store.prepare(project.id, 'alice')).status, 'preparing')
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  assert.equal(
    await fs.readFile(path.join(project.root, 'lake-manifest.json'), 'utf8'),
    '{"packages":[],"pinned":"keep"}',
  )
})

test('restart preserves projects and identifies interrupted preparation', async (t) => {
  const { store, project, dataDir, runtime } = await fixture(t)
  const persisted = store.get(project.id, 'alice')
  persisted.status = 'preparing'
  store.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(persisted), project.id)
  store.close()
  const restarted = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(() => restarted.close())
  // Avoid closing the original already-closed database in fixture cleanup.
  store.db = null
  assert.equal(restarted.get(project.id, 'alice').status, 'error')
  assert.match(restarted.get(project.id, 'alice').error, /interrupted/)
  assert.equal(
    (
      await restarted.readFile(project.id, 'alice', 'Main.lean')
    ).content.includes('hello_lean'),
    true,
  )
})

test('HTTPS Git URL validation rejects local, credentialed and non-public hosts', async () => {
  const publicDNS = async () => [{ address: '140.82.114.3' }]
  assert.equal(
    await validateRepository('https://github.com/owner/repo.git', publicDNS),
    'https://github.com/owner/repo.git',
  )
  for (const url of [
    'file:///tmp/repo',
    '/tmp/repo',
    'git@github.com:owner/repo',
    'http://github.com/owner/repo',
    'https://user:token@github.com/owner/repo',
    'https://127.0.0.1/repo',
    'https://10.0.0.2/repo',
    'https://[::1]/repo',
    'https://[::ffff:127.0.0.1]/repo',
    'https://localhost/repo',
    'https://host.local/repo',
    'https://github.com:8443/repo',
    'https://github.com/repo?token=secret',
  ]) {
    await assert.rejects(validateRepository(url, publicDNS))
  }
  await assert.rejects(
    validateRepository('https://github.com/owner/repo', async () => [
      { address: '140.82.114.3' },
      { address: '192.168.0.1' },
    ]),
  )
  await assert.rejects(
    validateRepository('https://example.com/repo', async () => [
      { address: 'fc00::1' },
    ]),
  )
})

test('imports an exact Git revision through the runtime, preserves instructions, and leaves broken proofs repairable', async (t) => {
  const runtime = fakeRuntime()
  const run = runtime.run
  runtime.run = async function (root, args, options) {
    const result = await run.call(this, root, args, options)
    if (args.includes('clone')) {
      await fs.mkdir(path.join(root, '.git'))
      await fs.writeFile(path.join(root, 'lean-toolchain'), `${TOOLCHAIN}\n`)
      await fs.writeFile(
        path.join(root, 'lakefile.toml'),
        'name = "imported"\n',
      )
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[],"revision":"pinned"}',
      )
      await fs.writeFile(
        path.join(root, 'Main.lean'),
        'example : False := by\n  trivial\n',
      )
      await fs.writeFile(
        path.join(root, 'AGENTS.md'),
        'Preserve this project convention.\n',
      )
    }
    if (args.includes('rev-parse')) {
      result.code = 0
      result.stdout = 'abcdef1234567890abcdef1234567890abcdef1234\n'
    }
    if (args[0] === 'lake' && args[1] === 'build') {
      result.code = 1
      result.stderr = 'Main.lean: unsolved goals'
    }
    return result
  }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-import-'))
  const store = await new WorkspaceStore({
    dataDir,
    runtime,
    resolveHost: async () => [{ address: '140.82.114.3' }],
  }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', {
    repository: 'https://github.com/owner/project.git',
    revision: 'release/v1',
    preset: 'lean',
  })
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  assert.match(store.get(project.id, 'alice').buildWarning, /repair/)
  assert.equal(
    store.get(project.id, 'alice').sourceRevision,
    'abcdef1234567890abcdef1234567890abcdef1234',
  )
  const commands = runtime.calls
  assert.ok(
    commands.some(
      (command) =>
        command.args.includes('clone') &&
        command.args.at(-1) === '.' &&
        command.options.network === 'bridge',
    ),
  )
  assert.ok(
    commands.some(
      (command) =>
        command.args.includes('fetch') && command.args.at(-1) === 'release/v1',
    ),
  )
  assert.ok(
    commands.some(
      (command) =>
        command.args.includes('checkout') &&
        command.args.at(-1) === 'FETCH_HEAD',
    ),
  )
  assert.ok(
    commands
      .filter((command) => command.args[0] === 'git')
      .every(
        (command) =>
          command.args.includes('http.followRedirects=false') &&
          command.args.includes('credential.helper='),
      ),
  )
  assert.ok(
    !commands.some(
      (command) => command.args[0] === 'lake' && command.args[1] === 'update',
    ),
  )
  const snapshot = await store.snapshot(project.id, 'alice', 'import-review')
  assert.equal(
    await fs.readFile(path.join(snapshot.root, 'AGENTS.md'), 'utf8'),
    'Preserve this project convention.\n',
  )
  await assert.rejects(
    store.create('alice', {
      repository: 'https://github.com/owner/project.git',
      revision: '--upload-pack=evil',
    }),
  )
})

test('preset projects and candidates share only readonly dependency sources without copying package trees', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-thin-cache-'))
  const template = path.join(dataDir, 'template')
  await fs.mkdir(path.join(template, '.lake', 'packages', 'mathlib'), {
    recursive: true,
  })
  await fs.writeFile(path.join(template, 'lean-toolchain'), `${TOOLCHAIN}\n`)
  await fs.writeFile(
    path.join(template, 'lake-manifest.json'),
    '{"packages":[{"name":"mathlib"}]}',
  )
  await fs.writeFile(path.join(template, 'Main.lean'), 'import Mathlib\n')
  await fs.writeFile(path.join(template, '.ready.json'), '{}')
  await fs.writeFile(
    path.join(template, '.lake', 'packages', 'mathlib', 'Mathlib.lean'),
    '-- Cached source\n',
  )
  const inherited = new Map()
  const runtime = fakeRuntime({
    templates: () => [{ id: 'mathlib', toolchain: TOOLCHAIN, ready: true }],
    templateRoot: () => template,
    async inheritDependencies(source, destination) {
      const origin = inherited.get(source) || source
      inherited.set(destination, origin)
      return origin
    },
    dependencyRoot: (root) => inherited.get(root) || null,
  })
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', { preset: 'mathlib' })
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  await assert.rejects(fs.stat(path.join(project.root, '.lake', 'packages')), {
    code: 'ENOENT',
  })
  await assert.rejects(fs.stat(path.join(project.root, '.ready.json')), {
    code: 'ENOENT',
  })
  assert.equal(
    (
      await store.readFile(
        project.id,
        'alice',
        '.lake/packages/mathlib/Mathlib.lean',
      )
    ).content,
    '-- Cached source\n',
  )
  assert.ok(
    (await store.files(project.id, 'alice')).some(
      (file) =>
        file.path === '.lake/packages/mathlib/Mathlib.lean' && file.readOnly,
    ),
  )
  const snapshot = await store.snapshot(project.id, 'alice', 'thin-run')
  assert.equal(inherited.get(snapshot.root), template)
  await assert.rejects(fs.stat(path.join(snapshot.root, '.lake', 'packages')), {
    code: 'ENOENT',
  })
  assert.deepEqual(await store.changes(snapshot), [])
})

test('Lean basics supports a custom pinned release without reusing a different cached toolchain', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-custom-lean-'))
  const template = path.join(dataDir, 'template')
  await fs.mkdir(template)
  await fs.writeFile(path.join(template, 'lean-toolchain'), `${TOOLCHAIN}\n`)
  await fs.writeFile(
    path.join(template, 'Main.lean'),
    '-- Cached default-version Lean project\n',
  )
  await fs.writeFile(
    path.join(template, 'CachedOnly.lean'),
    '-- Must not appear in a custom-version project\n',
  )
  const prepared = []
  const runtime = fakeRuntime({
    templates: () =>
      ['lean', 'mathlib', 'cslib', 'physlib'].map((id) => ({
        id,
        toolchain: TOOLCHAIN,
        ready: true,
      })),
    templateRoot: () => template,
    async prepareToolchain(toolchain) {
      prepared.push(toolchain)
    },
  })
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const defaultProject = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(defaultProject.id)
  assert.equal(store.get(defaultProject.id, 'alice').status, 'ready')
  assert.equal(
    await fs.readFile(
      path.join(defaultProject.root, 'CachedOnly.lean'),
      'utf8',
    ),
    '-- Must not appear in a custom-version project\n',
  )
  const requested = 'leanprover/lean4:v4.33.0'
  const customProject = await store.create('alice', {
    preset: 'lean',
    toolchain: requested,
  })
  await store.jobs.get(customProject.id)
  assert.equal(store.get(customProject.id, 'alice').status, 'ready')
  assert.equal(store.get(customProject.id, 'alice').toolchain, requested)
  assert.equal(
    await fs.readFile(path.join(customProject.root, 'lean-toolchain'), 'utf8'),
    `${requested}\n`,
  )
  assert.match(
    await fs.readFile(path.join(customProject.root, 'Main.lean'), 'utf8'),
    /hello_lean/,
  )
  await assert.rejects(
    fs.stat(path.join(customProject.root, 'CachedOnly.lean')),
    { code: 'ENOENT' },
  )
  assert.ok(prepared.includes(requested))
  for (const preset of ['mathlib', 'cslib', 'physlib'])
    await assert.rejects(
      store.create('alice', { preset, toolchain: requested }),
      (error) => error.status === 400 && error.message.includes('requires'),
    )
  await assert.rejects(
    store.create('alice', {
      preset: 'lean',
      toolchain: 'leanprover/lean4:nightly-2026-10-13',
    }),
    (error) => error.status === 400 && error.message.includes('Nightly'),
  )
  assert.equal(store.list('alice').length, 2)
})

test('rejects unsafe project inputs and binary or oversized file contents', async (t) => {
  const { store, project } = await fixture(t)
  for (const input of [
    { preset: 'other' },
    { preset: 'lean', name: 'bad\nname' },
    { preset: 'lean', toolchain: '../../host' },
    { preset: 'lean', revision: 'main' },
    { repository: 'file:///tmp/repo' },
  ]) {
    await assert.rejects(store.create('alice', input))
  }
  await assert.rejects(
    store.writeFile(project.id, 'alice', 'Binary.lean', 'a\0b'),
    { status: 413 },
  )
  await assert.rejects(
    store.writeFile(
      project.id,
      'alice',
      'Large.lean',
      'x'.repeat(8 * 1024 * 1024 + 1),
    ),
    { status: 413 },
  )
  await fs.writeFile(
    path.join(project.root, 'binary.dat'),
    Buffer.from([0, 1, 2]),
  )
  await assert.rejects(store.readFile(project.id, 'alice', 'binary.dat'), {
    status: 415,
  })
})
