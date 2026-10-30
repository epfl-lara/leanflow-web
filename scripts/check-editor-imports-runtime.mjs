#!/usr/bin/env node
// Real compiler regression in a disposable fixture; no provider calls or user
// projects. Optional STUDIO_TEST_TOOLCHAIN_DIR reuses installed toolchains.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'
import { checkEditorImports } from '../server/editor-imports.mjs'
import { runPinnedLake } from '../server/pinned-lake.mjs'

const reportDir = path.resolve('.runtime/editor-imports-runtime', randomUUID())
await fs.mkdir(reportDir, { recursive: true })
const runtime = new Runtime({
  dataDir: path.join(reportDir, 'data'),
  scope: 'helper',
  maxConcurrent: 1,
  cpus: 1,
  memory: '2g',
  hostToolchainDir: process.env.STUDIO_TEST_TOOLCHAIN_DIR,
})
const report = { providerCalls: 0, checks: [], passed: false }
const toolchain =
  process.env.STUDIO_TEST_TOOLCHAIN || 'leanprover/lean4:v4.34.1'
let store
try {
  const status = await runtime.init()
  assert.equal(status.ready, true, status.error)
  store = await new WorkspaceStore({ dataDir: runtime.dataDir, runtime }).init()
  const project = await store.create('imports-fixture', {
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: toolchain + '\n' },
      {
        path: 'lakefile.toml',
        content:
          'name = "ImportFixture"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n[[lean_lib]]\nname = "Helper"\n',
      },
      { path: 'Main.lean', content: 'theorem initial : True := by trivial\n' },
    ],
  })
  await store.jobs.get(project.id)
  const ready = store.get(project.id, 'imports-fixture')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(ready.setupBuildStatus, 'passed', ready.buildWarning)
  report.checks.push(
    'Setup checks real local import headers after its project build.',
  )
  const snapshot = await store.snapshot(
    project.id,
    'imports-fixture',
    randomUUID(),
  )
  await fs.writeFile(
    path.join(snapshot.root, 'Main.lean'),
    'import Helper\nexample : True := helper\n',
  )
  await fs.writeFile(
    path.join(snapshot.root, 'Helper.lean'),
    'theorem helper : True := by trivial\n',
  )
  await store.syncLive(snapshot, await store.changes(snapshot))
  const missing = await checkEditorImports(runtime, ready.root)
  assert.equal(missing.ready, false)
  assert.match(missing.message, /Helper|imports/)
  report.checks.push(
    'Publishing a new assistant module reproduces the missing compiled import.',
  )
  const rebuilt = await store.refreshEditorImports(
    project.id,
    'imports-fixture',
  )
  assert.equal(rebuilt.ready, true, rebuilt.message)
  assert(
    (
      await fs.stat(path.join(ready.root, '.lake/build/lib/lean/Helper.olean'))
    ).isFile(),
  )
  const compiler = await runPinnedLake(
    runtime,
    ready.root,
    ['lake', 'env', 'lean', 'Main.lean'],
    {
      network: 'none',
      readOnlyWorkspace: true,
      writeLakeCache: true,
      timeoutMs: 30000,
    },
  )
  assert.equal(compiler.code, 0, compiler.stdout + compiler.stderr)
  report.checks.push(
    'Rebuilding the saved workspace regenerates its own module and the importer compiles.',
  )
  const source = await store.readFile(
    project.id,
    'imports-fixture',
    'Main.lean',
  )
  await store.writeFile(
    project.id,
    'imports-fixture',
    'Main.lean',
    'import Helper\nexample : False := by sorry\n',
    source.hash,
  )
  const imports = await checkEditorImports(runtime, ready.root)
  assert.equal(imports.ready, true, imports.message)
  report.checks.push(
    'Unfinished proofs do not fail import readiness or get treated as proof verification.',
  )
  assert.equal(
    await fs.readFile(path.join(ready.root, 'lean-toolchain'), 'utf8'),
    toolchain + '\n',
  )
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
} finally {
  await runtime.shutdown()
  store?.close()
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report, null, 2))
