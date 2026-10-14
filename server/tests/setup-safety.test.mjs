import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  runPinnedLake,
  dependencyCacheCommands,
  runDependencyCache,
  setupInfrastructureFailure,
  setupFailureMessage,
} from '../pinned-lake.mjs'
import {
  TemporaryWorkspaces,
  removeDisposableTree,
} from '../temporary-workspaces.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-setup-safety-'),
  )
  t.after(() => removeDisposableTree(root))
  return root
}
const toolchain = 'leanprover/lean4:v4.34.1\n'
const files = [
  { path: 'lean-toolchain', content: toolchain },
  { path: 'lakefile.toml', content: 'name = "fixture"\n' },
  { path: 'Main.lean', content: 'example : True := by trivial\n' },
]
const runtime = () => ({
  templates: () => [{ id: 'lean', toolchain: toolchain.trim() }],
  templateRoot: () => null,
  prepareToolchain: async () => {},
  run: async () => ({ code: 0, stdout: '', stderr: '' }),
})

test('setup detects resource and Git transport failures even with a generic stderr and detailed stdout', async (t) => {
  for (const result of [
    { code: 137, stdout: '', stderr: '' },
    {
      code: 1,
      stdout: 'error: Lean exited with code 137\n',
      stderr: 'error: build failed\n',
    },
    { code: 124, timedOut: true, stdout: '', stderr: '' },
    {
      code: 1,
      stdout: '',
      stderr:
        'fatal: could not read Username for public repository: terminal prompts disabled\nfatal: expected flush after ref listing',
    },
  ]) {
    assert(setupInfrastructureFailure(result))
    const dataDir = await fixture(t)
    let repairs = 0
    const worker = runtime()
    worker.run = async () => result
    const store = await new WorkspaceStore({
      dataDir,
      runtime: worker,
      setupRepair: async () => {
        repairs++
      },
    }).init()
    t.after(() => store.close())
    const project = await store.create('alice', { files })
    await store.jobs.get(project.id)
    assert.equal(store.get(project.id, 'alice').status, 'error')
    assert(
      store
        .get(project.id, 'alice')
        .error.includes(setupFailureMessage(result)),
    )
    assert.equal(repairs, 0)
  }
  assert.equal(
    setupInfrastructureFailure({
      code: 1,
      stderr: 'lakefile.toml: expected closing bracket',
    }),
    false,
  )
})

test('shared dependency infrastructure failures stop setup without a private retry or paid repair', async (t) => {
  const dataDir = await fixture(t)
  const worker = runtime()
  let privateChecks = 0
  let repairs = 0
  const message =
    'Dependency access failed. Check the network and repository permissions, then retry setup.'
  worker.prepareSharedDependencies = async () => {
    throw Object.assign(new Error(message), { infrastructure: true })
  }
  worker.run = async (_root, args) => {
    if (args.includes('env')) privateChecks++
    return { code: 0, stdout: '', stderr: '' }
  }
  const store = await new WorkspaceStore({
    dataDir,
    runtime: worker,
    setupRepair: async () => {
      repairs++
    },
  }).init()
  t.after(() => store.close())
  const project = await store.create('alice', { files })
  await store.jobs.get(project.id)
  const failed = store.get(project.id, 'alice')
  assert.equal(failed.status, 'error')
  assert.equal(failed.error, message)
  assert.equal(failed.needsPreparation, true)
  assert.equal(privateChecks, 0)
  assert.equal(repairs, 0)
  assert.equal(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    files[2].content,
  )
})

test('other shared-cache failures retain the private setup fallback', async (t) => {
  const dataDir = await fixture(t)
  const worker = runtime()
  let privateChecks = 0
  worker.prepareSharedDependencies = async () => {
    throw new Error('Shared cache unavailable')
  }
  worker.run = async (_root, args) => {
    if (args.includes('env')) privateChecks++
    return { code: 0, stdout: '', stderr: '' }
  }
  const store = await new WorkspaceStore({ dataDir, runtime: worker }).init()
  t.after(() => store.close())
  const project = await store.create('alice', { files })
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  assert(privateChecks > 0)
})

test('project build warnings distinguish stopped workers from unfinished user proofs', async (t) => {
  for (const [result, warning] of [
    [
      {
        code: 1,
        stderr: 'error: build failed\n',
        stdout: 'error: Lean exited with code 137\n',
      },
      /memory/,
    ],
    [{ code: 124, timedOut: true, stdout: '', stderr: '' }, /time limit/],
    [
      { code: 1, stdout: '', stderr: 'Main.lean: unsolved goals' },
      /repair the Lean errors/,
    ],
  ]) {
    const dataDir = await fixture(t)
    const worker = runtime()
    worker.run = async (_root, args) =>
      args.includes('build') ? result : { code: 0, stdout: '', stderr: '' }
    const store = await new WorkspaceStore({ dataDir, runtime: worker }).init()
    t.after(() => store.close())
    const project = await store.create('alice', { files })
    await store.jobs.get(project.id)
    const ready = store.get(project.id, 'alice')
    assert.equal(ready.status, 'ready', ready.error)
    assert.match(ready.buildWarning, warning)
  }
})

test('setup retains Lean pins through implicit updates and restores an unexpected mutation even on failure', async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'lean-toolchain'), toolchain)
  let args
  const worker = {
    run: async (_root, command) => {
      args = command
      return { code: 0 }
    },
  }
  await runPinnedLake(worker, root, ['lake', 'env', 'lean', '--version'])
  assert.deepEqual(args, [
    'lake',
    '--keep-toolchain',
    'env',
    'lean',
    '--version',
  ])
  worker.run = async () => {
    await fs.writeFile(
      path.join(root, 'lean-toolchain'),
      'leanprover/lean4:v4.35.0\n',
    )
    throw new Error('Dependency incompatible')
  }
  await assert.rejects(
    runPinnedLake(worker, root, ['lake', 'update']),
    /original release was restored/,
  )
  assert.equal(
    await fs.readFile(path.join(root, 'lean-toolchain'), 'utf8'),
    toolchain,
  )
})

test('Physlib cache uses the outer project pin and packages without creating a nested Lake workspace', () => {
  const commands = dependencyCacheCommands(
    { packages: [{ name: 'mathlib' }, { name: 'Physlib' }] },
    { toolchain: toolchain.trim() },
  )
  assert.deepEqual(commands[0], { args: ['lake', 'exe', 'cache', 'get'] })
  assert.deepEqual(commands[1], {
    optional: true,
    args: [
      'lake',
      'cache',
      'get',
      '--package=Physlib',
      '--scope=physlib-master/leanprover-lean4-v4.34.1/physlib',
    ],
    env: { LAKE_CONFIG: '/workspace/.lake/packages/Physlib/lake-cache.toml' },
  })
})

test('configuration edits invalidate readiness, same-content saves do not, and retry pretests the environment', async (t) => {
  const dataDir = await fixture(t)
  const worker = runtime()
  let pretests = 0
  worker.run = async (_root, args) => {
    if (args.includes('--stdin')) pretests++
    return { code: 0, stdout: '', stderr: '' }
  }
  const store = await new WorkspaceStore({ dataDir, runtime: worker }).init()
  t.after(() => store.close())
  const created = await store.create('alice', { files })
  await store.jobs.get(created.id)
  const config = await store.readFile(created.id, 'alice', 'lakefile.toml')
  assert.equal(
    (
      await store.writeFile(
        created.id,
        'alice',
        'lakefile.toml',
        config.content,
        config.hash,
      )
    ).requiresPreparation,
    false,
  )
  assert.equal(store.get(created.id, 'alice').status, 'ready')
  assert.equal(
    (
      await store.writeFile(
        created.id,
        'alice',
        'lakefile.toml',
        config.content + '# updated\n',
        config.hash,
      )
    ).requiresPreparation,
    true,
  )
  assert.equal(store.get(created.id, 'alice').status, 'error')
  await assert.rejects(store.snapshot(created.id, 'alice', 'blocked'), {
    status: 409,
  })
  await store.prepare(created.id, 'alice')
  await store.jobs.get(created.id)
  assert.equal(store.get(created.id, 'alice').status, 'ready')
  assert.equal(pretests, 2)
})

test('capacity and toolchain-download errors do not call repair or lose the original error', async (t) => {
  for (const status of [429, 503]) {
    const dataDir = path.join(await fixture(t), String(status))
    const worker = runtime()
    let repairs = 0
    worker.run = async () => {
      throw Object.assign(new Error('Workers busy; retry later'), { status })
    }
    const store = await new WorkspaceStore({
      dataDir,
      runtime: worker,
      setupRepair: async () => {
        repairs++
      },
    }).init()
    t.after(() => store.close())
    const created = await store.create('alice', { files })
    await store.jobs.get(created.id)
    assert.equal(repairs, 0)
    assert.match(store.get(created.id, 'alice').error, /Workers busy/)
    await assert.rejects(fs.stat(path.join(dataDir, 'setup-repairs')), {
      code: 'ENOENT',
    })
  }
})

test('repair copies are removed on success and failure while records and original sources survive', async (t) => {
  for (const fails of [false, true]) {
    const dataDir = await fixture(t)
    const worker = runtime()
    worker.run = async (root) => ({
      code: root.includes('setup-repairs') ? 0 : 1,
      stdout: '',
      stderr: 'Invalid configuration',
    })
    let candidate
    const store = await new WorkspaceStore({
      dataDir,
      runtime: worker,
      setupRepair: async ({ root }) => {
        candidate = root
        if (fails) throw new Error('Repair unavailable')
      },
    }).init()
    t.after(() => store.close())
    const created = await store.create('alice', { files })
    await store.jobs.get(created.id)
    assert.match(store.get(created.id, 'alice').error, /Invalid configuration/)
    await assert.rejects(fs.stat(candidate), { code: 'ENOENT' })
    assert.equal(
      await fs.readFile(path.join(created.root, 'Main.lean'), 'utf8'),
      files[2].content,
    )
    if (!fails)
      assert(
        (
          await fs.stat(path.join(path.dirname(candidate), 'changes.json'))
        ).isFile(),
      )
    else
      assert.match(store.get(created.id, 'alice').error, /Repair unavailable/)
  }
})

test('crash recovery removes only owned dead workspaces, preserving live owners, mounts, unknown directories, and escaping links', async (t) => {
  const base = await fixture(t),
    directory = path.join(base, 'claims'),
    allowed = path.join(base, 'stages')
  await fs.mkdir(allowed)
  const removed = []
  const manager = new TemporaryWorkspaces({
    directory,
    allowedRoots: [allowed],
    cleanup: async (root) => {
      removed.push(root)
      await removeDisposableTree(root)
      return true
    },
  })
  for (const name of ['dead', 'live', 'mounted', 'unknown', 'escape'])
    await fs.mkdir(path.join(allowed, name))
  for (const name of ['dead', 'live', 'mounted', 'escape'])
    await manager.claim(path.join(allowed, name))
  for (const name of ['dead', 'mounted', 'escape']) {
    const claim = path.join(
      directory,
      createHash('sha256').update(path.join(allowed, name)).digest('hex') +
        '.json',
    )
    const data = JSON.parse(await fs.readFile(claim, 'utf8'))
    data.owner.startTime = '0'
    await fs.writeFile(claim, JSON.stringify(data))
  }
  const outside = path.join(base, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'preserved'), 'safe')
  await fs.rmdir(path.join(allowed, 'escape'))
  await fs.symlink(outside, path.join(allowed, 'escape'))
  await manager.sweep([path.join(allowed, 'mounted')])
  assert.deepEqual(removed, [path.join(allowed, 'dead')])
  for (const name of ['live', 'mounted', 'unknown'])
    assert((await fs.stat(path.join(allowed, name))).isDirectory())
  assert.equal(
    await fs.readFile(path.join(outside, 'preserved'), 'utf8'),
    'safe',
  )
})

test('old Lake releases retain their pin without the newer keep-toolchain option', async (t) => {
  const root = await fixture(t)
  await fs.writeFile(
    path.join(root, 'lean-toolchain'),
    'leanprover/lean4:v4.13.0\n',
  )
  let command
  await runPinnedLake(
    {
      run: async (_root, args) => {
        command = args
        return { code: 0 }
      },
    },
    root,
    ['lake', 'update'],
  )
  assert.deepEqual(command, ['lake', 'update'])
})

test('root Physlib uses its own cache configuration; dependency-only builders omit root modules', () => {
  const manifest = { name: 'Physlib', packages: [{ name: 'mathlib' }] }
  const commands = dependencyCacheCommands(manifest, {
    toolchain: toolchain.trim(),
  })
  assert.equal(commands[1].env.LAKE_CONFIG, '/workspace/lake-cache.toml')
  assert(commands[1].args.includes('--package=Physlib'))
  assert.deepEqual(
    dependencyCacheCommands(manifest, {
      dependencyOnly: true,
      toolchain: toolchain.trim(),
    }),
    [{ args: ['lake', 'exe', 'cache', 'get'] }],
  )
})

test('a retry rejects file saves immediately and preserves the metadata from preparation', async (t) => {
  const dataDir = await fixture(t),
    worker = runtime()
  const store = await new WorkspaceStore({ dataDir, runtime: worker }).init()
  t.after(() => store.close())
  const project = await store.create('alice', { files })
  await store.jobs.get(project.id)
  const original = await store.readFile(project.id, 'alice', 'lakefile.toml')
  await store.writeFile(
    project.id,
    'alice',
    'lakefile.toml',
    original.content + '# changed\n',
    original.hash,
  )
  let release, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const pending = new Promise((resolve) => {
    release = resolve
  })
  worker.run = async (_root, args) => {
    if (args.includes('--version')) {
      entered()
      await pending
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  await store.prepare(project.id, 'alice')
  await started
  await assert.rejects(
    store.writeFile(project.id, 'alice', 'lakefile.toml', original.content),
    { status: 409 },
  )
  release()
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  assert.equal(store.get(project.id, 'alice').toolchain, toolchain.trim())
})

test('cleanup failure is deferred per claim and does not prevent later dead claims from being cleaned', async (t) => {
  const base = await fixture(t),
    directory = path.join(base, 'claims'),
    allowed = path.join(base, 'stages')
  await fs.mkdir(allowed)
  const cleaned = []
  const manager = new TemporaryWorkspaces({
    directory,
    allowedRoots: [allowed],
    cleanup: async (root) => {
      if (root.endsWith('blocked'))
        throw Object.assign(new Error('Fixture directory temporarily busy'), {
          code: 'EBUSY',
        })
      cleaned.push(root)
      await removeDisposableTree(root)
      return true
    },
  })
  for (const name of ['blocked', 'available']) {
    const root = path.join(allowed, name)
    await fs.mkdir(root)
    await manager.claim(root)
    const file = path.join(
      directory,
      createHash('sha256').update(root).digest('hex') + '.json',
    )
    const marker = JSON.parse(await fs.readFile(file, 'utf8'))
    marker.owner.startTime = '0'
    await fs.writeFile(file, JSON.stringify(marker))
  }
  await manager.sweep([])
  assert.deepEqual(cleaned, [path.join(allowed, 'available')])
  assert.equal((await fs.readdir(directory)).length, 1)
})

test('transport failures do not invoke paid setup repair', async (t) => {
  const dataDir = await fixture(t),
    worker = runtime()
  let repairs = 0
  worker.run = async () => ({
    code: 1,
    stdout: '',
    stderr:
      'fatal: unable to access public repository: Could not resolve host: github.com',
  })
  const store = await new WorkspaceStore({
    dataDir,
    runtime: worker,
    setupRepair: async () => {
      repairs++
    },
  }).init()
  t.after(() => store.close())
  const project = await store.create('alice', { files })
  await store.jobs.get(project.id)
  assert.equal(repairs, 0)
  assert.match(store.get(project.id, 'alice').error, /Could not resolve host/)
})

test('cleanup cannot turn an accepted repair into failure or replace its original error', async (t) => {
  const dataDir = await fixture(t),
    worker = runtime()
  worker.run = async (root) => ({
    code: (
      await fs.readFile(path.join(root, 'lakefile.toml'), 'utf8')
    ).includes('broken')
      ? 1
      : 0,
    stdout: '',
    stderr: 'Invalid Lake configuration',
  })
  worker.releaseTemporaryWorkspace = async () => {
    throw new Error('Fixture cleanup deferred')
  }
  const store = await new WorkspaceStore({
    dataDir,
    runtime: worker,
    setupRepair: async ({ root }) =>
      fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n'),
  }).init()
  t.after(() => store.close())
  const project = await store.create('alice', {
    files: files.map((file) =>
      file.path === 'lakefile.toml'
        ? { ...file, content: 'broken config' }
        : file,
    ),
  })
  await store.jobs.get(project.id)
  assert.equal(
    store.get(project.id, 'alice').status,
    'ready',
    store.get(project.id, 'alice').error,
  )
  assert.equal(store.get(project.id, 'alice').setupRepair.status, 'completed')
})

test('retry status waits for a pending save and retains the saved custom environment metadata', async (t) => {
  const dataDir = await fixture(t),
    worker = runtime()
  const store = await new WorkspaceStore({ dataDir, runtime: worker }).init()
  t.after(() => store.close())
  const project = await store.create('alice', { files })
  await store.jobs.get(project.id)
  let release
  store.locks.set(
    project.id,
    new Promise((resolve) => {
      release = resolve
    }),
  )
  const saved = store.writeFile(
    project.id,
    'alice',
    'lakefile.toml',
    'name = "new-config"\n',
  )
  const retry = store.prepare(project.id, 'alice')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  release()
  await saved
  await retry
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  assert.equal(store.get(project.id, 'alice').customEnvironment, true)
})

test('infrastructure failures preserve diagnostics and editing for existing uploaded files', async (t) => {
  const dataDir = await fixture(t),
    worker = runtime()
  worker.run = async () => {
    throw Object.assign(new Error('Workers busy; retry later'), { status: 503 })
  }
  const store = await new WorkspaceStore({ dataDir, runtime: worker }).init()
  t.after(() => store.close())
  const project = await store.create('alice', { files })
  await store.jobs.get(project.id)
  const failed = store.get(project.id, 'alice')
  assert.equal(failed.needsPreparation, true)
  assert.match(failed.log, /Workers busy/)
})

test('reverting preset configuration reuses the original dependency binding', async (t) => {
  const dataDir = await fixture(t)
  const template = path.join(dataDir, 'template')
  await fs.mkdir(template)
  for (const file of files)
    await fs.writeFile(path.join(template, file.path), file.content)
  const worker = runtime()
  worker.templateRoot = () => template
  let bindings = 0,
    clears = 0
  worker.inheritDependencies = async () => {
    bindings++
  }
  worker.clearInheritedDependencies = async () => {
    clears++
  }
  const store = await new WorkspaceStore({ dataDir, runtime: worker }).init()
  t.after(() => store.close())
  const project = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(project.id)
  const original = await store.readFile(project.id, 'alice', 'lakefile.toml')
  const changed = await store.writeFile(
    project.id,
    'alice',
    'lakefile.toml',
    original.content + '# changed\n',
    original.hash,
  )
  await store.writeFile(
    project.id,
    'alice',
    'lakefile.toml',
    original.content,
    changed.hash,
  )
  await store.prepare(project.id, 'alice')
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  assert.equal(store.get(project.id, 'alice').customEnvironment, undefined)
  assert.equal(bindings, 2)
  assert.equal(clears, 0)
})

test('failed toolchain installation after an edit leaves files editable without automatic repair', async (t) => {
  const dataDir = await fixture(t),
    worker = runtime()
  let repairs = 0
  const store = await new WorkspaceStore({
    dataDir,
    runtime: worker,
    setupRepair: async () => {
      repairs++
    },
  }).init()
  t.after(() => store.close())
  const project = await store.create('alice', { files })
  await store.jobs.get(project.id)
  const config = await store.readFile(project.id, 'alice', 'lean-toolchain')
  await store.writeFile(
    project.id,
    'alice',
    'lean-toolchain',
    'leanprover/lean4:v4.99.0\n',
    config.hash,
  )
  worker.prepareToolchain = async () => {
    throw Object.assign(new Error('Lean release unavailable'), {
      infrastructure: true,
    })
  }
  await store.prepare(project.id, 'alice')
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').needsPreparation, true)
  assert.equal(repairs, 0)
  const failed = await store.readFile(project.id, 'alice', 'lean-toolchain')
  await store.writeFile(
    project.id,
    'alice',
    'lean-toolchain',
    toolchain,
    failed.hash,
  )
  worker.prepareToolchain = async () => {}
  await store.prepare(project.id, 'alice')
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
})

test('optional Physlib cache skips missing configuration and tolerates old Lake or missing artifacts', async (t) => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'lean-toolchain'), toolchain)
  const command = dependencyCacheCommands(
    { name: 'Physlib' },
    { toolchain: toolchain.trim() },
  )[0]
  let calls = 0
  const worker = {
    run: async () => {
      calls++
      return { code: 1, stderr: 'unknown command cache' }
    },
  }
  await runDependencyCache(worker, root, command)
  assert.equal(calls, 0)
  await fs.writeFile(
    path.join(root, 'lake-cache.toml'),
    'service = "fixture"\n',
  )
  await runDependencyCache(worker, root, command)
  assert.equal(calls, 1)
  worker.run = async () => ({
    code: 1,
    stderr: 'No published artifacts for this scope',
  })
  await runDependencyCache(worker, root, command)
  assert.equal(
    await fs.readFile(path.join(root, 'lean-toolchain'), 'utf8'),
    toolchain,
  )
})
