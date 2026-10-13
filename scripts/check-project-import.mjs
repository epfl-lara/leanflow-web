#!/usr/bin/env node
// Real import and server-owned repair, isolated from all user workspace records.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'
import { repairProjectSetup } from '../server/setup-repair.mjs'
import { loadConfig } from '../server/config.mjs'

const dataDir = path.resolve('.data')
const reportDir = path.resolve('.runtime/project-import-check')
const fixtureDir = path.join(dataDir, 'runtime', 'import-check', randomUUID())
await fs.mkdir(reportDir, { recursive: true })
const runtime = new Runtime({
  dataDir,
  image: 'lemex-web-worker:lean-probe-646cb0ee',
  scope: 'helper',
  memory: '8g',
  cpus: 4,
})
const config = await loadConfig(dataDir)
const report = { fixtureDir, checks: {}, providerSetupCalls: 0 }
let store
try {
  assert.equal((await runtime.init()).ready, true)
  store = await new WorkspaceStore({
    dataDir: fixtureDir,
    runtime,
    setupRepair: (args) => {
      report.providerSetupCalls++
      console.log('Setup repair started in isolated copy')
      return repairProjectSetup({ runtime, config, ...args })
    },
  }).init()
  const prepare = async (name, input) => {
    const project = await store.create('integration-fixture', {
      name,
      ...input,
    })
    console.log(name, project.id, 'preparing')
    await store.jobs.get(project.id)
    const result = store.get(project.id, 'integration-fixture')
    await fs.writeFile(
      path.join(reportDir, `${name}.json`),
      JSON.stringify(result, null, 2) + '\n',
    )
    console.log(name, result.status, result.error || '')
    assert.equal(result.status, 'ready', result.error)
    return result
  }
  const results = await Promise.allSettled([
    (async () => {
      const source =
        'theorem upload_preserved (n : Nat) : n + 0 = n := by rfl\n'
      const project = await prepare('repaired-upload', {
        files: [
          { path: 'lean-toolchain', content: 'leanprover/lean4:v4.34.1\n' },
          {
            path: 'lakefile.toml',
            content:
              'name = "UploadedFixture"\ndefaultTargets = ["Main"\n\n[[lean_lib]]\nname = "Main"\n',
          },
          { path: 'Main.lean', content: source },
        ],
      })
      assert.equal(project.setupRepair?.status, 'completed')
      assert.equal(
        (await store.readFile(project.id, 'integration-fixture', 'Main.lean'))
          .content,
        source,
      )
      assert.equal(project.toolchain, 'leanprover/lean4:v4.34.1')
      const backup = JSON.parse(
        await fs.readFile(
          path.join(
            fixtureDir,
            'setup-repairs',
            project.setupRepair.id,
            'changes.json',
          ),
          'utf8',
        ),
      )
      assert(
        backup.changes.length > 0 &&
          backup.changes.every((file) =>
            [
              'lakefile.toml',
              'lakefile.lean',
              'lake-manifest.json',
              'lean-toolchain',
            ].includes(file.path),
          ),
      )
      report.checks.repair = {
        projectId: project.id,
        status: project.status,
        sourcePreserved: true,
        changes: project.setupRepair.changes,
        backupRetained: true,
      }
    })(),
    (async () => {
      const project = await prepare('jordan-subproject', {
        repository:
          'https://github.com/epfl-lara/jordan-curve-theorem/tree/main/HOLLight-Lean',
      })
      assert.equal(project.subdirectory, 'HOLLight-Lean')
      assert.equal(project.toolchain, 'leanprover/lean4:v4.29.0')
      const temporary = path.join(project.root, 'LemexImportCheck.lean')
      await fs.writeFile(
        temporary,
        'import Mathlib.Data.Nat.Basic\nexample (n : Nat) : n + 0 = n := by rfl\n',
      )
      try {
        const proof = await runtime.run(
          project.root,
          ['lake', 'env', 'lean', 'LemexImportCheck.lean'],
          { network: 'none', timeoutMs: 120000 },
        )
        assert.equal(proof.code, 0, proof.stderr + proof.stdout)
      } finally {
        await fs.rm(temporary)
      }
      const git = await store.gitStatus(project.id, 'integration-fixture')
      report.checks.jordan = {
        projectId: project.id,
        status: project.status,
        toolchain: project.toolchain,
        subdirectory: project.subdirectory,
        sourceRevision: project.sourceRevision,
        buildWarning: project.buildWarning || null,
        git,
        mathlibImportChecked: true,
      }
    })(),
  ])
  for (const value of results)
    if (value.status === 'rejected') throw value.reason
  report.checks.libraries = []
  for (const libraries of [
    ['mathlib', 'cslib'],
    ['mathlib', 'physlib'],
  ]) {
    const project = await prepare(libraries.join('-'), { libraries })
    const proof = await runtime.run(
      project.root,
      ['lake', 'env', 'lean', 'Main.lean'],
      { network: 'none', readOnlyWorkspace: true, timeoutMs: 180000 },
    )
    assert.equal(proof.code, 0, proof.stderr + proof.stdout)
    report.checks.libraries.push({
      libraries,
      projectId: project.id,
      toolchain: project.toolchain,
      importsChecked: true,
    })
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
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report))
}
