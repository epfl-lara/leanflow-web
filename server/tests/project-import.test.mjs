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
async function fixture(t, { setupRepair, cloneFiles, broken = false } = {}) {
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
    resolveHost: async () => [{ address: '140.82.112.3' }],
    setupRepair,
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

test('automatic setup repair is announced, retains original configuration and rechecks the environment once', async (t) => {
  let repairs = 0
  const f = await fixture(t, {
    broken: true,
    setupRepair: async ({ root, onOutput }) => {
      repairs++
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
  assert(checks.some((call) => call.args[1] === 'env'))
  assert(checks.some((call) => call.args[1] === 'build'))
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
    if (args[0] !== 'lake' || args[1] !== 'build')
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
