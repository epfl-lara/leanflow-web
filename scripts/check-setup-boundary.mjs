#!/usr/bin/env node
// Compiler-only replay of a setup fix plus executable-config integrity checks.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'

const dataDir = path.resolve('.data')
const root = path.join(dataDir, 'runtime', 'setup-boundary', randomUUID())
const output = path.resolve('.runtime/setup-boundary')
const runtime = new Runtime({
  dataDir,
  image: 'lemex-web-worker:lean-probe-646cb0ee',
  scope: 'helper',
})
const source = 'theorem preserved (n : Nat) : n + 0 = n := by rfl\n'
const report = { root, providerCalls: 0, cases: [] }
let store
await fs.mkdir(output, { recursive: true })
try {
  assert.equal((await runtime.init()).ready, true)
  let hostile = false
  store = await new WorkspaceStore({
    dataDir: root,
    runtime,
    setupRepair: async ({ root: candidate }) => {
      if (!hostile)
        await fs.writeFile(
          path.join(candidate, 'lakefile.toml'),
          'name = "SetupBoundary"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n',
        )
      else {
        await fs.rm(path.join(candidate, 'lakefile.toml'))
        await fs.writeFile(
          path.join(candidate, 'lakefile.lean'),
          'import Lake\nopen Lake DSL\n#eval IO.FS.writeFile "Main.lean" "axiom injected : False\\n"\npackage SetupBoundary\nlean_lib Main\n',
        )
      }
    },
  }).init()
  for (const malicious of [false, true]) {
    hostile = malicious
    const project = await store.create('setup-boundary', {
      files: [
        { path: 'lean-toolchain', content: 'leanprover/lean4:v4.34.1\n' },
        { path: 'lakefile.toml', content: 'name = [ invalid toml\n' },
        { path: 'Main.lean', content: source },
      ],
    })
    await store.jobs.get(project.id)
    const finished = store.get(project.id, 'setup-boundary')
    assert.equal(
      await fs.readFile(path.join(finished.root, 'Main.lean'), 'utf8'),
      source,
    )
    if (malicious) {
      assert.equal(finished.status, 'error')
      assert.match(finished.error, /Source files were preserved/)
    } else {
      assert.equal(finished.status, 'ready', finished.error)
      assert.equal(finished.setupRepair.status, 'completed')
      assert.equal(finished.buildWarning, undefined)
      assert.equal(finished.repairedConfiguration, true)
    }
    report.cases.push({
      malicious,
      status: finished.status,
      error: finished.error || null,
      sourcePreserved: true,
      changes: finished.setupRepair?.changes,
    })
    console.log(JSON.stringify(report.cases.at(-1)))
  }
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack
  process.exitCode = 1
} finally {
  await runtime.shutdown()
  if (store) {
    await Promise.all([...store.jobs.values()])
    store.close()
  }
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify({ passed: report.passed, error: report.error }))
}
