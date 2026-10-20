#!/usr/bin/env node
// Real preset setup and offline imports in disposable workspaces; no model calls.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'

let dataDir = path.resolve(process.env.STUDIO_DATA_DIR || '.data')
const reportDir = path.resolve('.runtime/prepared-library-check')
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  maxConcurrent: 1,
  maxQueue: 2,
  memory: process.env.STUDIO_WORKER_MEMORY || '6g',
  cpus: 2,
})
const report = { providerCalls: 0, libraries: [] }
const projects = []
let store, fixtureDir, shutdown
const shutDown = () => (shutdown ||= runtime.shutdown())
const stop = () => {
  process.exitCode = 130
  void shutDown().catch(() => {})
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
await fs.mkdir(reportDir, { recursive: true })
try {
  const info = await runtime.init()
  assert.equal(info.ready, true, info.error)
  dataDir = runtime.dataDir
  const definitions = runtime.templates()
  const selected = process.argv.slice(2)
  const ids = selected.length
    ? selected
    : ['lean', 'mathlib', 'cslib', 'physlib']
  for (const id of ids) {
    const definition = definitions.find((item) => item.id === id)
    assert(definition?.ready, `Prepare ${id} before running this check`)
  }
  fixtureDir = await fs.mkdtemp(path.join(dataDir, 'runtime/library-smoke-'))
  store = await new WorkspaceStore({ dataDir: fixtureDir, runtime }).init()
  for (const id of ids) {
    const definition = definitions.find((item) => item.id === id)
    const template = runtime.templateRoot(id)
    const templateSource = await fs.readFile(path.join(template, 'Main.lean'))
    const result = { id, toolchain: definition.toolchain, readyTimesMs: [] }
    for (let index = 0; index < 2; index++) {
      assert(!runtime.stopping, 'Verification stopped')
      const started = performance.now()
      const created = await store.create('library-smoke', {
        name: `Library check ${id} ${index + 1}`,
        preset: id,
        autoRepair: false,
      })
      projects.push(created)
      await store.jobs.get(created.id)
      const project = store.get(created.id, 'library-smoke')
      assert.equal(project.status, 'ready', project.error)
      assert.equal(project.toolchain, definition.toolchain)
      if (definition.repository)
        assert.equal(runtime.dependencyRoot(project.root), template)
      result.readyTimesMs.push(Math.round(performance.now() - started))
      const compiled = await runtime.run(
        project.root,
        ['lake', 'env', 'lean', 'Main.lean'],
        {
          network: 'none',
          readOnlyWorkspace: true,
          writeLakeCache: true,
          timeoutMs: 180000,
        },
      )
      assert.equal(compiled.code, 0, compiled.stderr || compiled.stdout)
      assert.deepEqual(
        await fs.readdir(path.join(project.root, '.lake/packages')),
        [],
      )
    }
    assert.deepEqual(
      await fs.readFile(path.join(template, 'Main.lean')),
      templateSource,
    )
    result.offlineImports = true
    result.cache = definition.repository
      ? 'shared-pinned-libraries'
      : 'installed-toolchain'
    result.templateSourceUnchanged = true
    report.libraries.push(result)
    console.log(JSON.stringify(result))
  }
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.message
  process.exitCode = process.exitCode || 1
} finally {
  try {
    await shutDown()
  } catch (error) {
    report.passed = false
    report.error = error.message
    process.exitCode = process.exitCode || 1
  }
  if (store) {
    await Promise.allSettled([...store.jobs.values()])
    for (const project of projects) {
      await runtime.clearInheritedDependencies(project.root, { force: true })
      const home = createHash('sha256').update(project.root).digest('hex')
      await fs.rm(path.join(dataDir, 'runtime/homes', home), {
        recursive: true,
        force: true,
      })
    }
    store.close()
  }
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true })
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
}
console.log(JSON.stringify(report))
