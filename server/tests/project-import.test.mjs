import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  repositoryLocation,
  projectDirectory,
  uploadedFiles,
} from '../project-import.mjs'
import { WorkspaceStore, validateWorkspaceFilePath } from '../workspaces.mjs'
import { projectLibraries } from '../project-libraries.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const sources = [
  { path: 'lean-toolchain', content: toolchain + '\n' },
  { path: 'lakefile.toml', content: 'name = "fixture"\n' },
  { path: 'Main.lean', content: 'example : True := by trivial\n' },
]
async function fixture(
  t,
  {
    setupRepair,
    cloneFiles,
    broken = false,
    setupBuildTimeoutMs,
    resolveHost,
  } = {},
) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-import-'))
  const calls = []
  const runtime = {
    templates: () => [
      { id: 'lean', toolchain },
      { id: 'mathlib', toolchain },
    ],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args, options) {
      calls.push({ root, args, options })
      options.signal?.throwIfAborted()
      if (args.includes('clone')) {
        await fs.mkdir(path.join(root, '.git'))
        for (const file of cloneFiles || []) {
          const target = path.join(root, file.path)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, file.content)
        }
      }
      if (args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args.includes('rev-parse'))
        return { code: 0, stdout: 'a'.repeat(40), stderr: '' }
      if (args.includes('status'))
        return {
          code: 0,
          stdout: '## main\0 M HOLLight-Lean/Main.lean\0 M sibling.lean\0',
          stderr: '',
        }
      if (
        args[0] === 'lake' &&
        broken &&
        (await fs.readFile(path.join(root, 'lakefile.toml'), 'utf8')).includes(
          'broken',
        )
      )
        return { code: 1, stderr: 'Invalid Lake configuration', stdout: '' }
      return { code: 0, stdout: 'Lean version 4.34.1', stderr: '' }
    },
  }
  const store = await new WorkspaceStore({
    dataDir,
    runtime,
    resolveHost: resolveHost || (async () => [{ address: '140.82.112.3' }]),
    setupRepair,
    setupBuildTimeoutMs,
  }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const create = async (input) => {
    const project = await store.create('alice', input)
    await store.jobs.get(project.id)
    return store.get(project.id, 'alice')
  }
  return { store, create, runtime, calls, dataDir }
}

const redirectResult = {
  code: 128,
  stdout: '',
  stderr:
    'fatal: unable to access repository: The requested URL returned error: 301',
}

test('private setup and isolated repair build the entire dependency graph before readonly checks', async (t) => {
  for (const repair of [false, true]) {
    const manifest = {
      name: 'fixture',
      packages: ['mathlib', 'verso', '«verso-slides»'].map((name, index) => ({
        type: 'git',
        name,
        inherited: index > 0,
        url: `https://github.com/example/library-${index}`,
        rev: 'a'.repeat(40),
      })),
    }
    let repairs = 0
    const f = await fixture(t, {
      broken: repair,
      setupRepair: async ({ root }) => {
        repairs++
        await fs.writeFile(path.join(root, 'lakefile.toml'), sources[1].content)
      },
    })
    const inherited = new Set()
    const built = new Map()
    f.runtime.inheritDependencies = async (_source, root) => inherited.add(root)
    const run = f.runtime.run
    f.runtime.run = async (root, args, options) => {
      if (
        args.includes('build') &&
        args.at(-1).startsWith('@') &&
        !inherited.has(root)
      ) {
        assert.equal(args.at(-2), `${args.at(-1)}:extraDep`)
        if (!built.has(root)) built.set(root, new Set())
        built.get(root).add(args.at(-1))
      }
      if (
        inherited.has(root) &&
        (args.includes('build') || args.at(-1) === '--stdin')
      ) {
        for (const pkg of manifest.packages) {
          if (!built.get(root)?.has(`@${pkg.name}`))
            return {
              code: 1,
              stdout: '',
              stderr:
                'error: read-only file system\n file: /workspace/.lake/packages/mathlib/missing.hash',
            }
        }
      }
      return run(root, args, options)
    }
    const project = await f.create({
      files: [
        ...sources.map((file) =>
          file.path === 'lakefile.toml' && repair
            ? { ...file, content: 'name = "broken"\n' }
            : file,
        ),
        { path: 'lake-manifest.json', content: JSON.stringify(manifest) },
      ],
    })
    assert.equal(project.status, 'ready', project.error)
    assert.equal(repairs, repair ? 1 : 0)
    assert.equal(
      await fs.readFile(path.join(project.root, 'Main.lean'), 'utf8'),
      sources[2].content,
    )
    assert.equal(built.size, repair ? 2 : 1)
  }
})

test('GitLab redirect retries the validated .git URL once and retains revision and Git protections', async (t) => {
  const f = await fixture(t, { cloneFiles: sources })
  const run = f.runtime.run
  const urls = []
  f.runtime.run = async (root, args, options) => {
    if (args.includes('clone')) {
      urls.push(args.at(-2))
      if (urls.length === 1) return redirectResult
    }
    return run(root, args, options)
  }
  const project = await f.create({
    repository: 'https://gitlab.epfl.ch/lara/LeanTUI/',
    revision: 'release/v1',
  })
  assert.equal(project.status, 'ready', project.error)
  assert.deepEqual(urls, [
    'https://gitlab.epfl.ch/lara/LeanTUI/',
    'https://gitlab.epfl.ch/lara/LeanTUI.git',
  ])
  assert.equal(project.repository, urls[1])
  assert.equal(project.sourceRevision, 'a'.repeat(40))
  assert(
    f.calls.some(
      (call) =>
        call.args.includes('fetch') && call.args.at(-1) === 'release/v1',
    ),
  )
  assert(
    f.calls
      .filter((call) => call.args[0] === 'git')
      .every((call) => call.args.includes('http.followRedirects=false')),
  )
  assert.match(project.log, /Retrying its \.git clone URL/)
})

test('persistent redirects give direct clone URL guidance without repeated retries or Lemex repair', async (t) => {
  for (const suffix of ['', '.git']) {
    let repairs = 0,
      clones = 0
    const f = await fixture(t, {
      setupRepair: async () => {
        repairs++
      },
    })
    f.runtime.run = async () => {
      clones++
      return redirectResult
    }
    const project = await f.create({
      repository: `https://gitlab.epfl.ch/lara/LeanTUI${suffix}`,
    })
    assert.equal(project.status, 'error')
    assert.equal(clones, suffix ? 1 : 2)
    assert.equal(repairs, 0)
    assert.match(project.error, /direct HTTPS clone URL/)
    assert.match(
      project.log,
      /repair can run after the project files are available/,
    )
    assert.doesNotMatch(project.log, /needs a supported Lean version/)
  }
})

test('redirect retry revalidates DNS and rejects a host that becomes private', async (t) => {
  let lookups = 0,
    clones = 0
  const f = await fixture(t, {
    resolveHost: async () => [
      { address: ++lookups <= 2 ? '140.82.112.3' : '127.0.0.1' },
    ],
  })
  f.runtime.run = async () => {
    clones++
    return redirectResult
  }
  const project = await f.create({
    repository: 'https://gitlab.example.org/group/project',
  })
  assert.equal(project.status, 'error')
  assert.match(project.error, /Private repository hosts/)
  assert.equal(clones, 1)
  assert.equal(lookups, 3)
})

test('redirect retry preserves files left by an interrupted clone', async (t) => {
  const f = await fixture(t)
  let clones = 0
  f.runtime.run = async (root) => {
    clones++
    await fs.writeFile(path.join(root, 'preserved.txt'), 'partial checkout')
    return redirectResult
  }
  const project = await f.create({
    repository: 'https://gitlab.example.org/group/project',
  })
  assert.equal(project.status, 'error')
  assert.equal(clones, 1)
  assert.equal(
    await fs.readFile(path.join(project.root, 'preserved.txt'), 'utf8'),
    'partial checkout',
  )
})

test('stopping a clone prevents the redirect retry and automatic repair', async (t) => {
  let began
  const started = new Promise((resolve) => {
    began = resolve
  })
  const f = await fixture(t)
  let clones = 0
  f.runtime.run = async (_root, _args, options) => {
    clones++
    began()
    await new Promise((resolve) =>
      options.signal.addEventListener('abort', resolve, { once: true }),
    )
    return redirectResult
  }
  const project = await f.store.create('alice', {
    repository: 'https://gitlab.example.org/group/project',
  })
  await started
  assert.equal(
    f.store.get(project.id, 'alice').setupPhase,
    'cloning-repository',
  )
  const stopped = await f.store.stopPreparation(project.id, 'alice')
  assert.equal(stopped.status, 'error')
  assert.match(stopped.error, /stopped/)
  assert.equal(clones, 1)
})

test('setup output identifies streamed builds, preserves diagnostics and labels source revisions', async (t) => {
  const f = await fixture(t, { cloneFiles: sources })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    if (args.includes('build'))
      options.onOutput?.(
        'Build completed successfully (32 jobs).\nMain.lean: warning: fixture linter\n',
      )
    if (args.includes('rev-parse')) options.onOutput?.('a'.repeat(40) + '\n')
    return run(root, args, options)
  }
  const project = await f.create({
    repository: 'https://gitlab.example.org/group/project.git',
  })
  assert.equal(project.status, 'ready', project.error)
  assert.equal(project.setupBuildStatus, 'passed')
  assert.match(project.log, /Starting: Building project project\./)
  assert.match(project.log, /Completed: Building project project \(\d+\.\d+s\)/)
  assert.match(project.log, /Build completed successfully \(32 jobs\)/)
  assert.match(project.log, /warning: fixture linter/)
  assert.match(
    project.log,
    new RegExp(`Project source revision: ${'a'.repeat(40)}`),
  )
  assert.equal(project.log.split('\n').includes('a'.repeat(40)), false)
})

test('setup log retains more than 60 chunks and excludes later saves and background Git inspection', async (t) => {
  const f = await fixture(t)
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    if (args.includes('build'))
      for (let i = 0; i < 90; i++)
        options.onOutput?.(`Fixture build module ${i}\n`)
    if (args.includes('status')) {
      options.onOutput?.('## main\0 M init\0 M fetch\0')
      return { code: 0, stdout: '## main\0 M init\0 M fetch\0', stderr: '' }
    }
    if (args.includes('diff'))
      options.onOutput?.('Private file diff must not appear in setup output')
    return run(root, args, options)
  }
  const project = await f.create({ files: sources })
  assert.equal(project.status, 'ready', project.error)
  assert.match(project.log, /Fixture build module 0\n/)
  assert.match(project.log, /Fixture build module 89\n/)
  await f.store.writeFile(project.id, 'alice', 'init', 'fixture file')
  await f.store.writeFile(project.id, 'alice', 'fetch', 'fixture file')
  for (let i = 0; i < 80; i++)
    await f.store.writeFile(project.id, 'alice', 'Main.lean', `-- edit ${i}\n`)
  const outputs = () =>
    f.store
      .events(project.id, 'alice')
      .filter((event) => event.type === 'output').length
  const before = outputs()
  await f.store.gitStatus(project.id, 'alice')
  assert.equal(outputs(), before)
  assert.equal(f.store.get(project.id, 'alice').log, project.log)
  // Existing installations retain their setup window without a new scope marker.
  const legacy = f.store.get(project.id, 'alice')
  delete legacy.setupEventAfter
  f.store.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(legacy), project.id)
  f.store.db
    .prepare('INSERT INTO events(project,time,data) VALUES(?,?,?)')
    .run(
      project.id,
      new Date().toISOString(),
      JSON.stringify({ type: 'output', message: 'AFTER_SETUP_PRIVATE_DIFF' }),
    )
  const legacyLog = f.store.get(project.id, 'alice').log
  assert.match(legacyLog, /Fixture build module 0\n/)
  assert.doesNotMatch(
    legacyLog,
    /Saved |Private file diff|AFTER_SETUP_PRIVATE_DIFF/,
  )
})

test('setup log marks its character limit and refresh replaces the previous attempt and warnings', async (t) => {
  const f = await fixture(t)
  const run = f.runtime.run
  let first = true
  f.runtime.run = async (root, args, options) => {
    if (args.includes('build')) {
      options.onOutput?.(
        first ? 'OLD SETUP OUTPUT\n'.repeat(1500) : 'NEW SETUP OUTPUT\n',
      )
      if (first)
        return { code: 1, stdout: '', stderr: 'Main.lean: unsolved goals' }
    }
    return run(root, args, options)
  }
  const project = await f.create({ files: sources })
  assert.equal(project.status, 'ready', project.error)
  assert.equal(project.setupBuildStatus, 'warnings')
  assert.match(project.log, /^\[Showing the latest setup output/)
  assert.match(project.log, /Warning: Some project targets did not compile/)
  assert.equal(project.log.length, 20000)
  first = false
  await f.store.prepare(project.id, 'alice')
  await f.store.jobs.get(project.id)
  const refreshed = f.store.get(project.id, 'alice')
  assert.equal(refreshed.status, 'ready', refreshed.error)
  assert.equal(refreshed.setupBuildStatus, 'passed')
  assert.match(refreshed.log, /NEW SETUP OUTPUT/)
  assert.doesNotMatch(
    refreshed.log,
    /OLD SETUP OUTPUT|Warning:|earlier output was omitted/,
  )
})

test('inaccessible or missing repositories explain the clone problem without another clone or setup repair', async (t) => {
  for (const [stderr, message] of [
    [
      'fatal: could not read Username for public repository: terminal prompts disabled',
      /Access to this repository was denied/,
    ],
    [
      'fatal: requested URL returned error: 403',
      /Access to this repository was denied/,
    ],
    [
      'fatal: repository https://gitlab.example.org/group/missing.git not found',
      /The repository was not found/,
    ],
  ]) {
    let clones = 0,
      repairs = 0
    const f = await fixture(t, {
      setupRepair: async () => {
        repairs++
      },
    })
    f.runtime.run = async () => {
      clones++
      return { code: 128, stdout: '', stderr }
    }
    const project = await f.create({
      repository: 'https://gitlab.example.org/group/project.git',
    })
    assert.equal(project.status, 'error')
    assert.match(project.error, message)
    assert.equal(clones, 1)
    assert.equal(repairs, 0)
  }
})

test('a missing requested revision gives revision guidance after a successful clone', async (t) => {
  const f = await fixture(t, { cloneFiles: sources })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) =>
    args.includes('fetch')
      ? {
          code: 128,
          stdout: '',
          stderr: "fatal: couldn't find remote ref typo",
        }
      : run(root, args, options)
  const project = await f.create({
    repository: 'https://gitlab.example.org/group/project.git',
    revision: 'typo',
  })
  assert.equal(project.status, 'error')
  assert.match(
    project.error,
    /Revision typo was not found.*existing branch, tag, or full commit hash/,
  )
  assert.match(project.log, /selected revision could not be prepared/)
  assert.doesNotMatch(project.log, /retry with the direct HTTPS clone URL/)
})

test('Retry resumes a completed clone after revision fetch failure, including after a server restart', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    cloneFiles: sources,
    setupRepair: async () => {
      repairs++
    },
  })
  const run = f.runtime.run
  let clones = 0,
    fetches = 0
  f.runtime.run = async (root, args, options) => {
    if (args.includes('clone')) clones++
    if (args.includes('fetch') && ++fetches === 1)
      return { code: 128, stdout: '', stderr: 'fatal: Connection timed out' }
    return run(root, args, options)
  }
  const project = await f.create({
    repository: 'https://gitlab.example.org/group/project.git',
    revision: 'release/v1',
  })
  assert.equal(project.status, 'error')
  assert.equal(repairs, 0)
  await fs.writeFile(
    path.join(project.root, '.git/shallow.lock'),
    'interrupted fetch',
  )
  await fs.writeFile(
    path.join(project.root, '.git/index.lock'),
    'interrupted checkout',
  )
  await fs.writeFile(
    path.join(project.root, '.git/preserved.lock'),
    'unrelated metadata',
  )
  f.store.close()
  await f.store.init()
  await f.store.prepare(project.id, 'alice')
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(clones, 1)
  assert.equal(fetches, 2)
  await assert.rejects(fs.stat(path.join(ready.root, '.git/shallow.lock')), {
    code: 'ENOENT',
  })
  await assert.rejects(fs.stat(path.join(ready.root, '.git/index.lock')), {
    code: 'ENOENT',
  })
  assert.equal(
    await fs.readFile(path.join(ready.root, '.git/preserved.lock'), 'utf8'),
    'unrelated metadata',
  )
  assert.equal(ready.revision, 'release/v1')
  assert.equal(ready.repository, project.repository)
  assert.equal(
    await fs.readFile(path.join(ready.root, 'Main.lean'), 'utf8'),
    sources[2].content,
  )
})

test('Stop during revision fetch preserves the completed clone and Retry resumes it', async (t) => {
  const f = await fixture(t, { cloneFiles: sources })
  const run = f.runtime.run
  let began,
    clones = 0,
    fetches = 0
  const started = new Promise((resolve) => {
    began = resolve
  })
  f.runtime.run = async (root, args, options) => {
    if (args.includes('clone')) clones++
    if (args.includes('fetch') && ++fetches === 1) {
      began()
      await new Promise((resolve) =>
        options.signal.addEventListener('abort', resolve, { once: true }),
      )
      return { code: 137, stdout: '', stderr: 'stopped' }
    }
    return run(root, args, options)
  }
  const project = await f.store.create('alice', {
    repository: 'https://gitlab.example.org/group/project.git',
    revision: 'release/v1',
  })
  await started
  assert.equal(
    f.store.get(project.id, 'alice').setupPhase,
    'selecting-revision',
  )
  const stopped = await f.store.stopPreparation(project.id, 'alice')
  assert.match(stopped.error, /retry when ready/)
  await f.store.prepare(project.id, 'alice')
  await f.store.jobs.get(project.id)
  assert.equal(f.store.get(project.id, 'alice').status, 'ready')
  assert.equal(clones, 1)
  assert.equal(fetches, 2)
})

test('a stopped partial clone explains that a new import is needed and preserves partial files', async (t) => {
  const f = await fixture(t)
  let began
  const started = new Promise((resolve) => {
    began = resolve
  })
  f.runtime.run = async (root, _args, options) => {
    await fs.writeFile(path.join(root, 'partial.txt'), 'preserved')
    began()
    await new Promise((resolve) =>
      options.signal.addEventListener('abort', resolve, { once: true }),
    )
    return { code: 137, stdout: '', stderr: 'stopped' }
  }
  const project = await f.store.create('alice', {
    repository: 'https://gitlab.example.org/group/project.git',
  })
  await started
  const stopped = await f.store.stopPreparation(project.id, 'alice')
  assert.match(
    stopped.error,
    /Create a new import; the partial files were preserved/,
  )
  assert.equal(
    await fs.readFile(path.join(stopped.root, 'partial.txt'), 'utf8'),
    'preserved',
  )
  assert.doesNotMatch(stopped.error, /retry when ready/)
})

test('failed setup worker cleanup remains actionable, and Retry stops only its own remaining workers', async (t) => {
  const f = await fixture(t)
  const run = f.runtime.run
  let began
  const started = new Promise((resolve) => {
    began = resolve
  })
  f.runtime.run = async (_root, _args, options) => {
    began()
    await new Promise((resolve) =>
      options.signal.addEventListener('abort', resolve, { once: true }),
    )
    throw Object.assign(
      new Error('The project worker could not be stopped. Try again.'),
      { workerCleanup: true, status: 503 },
    )
  }
  const project = await f.store.create('alice', { files: sources })
  await started
  const stopped = await f.store.stopPreparation(project.id, 'alice')
  assert.match(stopped.error, /worker could not be stopped/)
  assert.equal(stopped.setupCleanupFailed, true)
  const roots = []
  f.runtime.stopProject = async (root) => {
    roots.push(root)
  }
  f.runtime.run = run
  await f.store.prepare(project.id, 'alice')
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(ready.setupCleanupFailed, undefined)
  assert.deepEqual(roots, [project.root])
})

test('Retry cannot start setup while a previous setup worker still cannot be stopped', async (t) => {
  const f = await fixture(t)
  const project = await f.create({ files: sources })
  project.status = 'error'
  project.setupCleanupFailed = true
  f.store.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(project), project.id)
  let launched = false
  f.runtime.run = async () => {
    launched = true
    return { code: 0, stdout: '', stderr: '' }
  }
  f.runtime.stopProject = async () => {
    throw Object.assign(new Error('Worker cleanup still unavailable'), {
      workerCleanup: true,
      status: 503,
    })
  }
  await assert.rejects(
    f.store.prepare(project.id, 'alice'),
    /cleanup still unavailable/,
  )
  assert.equal(launched, false)
  assert.equal(f.store.get(project.id, 'alice').status, 'error')
  assert.equal(f.store.get(project.id, 'alice').setupCleanupFailed, true)
})

test('the final project build cannot change the pinned Lean version or invoke repair to substitute it', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async () => {
      repairs++
    },
  })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    const result = await run(root, args, options)
    if (args.includes('build'))
      await fs.writeFile(
        path.join(root, 'lean-toolchain'),
        'leanprover/lean4:v4.35.0\n',
      )
    return result
  }
  const project = await f.create({ files: sources })
  assert.equal(project.status, 'error')
  assert.match(project.error, /pinned Lean release.*restored/)
  assert.equal(
    await fs.readFile(path.join(project.root, 'lean-toolchain'), 'utf8'),
    toolchain + '\n',
  )
  assert.equal(repairs, 0)
})

test('normal setup restores a resolved dependency pin changed by Lake and never admits the changed environment', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async () => {
      repairs++
    },
  })
  const manifest = JSON.stringify({
    packages: [
      {
        name: 'fixture-dependency',
        type: 'git',
        url: 'https://github.com/example/library.git',
        rev: 'a'.repeat(40),
      },
    ],
  })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    const result = await run(root, args, options)
    if (args[0] === 'lake')
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        manifest.replace('a'.repeat(40), 'b'.repeat(40)),
      )
    return result
  }
  const project = await f.create({
    files: [...sources, { path: 'lake-manifest.json', content: manifest }],
  })
  assert.equal(project.status, 'error')
  assert.match(project.error, /pinned dependency.*lockfile was restored/)
  assert.equal(
    await fs.readFile(path.join(project.root, 'lake-manifest.json'), 'utf8'),
    manifest,
  )
  assert.equal(repairs, 0)
})

test('Retry resolves dependencies when an interrupted update left .lake but no lockfile', async (t) => {
  const f = await fixture(t)
  const run = f.runtime.run
  let updates = 0
  f.runtime.run = async (root, args, options) => {
    if (args.includes('update')) {
      updates++
      await fs.mkdir(path.join(root, '.lake'), { recursive: true })
      if (updates === 1)
        return {
          code: 1,
          stdout: '',
          stderr: 'Fixture dependency download failed',
        }
      await fs.writeFile(
        path.join(root, 'lake-manifest.json'),
        '{"packages":[]}',
      )
    }
    return run(root, args, options)
  }
  const project = await f.create({ files: sources, autoRepair: false })
  assert.equal(project.status, 'error')
  await f.store.prepare(project.id, 'alice')
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(updates, 2)
  assert.equal(
    await fs.readFile(path.join(ready.root, 'lake-manifest.json'), 'utf8'),
    '{"packages":[]}',
  )
})

test('private dependency URLs are rejected before networked Lake work with or without a shared Mathlib graph', async (t) => {
  for (const name of ['mathlib', 'private-library']) {
    let repairs = 0
    const f = await fixture(t, {
      setupRepair: async () => {
        repairs++
      },
    })
    const manifest = JSON.stringify({
      packages: [
        {
          name,
          type: 'git',
          url: 'https://10.0.0.1/private/repo.git',
          rev: 'a'.repeat(40),
        },
      ],
    })
    const project = await f.create({
      files: [...sources, { path: 'lake-manifest.json', content: manifest }],
    })
    assert.equal(project.status, 'error')
    assert.match(project.error, /Private repository hosts/)
    assert.equal(
      f.calls.some(
        (call) => call.args[0] === 'lake' && call.options.network === 'bridge',
      ),
      false,
    )
    assert.equal(repairs, 0)
    assert.equal(
      await fs.readFile(path.join(project.root, 'lake-manifest.json'), 'utf8'),
      manifest,
    )
  }
})

test('a rejected repository recheck in shared preparation cannot fall back to unchecked private setup', async (t) => {
  let lookups = 0,
    repairs = 0,
    shared = 0
  const f = await fixture(t, {
    resolveHost: async () => [
      { address: ++lookups === 1 ? '140.82.112.3' : '127.0.0.1' },
    ],
    setupRepair: async () => {
      repairs++
    },
  })
  f.runtime.prepareSharedDependencies = async (_root, options) => {
    shared++
    await options.validateRepository(
      'https://gitlab.example.org/group/library.git',
    )
    assert.fail('Rejected dependency URL must stop preparation')
  }
  const manifest = JSON.stringify({
    packages: [
      {
        name: 'mathlib',
        type: 'git',
        url: 'https://gitlab.example.org/group/library.git',
        rev: 'a'.repeat(40),
      },
    ],
  })
  const project = await f.create({
    files: [...sources, { path: 'lake-manifest.json', content: manifest }],
  })
  assert.equal(project.status, 'error')
  assert.match(project.error, /Private repository hosts/)
  assert.equal(shared, 1)
  assert.equal(repairs, 0)
  assert.equal(
    f.calls.some(
      (call) => call.args[0] === 'lake' && call.options.network === 'bridge',
    ),
    false,
  )
  assert.doesNotMatch(project.log, /Continuing with a private environment/)
})

test('shared native build limitations keep a verified library environment editable without repair', async (t) => {
  for (const usable of [true, false]) {
    let repairs = 0
    const f = await fixture(t, {
      setupRepair: async () => {
        repairs++
      },
    })
    const run = f.runtime.run
    f.runtime.prepareSharedDependencies = async (root) => ({
      root,
      reused: true,
    })
    f.runtime.inheritDependencies = async () => {}
    f.runtime.run = async (root, args, options) => {
      if (args.includes('build'))
        return {
          code: 1,
          stdout: '',
          stderr:
            'error: unable to open output file /workspace/.lake/packages/mathlib/.lake/build/ir/Mathlib.c.o: Read-only file system',
        }
      if (!usable && args.at(-1) === '--stdin')
        return { code: 1, stdout: '', stderr: 'Mathlib import is unavailable' }
      return run(root, args, options)
    }
    const manifest = JSON.stringify({
      packages: [
        {
          name: 'mathlib',
          type: 'git',
          url: 'https://github.com/example/mathlib.git',
          rev: 'a'.repeat(40),
        },
      ],
    })
    const project = await f.create({
      autoRepair: false,
      files: [...sources, { path: 'lake-manifest.json', content: manifest }],
    })
    assert.equal(project.status, usable ? 'ready' : 'error')
    if (usable) {
      assert.equal(project.setupBuildStatus, 'warnings')
      assert.match(project.buildWarning, /shared library cache/)
      assert.doesNotMatch(project.buildWarning, /Refresh setup/)
    } else assert.match(project.error, /environment is not ready/)
    assert.equal(repairs, 0)
  }
  // The same soft build failure must not invoke an enabled automatic repair.
  const f = await fixture(t, {
    setupRepair: async () =>
      assert.fail('Native-only build limitation must not call repair'),
  })
  const run = f.runtime.run
  f.runtime.prepareSharedDependencies = async (root) => ({ root, reused: true })
  f.runtime.inheritDependencies = async () => {}
  f.runtime.run = async (root, args, options) =>
    args.includes('build')
      ? {
          code: 1,
          stdout: '',
          stderr:
            '.lake/packages/mathlib/.lake/build/ir/Mathlib.c.o: Read-only file system',
        }
      : run(root, args, options)
  const project = await f.create({ files: sources })
  assert.equal(project.status, 'ready', project.error)
})

test('derived setup logs are fetched separately and never stored in project metadata', async (t) => {
  const f = await fixture(t)
  const project = await f.create({ files: sources })
  assert(project.log)
  await f.store.rename(project.id, 'alice', { name: 'renamed' })
  assert.equal(f.store.list('alice')[0].log, undefined)
  const stored = JSON.parse(
    f.store.db.prepare('SELECT data FROM projects WHERE id=?').get(project.id)
      .data,
  )
  assert.equal(stored.log, undefined)
  assert.equal(f.store.get(project.id, 'alice').log, project.log)
})

test('setup repair omits generated build caches and preserves the original cache and proof sources', async (t) => {
  let repaired = false
  const f = await fixture(t, {
    broken: true,
    setupRepair: async ({ root }) => {
      await assert.rejects(fs.stat(path.join(root, '.lake')), {
        code: 'ENOENT',
      })
      assert.equal(
        await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
        sources[2].content,
      )
      await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
      repaired = true
    },
  })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    if (!root.includes('setup-repairs') && args[0] === 'lake') {
      await fs.mkdir(path.join(root, '.lake/build'), { recursive: true })
      await fs.writeFile(
        path.join(root, '.lake/build/preserved'),
        'original build cache',
      )
    }
    return run(root, args, options)
  }
  const project = await f.create({
    files: sources.map((file) =>
      file.path === 'lakefile.toml' ? { ...file, content: 'broken' } : file,
    ),
  })
  assert.equal(project.status, 'ready', project.error)
  assert.equal(repaired, true)
  assert.equal(
    await fs.readFile(path.join(project.root, '.lake/build/preserved'), 'utf8'),
    'original build cache',
  )
})

test('Stop before copying a repair candidate prevents the repair invocation', async (t) => {
  let began,
    repairs = 0
  const started = new Promise((resolve) => {
    began = resolve
  })
  const f = await fixture(t, {
    broken: true,
    setupRepair: async () => {
      repairs++
    },
  })
  f.runtime.claimTemporaryWorkspace = async () => {
    began()
  }
  const project = await f.store.create('alice', {
    files: sources.map((file) =>
      file.path === 'lakefile.toml' ? { ...file, content: 'broken' } : file,
    ),
  })
  await started
  const stopped = await f.store.stopPreparation(project.id, 'alice')
  assert.match(stopped.error, /stopped/)
  assert.equal(repairs, 0)
  assert.equal(
    await fs.readFile(path.join(stopped.root, 'Main.lean'), 'utf8'),
    sources[2].content,
  )
})

test('parses GitHub subprojects, explicit slash branches and encoded refs without treating blob links as repos', () => {
  assert.deepEqual(
    repositoryLocation(
      'https://github.com/epfl-lara/jordan-curve-theorem/tree/main/HOLLight-Lean',
    ),
    {
      repository: 'https://github.com/epfl-lara/jordan-curve-theorem',
      revision: 'main',
      subdirectory: 'HOLLight-Lean',
    },
  )
  assert.equal(
    repositoryLocation('https://github.com/a/b/tree/feature/proofs/Lean', {
      revision: 'feature/proofs',
    }).subdirectory,
    'Lean',
  )
  assert.equal(
    repositoryLocation('https://github.com/a/b/tree/feature%2Fproofs/Lean')
      .revision,
    'feature/proofs',
  )
  assert.deepEqual(
    repositoryLocation(
      'https://github.com/a/b/tree/main/Lean?tab=readme-ov-file#readme',
    ),
    {
      repository: 'https://github.com/a/b',
      revision: 'main',
      subdirectory: 'Lean',
    },
  )
  assert.equal(
    repositoryLocation('https://github.com/a/b?tab=readme-ov-file#readme')
      .repository,
    'https://github.com/a/b',
  )
  for (const input of [
    '../Lean',
    '/Lean',
    '.git',
    'Lean//X',
    'Lean/../../X',
    'Lean\\X',
  ])
    assert.throws(() => projectDirectory(input))
  assert.throws(() =>
    repositoryLocation('https://github.com/a/b/blob/main/Main.lean'),
  )
})

test('imports the selected Lean subdirectory while retaining full Git checkout and source revision', async (t) => {
  const f = await fixture(t, {
    cloneFiles: sources.map((file) => ({
      ...file,
      path: 'HOLLight-Lean/' + file.path,
    })),
  })
  const project = await f.create({
    repository:
      'https://github.com/epfl-lara/jordan-curve-theorem/tree/main/HOLLight-Lean',
  })
  assert.equal(project.status, 'ready', project.error)
  assert.equal(project.subdirectory, 'HOLLight-Lean')
  assert.equal(project.sourceRevision, 'a'.repeat(40))
  assert.equal(
    (await f.store.readFile(project.id, 'alice', 'Main.lean')).content,
    sources[2].content,
  )
  assert(
    f.calls
      .filter((call) => call.args[0] === 'lake')
      .every((call) => call.root === project.root),
  )
  assert(
    f.calls
      .filter((call) => call.args[0] === 'git')
      .every((call) => call.root === path.dirname(project.root)),
  )
  const git = await f.store.gitStatus(project.id, 'alice')
  assert.deepEqual(git.changes, [{ status: ' M', path: 'Main.lean' }])
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) =>
    args.includes('rev-parse')
      ? { code: 0, stdout: 'b'.repeat(40), stderr: '' }
      : run(root, args, options)
  const snapshot = await f.store.snapshot(project.id, 'alice', 'nested-proof')
  assert.equal(snapshot.sourceRevision, 'b'.repeat(40))
  assert.equal(
    await fs.readFile(path.join(snapshot.root, 'Main.lean'), 'utf8'),
    sources[2].content,
  )
  f.store.close()
  await f.store.init()
  assert.equal(f.store.get(project.id, 'alice').root, project.root)
})

test('detects a single uploaded Lean root and preserves unfinished proofs', async (t) => {
  const f = await fixture(t)
  const project = await f.create({
    files: sources.map((file) => ({
      ...file,
      path: 'examples/Lean/' + file.path,
    })),
  })
  assert.equal(project.status, 'ready', project.error)
  assert.equal(project.subdirectory, 'examples/Lean')
  const before = await f.store.readFile(project.id, 'alice', 'Main.lean')
  await assert.rejects(
    f.store.upload(project.id, 'alice', [
      { path: 'Added.lean', content: 'example : True := by trivial' },
      { path: 'Main.lean', content: 'overwrite' },
    ]),
    { status: 409 },
  )
  await assert.rejects(f.store.readFile(project.id, 'alice', 'Added.lean'), {
    status: 404,
  })
  assert.equal(
    (await f.store.readFile(project.id, 'alice', 'Main.lean')).hash,
    before.hash,
  )
  await f.store.upload(project.id, 'alice', [
    { path: 'Added.lean', content: 'example : True := by trivial' },
  ])
  assert.equal(
    (await f.store.readFile(project.id, 'alice', 'Added.lean')).content,
    'example : True := by trivial',
  )
  await assert.rejects(
    f.store.upload(project.id, 'bob', [{ path: 'X.lean', content: 'x' }]),
    { status: 404 },
  )
})

test('uploads over 1,000 files and serializes collision checks with writes', async (t) => {
  const f = await fixture(t)
  const project = await f.create({ files: sources })
  const files = Array.from({ length: 1001 }, (_, index) => ({
    path: `Batch/File${index}.lean`,
    content: `-- file ${index}\n`,
  }))
  await f.store.upload(project.id, 'alice', files)
  assert.equal(
    (await fs.readdir(path.join(project.root, 'Batch'))).length,
    1001,
  )
  const results = await Promise.allSettled(
    ['first', 'second'].map((content) =>
      f.store.upload(project.id, 'alice', [
        { path: 'Concurrent.lean', content },
      ]),
    ),
  )
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.equal(
    results.find((result) => result.status === 'rejected').reason.status,
    409,
  )
})

test('ambiguous uploaded projects require a directory and never trigger speculative automatic repair', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async () => {
      repairs++
    },
  })
  const project = await f.create({
    files: ['One', 'Two'].flatMap((prefix) =>
      sources.map((file) => ({ ...file, path: prefix + '/' + file.path })),
    ),
  })
  assert.equal(project.status, 'error')
  assert.match(project.error, /Several Lean projects/)
  assert.equal(repairs, 0)
})

test('setup repair copies source without original Git metadata or nested gitdir files', async (t) => {
  let checked = false
  const f = await fixture(t, {
    broken: true,
    cloneFiles: [
      ...sources.map((file) =>
        file.path === 'lakefile.toml' ? { ...file, content: 'broken' } : file,
      ),
      {
        path: '.git/config',
        content: '[credential]\nhelper = private-helper\n',
      },
      { path: 'Nested/.git', content: 'gitdir: /private/other-checkout\n' },
      { path: 'Nested/Proof.lean', content: 'example : True := by trivial\n' },
    ],
    setupRepair: async ({ root }) => {
      for (const filename of ['.git', 'Nested/.git'])
        await assert.rejects(fs.lstat(path.join(root, filename)), {
          code: 'ENOENT',
        })
      assert.equal(
        await fs.readFile(path.join(root, 'Nested/Proof.lean'), 'utf8'),
        'example : True := by trivial\n',
      )
      checked = true
      await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
    },
  })
  const project = await f.create({
    repository: 'https://github.com/fixture/setup.git',
  })
  assert.equal(project.status, 'ready', project.error)
  assert(checked)
  assert.match(
    await fs.readFile(path.join(project.root, '.git/config'), 'utf8'),
    /private-helper/,
  )
})

test('automatic setup repair is announced, retains original configuration and rechecks the environment once', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    broken: true,
    setupRepair: async ({ root, onOutput }) => {
      repairs++
      const running = f.store.list('alice')[0]
      assert.equal(running.status, 'preparing')
      assert.equal(running.setupPhase, 'repairing-setup')
      onOutput('Repairing the Lake name.\n')
      await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
    },
  })
  const project = await f.create({
    files: sources.map((file) =>
      file.path === 'lakefile.toml' ? { ...file, content: 'broken' } : file,
    ),
  })
  assert.equal(project.status, 'ready', project.error)
  assert.equal(repairs, 1)
  assert.equal(project.setupRepair.status, 'completed')
  assert.equal(project.setupPhase, 'checking-environment')
  assert.deepEqual(project.setupRepair.changes, ['lakefile.toml'])
  assert.match(project.log, /Automatic setup failed. Lemex is repairing/)
  assert.equal(
    (await f.store.readFile(project.id, 'alice', 'Main.lean')).content,
    sources[2].content,
  )
  const backup = JSON.parse(
    await fs.readFile(
      path.join(
        f.dataDir,
        'setup-repairs',
        project.setupRepair.id,
        'changes.json',
      ),
    ),
  )
  assert.equal(backup.changes[0].before, 'broken')
  const checks = f.calls.filter(
    (call) =>
      call.root === project.root &&
      call.args[0] === 'lake' &&
      call.options.readOnlyWorkspace,
  )
  assert(checks.some((call) => call.args.includes('env')))
  assert(checks.some((call) => call.args.includes('build')))
  assert(checks.every((call) => call.options.writeLakeCache))
})

test('setup repair never admits proof edits or loops after a failed repair; opt-out makes no agent call', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    broken: true,
    setupRepair: async ({ root }) => {
      repairs++
      await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
      await fs.writeFile(path.join(root, 'Main.lean'), 'axiom fake : False')
    },
  })
  const files = sources.map((file) =>
    file.path === 'lakefile.toml' ? { ...file, content: 'broken' } : file,
  )
  const project = await f.create({ files })
  assert.equal(project.status, 'error')
  assert.equal(repairs, 1)
  assert.match(project.error, /Source files were preserved/)
  assert.equal(
    await fs.readFile(path.join(project.root, 'Main.lean'), 'utf8'),
    sources[2].content,
  )
  const optedOut = await f.create({ files, autoRepair: false })
  assert.equal(optedOut.status, 'error')
  assert.equal(repairs, 1)
})

test('rejects upload traversal, secrets, duplicates, binary data and parent-file collisions before creating files', () => {
  for (const files of [
    [{ path: '../x', content: '' }],
    [{ path: '.env', content: 'secret' }],
    [{ path: 'x', content: '\0' }],
    [{ path: 'x', content: '\ud800' }],
    [
      { path: 'x', content: '' },
      { path: 'x', content: 'y' },
    ],
    [
      { path: 'x', content: '' },
      { path: 'x/y', content: '' },
    ],
  ])
    assert.throws(() => uploadedFiles(files, validateWorkspaceFilePath))
})

test('library combinations use the dependency owner pin and reject incompatible prepared releases', () => {
  const definitions = ['lean', 'mathlib', 'cslib', 'physlib'].map((id) => ({
    id,
  }))
  assert.deepEqual(projectLibraries(['mathlib', 'cslib'], definitions), {
    preset: 'cslib',
    libraries: ['mathlib', 'cslib'],
    imports: ['Mathlib', 'Cslib'],
  })
  assert.equal(
    projectLibraries(['mathlib', 'physlib'], definitions).preset,
    'physlib',
  )
  assert.equal(projectLibraries([], definitions).preset, 'lean')
  assert.throws(
    () => projectLibraries(['physlib', 'cslib'], definitions),
    /different Lean versions/,
  )
  assert.throws(
    () => projectLibraries(['unknown'], definitions),
    /Choose Mathlib/,
  )
})

test('Stop during shared toolchain preparation returns without cancelling the shared cache task or launching repair', async (t) => {
  let began, finish
  const started = new Promise((resolve) => {
    began = resolve
  })
  const shared = new Promise((resolve) => {
    finish = resolve
  })
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async () => {
      repairs++
    },
  })
  f.runtime.prepareToolchain = () => {
    began()
    return shared
  }
  const project = await f.store.create('alice', { files: sources })
  await started
  const stopped = await f.store.stopPreparation(project.id, 'alice')
  assert.equal(stopped.status, 'error')
  assert.match(stopped.error, /stopped/)
  assert.equal(repairs, 0)
  finish()
  await shared
  assert.equal(f.store.get(project.id, 'alice').status, 'error')
})

test('Stop during project build cannot become a ready project or trigger setup repair', async (t) => {
  let began
  const started = new Promise((resolve) => {
    began = resolve
  })
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async () => {
      repairs++
    },
  })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    if (
      args.filter((arg) => arg !== '--keep-toolchain').join(' ') !==
      'lake build'
    )
      return run(root, args, options)
    began()
    await new Promise((resolve) =>
      options.signal.addEventListener('abort', resolve, { once: true }),
    )
    return { code: 137, stdout: '', stderr: 'stopped' }
  }
  const project = await f.store.create('alice', { files: sources })
  await started
  const stopped = await f.store.stopPreparation(project.id, 'alice')
  assert.equal(stopped.status, 'error')
  assert.match(stopped.error, /stopped/)
  assert.equal(repairs, 0)
})

test('restart marks setup repair interrupted and retry does not credit an unapplied repair', async (t) => {
  const f = await fixture(t)
  const project = await f.create({ files: sources })
  project.status = 'preparing'
  project.setupRepair = {
    id: 'interrupted-repair',
    status: 'running',
    message: 'Repairing',
  }
  f.store.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(project), project.id)
  f.store.close()
  await f.store.init()
  const interrupted = f.store.get(project.id, 'alice')
  assert.equal(interrupted.setupRepair.status, 'failed')
  assert.match(interrupted.setupRepair.message, /interrupted/)
  await f.store.prepare(project.id, 'alice')
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready')
  assert.equal(ready.setupRepair, undefined)
  assert.equal(ready.setupRepairHistory[0].id, 'interrupted-repair')
})

test('repaired Lake configuration that changes proof sources during evaluation is rejected before admission', async (t) => {
  const f = await fixture(t, {
    broken: true,
    setupRepair: async ({ root }) => {
      await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
    },
  })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    if (root.includes('setup-repairs') && args[0] === 'lake')
      await fs.writeFile(
        path.join(root, 'Main.lean'),
        'axiom injected : False\n',
      )
    return run(root, args, options)
  }
  const project = await f.create({
    files: sources.map((file) =>
      file.path === 'lakefile.toml' ? { ...file, content: 'broken' } : file,
    ),
  })
  assert.equal(project.status, 'error')
  assert.match(project.error, /Source files were preserved/)
  assert.equal(
    await fs.readFile(path.join(project.root, 'Main.lean'), 'utf8'),
    sources[2].content,
  )
  assert.equal(
    await fs.readFile(path.join(project.root, 'lakefile.toml'), 'utf8'),
    'broken',
  )
})

test('Mathlib setup must pass an import proof, requests Lemex repair on failure, and retests without changing unfinished proofs', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async ({ root, error }) => {
      repairs++
      assert.match(error, /environment is not ready/)
      await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
    },
  })
  const run = f.runtime.run
  const smoke = []
  f.runtime.run = async (root, args, options) => {
    const result = await run(root, args, options)
    if (args.at(-1) !== '--stdin') return result
    smoke.push({ root, options })
    assert.match(options.input, /import Mathlib/)
    assert.equal(options.readOnlyWorkspace, true)
    assert.equal(options.writeLakeCache, true)
    const fixed = (
      await fs.readFile(path.join(root, 'lakefile.toml'), 'utf8')
    ).includes('fixed')
    return fixed
      ? result
      : {
          code: 1,
          stderr:
            "error: object file '/workspace/.lake/packages/mathlib/Mathlib.olean' of module Mathlib does not exist",
          stdout: '',
        }
  }
  const manifest = JSON.stringify({
    packages: [
      {
        name: 'mathlib',
        type: 'git',
        url: 'https://github.com/leanprover-community/mathlib4',
        rev: 'a'.repeat(40),
      },
    ],
  })
  const proof = 'import Mathlib\nexample : True := by\n'
  const project = await f.create({
    files: [
      ...sources.filter((file) => file.path !== 'Main.lean'),
      { path: 'Main.lean', content: proof },
      { path: 'lake-manifest.json', content: manifest },
    ],
  })
  assert.equal(project.status, 'ready', project.error)
  assert.equal(repairs, 1)
  assert.equal(project.setupRepair.status, 'completed')
  assert.equal(smoke.length, 3)
  assert.equal(smoke.at(-1).root, project.root)
  assert.equal(
    (await f.store.readFile(project.id, 'alice', 'Main.lean')).content,
    proof,
  )
  assert.equal(
    await fs.readFile(path.join(project.root, 'lake-manifest.json'), 'utf8'),
    manifest,
  )
  assert(
    f.calls.filter(
      (call) =>
        call.args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
        'lake exe cache get',
    ).length >= 2,
  )
})

test('failed environment pretests stay unavailable after one repair attempt, even if Lemex reports success without edits', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async () => {
      repairs++
    },
  })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    const result = await run(root, args, options)
    return args.at(-1) === '--stdin' && !root.includes('/setup-repairs/')
      ? { code: 1, stdout: '', stderr: 'Fixture environment still unavailable' }
      : result
  }
  const project = await f.create({ files: sources })
  assert.equal(project.status, 'error')
  assert.equal(repairs, 1)
  assert.match(project.error, /environment is not ready/)
  assert.equal(project.setupRepair.status, 'failed')
  assert.equal(
    f.store.events(project.id, 'alice').some((event) => event.type === 'ready'),
    false,
  )
})

test('a prepared preset environment failure also requests repair and checks the final environment', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async ({ root }) => {
      repairs++
      await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
    },
  })
  const run = f.runtime.run
  f.runtime.run = async (root, args, options) => {
    const result = await run(root, args, options)
    if (args.at(-1) !== '--stdin') return result
    return (
      await fs.readFile(path.join(root, 'lakefile.toml'), 'utf8')
    ).includes('fixed')
      ? result
      : { code: 1, stdout: '', stderr: 'Fixture preset environment failed' }
  }
  const project = await f.create({ preset: 'lean' })
  assert.equal(project.status, 'ready', project.error)
  assert.equal(repairs, 1)
})

test('setup repair cannot switch an existing valid Lean pin or resolved dependency revision', async (t) => {
  for (const changed of ['lean', 'mathlib']) {
    const manifest = JSON.stringify({
      packages: [
        {
          name: 'mathlib',
          type: 'git',
          url: 'https://github.com/leanprover-community/mathlib4',
          rev: 'a'.repeat(40),
        },
      ],
    })
    const f = await fixture(t, {
      broken: true,
      setupRepair: async ({ root }) => {
        await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
        if (changed === 'lean')
          await fs.writeFile(
            path.join(root, 'lean-toolchain'),
            'leanprover/lean4:v4.35.0\n',
          )
        else
          await fs.writeFile(
            path.join(root, 'lake-manifest.json'),
            manifest.replace('a'.repeat(40), 'b'.repeat(40)),
          )
      },
    })
    const project = await f.create({
      files: [
        ...sources.map((file) =>
          file.path === 'lakefile.toml' ? { ...file, content: 'broken' } : file,
        ),
        { path: 'lake-manifest.json', content: manifest },
      ],
    })
    assert.equal(project.status, 'error')
    assert.match(project.error, /changed.*pinned/)
    assert.equal(
      await fs.readFile(path.join(project.root, 'lean-toolchain'), 'utf8'),
      toolchain + '\n',
    )
    assert.equal(
      await fs.readFile(path.join(project.root, 'lake-manifest.json'), 'utf8'),
      manifest,
    )
  }
})

test('unsupported chosen Lean releases are reported without asking Lemex to substitute a version', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    setupRepair: async () => {
      repairs++
    },
  })
  const chosen = 'leanprover/lean4:nightly-2026-10-13\n'
  const project = await f.create({
    files: sources.map((file) =>
      file.path === 'lean-toolchain' ? { ...file, content: chosen } : file,
    ),
  })
  assert.equal(project.status, 'error')
  assert.match(project.error, /Nightly toolchains are not supported/)
  assert.equal(repairs, 0)
  assert.equal(
    await fs.readFile(path.join(project.root, 'lean-toolchain'), 'utf8'),
    chosen,
  )
})

test('ready legacy-cache projects expose preparation guidance through both list and detail without changing their pins', async (t) => {
  const f = await fixture(t)
  const project = await f.create({ files: sources })
  f.runtime.dependencyPreparationReason = () =>
    'An older cache needs Refresh setup.'
  const listed = f.store.list('alice').find((item) => item.id === project.id)
  const detail = f.store.get(project.id, 'alice')
  assert.equal(listed.needsPreparation, true)
  assert.equal(detail.dependencyWarning, 'An older cache needs Refresh setup.')
  assert.equal(detail.status, 'ready')
  assert.equal(detail.toolchain, toolchain)
  assert.equal(
    (await f.store.readFile(project.id, 'alice', 'Main.lean')).content,
    sources[2].content,
  )
})

test('import preparation uses its configured root build timeout while dependency and import checks retain their own limits', async (t) => {
  for (const timeout of [undefined, 5400000]) {
    const f = await fixture(t, { setupBuildTimeoutMs: timeout })
    const project = await f.create({ files: sources })
    assert.equal(project.status, 'ready')
    const build = f.calls.find(
      (call) =>
        call.args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
        'lake build',
    )
    assert(build)
    assert.equal(build.options.timeoutMs, timeout ?? 1800000)
    assert.equal(
      f.calls.find((call) => call.args.at(-1) === '--stdin').options.timeoutMs,
      180000,
    )
  }
  for (const timeout of [0, -1, 1.5, 21600001, Infinity])
    assert.throws(
      () =>
        new WorkspaceStore({
          dataDir: os.tmpdir(),
          runtime: {},
          setupBuildTimeoutMs: timeout,
        }),
      /setupBuildTimeoutMs/,
    )
})

test('non-Lean Git imports wait for an environment choice without Lake or AI repair', async (t) => {
  let repairs = 0
  const documents = [
    { path: 'README.md', content: '# My ETL project\n' },
    { path: 'etl/pipeline.py', content: 'print("original")\n' },
  ]
  const f = await fixture(t, {
    cloneFiles: documents,
    setupRepair: async () => {
      repairs++
    },
  })
  const project = await f.create({
    repository: 'https://github.com/example/etl',
    autoRepair: true,
  })
  assert.equal(project.status, 'needs-setup', project.error)
  assert.equal(project.error, undefined)
  assert.equal(repairs, 0)
  assert(!f.calls.some(({ args }) => args[0] === 'lake'))
  for (const file of documents)
    assert.equal(
      await fs.readFile(path.join(project.root, file.path), 'utf8'),
      file.content,
    )
  assert.equal(
    await fs.stat(path.join(project.root, 'lean-toolchain')).catch(() => null),
    null,
  )
  const restored = await new WorkspaceStore({
    dataDir: f.dataDir,
    runtime: f.runtime,
  }).init()
  t.after(() => restored.close())
  assert.equal(restored.get(project.id, 'alice').status, 'needs-setup')
})

test('choosing Lean for an imported repository preserves content and uses the chosen exact version', async (t) => {
  const documents = [
    { path: 'Main.lean', content: '-- Already present, do not overwrite\n' },
    { path: '.gitignore', content: 'output/\n' },
    { path: 'paper.md', content: 'Original mathematics\n' },
  ]
  const f = await fixture(t, { cloneFiles: documents })
  const project = await f.create({
    repository: 'https://github.com/example/paper',
  })
  const selected = 'leanprover/lean4:v4.35.0-rc4'
  let installations = 0
  f.runtime.prepareToolchain = async (value) => {
    assert.equal(value, selected)
    installations++
  }
  await f.store.initializeEnvironment(project.id, 'alice', {
    libraries: [],
    toolchain: selected,
  })
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(ready.toolchain, selected)
  assert.equal(installations, 1)
  assert.equal(f.calls.filter(({ args }) => args.includes('clone')).length, 1)
  assert.equal(
    await fs.readFile(path.join(project.root, 'lean-toolchain'), 'utf8'),
    selected + '\n',
  )
  for (const file of documents)
    assert.equal(
      await fs.readFile(path.join(project.root, file.path), 'utf8'),
      file.content,
    )
  await assert.rejects(
    f.store.initializeEnvironment(project.id, 'alice', { libraries: [] }),
    { status: 409 },
  )
})

test('imported library setup reuses its prepared graph without replacing repository sources', async (t) => {
  for (const preset of ['mathlib', 'cslib', 'physlib']) {
    const f = await fixture(t, {
      cloneFiles: [{ path: 'paper.md', content: 'Keep this\n' }],
    })
    const template = path.join(f.dataDir, 'prepared')
    await fs.mkdir(template)
    for (const [name, content] of Object.entries({
      'lean-toolchain': toolchain + '\n',
      'lakefile.toml': 'name = "ProofWorkspace"\n[[lean_lib]]\nname = "Main"\n',
      'lake-manifest.json': JSON.stringify({
        name: 'ProofWorkspace',
        packages: [
          {
            type: 'git',
            name: preset,
            url: `https://github.com/example/${preset}`,
            rev: 'a'.repeat(40),
          },
        ],
      }),
    }))
      await fs.writeFile(path.join(template, name), content)
    const bindings = new Map()
    f.runtime.templates = () =>
      ['lean', 'mathlib', 'cslib', 'physlib'].map((id) => ({
        id,
        toolchain,
        ready: true,
      }))
    f.runtime.templateRoot = () => template
    f.runtime.inheritDependencies = async (source, root) =>
      bindings.set(root, source)
    f.runtime.dependencyRoot = (root) => bindings.get(root)
    const project = await f.create({
      repository: 'https://github.com/example/paper',
    })
    await f.store.initializeEnvironment(project.id, 'alice', {
      libraries: preset === 'mathlib' ? [preset] : ['mathlib', preset],
    })
    await f.store.jobs.get(project.id)
    const ready = f.store.get(project.id, 'alice')
    assert.equal(ready.status, 'ready', ready.error)
    assert.equal(bindings.get(project.root), template)
    assert.equal(ready.setupBuildStatus, 'passed')
    assert.equal(
      await fs.readFile(path.join(project.root, 'paper.md'), 'utf8'),
      'Keep this\n',
    )
    assert.match(
      await fs.readFile(path.join(project.root, 'Main.lean'), 'utf8'),
      /import Mathlib/,
    )
    assert(
      !f.calls.some(
        ({ args }) =>
          args.includes('cache') || args.some((arg) => arg.startsWith('@')),
      ),
    )
  }
})

test('environment selection enforces ownership, idle state and validation before writing files', async (t) => {
  const f = await fixture(t, {
    cloneFiles: [{ path: 'README.md', content: 'original' }],
  })
  const project = await f.create({
    repository: 'https://github.com/example/etl',
  })
  await assert.rejects(
    f.store.initializeEnvironment(project.id, 'bob', { libraries: [] }),
    { status: 404 },
  )
  await assert.rejects(
    f.store.initializeEnvironment(
      project.id,
      'alice',
      { libraries: [] },
      {
        assertIdle: () => {
          throw Object.assign(new Error('busy'), { status: 409 })
        },
      },
    ),
    { status: 409 },
  )
  for (const input of [
    null,
    [],
    {},
    { libraries: [], unexpected: true },
    { libraries: ['cslib', 'physlib'] },
    { libraries: [], toolchain: 'latest' },
    { libraries: ['mathlib'], toolchain: 'leanprover/lean4:v4.33.0' },
  ])
    await assert.rejects(
      f.store.initializeEnvironment(project.id, 'alice', input),
      { status: 400 },
    )
  await assert.rejects(
    f.store.initializeEnvironment(project.id, 'alice', {
      libraries: ['mathlib'],
    }),
    { status: 503 },
  )
  assert.equal(f.store.get(project.id, 'alice').status, 'needs-setup')
  assert.equal(
    await fs.stat(path.join(project.root, 'lean-toolchain')).catch(() => null),
    null,
  )
})

test('a partial or newly added Lean setup keeps its pins and never gets initialized over', async (t) => {
  for (const prefix of ['', 'formalization/']) {
    const f = await fixture(t, {
      cloneFiles: [
        { path: prefix + 'lakefile.toml', content: 'name = "existing"\n' },
      ],
    })
    const project = await f.create({
      repository: 'https://github.com/example/partial',
    })
    assert.equal(project.status, 'error')
    assert.match(project.error, /no lean-toolchain/)
    await assert.rejects(
      f.store.initializeEnvironment(project.id, 'alice', { libraries: [] }),
      { status: 409 },
    )
    assert.equal(
      await fs.readFile(path.join(project.root, 'lakefile.toml'), 'utf8'),
      'name = "existing"\n',
    )
  }
  const f = await fixture(t, {
    cloneFiles: [{ path: 'paper.md', content: 'original' }],
  })
  const project = await f.create({
    repository: 'https://github.com/example/paper',
  })
  await fs.mkdir(path.join(project.root, 'formalization'))
  await fs.writeFile(
    path.join(project.root, 'formalization', 'lean-toolchain'),
    toolchain + '\n',
  )
  await fs.writeFile(
    path.join(project.root, 'formalization', 'lakefile.toml'),
    'name = "existing"\n',
  )
  await f.store.initializeEnvironment(project.id, 'alice', {
    libraries: [],
    toolchain: 'leanprover/lean4:v4.33.0',
  })
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(ready.toolchain, toolchain)
  assert.equal(ready.subdirectory, 'formalization')
  assert.equal(
    await fs.stat(path.join(project.root, 'lean-toolchain')).catch(() => null),
    null,
  )
})

test('an interrupted initialization resumes existing configuration rather than trapping the setup page', async (t) => {
  const f = await fixture(t, {
    cloneFiles: [{ path: 'paper.md', content: 'original' }],
  })
  const project = await f.create({
    repository: 'https://github.com/example/paper',
  })
  const pin = 'leanprover/lean4:v4.33.0'
  for (const [name, content] of Object.entries({
    'lean-toolchain': pin + '\n',
    'lakefile.toml': 'name = "existing"\n',
    'Main.lean': '-- preserved\n',
  }))
    await fs.writeFile(path.join(project.root, name), content)
  await f.store.initializeEnvironment(project.id, 'alice', {
    libraries: ['mathlib'],
  })
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(ready.toolchain, pin)
  assert.equal(
    await fs.readFile(path.join(project.root, 'Main.lean'), 'utf8'),
    '-- preserved\n',
  )
})

test('a selected parent folder finds its nested pinned project; complete projects take priority over partial examples', async (t) => {
  for (const input of [{ subdirectory: 'work' }, {}]) {
    const f = await fixture(t, {
      cloneFiles: [
        ...sources.map((file) => ({ ...file, path: 'work/lean/' + file.path })),
        { path: 'examples/demo/lakefile.lean', content: 'import Lake\n' },
      ],
    })
    const project = await f.create({
      repository: 'https://github.com/example/paper',
      ...input,
    })
    assert.equal(project.status, 'ready', project.error)
    assert.equal(project.subdirectory, 'work/lean')
    assert.equal(
      await fs
        .stat(path.join(f.store.repositoryRoot(project), 'lean-toolchain'))
        .catch(() => null),
      null,
    )
  }
})

test('incomplete detection warns without blocking root setup; submodules are explained before choosing an environment', async (t) => {
  const deep = await fixture(t, {
    cloneFiles: sources.map((file) => ({
      ...file,
      path: 'a/b/c/d/e/f/' + file.path,
    })),
  })
  const stopped = await deep.create({
    repository: 'https://github.com/example/deep',
  })
  assert.equal(stopped.status, 'needs-setup')
  assert.match(stopped.importWarning, /Only part of this repository/)
  assert.equal(
    await fs.stat(path.join(stopped.root, 'lean-toolchain')).catch(() => null),
    null,
  )
  const f = await fixture(t, {
    cloneFiles: [
      { path: 'paper.md', content: 'original' },
      {
        path: '.gitmodules',
        content:
          '[submodule "formalization"]\npath = formalization\nurl = https://github.com/example/lean\n',
      },
    ],
  })
  const pending = await f.create({
    repository: 'https://github.com/example/paper',
  })
  assert.equal(pending.status, 'needs-setup')
  assert.match(pending.importWarning, /Git submodules were not imported/)
  assert.equal(
    await fs.stat(path.join(pending.root, 'lean-toolchain')).catch(() => null),
    null,
  )
})

test('changed repair configuration or a missing preset cannot reuse an old template binding', async (t) => {
  for (const missing of [false, true]) {
    let repairs = 0
    const added = {
      type: 'git',
      name: 'extra',
      url: 'https://github.com/example/extra',
      rev: 'b'.repeat(40),
    }
    const manifest = {
      name: 'fixture',
      packages: [
        {
          type: 'git',
          name: 'mathlib',
          url: 'https://github.com/example/mathlib',
          rev: 'a'.repeat(40),
        },
      ],
    }
    const f = await fixture(t, {
      cloneFiles: [{ path: 'paper.md', content: 'original' }],
      broken: !missing,
      setupRepair: async ({ root }) => {
        repairs++
        await fs.writeFile(path.join(root, 'lakefile.toml'), 'name = "fixed"\n')
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          JSON.stringify({
            ...manifest,
            packages: [...manifest.packages, added],
          }),
        )
      },
    })
    const template = path.join(f.dataDir, 'template')
    await fs.mkdir(template)
    for (const [name, content] of Object.entries({
      'lean-toolchain': toolchain + '\n',
      'lakefile.toml': `name = "${missing ? 'fixture' : 'broken'}"\n`,
      'lake-manifest.json': JSON.stringify(manifest),
    }))
      await fs.writeFile(path.join(template, name), content)
    let selections = 0
    f.runtime.templateRoot = () =>
      missing && selections++ > 0 ? null : template
    const bindings = new Map(),
      cleared = []
    f.runtime.inheritDependencies = async (source, root) =>
      bindings.set(root, source)
    f.runtime.dependencyRoot = (root) => bindings.get(root) ?? null
    f.runtime.clearInheritedDependencies = async (root, options) => {
      if (options?.force) {
        cleared.push(root)
        bindings.delete(root)
      }
    }
    const project = await f.create({
      repository: 'https://github.com/example/paper',
      autoRepair: true,
    })
    await f.store.initializeEnvironment(project.id, 'alice', {
      libraries: ['mathlib'],
    })
    await f.store.jobs.get(project.id)
    const ready = f.store.get(project.id, 'alice')
    assert.equal(ready.status, 'ready', ready.error)
    assert.equal(repairs, missing ? 0 : 1)
    assert(cleared.includes(project.root))
    assert.notEqual(bindings.get(project.root), template)
    assert(
      f.calls.some(
        ({ root, args }) => root === project.root && args.includes('@mathlib'),
      ),
    )
    if (!missing)
      assert(
        f.calls.some(
          ({ root, args }) => root === project.root && args.includes('@extra'),
        ),
      )
    assert.match(
      ready.log,
      /Added the selected Lean environment. Imported files were preserved/,
    )
  }
})

test('a deeply nested ETL repository without Lean can choose and prepare an environment at its root', async (t) => {
  const content = 'print("original pipeline")\n',
    relative = 'src/main/python/com/acme/etl/pipeline.py'
  const f = await fixture(t, { cloneFiles: [{ path: relative, content }] })
  const project = await f.create({
    repository: 'https://github.com/example/etl',
  })
  assert.equal(project.status, 'needs-setup', project.error)
  assert.match(project.importWarning, /Only part of this repository/)
  await f.store.initializeEnvironment(project.id, 'alice', { libraries: [] })
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(ready.root, project.root)
  assert.equal(
    await fs.readFile(path.join(project.root, relative), 'utf8'),
    content,
  )
  assert.equal(
    await fs.readFile(path.join(project.root, 'lean-toolchain'), 'utf8'),
    toolchain + '\n',
  )
})
