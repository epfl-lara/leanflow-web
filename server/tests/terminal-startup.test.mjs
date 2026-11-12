import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'
import { Terminals } from '../terminals.mjs'
import { WorkspaceStore } from '../workspaces.mjs'

function socket() {
  const ws = new EventEmitter()
  Object.assign(ws, { readyState: 1, send() {}, ping() {} })
  ws.close = ws.terminate = () => {
    if (ws.readyState === 3) return
    ws.readyState = 3
    ws.emit('close')
  }
  return ws
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('The terminal fixture did not reach the expected state.')
}

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Terminal stop did not finish promptly.')),
          1000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-terminal-startup-'),
  )
  const runtime = {
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    async run(root, args) {
      if (args[0] === 'lake' && args.includes('update')) {
        await fs.mkdir(path.join(root, '.lake'), { recursive: true })
        await fs.writeFile(
          path.join(root, 'lake-manifest.json'),
          '{"packages":[]}',
        )
      }
      return { code: 0, stdout: 'Lean version 4.34.1\n', stderr: '' }
    },
  }
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  const cleanup = []
  t.after(async () => {
    for (const action of cleanup) await action()
    await Promise.allSettled([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const initial = await store.create('alice', { preset: 'lean' })
  await store.jobs.get(initial.id)
  return {
    dataDir,
    store,
    runtime,
    cleanup,
    project: store.get(initial.id, 'alice'),
  }
}

test('closing terminal startup cancels its queued Git lookup without stopping an active editor', async (t) => {
  const f = await fixture(t)
  const docker = path.join(f.dataDir, 'docker-fixture')
  await fs.writeFile(
    docker,
    `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === 'run') {
  if (args.includes('hold-editor')) {
    console.log('Editor ready')
    setInterval(() => {}, 1000)
  } else console.log('a'.repeat(40))
}
`,
    { mode: 0o700 },
  )
  const runtime = new Runtime({ dataDir: f.dataDir, docker, maxConcurrent: 1 })
  await fs.mkdir(runtime.runtimeDir, { recursive: true })
  const editorRoot = path.join(f.dataDir, 'other-project')
  await fs.mkdir(editorRoot)
  await fs.mkdir(path.join(f.project.root, '.git'))
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  f.store.runtime = runtime
  const terminals = new Terminals({
    runtime,
    workspaces: f.store,
    capacity: {},
  })
  f.cleanup.push(async () => {
    await runtime.stopProject(f.project.root)
    await runtime.stopProject(editorRoot)
    await terminals.close()
    await runtime.shutdown()
  })
  let ready
  const started = new Promise((resolve) => (ready = resolve))
  const editor = runtime.run(editorRoot, ['hold-editor'], { onOutput: ready })
  await started
  terminals.connect(socket(), f.project, 'alice')
  await until(() => runtime.info().queued === 1)
  await bounded(terminals.closeProject(f.project.id, 'alice'))
  assert.equal(runtime.info().queued, 0)
  assert.equal(terminals.sessions.size, 0)
  assert.equal(f.store.terminalCopies.size, 0)
  assert.deepEqual(await fs.readdir(f.store.snapshotsDir), [])
  assert.equal(runtime.children.size, 1)
  assert.equal([...runtime.children][0].cancelled, undefined)
  assert.doesNotThrow(() => terminals.assertIdle(f.project.id))
  await runtime.stopProject(editorRoot)
  await editor
})

test('terminal stop retries failed startup cleanup and preserves other live tabs until it succeeds', async (t) => {
  const f = await fixture(t)
  const dependencies = new Runtime({ dataDir: f.dataDir })
  await fs.mkdir(dependencies.runtimeDir, { recursive: true })
  await fs.mkdir(path.join(f.project.root, '.lake/packages/local'), {
    recursive: true,
  })
  f.runtime.inheritDependencies =
    dependencies.inheritDependencies.bind(dependencies)
  let releaseCleanup
  const cleanupReady = new Promise((resolve) => (releaseCleanup = resolve))
  let cleanupCalls = 0
  f.runtime.clearInheritedDependencies = async (...args) => {
    if (++cleanupCalls === 1) throw new Error('Transient registry failure')
    await cleanupReady
    return dependencies.clearInheritedDependencies(...args)
  }
  f.runtime.spawn = () => {
    throw Object.assign(new Error('All workspace workers are busy.'), {
      status: 503,
    })
  }
  const terminals = new Terminals({
    runtime: f.runtime,
    workspaces: f.store,
    capacity: {},
  })
  f.cleanup.push(async () => {
    releaseCleanup()
    await terminals.closeProject(f.project.id, 'alice')
    await terminals.close()
  })
  const openingId = '11111111-1111-4111-8111-111111111111'
  terminals.connect(socket(), f.project, 'alice', undefined, { openingId })
  const session = [...terminals.sessions][0]
  await assert.rejects(session.startup, { status: 503 })
  assert.equal(
    dependencies.dependencyRoot(session.snapshot.root),
    f.project.root,
  )
  assert.throws(() => terminals.assertIdle(f.project.id), { status: 409 })
  const otherTab = {
    ws: socket(),
    projectId: f.project.id,
    actor: 'alice',
    openingId: '22222222-2222-4222-8222-222222222222',
  }
  const otherActor = { ws: socket(), projectId: f.project.id, actor: 'bob' }
  const otherProject = { ws: socket(), projectId: 'other', actor: 'alice' }
  for (const live of [otherTab, otherActor, otherProject])
    terminals.sessions.add(live)
  f.cleanup.unshift(() => {
    for (const live of [otherTab, otherActor, otherProject])
      terminals.sessions.delete(live)
  })
  const stopped = Promise.all([
    terminals.closeProject(f.project.id, 'alice', { openingId }),
    terminals.closeProject(f.project.id, 'alice', { openingId }),
  ])
  await until(() => cleanupCalls === 2)
  assert.equal(terminals.sessions.has(session), true)
  await assert.rejects(
    f.store.terminalRecovery(f.project.id, 'alice', session.snapshot.runId),
    { status: 409 },
  )
  releaseCleanup()
  await bounded(stopped)
  assert.equal(cleanupCalls, 2)
  assert.equal(terminals.sessions.has(session), false)
  assert.equal(f.store.terminalCopies.size, 0)
  const bindings = JSON.parse(
    await fs.readFile(
      path.join(dependencies.runtimeDir, 'dependencies.json'),
      'utf8',
    ),
  )
  assert.equal(bindings[session.snapshot.root], undefined)
  assert.deepEqual(await fs.readdir(f.store.snapshotsDir), [])
  for (const live of [otherTab, otherActor, otherProject]) {
    assert.equal(terminals.sessions.has(live), true)
    assert.equal(live.ws.readyState, 1)
  }
})
