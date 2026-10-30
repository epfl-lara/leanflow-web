#!/usr/bin/env node
// Exercise real Lean setup in a separate runtime. No provider configuration is loaded.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'
import { runPinnedLake } from '../server/pinned-lake.mjs'

const { values } = parseArgs({ options: { repository: { type: 'string' } } })
const reportDir = path.resolve('.runtime/project-setup-check')
const dataDir = path.join(reportDir, randomUUID())
const toolchain = 'leanprover/lean4:v4.34.1'
const source = 'theorem preserved (n : Nat) : n + 0 = n := by rfl\n'
const configuration =
  'name = "SetupFixture"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n'
const files = (proof = source, lakefile = configuration) => [
  { path: 'lean-toolchain', content: toolchain + '\n' },
  { path: 'lakefile.toml', content: lakefile },
  { path: 'Main.lean', content: proof },
]
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  maxConcurrent: 1,
  cpus: 2,
  memory: process.env.STUDIO_WORKER_MEMORY || '8g',
  ...(process.env.LEAN_TEST_TOOLCHAIN_DIR
    ? { hostToolchainDir: process.env.LEAN_TEST_TOOLCHAIN_DIR }
    : {}),
})
const report = {
  dataDir,
  providerCalls: 0,
  repairs: 0,
  checks: [],
  passed: false,
}
let store
await fs.mkdir(reportDir, { recursive: true })
try {
  const status = await runtime.init()
  assert.equal(status.ready, true, status.error)
  store = await new WorkspaceStore({
    dataDir,
    runtime,
    setupBuildTimeoutMs: 600000,
    setupRepair: async ({ root, project }) => {
      assert.equal(
        project.name,
        'repair-fixture',
        'Only the known fixture can receive an offline repair',
      )
      report.repairs++
      await fs.writeFile(path.join(root, 'lakefile.toml'), configuration)
    },
  }).init()
  const prepare = async (name, input) => {
    const started = Date.now()
    const project = await store.create('setup-fixture', {
      name,
      autoRepair: false,
      ...input,
    })
    const timer = setTimeout(() => {
      void store.stopPreparation(project.id, 'setup-fixture')
    }, 600000)
    try {
      await store.jobs.get(project.id)
    } finally {
      clearTimeout(timer)
    }
    const result = store.get(project.id, 'setup-fixture')
    await fs.writeFile(
      path.join(dataDir, `${name}-result.json`),
      JSON.stringify(result, null, 2) + '\n',
    )
    assert.equal(result.status, 'ready', result.error)
    report.checks.push({
      name,
      status: result.status,
      toolchain: result.toolchain,
      sourceRevision: result.sourceRevision,
      buildStatus: result.setupBuildStatus,
      buildWarning: result.buildWarning || null,
      durationMs: Date.now() - started,
    })
    console.log(JSON.stringify(report.checks.at(-1)))
    return result
  }
  const valid = await prepare('valid-upload', { files: files() })
  assert.equal(valid.setupBuildStatus, 'passed')
  for (const file of files())
    assert.equal(
      await fs.readFile(path.join(valid.root, file.path), 'utf8'),
      file.content,
    )
  const proof = await runPinnedLake(
    runtime,
    valid.root,
    ['lake', 'env', 'lean', 'Main.lean'],
    { network: 'none', timeoutMs: 120000 },
  )
  assert.equal(proof.code, 0, proof.stderr + proof.stdout)
  const leanConfiguration =
    'import Lake\nopen Lake DSL\n\npackage SetupLeanFixture where\n  moreLeanArgs := #["-j2"]\n\n@[default_target] lean_lib Main\n'
  const leanFiles = [
    ...files().filter((file) => file.path !== 'lakefile.toml'),
    { path: 'lakefile.lean', content: leanConfiguration },
  ]
  const leanProject = await prepare('lean-config-upload', { files: leanFiles })
  assert.equal(leanProject.setupBuildStatus, 'passed')
  for (const file of leanFiles)
    assert.equal(
      await fs.readFile(path.join(leanProject.root, file.path), 'utf8'),
      file.content,
    )
  const unfinished = await prepare('unfinished-proof', {
    files: files('theorem unfinished : False := by\n  trivial\n'),
  })
  assert.equal(unfinished.setupBuildStatus, 'warnings')
  assert(unfinished.buildWarning)
  const repaired = await prepare('repair-fixture', {
    autoRepair: true,
    files: files(source, 'name = [ invalid toml\n'),
  })
  assert.equal(repaired.setupRepair?.status, 'completed')
  assert.equal(report.repairs, 1)
  assert.equal(
    await fs.readFile(path.join(repaired.root, 'Main.lean'), 'utf8'),
    source,
  )
  assert.equal(
    await fs.readFile(path.join(repaired.root, 'lean-toolchain'), 'utf8'),
    toolchain + '\n',
  )
  await store.prepare(valid.id, 'setup-fixture')
  await store.jobs.get(valid.id)
  assert.equal(store.get(valid.id, 'setup-fixture').status, 'ready')
  report.checks.push({ name: 'refresh-valid-upload', status: 'ready' })
  // A miniature dependency exercises actual native artifact writes through the
  // same read-only package overlay, without downloading a full Mathlib cache.
  const nativeCache = path.join(dataDir, 'native-dependency-cache')
  const mathlib = path.join(nativeCache, '.lake/packages/mathlib')
  await fs.mkdir(mathlib, { recursive: true })
  await fs.writeFile(path.join(mathlib, 'lean-toolchain'), toolchain + '\n')
  await fs.writeFile(
    path.join(mathlib, 'lakefile.toml'),
    'name = "mathlib"\ndefaultTargets = ["Mathlib"]\n[[lean_lib]]\nname = "Mathlib"\n',
  )
  await fs.writeFile(
    path.join(mathlib, 'Mathlib.lean'),
    'def nativeFixtureValue : Nat := 42\n',
  )
  const library = await runPinnedLake(
    runtime,
    mathlib,
    ['lake', 'build', 'Mathlib'],
    { network: 'none', timeoutMs: 120000 },
  )
  assert.equal(library.code, 0, library.stderr + library.stdout)
  const prepareShared = runtime.prepareSharedDependencies.bind(runtime)
  runtime.prepareSharedDependencies = async (root, options) =>
    options.configuration['lakefile.toml']?.includes('name = "NativeFixture"')
      ? { root: nativeCache, reused: true }
      : prepareShared(root, options)
  try {
    const nativeProject = await prepare('readonly-native-target', {
      files: [
        { path: 'lean-toolchain', content: toolchain + '\n' },
        {
          path: 'lakefile.toml',
          content:
            'name = "NativeFixture"\ndefaultTargets = ["native-demo"]\n[[require]]\nname = "mathlib"\npath = ".lake/packages/mathlib"\n[[lean_exe]]\nname = "native-demo"\nroot = "Main"\n',
        },
        {
          path: 'lake-manifest.json',
          content: JSON.stringify({
            version: '1.2.0',
            packagesDir: '.lake/packages',
            packages: [
              {
                type: 'path',
                name: 'mathlib',
                dir: './.lake/packages/mathlib',
                configFile: 'lakefile.toml',
                manifestFile: 'lake-manifest.json',
                inherited: false,
              },
            ],
            name: 'NativeFixture',
            lakeDir: '.lake',
            fixedToolchain: false,
          }),
        },
        {
          path: 'Main.lean',
          content:
            'import Mathlib\ndef main : IO Unit := IO.println nativeFixtureValue\n',
        },
      ],
    })
    assert.equal(nativeProject.setupBuildStatus, 'warnings')
    assert.match(nativeProject.buildWarning, /shared library cache/)
    const checked = await runPinnedLake(
      runtime,
      nativeProject.root,
      ['lake', 'env', 'lean', '--stdin'],
      {
        input: 'import Mathlib\nexample : nativeFixtureValue = 42 := by rfl\n',
        network: 'none',
        timeoutMs: 120000,
      },
    )
    assert.equal(checked.code, 0, checked.stderr + checked.stdout)
    report.checks.at(-1).libraryImportChecked = true
    assert.equal(
      report.repairs,
      1,
      'No configuration repair for a native-only target failure',
    )
  } finally {
    runtime.prepareSharedDependencies = prepareShared
  }
  if (values.repository) {
    const imported = await prepare('public-repository', {
      repository: values.repository,
    })
    const importedPin = await fs.readFile(
      path.join(imported.root, 'lean-toolchain'),
      'utf8',
    )
    assert.equal(importedPin.trim(), imported.toolchain)
    // Check the reported LeanTUI library separately from demo executable targets.
    if (new URL(imported.repository).pathname === '/lara/LeanTUI.git') {
      const checked = await runPinnedLake(
        runtime,
        imported.root,
        ['lake', 'env', 'lean', '--stdin'],
        {
          input: 'import LeanTui\nexample : True := by trivial\n',
          network: 'none',
          timeoutMs: 120000,
        },
      )
      assert.equal(checked.code, 0, checked.stderr + checked.stdout)
      report.checks.at(-1).libraryImportChecked = true
    }
    assert.equal(
      await fs.readFile(path.join(imported.root, 'lean-toolchain'), 'utf8'),
      importedPin,
    )
  }
  report.passed = true
} catch (error) {
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
  console.log(JSON.stringify(report, null, 2))
}
