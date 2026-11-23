// Exercise two real Lean editors on one saved project. No provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'
import { checkSetupEditor } from './lib/setup-readiness.mjs'

const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'leanflow-shared-oleans-'),
)
const runtime = new Runtime({
  dataDir: directory,
  image: process.env.STUDIO_TEST_WORKER_IMAGE || process.env.LEMEX_WORKER_IMAGE,
  hostToolchainDir: process.env.STUDIO_TEST_TOOLCHAIN_DIR,
  scope: 'helper',
  cpus: 1,
  memory: '1g',
  kernelExportMaxBytes: 512 * 1024 ** 2,
  maxConcurrent: 4,
})
const toolchain =
  process.env.STUDIO_TEST_TOOLCHAIN || 'leanprover/lean4:v4.34.1'
const containedPackage = process.env.STUDIO_TEST_LOCAL_PACKAGE === '1'
const commonFile = containedPackage ? 'Library/Common.lean' : 'Common.lean'
const mainPackage =
  'name = "Sharing"\ndefaultTargets = ["Common"]\n[[lean_lib]]\nname = "Common"\n'
const withLibrary =
  'name = "Project"\ndefaultTargets = ["Root"]\n[[lean_lib]]\nname = "Root"\n[[require]]\nname = "Sharing"\npath = "Library"\n'
const proof = 'import Common\nexample : sharedAnswer = 37 := by\n  rfl\n'
const common =
  'module\npublic import Lean\npublic def sharedAnswer : Nat := 37\n'
let store
try {
  const status = await runtime.init()
  assert.equal(status.ready, true, status.error)
  store = await new WorkspaceStore({ dataDir: directory, runtime }).init()
  const project = await store.create('alice', {
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: toolchain + '\n' },
      {
        path: 'lakefile.toml',
        content: containedPackage ? withLibrary : mainPackage,
      },
      ...(containedPackage
        ? [
            { path: 'Library/lakefile.toml', content: mainPackage },
            {
              path: 'Root.lean',
              content:
                'import Common\ntheorem checkedAnswer : sharedAnswer = 37 := rfl\n',
            },
          ]
        : []),
      { path: commonFile, content: common },
      { path: 'Alice.lean', content: proof },
      { path: 'Bob.lean', content: proof },
    ],
  })
  await store.jobs.get(project.id)
  const alice = store.get(project.id, 'alice')
  assert.equal(
    alice.setupBuildStatus,
    'passed',
    alice.buildWarning || alice.error,
  )
  await store.setMember(project.id, 'alice', 'bob', 'editor')
  const bob = store.get(project.id, 'bob')
  const file = await store.readFile(project.id, 'bob', commonFile)
  await store.writeFile(
    project.id,
    'bob',
    commonFile,
    common +
      'run_cmd do\n  let h ← IO.FS.Handle.mk "/workspace/.lake/build-count" .append\n  h.putStrLn "compiled"\n  h.flush\n  IO.sleep 1200\n',
    file.hash,
  )
  const counter = path.join(alice.root, '.lake/build-count')
  await store.setMember(project.id, 'alice', 'bob', 'viewer')
  const checkSavedFile = () =>
    store.withFileCheckWorkspace(
      project.id,
      'bob',
      { file: 'Bob.lean' },
      async (root, digest, onSpawn) => {
        assert.notEqual(root, bob.root)
        assert.ok(digest)
        const result = await runtime.run(
          root,
          ['lake', 'lean', './Bob.lean', '--', '--json'],
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
        assert.equal(result.code, 0, result.stderr + result.stdout)
        await assert.rejects(fs.stat(path.join(root, '.lake/build-count')), {
          code: 'ENOENT',
        })
      },
    )
  const results = await Promise.allSettled([
    checkSetupEditor(runtime, alice.root, 'Alice.lean', {
      line: 2,
      character: 2,
    }),
    checkSavedFile(),
    checkSetupEditor(runtime, bob.root, 'Bob.lean', { line: 2, character: 2 }),
  ])
  for (const result of results)
    if (result.status === 'rejected') throw result.reason
  assert.equal(await fs.readFile(counter, 'utf8'), 'compiled\n')
  const refreshed = await store.refreshEditorImports(project.id, 'alice')
  assert.equal(refreshed.ready, true, refreshed.message)
  assert.equal(await fs.readFile(counter, 'utf8'), 'compiled\n')
  if (await runtime.leanCheckSupported(alice.root)) {
    const checked = await runtime.checkProject(alice.root, {
      timeoutMs: 180000,
    })
    assert.equal(checked.code, 0, checked.stderr + checked.stdout)
    assert.equal(await fs.readFile(counter, 'utf8'), 'compiled\n')
    console.log(
      'The independent project kernel check reused the compiled module.',
    )
  }
  // Change and restore the source while a real compiler owns the cache.
  // Its attempted compilation must not seed the next participant's editor.
  const previous = await store.readFile(project.id, 'alice', commonFile)
  const next = await store.writeFile(
    project.id,
    'alice',
    commonFile,
    previous.content + '-- another saved revision\n',
    previous.hash,
  )
  const compiling = runtime.run(
    alice.root,
    ['lake', 'setup-file', './Alice.lean'],
    {
      network: 'none',
      cleanHome: true,
      freshHome: true,
      readOnlyWorkspace: true,
      writeLakeCache: true,
      timeoutMs: 30000,
    },
  )
  const deadline = AbortSignal.timeout(25000)
  while ((await fs.readFile(counter, 'utf8')) !== 'compiled\ncompiled\n')
    await delay(25, undefined, { signal: deadline })
  const transient = await store.writeFile(
    project.id,
    'alice',
    commonFile,
    next.content + '-- temporary edit\n',
    next.hash,
  )
  await store.writeFile(
    project.id,
    'alice',
    commonFile,
    next.content,
    transient.hash,
  )
  const stale = await compiling
  assert.notEqual(stale.code, 0)
  assert.match(stale.stderr, /changed during the build/)
  await checkSetupEditor(runtime, bob.root, 'Bob.lean', {
    line: 2,
    character: 2,
  })
  assert.equal(
    await fs.readFile(counter, 'utf8'),
    'compiled\ncompiled\ncompiled\n',
  )
  console.log(
    'Two editors, a build and an isolated file check reused one compilation. An edit followed by undo invalidated the in-flight build, and the next editor rebuilt successfully.',
  )
} finally {
  await runtime.shutdown()
  store?.close()
  await fs.rm(directory, { recursive: true, force: true })
}
