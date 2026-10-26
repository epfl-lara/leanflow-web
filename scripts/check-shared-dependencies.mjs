#!/usr/bin/env node
// Offline Docker smoke: a small compiled Mathlib fixture replaces downloads.
// No user project, provider call, or production registry is touched.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Runtime } from '../server/runtime.mjs'
import { dependencyBuildCommand } from '../server/project-libraries.mjs'

const execute = promisify(execFile)
const reportDir = path.resolve('.runtime/shared-dependency-check')
const dataDir = path.join(reportDir, randomUUID())
const runtime = new Runtime({
  dataDir,
  image:
    process.env.LEAN_PROBE_TEST_IMAGE || 'lemex-web-worker:lean-probe-646cb0ee',
  scope: 'helper',
  maxConcurrent: 1,
  cpus: 1,
  memory: '2g',
  ...(process.env.LEAN_TEST_TOOLCHAIN_DIR
    ? { hostToolchainDir: process.env.LEAN_TEST_TOOLCHAIN_DIR }
    : {}),
})
const toolchain = process.env.LEAN_TEST_TOOLCHAIN || 'leanprover/lean4:v4.34.1'
const report = {
  providerCalls: 0,
  network: 'none',
  fixtureCacheDownload: true,
  checks: {},
}
const source = path.join(dataDir, 'upstream-fixture')
await fs.mkdir(source, { recursive: true })
await fs.writeFile(path.join(source, 'lean-toolchain'), toolchain + '\n')
await fs.writeFile(
  path.join(source, 'lakefile.toml'),
  'name = "mathlib"\ndefaultTargets = ["Mathlib"]\n\n[[lean_lib]]\nname = "Mathlib"\n',
)
await fs.writeFile(
  path.join(source, 'lake-manifest.json'),
  JSON.stringify({
    version: '1.2.0',
    name: 'mathlib',
    packagesDir: '.lake/packages',
    packages: [],
  }),
)
await fs.writeFile(
  path.join(source, 'Mathlib.lean'),
  'import Lean\ndef shared_fixture_value : Nat := 42\n',
)
await fs.writeFile(path.join(source, '.gitignore'), '.lake/\n')
const git = (args) =>
  execute('git', ['-c', 'core.hooksPath=/dev/null', '-C', source, ...args])
await git(['init', '-b', 'main'])
await git(['add', '.'])
await git([
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-m',
  'Offline dependency fixture',
])
const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim()
const emptySource = path.join(dataDir, 'empty-fixture')
await fs.mkdir(emptySource, { recursive: true })
await fs.writeFile(path.join(emptySource, 'lean-toolchain'), toolchain + '\n')
await fs.writeFile(
  path.join(emptySource, 'lakefile.toml'),
  'name = "empty-dependency"\n\n[[lean_lib]]\nname = "Unused"\n',
)
await fs.writeFile(
  path.join(emptySource, 'Unused.lean'),
  'invalid proof source\n',
)
await execute('git', ['-C', emptySource, 'init', '-b', 'main'])
await execute('git', ['-C', emptySource, 'add', '.'])
await execute('git', [
  '-c',
  'core.hooksPath=/dev/null',
  '-C',
  emptySource,
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-m',
  'Escaped package without default targets',
])
const emptyRevision = (
  await execute('git', ['-C', emptySource, 'rev-parse', 'HEAD'])
).stdout.trim()
const demoSource = path.join(dataDir, 'demo-fixture')
await fs.cp(emptySource, demoSource, { recursive: true })
await fs.rm(path.join(demoSource, 'lakefile.toml'))
await fs.writeFile(
  path.join(demoSource, 'lakefile.lean'),
  'import Lake\nopen Lake DSL\npackage «demo-dependency»\n@[default_target]\nlean_exe demo where\n  root := `Unused\n',
)
await execute('git', ['-C', demoSource, 'add', '-A'])
await execute('git', [
  '-c',
  'core.hooksPath=/dev/null',
  '-C',
  demoSource,
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-m',
  'Dependency with an unusable standalone demo',
])
const demoRevision = (
  await execute('git', ['-C', demoSource, 'rev-parse', 'HEAD'])
).stdout.trim()
const configuration = {
  'lean-toolchain': toolchain + '\n',
  'lakefile.toml': `name = "First"\ndefaultTargets = ["Main"]\n\n[[lean_lib]]\nname = "Main"\n\n[[require]]\nname = "mathlib"\ngit = "https://github.com/leanprover-community/mathlib4"\nrev = "${revision}"\n\n[[require]]\nname = "empty-dependency"\ngit = "https://github.com/example/empty-dependency"\nrev = "${emptyRevision}"\n`,
  'lake-manifest.json': JSON.stringify({
    version: '1.2.0',
    name: 'First',
    lakeDir: '.lake',
    packagesDir: '.lake/packages',
    packages: [
      {
        name: 'mathlib',
        type: 'git',
        url: 'https://github.com/leanprover-community/mathlib4',
        rev: revision,
        inputRev: revision,
        inherited: false,
        subDir: null,
        configFile: 'lakefile.toml',
        manifestFile: 'lake-manifest.json',
      },
      {
        name: '«empty-dependency»',
        type: 'git',
        url: 'https://github.com/example/empty-dependency',
        rev: emptyRevision,
        inputRev: emptyRevision,
        inherited: false,
        subDir: null,
        configFile: 'lakefile.toml',
        manifestFile: 'lake-manifest.json',
      },
      {
        name: '«demo-dependency»',
        type: 'git',
        url: 'https://github.com/example/demo-dependency',
        rev: demoRevision,
        inputRev: demoRevision,
        inherited: false,
        subDir: null,
        configFile: 'lakefile.lean',
        manifestFile: 'lake-manifest.json',
      },
    ],
  }),
}
configuration['lakefile.toml'] +=
  `\n[[require]]\nname = "demo-dependency"\ngit = "https://github.com/example/demo-dependency"\nrev = "${demoRevision}"\n`
const realRun = runtime.run.bind(runtime)
let downloads = 0
let removedHash = false
let readOnlyFailures = 0
let recoveryBuilds = 0
try {
  assert.equal((await runtime.init()).ready, true, runtime.error)
  await runtime.prepareToolchain(toolchain)
  runtime.run = async (root, args, options) => {
    const command = args.filter((arg) => arg !== '--keep-toolchain').join(' ')
    if (root.includes('/shared-dependency-stages/')) {
      if (command === 'lake env lean --version') {
        await fs.mkdir(path.join(root, '.lake/packages'), { recursive: true })
        await fs.cp(source, path.join(root, '.lake/packages/mathlib'), {
          recursive: true,
        })
        await fs.cp(
          emptySource,
          path.join(root, '.lake/packages/empty-dependency'),
          {
            recursive: true,
          },
        )
        await fs.cp(
          demoSource,
          path.join(root, '.lake/packages/demo-dependency'),
          { recursive: true },
        )
      }
      if (command === 'lake exe cache get') {
        downloads++
        // Compile the fixture instead of downloading real Mathlib artifacts.
        return realRun(root, dependencyBuildCommand('@mathlib'), {
          ...options,
          network: 'none',
        })
      }
      if (args.includes('build') && options.readOnlyWorkspace && !removedHash) {
        // Reproduce the production failure with a real Lake replay, after the
        // initial writable build succeeded and before certification.
        await fs.unlink(
          path.join(
            root,
            '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean.hash',
          ),
        )
        removedHash = true
      } else if (
        removedHash &&
        args.includes('@mathlib:extraDep') &&
        !options.readOnlyWorkspace
      ) {
        recoveryBuilds++
      }
    }
    const result = await realRun(root, args, { ...options, network: 'none' })
    if (options.readOnlyWorkspace && result.code !== 0) {
      assert.match(result.stderr + result.stdout, /read.only file system/i)
      readOnlyFailures++
    }
    return result
  }
  const roots = ['first', 'second'].map((name) => path.join(dataDir, name))
  let shared
  for (const root of roots) {
    await fs.mkdir(root, { recursive: true })
    for (const [name, content] of Object.entries(configuration))
      await fs.writeFile(path.join(root, name), content)
    await fs.writeFile(
      path.join(root, 'Main.lean'),
      'import Mathlib\nexample : shared_fixture_value = 42 := rfl\n',
    )
    const prepared = await runtime.prepareSharedDependencies(root, {
      owner: 'fixture',
      toolchain,
      configuration,
      validateRepository: async () => {},
    })
    assert(prepared)
    if (shared) {
      assert.equal(prepared.root, shared.root)
      assert(prepared.reused)
    }
    shared = prepared
    await runtime.inheritDependencies(shared.root, root)
    const build = await runtime.run(root, ['lake', 'build'], {
      cleanHome: true,
      readOnlyWorkspace: true,
      writeLakeCache: true,
      timeoutMs: 120000,
    })
    assert.equal(build.code, 0, build.stderr + build.stdout)
    assert(
      (
        await fs.stat(path.join(root, '.lake/build/lib/lean/Main.olean'))
      ).isFile(),
    )
    assert.deepEqual(await fs.readdir(path.join(root, '.lake/packages')), [])
    const proof = await runtime.run(
      root,
      ['lake', 'env', 'lean', 'Main.lean'],
      {
        cleanHome: true,
        readOnlyWorkspace: true,
        writeLakeCache: true,
        timeoutMs: 60000,
      },
    )
    assert.equal(proof.code, 0, proof.stderr + proof.stdout)
  }
  assert.equal(downloads, 1)
  assert.equal(removedHash, true)
  assert.equal(readOnlyFailures, 1)
  assert.equal(recoveryBuilds, 1)
  const denied = await runtime.run(
    roots[0],
    [
      'python3',
      '-c',
      `from pathlib import Path
for target in ('/workspace/.lake/packages/mathlib/Mathlib.lean', '/workspace/.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean'):
    try:
        Path(target).write_text('MUTATED')
    except OSError:
        continue
    raise RuntimeError('Shared dependency was writable')
assert not Path(${JSON.stringify(path.join(roots[1], 'Main.lean'))}).exists()
assert not Path('/home/worker/.lemex/config.toml').exists()
print('readonly and isolated')`,
    ],
    { cleanHome: true, timeoutMs: 30000 },
  )
  assert.equal(denied.code, 0, denied.stderr + denied.stdout)
  report.checks = {
    compiledImport: true,
    projectBuildsPrivate: true,
    packageTreesNotCopied: true,
    sharedWritesDenied: true,
    siblingProjectHidden: true,
    cleanWorkerHome: true,
    missingHashRecovered: true,
    boundedArtifactRebuild: true,
    escapedPackageWithoutDefaults: true,
    standaloneDependencyDemosExcluded: true,
    downloads,
  }
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack
  process.exitCode = 1
} finally {
  runtime.run = realRun
  await runtime.shutdown()
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report))
}
