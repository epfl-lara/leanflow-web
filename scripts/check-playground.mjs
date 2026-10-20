#!/usr/bin/env node
// Real prepared Mathlib check in temporary fixture workspaces. No provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Runtime } from '../server/runtime.mjs'
import { WorkspaceStore } from '../server/workspaces.mjs'

let dataDir = path.resolve(process.env.STUDIO_DATA_DIR || '.data')
const reportDir = path.resolve('.runtime/playground-real-check')
await fs.mkdir(reportDir, { recursive: true })
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  maxConcurrent: 1,
  maxQueue: 2,
  memory: process.env.STUDIO_WORKER_MEMORY || '4g',
})
const report = { providerCalls: 0, checks: [], readyTimesMs: [] }
let store, fixtureDir
const projects = []
try {
  const info = await runtime.init()
  assert.equal(info.ready, true, info.error)
  dataDir = runtime.dataDir
  await runtime.preparePresetEnvironment('mathlib')
  const template = runtime.templateRoot('mathlib')
  const templateSource = await fs.readFile(
    path.join(template, 'Main.lean'),
    'utf8',
  )
  fixtureDir = await fs.mkdtemp(path.join(dataDir, 'runtime/playground-smoke-'))
  store = await new WorkspaceStore({ dataDir: fixtureDir, runtime }).init()
  const calls = []
  const run = runtime.run.bind(runtime)
  runtime.run = async (root, args, options) => {
    calls.push({ root, args })
    return run(root, args, options)
  }
  for (const owner of ['fixture-alice', 'fixture-alice', 'fixture-bob']) {
    const start = performance.now()
    const project = await store.create(owner, { kind: 'single-file' })
    report.readyTimesMs.push(Math.round(performance.now() - start))
    assert.equal(project.status, 'ready', project.error)
    assert.equal(runtime.dependencyRoot(project.root), template)
    projects.push(project)
  }
  assert.deepEqual(
    projects.map((project) => project.name),
    ['Scratch.lean', 'Scratch2.lean', 'Scratch.lean'],
  )
  assert.equal(
    calls.some((call) => call.args[0] === 'lake'),
    false,
  )
  report.checks.push(
    'Private playgrounds return ready using the same read-only Mathlib dependencies, with no per-file Lean setup commands',
  )
  const project = projects[0]
  const source = await store.readFile(project.id, project.owner, 'Main.lean')
  const proof = 'import Mathlib\nexample (n : ℕ) : n = n := by rfl\n'
  await store.writeFile(
    project.id,
    project.owner,
    'Main.lean',
    proof,
    source.hash,
  )
  const verified = await runtime.run(
    project.root,
    ['lake', 'env', 'lean', 'Main.lean'],
    { network: 'none', timeoutMs: 120000 },
  )
  assert.equal(verified.code, 0, verified.stderr + verified.stdout)
  await store.rename(project.id, project.owner, { name: 'Natural numbers' })
  const receipt = await store.trash(project.id, project.owner)
  await store.restore(receipt.trashId, project.owner)
  assert.equal(
    (await store.readFile(project.id, project.owner, 'Main.lean')).content,
    proof,
  )
  assert.equal(store.get(project.id, project.owner).name, 'Natural numbers')
  assert.equal(
    await fs.readFile(path.join(template, 'Main.lean'), 'utf8'),
    templateSource,
  )
  report.checks.push(
    'A real Lean proof compiles in the cached private environment; rename and delete/restore preserve it and leave the shared template unchanged',
  )
  report.passed = true
} catch (error) {
  report.failure = error.stack
  throw error
} finally {
  await runtime.shutdown()
  if (store) {
    await Promise.all([...store.jobs.values()])
    for (const project of projects) {
      await runtime.clearInheritedDependencies(project.root, { force: true })
      await fs.rm(
        path.join(
          dataDir,
          'runtime/homes',
          createHash('sha256').update(project.root).digest('hex'),
        ),
        { recursive: true, force: true },
      )
    }
    store.close()
  }
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true })
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report))
