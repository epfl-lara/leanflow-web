import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { Runtime } from '../runtime.mjs'
import { sharedDependencySpec } from '../shared-dependencies.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const revision = 'a'.repeat(40)
const manifest = {
  version: '1.2.0',
  packagesDir: '.lake/packages',
  lakeDir: '.lake',
  name: 'First',
  packages: [
    {
      name: 'mathlib',
      type: 'git',
      url: 'https://github.com/leanprover-community/mathlib4',
      rev: revision,
      configFile: 'lakefile.lean',
      manifestFile: 'lake-manifest.json',
      subDir: null,
    },
  ],
}
const configuration = {
  'lean-toolchain': toolchain + '\n',
  'lake-manifest.json': JSON.stringify(manifest),
  'lakefile.toml':
    'name = "First"\nversion = "0.1.0"\ndefaultTargets = ["Main"]\n\n[[require]]\nname = "mathlib"\ngit = "https://github.com/leanprover-community/mathlib4"\nrev = "' +
    revision +
    '"\n\n[[lean_lib]]\nname = "Main"\n',
}
const request = (overrides) => ({
  owner: 'alice',
  toolchain,
  image: 'fixture-image',
  configuration: structuredClone(configuration),
  validateRepository: async () => {},
  ...overrides,
})

async function writeConfig(root, config = configuration) {
  await fs.mkdir(root, { recursive: true })
  for (const [name, content] of Object.entries(config))
    await fs.writeFile(path.join(root, name), content)
}

async function thaw(directory) {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return
  await fs.chmod(directory, 0o700)
  for (const entry of await fs.readdir(directory, { withFileTypes: true }))
    if (entry.isDirectory()) await thaw(path.join(directory, entry.name))
}

async function fixture(t, command = async () => null) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-shared-deps-'),
  )
  const root = path.join(dataDir, 'first')
  await writeConfig(root)
  await fs.writeFile(path.join(root, 'Main.lean'), 'PRIVATE PROOF SOURCE')
  const docker = path.join(dataDir, 'docker-fixture')
  await fs.writeFile(
    docker,
    `#!${process.execPath}\nif (process.argv[2] === 'run') console.log(JSON.stringify(process.argv.slice(2)))\n`,
    { mode: 0o700 },
  )
  await fs.mkdir(path.join(dataDir, 'runtime'), { recursive: true })
  const runtime = new Runtime({ dataDir, docker })
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  const run = runtime.run.bind(runtime)
  const calls = []
  runtime.run = async (stage, args, options) => {
    calls.push({ stage, args, options })
    assert.equal(options.cleanHome, true)
    assert.equal(options.signal, undefined)
    await assert.rejects(fs.stat(path.join(stage, 'Main.lean')), {
      code: 'ENOENT',
    })
    const override = await command(stage, args, options, runtime)
    if (override) return override
    if (
      args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
      'lake env lean --version'
    ) {
      const packages = path.join(stage, '.lake/packages/mathlib')
      await fs.mkdir(path.join(packages, '.lake/build/lib/lean'), {
        recursive: true,
      })
      await fs.writeFile(
        path.join(packages, 'Mathlib.lean'),
        'UPSTREAM FIXTURE SOURCE',
      )
    }
    if (
      args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
      'lake exe cache get'
    ) {
      await fs.writeFile(
        path.join(
          stage,
          '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean',
        ),
        'COMPILED FIXTURE',
      )
      const home = path.join(
        runtime.runtimeDir,
        'homes',
        createHash('sha256').update(stage).digest('hex'),
      )
      await fs.mkdir(path.join(home, '.cache/lake/artifacts'), {
        recursive: true,
      })
      await fs.writeFile(
        path.join(home, '.cache/lake/artifacts/fixture.ltar'),
        'DOWNLOADED FIXTURE',
      )
    }
    if (args.at(-1) === '--stdin') {
      assert.match(options.input, /import Mathlib\n/)
      assert.equal(options.network, 'none')
      assert.equal(options.readOnlyWorkspace, true)
      assert.equal(runtime.dependencyRoot(stage), stage)
      assert.equal(
        await fs.readFile(
          path.join(
            stage,
            '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean',
          ),
          'utf8',
        ),
        'COMPILED FIXTURE',
      )
    }
    return {
      code: 0,
      stdout: args.at(-1) === 'HEAD' ? revision + '\n' : '',
      stderr: '',
    }
  }
  t.after(async () => {
    runtime.run = run
    await runtime.shutdown()
    await Promise.allSettled([...runtime.sharedCache.building.values()])
    await thaw(dataDir)
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return { runtime, root, dataDir, calls, run }
}

test('cache matches exact Lean, all dependency pins, image, account and settings while ignoring TOML project names', async () => {
  const first = await sharedDependencySpec(request())
  const renamed = request()
  renamed.configuration['lake-manifest.json'] = JSON.stringify({
    ...manifest,
    name: 'Second',
  })
  renamed.configuration['lakefile.toml'] = configuration['lakefile.toml']
    .replace('First', 'Second')
    .replaceAll('Main', 'Other')
  assert.equal((await sharedDependencySpec(renamed)).key, first.key)
  const differentLean = 'leanprover/lean4:v4.35.0-rc4'
  const variants = [
    request({ owner: 'bob' }),
    request({ image: 'other-image' }),
    request({
      toolchain: differentLean,
      configuration: {
        ...configuration,
        'lean-toolchain': differentLean + '\n',
      },
    }),
    request({
      configuration: {
        ...configuration,
        'lake-manifest.json': JSON.stringify({
          ...manifest,
          packages: [{ ...manifest.packages[0], rev: 'b'.repeat(40) }],
        }),
      },
    }),
    request({
      configuration: {
        ...configuration,
        'lakefile.toml':
          configuration['lakefile.toml'] +
          '\n[leanOptions]\nmaxRecDepth = 2000\n',
      },
    }),
  ]
  for (const variant of variants)
    assert.notEqual((await sharedDependencySpec(variant)).key, first.key)
  const extra = {
    ...manifest.packages[0],
    name: 'batteries',
    url: 'https://github.com/leanprover-community/batteries',
  }
  const graph = request({
    configuration: {
      ...configuration,
      'lake-manifest.json': JSON.stringify({
        ...manifest,
        packages: [...manifest.packages, extra],
      }),
    },
  })
  const original = (await sharedDependencySpec(graph)).key
  extra.rev = 'c'.repeat(40)
  graph.configuration['lake-manifest.json'] = JSON.stringify({
    ...manifest,
    packages: [...manifest.packages, extra],
  })
  assert.notEqual((await sharedDependencySpec(graph)).key, original)
})

test('unsupported or unpinned dependency graphs keep their private preparation path', async () => {
  for (const pkg of [
    { ...manifest.packages[0], type: 'path', dir: '../private' },
    { ...manifest.packages[0], rev: 'main' },
    { ...manifest.packages[0], subDir: '../outside' },
    { ...manifest.packages[0], url: 'https://token@github.com/owner/private' },
    null,
  ]) {
    assert.equal(
      await sharedDependencySpec(
        request({
          configuration: {
            ...configuration,
            'lake-manifest.json': JSON.stringify({
              ...manifest,
              packages: [pkg],
            }),
          },
        }),
      ),
      null,
    )
  }
})

test('Mathlib dependency traces are complete before imported projects build with readonly packages', async (t) => {
  const widgetLock = '.lake/packages/proofwidgets/widget/package-lock.json'
  const { runtime, root, calls } = await fixture(
    t,
    async (stage, args, options) => {
      const command = args.filter((arg) => arg !== '--keep-toolchain').join(' ')
      if (command === 'lake exe cache get') {
        const lock = path.join(stage, widgetLock)
        await fs.mkdir(path.dirname(lock), { recursive: true })
        await fs.writeFile(lock, '{"lockfileVersion":3}\n')
      }
      if (command === 'lake build @mathlib') {
        const lock = await fs.readFile(path.join(stage, widgetLock))
        const expected = createHash('sha256').update(lock).digest('hex')
        if (options.readOnlyWorkspace) {
          assert.equal(options.network, 'none')
          assert.equal(
            await fs.readFile(path.join(stage, widgetLock + '.hash'), 'utf8'),
            expected,
          )
        } else
          await fs.writeFile(path.join(stage, widgetLock + '.hash'), expected)
      }
    },
  )
  const config = {
    ...configuration,
    'lake-manifest.json': JSON.stringify({
      ...manifest,
      packages: [
        ...manifest.packages,
        {
          ...manifest.packages[0],
          name: 'proofwidgets',
          url: 'https://github.com/leanprover-community/ProofWidgets4',
          inherited: true,
        },
      ],
    }),
  }
  await writeConfig(root, config)
  const shared = await runtime.prepareSharedDependencies(
    root,
    request({ configuration: config }),
  )
  const widgetBuilds = calls.filter(
    (call) => call.args.includes('build') && call.args.includes('proofwidgets'),
  )
  assert.equal(
    widgetBuilds.length,
    2,
    'Inherited packages must build before publication and replay read only',
  )
  assert.notEqual(widgetBuilds[0].options.readOnlyWorkspace, true)
  assert.equal(widgetBuilds[1].options.readOnlyWorkspace, true)
  await runtime.inheritDependencies(shared.root, root)
  runtime.run = async (project, args) => {
    assert.deepEqual(args, ['lake', 'build'])
    const source = runtime.dependencyRoot(project)
    const lock = await fs.readFile(path.join(source, widgetLock))
    const hash = await fs
      .readFile(path.join(source, widgetLock + '.hash'), 'utf8')
      .catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    return hash === createHash('sha256').update(lock).digest('hex')
      ? { code: 0, stdout: 'Build completed successfully', stderr: '' }
      : {
          code: 1,
          stdout: '',
          stderr:
            'Replaying proofwidgets/widgetPackageLock: read-only file system',
        }
  }
  const result = await runtime.run(root, ['lake', 'build'], {
    network: 'none',
    readOnlyWorkspace: true,
    writeLakeCache: true,
  })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(
    (await fs.stat(path.join(shared.root, widgetLock + '.hash'))).mode & 0o222,
    0,
  )
  assert.equal(
    await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
    'PRIVATE PROOF SOURCE',
  )
})

test('complete-build caches use new entries while existing import-only bindings stay unchanged', async (t) => {
  const oldKey =
    '7f37e36e8b52d43a900ecc08fa181e4e7838a0b5eaa2aecb96c79170b9e098ce'
  const { runtime, root, dataDir, calls } = await fixture(t)
  const oldRoot = path.join(dataDir, 'runtime/shared-dependencies', oldKey)
  await writeConfig(oldRoot)
  const oldArtifact = path.join(oldRoot, '.lake/packages/mathlib/Mathlib.lean')
  await fs.mkdir(path.dirname(oldArtifact), { recursive: true })
  await fs.writeFile(oldArtifact, 'EXISTING IMMUTABLE DEPENDENCY', {
    mode: 0o400,
  })
  await fs.writeFile(
    path.join(oldRoot, '.ready.json'),
    JSON.stringify({ key: oldKey, check: 'import Mathlib' }),
    { mode: 0o400 },
  )
  const active = path.join(dataDir, 'active-project')
  await writeConfig(active)
  await runtime.inheritDependencies(oldRoot, active)
  const shared = await runtime.prepareSharedDependencies(root, request())
  assert.notEqual(shared.root, oldRoot)
  assert.equal(runtime.dependencyRoot(active), oldRoot)
  assert.equal(
    await fs.readFile(oldArtifact, 'utf8'),
    'EXISTING IMMUTABLE DEPENDENCY',
  )
  assert.equal((await fs.stat(oldArtifact)).mode & 0o777, 0o400)
  const marker = JSON.parse(
    await fs.readFile(path.join(shared.root, '.ready.json'), 'utf8'),
  )
  assert.equal(marker.schema, 4)
  assert.match(marker.check, /lake build @mathlib/)
  const preparedCommands = calls.length
  const hit = await runtime.prepareSharedDependencies(root, request())
  assert.equal(hit.root, shared.root)
  assert.equal(hit.reused, true)
  assert.equal(calls.length, preparedCommands)
})

test('a dependency cache is not published when build replay needs a write under the readonly mounts', async (t) => {
  const { runtime, root, dataDir } = await fixture(
    t,
    async (_stage, args, options) => {
      if (args.includes('@mathlib') && options.readOnlyWorkspace)
        return {
          code: 1,
          stdout: '',
          stderr:
            'read-only file system: proofwidgets/widget/package-lock.json.hash',
        }
    },
  )
  await assert.rejects(
    runtime.prepareSharedDependencies(root, request()),
    /read-only file system/,
  )
  assert.deepEqual(
    await fs.readdir(path.join(dataDir, 'runtime/shared-dependencies')),
    [],
  )
})

test('imports and snapshots reuse compiled readonly dependencies without copying private sources or project builds', async (t) => {
  const { runtime, root, dataDir, calls, run } = await fixture(t)
  await fs.mkdir(path.join(root, '.lake/build'), { recursive: true })
  await fs.writeFile(
    path.join(root, '.lake/build/private.olean'),
    'PRIVATE BUILD',
  )
  const shared = await runtime.prepareSharedDependencies(root, request())
  assert(shared)
  assert.equal(
    calls.filter(
      (call) =>
        call.args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
        'lake exe cache get',
    ).length,
    1,
  )
  assert.equal(
    (await fs.stat(path.join(shared.root, '.lake/packages/mathlib'))).mode &
      0o222,
    0,
  )
  assert.equal(
    (
      await fs.stat(
        path.join(
          shared.root,
          '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean',
        ),
      )
    ).mode & 0o222,
    0,
  )
  await assert.rejects(
    fs.stat(path.join(shared.root, '.lake/build/private.olean')),
    { code: 'ENOENT' },
  )
  assert.equal(
    await fs.readFile(
      path.join(shared.root, '.dependency-lake-cache/artifacts/fixture.ltar'),
      'utf8',
    ),
    'DOWNLOADED FIXTURE',
  )
  await runtime.inheritDependencies(shared.root, root)
  const second = path.join(dataDir, 'second')
  await writeConfig(second)
  const hit = await runtime.prepareSharedDependencies(second, request())
  assert.equal(hit.root, shared.root)
  assert.equal(hit.reused, true)
  await runtime.inheritDependencies(hit.root, second)
  assert.deepEqual(await fs.readdir(path.join(second, '.lake/packages')), [])
  const candidate = path.join(dataDir, 'candidate')
  await writeConfig(candidate)
  await runtime.inheritDependencies(root, candidate)
  assert.equal(runtime.dependencyRoot(candidate), shared.root)
  runtime.run = run
  const argv = JSON.parse((await runtime.run(candidate, ['true'])).stdout)
  assert(
    argv.includes(
      `type=bind,src=${shared.root}/.lake/packages,dst=/workspace/.lake/packages,readonly`,
    ),
  )
  assert(
    argv.includes(
      `type=bind,src=${shared.root}/.dependency-lake-cache,dst=/opt/dependency-lake-cache,readonly`,
    ),
  )
  assert.equal(
    await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
    'PRIVATE PROOF SOURCE',
  )
  const home = await runtime.home(candidate)
  assert.equal(
    await fs.readlink(path.join(home, '.cache/lake/artifacts/fixture.ltar')),
    '/opt/dependency-lake-cache/artifacts/fixture.ltar',
  )
  const restored = new Runtime({ dataDir, docker: runtime.docker })
  assert.equal(restored.dependencyRoot(second), shared.root)
})

test('a cancelled cache waiter cannot cancel another import and remaining waiters receive build progress', async (t) => {
  let started, resume, joined
  const reached = new Promise((resolve) => {
    started = resolve
  })
  const waiting = new Promise((resolve) => {
    resume = resolve
  })
  const secondValidated = new Promise((resolve) => {
    joined = resolve
  })
  const firstOutput = [],
    secondOutput = []
  const { runtime, root, dataDir, calls } = await fixture(
    t,
    async (_stage, args, options) => {
      if (
        args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
        'lake exe cache get'
      ) {
        options.onOutput('Downloading pinned libraries')
        started()
        await waiting
        options.onOutput('Replaying dependency builds')
      }
    },
  )
  const controller = new AbortController()
  const first = runtime.prepareSharedDependencies(
    root,
    request({
      signal: controller.signal,
      onOutput: (message) => firstOutput.push(message),
    }),
  )
  await reached
  assert.deepEqual(
    await fs.readdir(path.join(dataDir, 'runtime/shared-dependencies')),
    [],
  )
  const second = runtime.prepareSharedDependencies(
    root,
    request({
      validateRepository: async () => joined(),
      onOutput: (message) => secondOutput.push(message),
    }),
  )
  await secondValidated
  await new Promise(setImmediate)
  controller.abort(new Error('Stopped fixture'))
  await assert.rejects(first, /Stopped fixture/)
  resume()
  assert(await second)
  assert.deepEqual(firstOutput, ['Downloading pinned libraries'])
  assert.deepEqual(secondOutput, ['Replaying dependency builds'])
  assert.equal(
    calls.filter(
      (call) =>
        call.args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
        'lake exe cache get',
    ).length,
    1,
  )
})

test('download, dependency build and import failures never publish entries and can be retried', async (t) => {
  for (const failing of [
    'lake exe cache get',
    'lake build @mathlib',
    'lake env lean --stdin',
  ]) {
    let fail = true
    const { runtime, root, dataDir } = await fixture(t, async (_stage, args) =>
      args.filter((arg) => arg !== '--keep-toolchain').join(' ') === failing &&
      fail
        ? { code: 1, stdout: '', stderr: 'fixture failure' }
        : null,
    )
    await assert.rejects(
      runtime.prepareSharedDependencies(root, request()),
      /fixture failure/,
    )
    assert.deepEqual(
      await fs.readdir(path.join(dataDir, 'runtime/shared-dependencies')),
      [],
    )
    assert.deepEqual(
      await fs.readdir(path.join(dataDir, 'runtime/shared-dependency-stages')),
      [],
    )
    fail = false
    assert(await runtime.prepareSharedDependencies(root, request()))
  }
})

test('changed configuration cannot silently use the old mounted cache, while existing snapshots retain their pins', async (t) => {
  const { runtime, root, dataDir, run } = await fixture(t)
  const shared = await runtime.prepareSharedDependencies(root, request())
  await runtime.inheritDependencies(shared.root, root)
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(() => store.close())
  const projectId = 'terminal-shared-fixture'
  store.db.prepare('INSERT INTO projects(id,owner,data) VALUES(?,?,?)').run(
    projectId,
    'alice',
    JSON.stringify({
      id: projectId,
      owner: 'alice',
      root,
      status: 'ready',
      toolchain,
      preset: 'lean',
    }),
  )
  const baseline = store.configurationFingerprint(projectId, 'alice')
  const candidate = path.join(dataDir, 'candidate')
  await writeConfig(candidate)
  await runtime.inheritDependencies(root, candidate)
  await fs.writeFile(
    path.join(root, 'lean-toolchain'),
    'leanprover/lean4:v4.35.0-rc4\n',
  )
  runtime.run = run
  await assert.rejects(
    runtime.run(root, ['true']),
    /configuration changed.*Prepare the project again/,
  )
  assert.equal(
    await store.refreshExternalConfiguration(projectId, 'alice', baseline),
    true,
  )
  assert.equal(store.get(projectId, 'alice').status, 'error')
  assert.equal(store.get(projectId, 'alice').needsPreparation, true)
  assert.match(store.get(projectId, 'alice').error, /Retry setup/)
  assert.equal((await runtime.run(candidate, ['true'])).code, 0)
  await runtime.clearInheritedDependencies(root)
  assert.notEqual(runtime.dependencyRoot(root), shared.root)
  assert.equal(runtime.dependencyRoot(candidate), shared.root)
})

test('public repository validation happens before any worker starts', async (t) => {
  const { runtime, root, calls } = await fixture(t)
  await assert.rejects(
    runtime.prepareSharedDependencies(
      root,
      request({
        validateRepository: async () => {
          throw new Error('Private repository host')
        },
      }),
    ),
    /Private repository host/,
  )
  assert.equal(calls.length, 0)
})

test('shared dependency failures preserve infrastructure classification before publication', async (t) => {
  for (const result of [
    {
      code: 1,
      stderr: 'error: build failed\n',
      stdout: 'error: Lean exited with code 137\n',
    },
    { code: 1, stderr: 'fatal: expected flush after ref listing', stdout: '' },
    { code: 124, timedOut: true, stderr: '', stdout: '' },
  ]) {
    const { runtime, root, dataDir } = await fixture(t, async () => result)
    await assert.rejects(
      runtime.prepareSharedDependencies(root, request()),
      (error) => error.infrastructure === true,
    )
    assert.deepEqual(
      await fs.readdir(path.join(dataDir, 'runtime/shared-dependencies')),
      [],
    )
  }
})

test('configuration symlinks cannot read another project or select a shared binding', async (t) => {
  const { runtime, root } = await fixture(t)
  const shared = await runtime.prepareSharedDependencies(root, request())
  await fs.unlink(path.join(root, 'lean-toolchain'))
  await fs.symlink(
    path.join(shared.root, 'lean-toolchain'),
    path.join(root, 'lean-toolchain'),
  )
  await assert.rejects(runtime.inheritDependencies(shared.root, root), {
    code: 'ELOOP',
  })
})

test('uploaded projects share dependencies before builds, preserve unfinished proofs and reuse them in candidates', async (t) => {
  const { runtime, dataDir, calls } = await fixture(t)
  const buildCache = runtime.run.bind(runtime)
  const projectCommands = []
  runtime.prepareToolchain = async () => {}
  runtime.run = async (root, args, options) => {
    if (root.includes('/shared-dependency-stages/'))
      return buildCache(root, args, options)
    projectCommands.push({ root, args })
    if (args.includes('init'))
      await fs.mkdir(path.join(root, '.git'), { recursive: true })
    if (args[0] === 'lake') {
      assert.match(
        runtime.dependencyRoot(root),
        /\/shared-dependencies\/[a-f0-9]{64}$/,
      )
      assert.notEqual(
        args.filter((arg) => arg !== '--keep-toolchain').join(' '),
        'lake exe cache get',
      )
      if (args.includes('build')) {
        await fs.mkdir(path.join(root, '.lake/build'), { recursive: true })
        await fs.writeFile(path.join(root, '.lake/build/Private.olean'), root)
        return { code: 1, stdout: '', stderr: 'Unfinished user proof' }
      }
    }
    return {
      code: args.includes('rev-parse') ? 1 : 0,
      stdout: 'Lean version 4.34.1',
      stderr: '',
    }
  }
  const store = await new WorkspaceStore({
    dataDir,
    runtime,
    resolveHost: async () => [{ address: '140.82.112.3' }],
  }).init()
  t.after(() => store.close())
  const unfinished = 'import Mathlib\nexample : True := by\n'
  const create = async (name) => {
    const config = {
      ...configuration,
      'lakefile.toml': configuration['lakefile.toml'].replace('First', name),
      'lake-manifest.json': JSON.stringify({ ...manifest, name }),
    }
    const project = await store.create('alice', {
      files: [
        ...Object.entries(config).map(([path, content]) => ({ path, content })),
        { path: 'Main.lean', content: unfinished },
      ],
    })
    await store.jobs.get(project.id)
    return store.get(project.id, 'alice')
  }
  const first = await create('First')
  const second = await create('Second')
  for (const project of [first, second]) {
    assert.equal(project.status, 'ready', project.error)
    assert.match(project.buildWarning, /Some project targets/)
    assert.equal(
      (await store.readFile(project.id, 'alice', 'Main.lean')).content,
      unfinished,
    )
    assert.equal(
      (
        await store.readFile(
          project.id,
          'alice',
          '.lake/packages/mathlib/Mathlib.lean',
        )
      ).content,
      'UPSTREAM FIXTURE SOURCE',
    )
    assert.deepEqual(
      await fs.readdir(path.join(project.root, '.lake/packages')),
      [],
    )
    assert.equal(
      await fs.readFile(
        path.join(project.root, '.lake/build/Private.olean'),
        'utf8',
      ),
      project.root,
    )
  }
  assert.equal(
    runtime.dependencyRoot(first.root),
    runtime.dependencyRoot(second.root),
  )
  assert.equal(
    calls.filter(
      (call) =>
        call.args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
        'lake exe cache get',
    ).length,
    1,
  )
  assert.equal(
    projectCommands.filter(
      (call) =>
        call.args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
        'lake build',
    ).length,
    2,
  )
  const snapshot = await store.snapshot(first.id, 'alice', 'shared-candidate')
  assert.equal(
    runtime.dependencyRoot(snapshot.root),
    runtime.dependencyRoot(first.root),
  )
  assert.deepEqual(await store.changes(snapshot), [])
})

test('a malicious dependency ancestor link cannot expose or freeze another project', async (t) => {
  let replaced = false
  const { runtime, root, dataDir } = await fixture(t, async (stage, args) => {
    if (
      args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
      'lake exe cache get'
    ) {
      await fs.rm(path.join(stage, '.lake'), { recursive: true })
      await fs.symlink(
        path.join(dataDir, 'private-lake'),
        path.join(stage, '.lake'),
      )
      replaced = true
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  const privateFile = path.join(dataDir, 'private-lake/packages/secret.txt')
  await fs.mkdir(path.dirname(privateFile), { recursive: true })
  await fs.writeFile(privateFile, 'PRIVATE', { mode: 0o600 })
  await assert.rejects(
    runtime.prepareSharedDependencies(root, request()),
    /must not follow symbolic links/,
  )
  assert(replaced)
  assert.equal(await fs.readFile(privateFile, 'utf8'), 'PRIVATE')
  assert.equal((await fs.stat(privateFile)).mode & 0o777, 0o600)
  assert.deepEqual(
    await fs.readdir(path.join(dataDir, 'runtime/shared-dependencies')),
    [],
  )
})

test('safe package links used by upstream libraries are shared, but links escaping the tree are rejected', async (t) => {
  for (const escape of [false, true]) {
    const { runtime, root } = await fixture(t, async (stage, args) => {
      if (args.at(-1) !== '--stdin') return null
      const pkg = path.join(stage, '.lake/packages/mathlib')
      await fs.mkdir(path.join(pkg, 'docs'))
      await fs.writeFile(
        path.join(pkg, 'README.md'),
        'Fixture library documentation',
      )
      await fs.symlink(
        escape ? '../../../../lean-toolchain' : '../README.md',
        path.join(pkg, 'docs/README.md'),
      )
    })
    if (escape)
      await assert.rejects(
        runtime.prepareSharedDependencies(root, request()),
        /symbolic links must stay inside/,
      )
    else {
      const shared = await runtime.prepareSharedDependencies(root, request())
      assert.equal(
        await fs.readFile(
          path.join(shared.root, '.lake/packages/mathlib/docs/README.md'),
          'utf8',
        ),
        'Fixture library documentation',
      )
    }
  }
})

test('simultaneous builders in separate runtimes publish one complete entry without replacing the winner', async (t) => {
  let reached = 0,
    release
  const waiting = new Promise((resolve) => {
    release = resolve
  })
  const { runtime, root, dataDir } = await fixture(t, async (_stage, args) => {
    if (
      args.filter((arg) => arg !== '--keep-toolchain').join(' ') !==
      'lake exe cache get'
    )
      return null
    if (++reached === 2) release()
    await waiting
  })
  const other = new Runtime({ dataDir, docker: runtime.docker })
  other.ready = true
  other.imageId = runtime.imageId
  other.run = runtime.run.bind(runtime)
  const [first, second] = await Promise.all([
    runtime.prepareSharedDependencies(root, request()),
    other.prepareSharedDependencies(root, request()),
  ])
  assert.equal(first.root, second.root)
  assert.equal(reached, 2)
  assert.equal(
    await fs.readFile(
      path.join(
        first.root,
        '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean',
      ),
      'utf8',
    ),
    'COMPILED FIXTURE',
  )
  assert.deepEqual(
    await fs.readdir(path.join(dataDir, 'runtime/shared-dependency-stages')),
    [],
  )
})

test('cleanup failure after atomic publication does not discard a verified shared cache', async (t) => {
  const { runtime, root } = await fixture(t)
  runtime.releaseTemporaryWorkspace = async () => {
    throw new Error('Fixture cleanup deferred')
  }
  const first = await runtime.prepareSharedDependencies(root, request())
  const second = await runtime.prepareSharedDependencies(root, request())
  assert.equal(first.root, second.root)
  assert.equal(second.reused, true)
  assert((await fs.stat(path.join(first.root, '.ready.json'))).isFile())
})
