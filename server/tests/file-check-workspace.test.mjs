import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventStore, JobManager } from '../events.mjs'
import { Runtime } from '../runtime.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-file-check-'),
  )
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args) {
      if (args[0] === 'lake' && args[1] === 'update')
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const store = await new WorkspaceStore({ dataDir: directory, runtime }).init()
  const project = await store.create('owner', {
    name: 'Competition',
    preset: 'lean',
  })
  await store.jobs.get(project.id)
  await store.setMember(project.id, 'owner', 'viewer', 'viewer')
  const events = new EventStore(directory)
  const jobs = new JobManager({ events, workspaces: store, runtime })
  t.after(async () => {
    await jobs.shutdown()
    events.close()
    store.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return {
    store,
    events,
    jobs,
    runtime,
    project,
    scratch: path.join(directory, 'file-checks'),
  }
}

test('a viewer’s file check compiles captured imports while a teammate saves, and reports the snapshot it checked', async (t) => {
  const { store, events, jobs, runtime, project, scratch } = await fixture(t)
  const original = 'def helper : Nat := 1\n'
  const sibling = 'example : False := by trivial\n'
  await fs.writeFile(
    path.join(project.root, 'Target.lean'),
    'import Helper\n#check helper\n',
  )
  await fs.writeFile(path.join(project.root, 'Helper.lean'), original)
  await fs.writeFile(path.join(project.root, 'Unrelated.lean'), sibling)
  await fs.mkdir(path.join(project.root, '.lake/build'), { recursive: true })
  await fs.writeFile(
    path.join(project.root, '.lake/build/stale.olean'),
    'stale',
  )
  const expected = await store.checkFingerprint(project.id, 'viewer')
  const entered = Promise.withResolvers(),
    finish = Promise.withResolvers()
  const bindings = []
  runtime.inheritDependencies = async (from, to) => bindings.push([from, to])
  runtime.run = async (root, args, options) => {
    entered.resolve(root)
    await finish.promise
    assert.notEqual(root, project.root)
    assert.deepEqual(bindings, [[project.root, root]])
    assert.equal(args[2], './Target.lean')
    assert.equal(options.readOnlyWorkspace, true)
    assert.equal(options.writeLakeCache, true)
    assert.equal(options.writePrivateDependencyCache, true)
    assert.equal(options.network, 'none')
    assert.equal(
      await fs.readFile(path.join(root, 'Helper.lean'), 'utf8'),
      original,
    )
    assert.equal(
      await fs.readFile(path.join(root, 'Unrelated.lean'), 'utf8'),
      sibling,
    )
    await assert.rejects(fs.stat(path.join(root, '.lake/build/stale.olean')), {
      code: 'ENOENT',
    })
    return { code: 0, stdout: '', stderr: '' }
  }
  const job = jobs.check('viewer', project.id, 'Target.lean', 'file')
  const task = jobs.active.get(job.id)
  try {
    await Promise.race([
      entered.promise,
      task.then(() => assert.fail(events.get(job.id).error)),
    ])
    for (const filename of ['Helper.lean', 'Unrelated.lean']) {
      const prior = await store.readFile(project.id, 'owner', filename)
      await store.writeFile(
        project.id,
        'owner',
        filename,
        '-- later source\n',
        prior.hash,
      )
    }
  } finally {
    finish.resolve()
  }
  await task
  const result = events.get(job.id)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.result.checkedSnapshot, expected)
  assert.equal(result.result.sourceChanged, true)
  assert.deepEqual(await fs.readdir(scratch), [])
})

test('waiting checks allocate no source copies, cancel promptly and remove failed copies', async (t) => {
  const { store, project, scratch, runtime } = await fixture(t)
  const release = Promise.withResolvers()
  const live = []
  let available = 2
  runtime.fileCheckCapacity = () => available
  const run = (operation, signal) =>
    store.withFileCheckWorkspace(project.id, 'viewer', { signal }, operation)
  const checks = Array.from({ length: 6 }, () =>
    run(async (root) => {
      live.push(root)
      await release.promise
    }),
  )
  try {
    await t.waitFor(() => assert.equal(live.length, 2))
    assert.equal((await fs.readdir(scratch)).length, 2)
    available = 10
    await t.waitFor(() => assert.equal(live.length, 6))
    const controllers = Array.from({ length: 19 }, () => new AbortController())
    const waiting = controllers.map((controller) =>
      assert.rejects(
        run(() => assert.fail('Cancelled check entered'), controller.signal),
        /cancelled/,
      ),
    )
    assert.equal((await fs.readdir(scratch)).length, 6)
    for (const controller of controllers)
      controller.abort(new Error('cancelled'))
    await Promise.all(waiting)
  } finally {
    release.resolve()
  }
  await Promise.all(checks)
  await assert.rejects(
    run(() => {
      throw new Error('fixture compile failed')
    }),
    /fixture compile failed/,
  )
  assert.deepEqual(await fs.readdir(scratch), [])
  // Omitted/private inputs cannot acquire an immutable-source receipt.
  await fs.writeFile(path.join(project.root, '.env'), 'fixture only')
  await run((root, digest) => {
    assert.equal(root, project.root)
    assert.equal(digest, undefined)
  })
  assert.deepEqual(await fs.readdir(scratch), [])
})

test('source links and size limits do not certify an incomplete copy', async (t) => {
  const { store, project, scratch } = await fixture(t)
  const run = (operation) =>
    store.withFileCheckWorkspace(project.id, 'viewer', {}, operation)
  const alias = path.join(project.root, 'Alias.lean')
  const canonical = (root, digest) => {
    assert.equal(root, project.root)
    assert.equal(digest, undefined)
  }
  await fs.symlink('Main.lean', alias)
  const expected = await store.checkFingerprint(project.id, 'viewer')
  await run(async (root, digest) => {
    assert.notEqual(root, project.root)
    assert.equal(digest, expected)
    assert.equal(await fs.readlink(path.join(root, 'Alias.lean')), 'Main.lean')
  })
  await fs.unlink(alias)
  await fs.symlink('../' + path.basename(project.root) + '/Main.lean', alias)
  await run(canonical)
  await fs.unlink(alias)
  const big = await fs.open(path.join(project.root, 'large-input'), 'wx')
  try {
    await big.truncate(129 * 1024 ** 2)
  } finally {
    await big.close()
  }
  await run(canonical)
  assert.deepEqual(await fs.readdir(scratch), [])
})

test('a private repository mounts its own installed packages read-only while the disposable file check owns its build output', async (t) => {
  const { store, project, scratch } = await fixture(t)
  const engine = path.join(store.dataDir, 'engine')
  await fs.writeFile(
    engine,
    '#!' +
      process.execPath +
      "\nif (process.argv[2] === 'run') console.log(JSON.stringify(process.argv.slice(2)))\n",
    { mode: 0o700 },
  )
  const runtime = new Runtime({ dataDir: store.dataDir, docker: engine })
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  store.runtime = runtime
  const packages = path.join(project.root, '.lake/packages')
  await fs.mkdir(path.join(packages, 'PrivateHelper'), { recursive: true })
  await fs.writeFile(
    path.join(packages, 'PrivateHelper', 'Main.lean'),
    'def privateHelper := 1\n',
  )
  try {
    await store.withFileCheckWorkspace(
      project.id,
      'viewer',
      {},
      async (root, digest, onSpawn) => {
        assert.match(digest, /^[a-f0-9]{64}$/)
        assert.equal(runtime.dependencyRoot(root), project.root)
        const result = await runtime.run(
          root,
          ['lake', 'lean', './Main.lean'],
          {
            readOnlyWorkspace: true,
            writeLakeCache: true,
            writePrivateDependencyCache: true,
            freshHome: true,
            cleanHome: true,
            network: 'none',
            onSpawn,
          },
        )
        const args = JSON.parse(result.stdout)
        assert(
          args.includes(
            'type=bind,src=' +
              packages +
              ',dst=/workspace/.lake/packages,readonly',
          ),
        )
        assert(
          args.includes('type=bind,src=' + root + ',dst=/workspace,readonly'),
        )
        assert(
          args.includes(
            'type=bind,src=' +
              path.join(root, '.lake') +
              ',dst=/workspace/.lake',
          ),
        )
        assert(
          !args.includes('type=bind,src=' + project.root + ',dst=/workspace'),
        )
      },
    )
    assert.deepEqual(await fs.readdir(scratch), [])
    assert.deepEqual(
      await fs.readdir(path.join(runtime.runtimeDir, 'temporary-workspaces')),
      [],
    )
    assert.equal(
      await fs.readFile(
        path.join(packages, 'PrivateHelper', 'Main.lean'),
        'utf8',
      ),
      'def privateHelper := 1\n',
    )
  } finally {
    await runtime.shutdown()
  }
})

test('failed container cleanup retains its workspace and slot until the worker confirms it stopped', async (t) => {
  const { store, project, scratch, runtime } = await fixture(t)
  const stopped = Promise.withResolvers()
  runtime.fileCheckCapacity = () => 1
  let mounted = true
  runtime.claimTemporaryWorkspace = async () => {}
  runtime.releaseTemporaryWorkspace = async (root) => {
    if (mounted) return false
    await fs.rm(root, { recursive: true, force: true })
    return true
  }
  const run = (operation) =>
    store.withFileCheckWorkspace(project.id, 'viewer', {}, operation)
  await assert.rejects(
    run((_root, _digest, onSpawn) => {
      onSpawn({ workerReleased: stopped.promise })
      throw new Error('unconfirmed worker cleanup')
    }),
    /unconfirmed worker cleanup/,
  )
  let nextStarted = false
  const next = run(() => {
    nextStarted = true
  })
  assert.equal((await fs.readdir(scratch)).length, 1)
  assert.equal(nextStarted, false)
  mounted = false
  stopped.resolve()
  await next
  assert.equal(nextStarted, true)
  assert.deepEqual(await fs.readdir(scratch), [])
})
