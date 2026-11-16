import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../workspaces.mjs'

const toolchain = 'leanprover/lean4:v4.34.1\n'
const originalLakefile = 'broken fixture configuration\n'
const originalManifest = '{"name":"fixture","packages":[]}\n'
const repairedLakefile = 'name = "repaired"\n'
const repairedManifest = '{"name":"repaired","packages":[]}\n'
const proof = 'example : True := by trivial\n'
const diskFull = () =>
  Object.assign(new Error('Fixture disk is full.'), { code: 'ENOSPC' })

async function fixture(t, { onRepair = async () => {} } = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lf-setup-transactions-'),
  )
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: toolchain.trim() }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args, options) {
      options.signal?.throwIfAborted()
      if (args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (
        args[0] === 'lake' &&
        (await fs.readFile(path.join(root, 'lakefile.toml'), 'utf8')).includes(
          'broken',
        )
      )
        return { code: 1, stderr: 'Invalid Lake configuration', stdout: '' }
      if (args.includes('python3'))
        return {
          code: 0,
          stdout: JSON.stringify({
            ready: true,
            message: 'Fixture imports ready.',
          }),
          stderr: '',
        }
      return { code: 0, stdout: 'Lean version 4.34.1', stderr: '' }
    },
  }
  let store = await new WorkspaceStore({
    dataDir,
    runtime,
    setupRepair: async (repair) => {
      await fs.writeFile(
        path.join(repair.root, 'lakefile.toml'),
        repairedLakefile,
      )
      await fs.writeFile(
        path.join(repair.root, 'lake-manifest.json'),
        repairedManifest,
      )
      await onRepair(repair, f)
    },
  }).init()
  const f = {
    dataDir,
    get store() {
      return store
    },
    async create() {
      const project = await store.create('alice', {
        files: [
          { path: 'lean-toolchain', content: toolchain },
          { path: 'lakefile.toml', content: originalLakefile },
          { path: 'lake-manifest.json', content: originalManifest },
          { path: 'Main.lean', content: proof },
        ],
      })
      await store.jobs.get(project.id)
      return store.get(project.id, 'alice')
    },
    async reopen() {
      store.close()
      store = await new WorkspaceStore({ dataDir, runtime }).init()
    },
  }
  t.after(async () => {
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return f
}

async function configuration(project) {
  return Promise.all(
    ['lean-toolchain', 'lakefile.toml', 'lake-manifest.json', 'Main.lean'].map(
      (name) => fs.readFile(path.join(project.root, name), 'utf8'),
    ),
  )
}
const unchanged = [toolchain, originalLakefile, originalManifest, proof]
const pending = (store) =>
  store.db
    .prepare('SELECT COUNT(*) AS count FROM pending_project_transactions')
    .get().count

function replaceFs(t, name, replacement) {
  const original = fs[name]
  fs[name] = replacement(original)
  syncBuiltinESMExports()
  const restore = () => {
    fs[name] = original
    syncBuiltinESMExports()
  }
  t.after(restore)
  return restore
}

test('accepted automatic repairs retain durable originals in the regular transaction history', async (t) => {
  const f = await fixture(t)
  const project = await f.create()
  assert.equal(project.status, 'ready', project.error)
  assert.deepEqual(await configuration(project), [
    toolchain,
    repairedLakefile,
    repairedManifest,
    proof,
  ])
  assert.equal(pending(f.store), 0)
  const histories = await fs.readdir(
    path.join(f.dataDir, 'history', project.id),
  )
  assert.equal(histories.length, 1)
  const directory = path.join(f.dataDir, 'history', project.id, histories[0])
  const record = JSON.parse(
    await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
  )
  const retained = {}
  for (const [index, change] of record.changes.entries())
    retained[change.path] = await fs.readFile(
      path.join(directory, 'before', String(index)),
      'utf8',
    )
  assert.deepEqual(retained, {
    'lake-manifest.json': originalManifest,
    'lakefile.toml': originalLakefile,
  })
  assert((await fs.stat(path.join(directory, 'applied.json'))).isFile())
})

test('a storage fault halfway through repair application rolls back every configuration file', async (t) => {
  const f = await fixture(t)
  let failed = false
  replaceFs(t, 'rename', (rename) => async (from, to) => {
    if (
      !failed &&
      String(from).startsWith(f.dataDir + '/history/') &&
      String(from).endsWith('/staged/1')
    ) {
      failed = true
      throw diskFull()
    }
    return rename(from, to)
  })
  const project = await f.create()
  assert.equal(failed, true)
  assert.equal(project.status, 'error')
  assert.match(project.error, /save was not applied; your files are unchanged/)
  assert.deepEqual(await configuration(project), unchanged)
  assert.equal(pending(f.store), 0)
})

test('failed repair rollback quarantines the project and restart restores the whole original configuration', async (t) => {
  const f = await fixture(t)
  let failed = false
  const restore = replaceFs(t, 'rename', (rename) => async (from, to) => {
    if (
      !failed &&
      String(from).startsWith(f.dataDir + '/history/') &&
      String(from).endsWith('/staged/1')
    ) {
      failed = true
      throw diskFull()
    }
    if (
      failed &&
      String(to).endsWith('/lake-manifest.json') &&
      (await fs.realpath(path.dirname(String(from)))).endsWith('/before')
    )
      throw diskFull()
    return rename(from, to)
  })
  const project = await f.create()
  assert.equal(failed, true)
  assert.equal(project.fileRecoveryRequired, true)
  assert.equal(pending(f.store), 1)
  assert.throws(() => f.store.requireEditor(project.id, 'alice'), {
    status: 503,
  })
  restore()
  await f.reopen()
  assert.equal(pending(f.store), 0)
  assert.equal(f.store.get(project.id, 'alice').fileRecoveryRequired, undefined)
  assert.deepEqual(await configuration(project), unchanged)
})

test('an original configuration changed while the repair agent runs is preserved instead of overwritten', async (t) => {
  const external = 'name = "changed outside the setup attempt"\n'
  const f = await fixture(t, {
    onRepair: async (_repair, state) => {
      const project = state.store.list('alice')[0]
      await fs.writeFile(path.join(project.root, 'lakefile.toml'), external)
    },
  })
  const project = await f.create()
  assert.equal(project.status, 'error')
  assert.match(
    project.error,
    /configuration lakefile.toml changed during repair/,
  )
  assert.deepEqual(await configuration(project), [
    toolchain,
    external,
    originalManifest,
    proof,
  ])
  assert.equal(pending(f.store), 0)
})

test('a configuration edited during transaction staging causes a 409 and retains the newer bytes', async (t) => {
  const f = await fixture(t)
  const external = 'name = "newer original configuration"\n'
  let changed = false,
    caught
  const apply = f.store.transactions.apply.bind(f.store.transactions)
  f.store.transactions.apply = async (...args) => {
    try {
      return await apply(...args)
    } catch (error) {
      caught = error
      throw error
    }
  }
  replaceFs(t, 'open', (open) => async (filename, ...args) => {
    if (
      !changed &&
      String(filename).startsWith(f.dataDir + '/history/') &&
      String(filename).endsWith('/staged/0')
    ) {
      changed = true
      const project = f.store.list('alice')[0]
      await fs.writeFile(path.join(project.root, 'lakefile.toml'), external)
    }
    return open(filename, ...args)
  })
  const project = await f.create()
  assert.equal(changed, true)
  assert.equal(caught.status, 409)
  assert.equal(project.status, 'error')
  assert.deepEqual(await configuration(project), [
    toolchain,
    external,
    originalManifest,
    proof,
  ])
  assert.equal(pending(f.store), 0)
})

test('stopping immediately before the repair transaction leaves all original files unchanged', async (t) => {
  const f = await fixture(t)
  let stopped = false
  replaceFs(t, 'open', (open) => async (filename, ...args) => {
    if (
      !stopped &&
      String(filename).startsWith(f.dataDir + '/setup-repairs/') &&
      String(filename).endsWith('/changes.json')
    ) {
      stopped = true
      const project = f.store.list('alice')[0]
      f.store.preparationControllers
        .get(project.id)
        .abort(new Error('Project setup stopped before commit.'))
    }
    return open(filename, ...args)
  })
  const project = await f.create()
  assert.equal(stopped, true)
  assert.equal(project.status, 'error')
  assert.match(project.error, /setup stopped/)
  assert.deepEqual(await configuration(project), unchanged)
  assert.equal(pending(f.store), 0)
})

test('a newly added configuration file outside the repair change set invalidates the candidate', async (t) => {
  const external = 'import Lake\nopen Lake DSL\npackage external\n'
  const f = await fixture(t, {
    onRepair: async (_repair, state) => {
      const project = state.store.list('alice')[0]
      await fs.writeFile(path.join(project.root, 'lakefile.lean'), external)
    },
  })
  const project = await f.create()
  assert.equal(project.status, 'error')
  assert.match(
    project.error,
    /configuration lakefile.lean changed during repair/,
  )
  assert.equal(
    await fs.readFile(path.join(project.root, 'lakefile.lean'), 'utf8'),
    external,
  )
  assert.deepEqual(await configuration(project), unchanged)
  assert.equal(pending(f.store), 0)
})

test('recovery retains the protected setup digest when the configuration committed before metadata cleanup failed', async (t) => {
  const f = await fixture(t)
  const apply = f.store.transactions.apply.bind(f.store.transactions)
  f.store.transactions.apply = (project, changes, options) =>
    apply(project, changes, {
      ...options,
      onCommitted: () => {
        throw Object.assign(
          new Error('Fixture metadata unavailable after commit.'),
          { code: 'SQLITE_FULL' },
        )
      },
    })
  const project = await f.create()
  assert.equal(project.fileRecoveryRequired, true)
  assert.equal(pending(f.store), 1)
  await f.reopen()
  const recovered = f.store.get(project.id, 'alice')
  assert.equal(pending(f.store), 0)
  assert.equal(recovered.repairedConfiguration, true)
  assert.match(recovered.repairedConfigurationDigest, /^[a-f0-9]{64}$/)
  assert.deepEqual(await configuration(project), [
    toolchain,
    repairedLakefile,
    repairedManifest,
    proof,
  ])
  await f.store.prepare(project.id, 'alice')
  await f.store.jobs.get(project.id)
  assert.equal(f.store.get(project.id, 'alice').status, 'ready')
  assert.equal(f.store.get(project.id, 'alice').repairedConfiguration, true)
})
