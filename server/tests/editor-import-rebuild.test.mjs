import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from '../workspaces.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(
  t,
  readiness = { ready: true, message: 'Project imports are ready.' },
) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-import-rebuild-'),
  )
  const calls = []
  const runtime = {
    templates: () => [{ id: 'lean', toolchain }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args, options) {
      calls.push({ root, args, options })
      if (args[0] === 'git' && args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse'))
        return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'lake' && args.includes('build')) {
        if (runtime.build) await runtime.build(root, options)
      }
      if (args.includes('python3'))
        return {
          code: 0,
          stdout: JSON.stringify(runtime.readiness),
          stderr: '',
        }
      return { code: 0, stdout: '', stderr: '' }
    },
    readiness,
  }
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = await store.create('alice', {
    name: 'Imports fixture',
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: toolchain + '\n' },
      { path: 'lake-manifest.json', content: '{"packages":[]}' },
      {
        path: 'lakefile.toml',
        content:
          'name = "fixture"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n',
      },
      { path: 'Main.lean', content: 'example : True := by trivial\n' },
    ],
  })
  await store.jobs.get(project.id)
  assert.equal(store.get(project.id, 'alice').status, 'ready')
  return { store, project, calls, runtime }
}

test('setup reports unresolved local imports even when the project build and external library smoke check succeed', async (t) => {
  const message =
    'The import Helper is unavailable. Run Check project after fixing the build errors.'
  const { store, project } = await fixture(t, { ready: false, message })
  const ready = store.get(project.id, 'alice')
  assert.equal(ready.setupBuildStatus, 'warnings')
  assert.match(ready.buildWarning, /Helper/)
  assert(
    store
      .events(project.id, 'alice')
      .some(
        (event) => event.type === 'warning' && event.message.includes('Helper'),
      ),
  )
})

test('saved assistant modules are rebuilt in the saved workspace without copying candidate artifacts', async (t) => {
  const { store, project, runtime, calls } = await fixture(t)
  const snapshot = await store.snapshot(project.id, 'alice', randomUUID())
  await fs.writeFile(
    path.join(snapshot.root, 'Helper.lean'),
    'theorem helper : True := by trivial\n',
  )
  await fs.mkdir(path.join(snapshot.root, '.lake/build/lib/lean'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(snapshot.root, '.lake/build/lib/lean/Helper.olean'),
    'candidate artifact',
  )
  const changes = await store.changes(snapshot)
  await store.syncLive(snapshot, changes)
  const artifact = path.join(project.root, '.lake/build/lib/lean/Helper.olean')
  await assert.rejects(fs.stat(artifact), { code: 'ENOENT' })
  runtime.build = async (root, options) => {
    assert.equal(root, project.root)
    assert.equal(options.network, 'none')
    assert.equal(options.readOnlyWorkspace, true)
    assert.equal(options.writeLakeCache, true)
    await fs.mkdir(path.dirname(artifact), { recursive: true })
    await fs.writeFile(artifact, 'built from saved Helper.lean')
  }
  const result = await store.refreshEditorImports(project.id, 'alice')
  assert.equal(result.ready, true)
  assert.equal(
    await fs.readFile(artifact, 'utf8'),
    'built from saved Helper.lean',
  )
  const saved = store.get(project.id, 'alice')
  assert.equal(saved.editorImportsVersion, 1)
  assert.equal(saved.setupBuildStatus, 'passed')
  assert.equal(saved.buildWarning, undefined)
  assert.equal(
    await fs.readFile(path.join(project.root, 'lean-toolchain'), 'utf8'),
    toolchain + '\n',
  )
  assert(
    calls.some(
      (call) => call.root === project.root && call.args.includes('python3'),
    ),
  )
})

test('building imports leaves editing responsive and reports saved-source changes instead of claiming success', async (t) => {
  const { store, project, runtime } = await fixture(t)
  const started = deferred(),
    finish = deferred()
  runtime.build = async () => {
    started.resolve()
    await finish.promise
  }
  const refresh = store.refreshEditorImports(project.id, 'alice')
  await started.promise
  const file = await store.readFile(project.id, 'alice', 'Main.lean')
  await store.writeFile(
    project.id,
    'alice',
    'Main.lean',
    file.content + '-- user edit\n',
    file.hash,
  )
  finish.resolve()
  const result = await refresh
  assert.equal(result.ready, false)
  assert.match(result.message, /changed while/)
  assert.match(
    (await store.readFile(project.id, 'alice', 'Main.lean')).content,
    /user edit/,
  )
  assert.equal(store.get(project.id, 'alice').setupBuildStatus, 'warnings')
})

test('cancelling an import build cancels its worker and does not publish readiness', async (t) => {
  const { store, project, runtime } = await fixture(t)
  const started = deferred(),
    controller = new AbortController()
  runtime.build = async (_root, { signal }) => {
    assert.equal(signal, controller.signal)
    started.resolve()
    await new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    )
  }
  const refresh = store.refreshEditorImports(project.id, 'alice', {
    signal: controller.signal,
  })
  await started.promise
  controller.abort(new Error('Stop import build'))
  await assert.rejects(refresh, /Stop import build/)
  assert.equal(store.get(project.id, 'alice').editorImportsVersion, undefined)
})

test('failed import builds keep saved sources available with a recovery action', async (t) => {
  const { store, project, runtime } = await fixture(t)
  runtime.build = async () => {
    throw new Error('Worker unavailable')
  }
  assert.equal(
    (await store.refreshEditorImports(project.id, 'alice')).ready,
    false,
  )
  const saved = store.get(project.id, 'alice')
  assert.equal(saved.status, 'ready')
  assert.match(saved.buildWarning, /Check project/)
  assert.equal(saved.setupBuildStatus, 'warnings')
  await assert.rejects(store.refreshEditorImports(project.id, 'bob'), {
    status: 404,
  })
})
