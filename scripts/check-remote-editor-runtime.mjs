#!/usr/bin/env node
// Opt-in, actual pinned Lean through the remote streaming adapters. No user
// projects, provider keys or inference. It does not enroll a worker or restart a service.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import { editorConformance } from '../server/cluster/editor-conformance.mjs'
import { removeDisposableTree } from '../server/temporary-workspaces.mjs'
import { clusterEditorRuntime } from './lib/remote-editor-runtime.mjs'

assert.equal(
  process.env.STUDIO_ALLOW_RUNTIME_CHECKS,
  '1',
  'Set STUDIO_ALLOW_RUNTIME_CHECKS=1 on an idle test host.',
)
const directory =
  process.env.STUDIO_TEST_CLUSTER_EDITOR === '1'
    ? await fs.realpath(
        await fs.mkdtemp(
          path.join(
            process.env.STUDIO_TEST_RUNTIME_TMPDIR || os.tmpdir(),
            'leanflow-editor-',
          ),
        ),
      )
    : path.resolve('.runtime/remote-editor-runtime', randomUUID())
const root = path.join(directory, 'project')
const toolchain =
  process.env.STUDIO_TEST_TOOLCHAIN || 'leanprover/lean4:v4.35.0'
const report = { passed: false, providerCalls: 0, toolchain }
const editorCpus = Number(process.env.STUDIO_TEST_EDITOR_CPUS || 2)
assert(Number.isFinite(editorCpus) && editorCpus > 0 && editorCpus <= 2)
const runtime = new Runtime({
  dataDir: directory,
  image: process.env.STUDIO_TEST_WORKER_IMAGE,
  hostToolchainDir: process.env.STUDIO_TEST_TOOLCHAIN_DIR,
  scope: 'helper',
  cpus: 2,
  memory: '1g',
  editorMemory: '3g',
  editorCpus,
  memoryBudget: '6g',
  maxConcurrent: 3,
  batchReserved: 1,
  batchMemoryReserved: '1g',
})
try {
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  assert((await runtime.init()).ready)
  await runtime.prepareToolchain(toolchain)
  await fs.writeFile(path.join(root, 'lean-toolchain'), toolchain + '\n')
  await fs.writeFile(
    path.join(root, 'lakefile.toml'),
    'name = "RemoteEditorFixture"\n[[lean_lib]]\nname = "Main"\n',
  )
  await fs.writeFile(
    path.join(root, 'lake-manifest.json'),
    JSON.stringify({
      version: '1.1.0',
      packagesDir: '.lake/packages',
      packages: [],
      name: 'RemoteEditorFixture',
      lakeDir: '.lake',
    }),
  )
  const publicEnvironment = process.env.STUDIO_TEST_PUBLIC_ENVIRONMENT
  if (publicEnvironment) {
    assert.equal(await fs.realpath(publicEnvironment), publicEnvironment)
    assert.equal(
      (
        await fs.readFile(
          path.join(publicEnvironment, 'lean-toolchain'),
          'utf8',
        )
      ).trim(),
      toolchain,
    )
    for (const filename of [
      'lean-toolchain',
      'lakefile.toml',
      'lakefile.lean',
      'lake-manifest.json',
    ]) {
      const source = path.join(publicEnvironment, filename)
      const stat = await fs.lstat(source).catch((error) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (!stat) {
        await fs.rm(path.join(root, filename), { force: true })
        continue
      }
      assert(
        stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 ** 2,
      )
      await fs.copyFile(source, path.join(root, filename))
    }
    // Keep Runtime's owned-root containment intact. A test uses its own copy;
    // COPYFILE_FICLONE shares blocks when supported and otherwise copies bytes.
    const environment = path.join(directory, 'public-environment')
    await fs.mkdir(environment, { mode: 0o700 })
    for (const filename of [
      'lean-toolchain',
      'lakefile.toml',
      'lakefile.lean',
      'lake-manifest.json',
    ]) {
      await fs
        .copyFile(path.join(root, filename), path.join(environment, filename))
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
    }
    await fs.cp(
      path.join(publicEnvironment, '.lake/packages'),
      path.join(environment, '.lake/packages'),
      {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      },
    )
    await runtime.inheritDependencies(environment, root)
    report.publicEnvironment = true
  }
  report.image = runtime.info().imageId
  report.editorCpus = editorCpus
  report.checks = await editorConformance(runtime, root, {
    network: 'none',
    timeoutMs: 180000,
    readOnlyWorkspace: true,
    writeLakeCache: true,
    freshHome: true,
    cleanHome: true,
    boundedScratchBytes: 256 * 1024 ** 2,
    ...(publicEnvironment ? { prelude: 'import Mathlib\n' } : {}),
  })
  assert.equal(runtime.info().usedSlots, 0)
  if (process.env.STUDIO_TEST_CLUSTER_EDITOR === '1') {
    assert(
      !publicEnvironment,
      'The loopback launch-contract check uses the small Lean fixture.',
    )
    await fs.writeFile(
      path.join(root, 'Main.lean'),
      '#eval IO.println "NO_POST_CHECK_ALLOWED"\nexample : True := by trivial\n',
    )
    report.cluster = await clusterEditorRuntime(
      runtime,
      directory,
      root,
      toolchain,
    )
  }
  report.passed = true
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  await runtime.shutdown()
  await removeDisposableTree(directory)
  console.log(JSON.stringify(report, null, 2))
}
