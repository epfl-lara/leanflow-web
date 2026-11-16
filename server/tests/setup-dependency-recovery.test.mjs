import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspaceStore } from '../workspaces.mjs'

const pin = 'leanprover/lean4:v4.34.1\n'
const source = 'example : True := by trivial\n'
const fixed =
  'name = "fixture"\n[[require]]\nname = "Local"\npath = "./Local"\n'
const lock = JSON.stringify({
  name: 'fixture',
  packages: [{ type: 'path', name: 'Local', dir: './Local' }],
})

async function fixture(t, { repair = true, unchanged = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-setup-deps-'))
  const inherited = [],
    calls = []
  let initiallyFailed = false
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: pin.trim() }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    verifiedDependencyRoot: () => null,
    inheritDependencies: async (from, to) => {
      inherited.push({ from, to })
      return from
    },
    clearInheritedDependencies: async () => {},
    async run(root, args, options) {
      calls.push({ root, args, options })
      options.signal?.throwIfAborted()
      if (args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
      if (args[0] !== 'lake') return { code: 0, stdout: '', stderr: '' }
      const text = await fs.readFile(path.join(root, 'lakefile.toml'), 'utf8')
      const original = root.startsWith(
        path.join(dataDir, 'projects') + path.sep,
      )
      if (text === 'broken' || (unchanged && original && !initiallyFailed)) {
        initiallyFailed = true
        return { code: 1, stdout: '', stderr: 'Invalid Lake configuration' }
      }
      // Model the real mount boundary: a cold private package cannot be fetched
      // or compiled through a read-only dependency mount, but warmed imports can.
      const artifact = path.join(root, 'Local/.lake/build-ready')
      if (
        args.includes('build') &&
        !(await fs.stat(artifact).catch(() => null))
      ) {
        if (options.readOnlyWorkspace && !options.writePrivateDependencyCache)
          return {
            code: 1,
            stdout: '',
            stderr: 'read-only file system: Local/.lake and .lake/packages',
          }
        await fs.mkdir(path.dirname(artifact), { recursive: true })
        await fs.writeFile(artifact, 'compiled private dependency')
        await fs.mkdir(path.join(root, '.lake/packages/Generated'), {
          recursive: true,
        })
      }
      if (args.includes('python3'))
        return {
          code: 0,
          stdout: JSON.stringify({ ready: true, message: 'Imports ready.' }),
          stderr: '',
        }
      return { code: 0, stdout: 'Lean version 4.34.1', stderr: '' }
    },
  }
  const store = await new WorkspaceStore({
    dataDir,
    runtime,
    setupRepair: async ({ root }) => {
      if (!unchanged)
        await fs.writeFile(path.join(root, 'lakefile.toml'), fixed)
    },
  }).init()
  t.after(async () => {
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const created = await store.create('alice', {
    autoRepair: repair,
    files: [
      { path: 'lean-toolchain', content: pin },
      { path: 'lakefile.toml', content: unchanged ? fixed : 'broken' },
      { path: 'lake-manifest.json', content: lock },
      { path: 'Main.lean', content: source },
      {
        path: 'Local/lakefile.toml',
        content: 'name = "Local"\n[[lean_lib]]\nname = "Local"\n',
      },
      { path: 'Local/Local.lean', content: source },
    ],
  })
  await store.jobs.get(created.id)
  return {
    store,
    runtime,
    calls,
    inherited,
    project: store.get(created.id, 'alice'),
  }
}

test('automatic configuration repair rebuilds private and local caches without making proof sources writable', async (t) => {
  const f = await fixture(t)
  assert.equal(f.project.status, 'ready', f.project.error)
  assert.equal(f.project.repairedConfiguration, true)
  assert.match(f.project.repairedConfigurationDigest, /^[a-f0-9]{64}$/)
  const repairedBuilds = f.calls.filter(
    (call) => call.root === f.project.root && call.args.includes('build'),
  )
  assert(repairedBuilds.length)
  assert(repairedBuilds.every((call) => call.options.readOnlyWorkspace))
  assert(
    repairedBuilds.some((call) => call.options.writePrivateDependencyCache),
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'Main.lean'), 'utf8'),
    source,
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'Local/Local.lean'), 'utf8'),
    source,
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'lean-toolchain'), 'utf8'),
    pin,
  )
  const config = await f.store.readFile(f.project.id, 'alice', 'lakefile.toml')
  await f.store.writeFile(
    f.project.id,
    'alice',
    'lakefile.toml',
    config.content + '\n# explicit user change\n',
    config.hash,
  )
  assert.equal(
    f.store.get(f.project.id, 'alice').repairedConfiguration,
    undefined,
  )
  assert.equal(
    f.store.get(f.project.id, 'alice').repairedConfigurationDigest,
    undefined,
  )
})

test('zero-change recovery retains the original writable private setup policy and chosen pins', async (t) => {
  const f = await fixture(t, { unchanged: true })
  assert.equal(f.project.status, 'ready', f.project.error)
  assert.deepEqual(f.project.setupRepair.changes, [])
  assert.equal(f.project.repairedConfiguration, undefined)
  assert.equal(f.project.repairedConfigurationDigest, undefined)
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'lean-toolchain'), 'utf8'),
    pin,
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'lake-manifest.json'), 'utf8'),
    lock,
  )
})

test('setup agents and independent checks rebuild fresh private dependencies instead of inheriting failed caches', async (t) => {
  const f = await fixture(t, { repair: false })
  assert.equal(f.project.status, 'error')
  await fs.mkdir(path.join(f.project.root, '.lake/packages/Partial'), {
    recursive: true,
  })
  await fs.writeFile(
    path.join(f.project.root, '.lake/packages/Partial/broken'),
    'partial old cache',
  )
  const snapshot = await f.store.snapshot(
    f.project.id,
    'alice',
    'setup-fresh-candidate',
    { allowUnprepared: true },
  )
  assert(!f.inherited.some((entry) => entry.to === snapshot.root))
  await assert.rejects(
    fs.stat(path.join(snapshot.root, '.lake/packages/Partial')),
    { code: 'ENOENT' },
  )
  await fs.writeFile(path.join(snapshot.root, 'lakefile.toml'), fixed)
  const changes = await f.store.changes(snapshot)
  const verified = await f.store.verificationCopy(snapshot, changes, {
    allowProjectConfiguration: true,
  })
  assert(!f.inherited.some((entry) => entry.to === verified.root))
  await f.store.prepareVerificationConfiguration(verified, changes)
  const work = f.calls.filter((call) => call.root === verified.root)
  assert(
    work.some(
      (call) =>
        call.args.includes('build') &&
        call.options.network === 'bridge' &&
        call.options.writePrivateDependencyCache,
    ),
  )
  assert(
    (
      await fs.stat(path.join(verified.root, 'Local/.lake/build-ready'))
    ).isFile(),
  )
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'lakefile.toml'), 'utf8'),
    'broken',
  )
  await f.store.cleanupVerificationCopy(verified)
})

test('ready projects continue to reuse their prepared dependency sources', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.store.snapshot(
    f.project.id,
    'alice',
    'ready-reuses-cache',
  )
  assert(
    f.inherited.some(
      (entry) => entry.from === f.project.root && entry.to === snapshot.root,
    ),
  )
})

test('explicitly verified shared dependencies remain reusable even when the project needs setup', async (t) => {
  const f = await fixture(t, { repair: false })
  f.runtime.verifiedDependencyRoot = () => '/fixture/verified-shared-cache'
  const snapshot = await f.store.snapshot(
    f.project.id,
    'alice',
    'verified-shared-reuse',
    { allowUnprepared: true },
  )
  assert(
    f.inherited.some(
      (entry) => entry.from === f.project.root && entry.to === snapshot.root,
    ),
  )
})

test('reviewed setup application records protected configuration before its transaction commits', async (t) => {
  const f = await fixture(t, { repair: false })
  const current = await f.store.readFile(f.project.id, 'alice', 'lakefile.toml')
  const apply = f.store.transactions.apply.bind(f.store.transactions)
  let protectedBeforeCommit = false
  f.store.transactions.apply = (project, changes, options) => {
    const stored = f.store.get(project.id, 'alice')
    protectedBeforeCommit =
      stored.repairedConfiguration === true &&
      /^[a-f0-9]{64}$/.test(stored.repairedConfigurationDigest)
    return apply(project, changes, options)
  }
  await f.store.applyChanges(
    f.project.id,
    'alice',
    [{ path: 'lakefile.toml', beforeHash: current.hash, after: fixed }],
    { setupRepair: true },
  )
  assert(protectedBeforeCommit)
  assert.equal(f.store.get(f.project.id, 'alice').repairedConfiguration, true)
  await f.store.prepare(f.project.id, 'alice')
  await f.store.jobs.get(f.project.id)
  assert.equal(f.store.get(f.project.id, 'alice').status, 'ready')
  assert.equal(
    await fs.readFile(path.join(f.project.root, 'Main.lean'), 'utf8'),
    source,
  )
})
