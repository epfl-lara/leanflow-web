import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventStore, JobManager } from '../events.mjs'
import { createStudio } from '../studio.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-shutdown-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('check shutdown stops new checks and waits for every pending task', async t => {
  const root = await directory(t), events = new EventStore(root)
  t.after(() => events.close())
  const gate = deferred(), started = deferred()
  const jobs = new JobManager({ events,
    workspaces: { get: () => ({ root: '/project', status: 'ready' }) },
    runtime: { async run() { started.resolve(); return gate.promise } },
  })
  const job = jobs.check('owner', 'project')
  await started.promise
  const stopping = jobs.shutdown()
  assert.equal(jobs.shutdown(), stopping)
  assert.throws(() => jobs.check('owner', 'project'), { status: 503 })
  assert.equal(jobs.active.size, 1)
  let finished = false
  stopping.then(() => { finished = true })
  await new Promise(setImmediate)
  assert.equal(finished, false)
  gate.resolve({ code: 0, stdout: 'checked', stderr: '' })
  await stopping
  assert.equal(events.get(job.id, 'owner').status, 'completed')
  assert.equal(jobs.active.size, 0)
});

test('studio closes its listener early and waits for an in-flight check before closing SQLite', async t => {
  const root = await directory(t), gate = deferred(), started = deferred()
  let runtimeStopped = false
  const runtime = {
    init: async () => {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    spawn: () => { throw new Error('This test never starts an LSP process') },
    async run(projectRoot, args) {
      if (args[0] === 'git' && args.includes('init')) await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true })
      if (args[0] === 'git' && args.includes('rev-parse')) return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'lake' && args[1] === 'update') {
        await fs.mkdir(path.join(projectRoot, '.lake'), { recursive: true })
        await fs.writeFile(path.join(projectRoot, 'lake-manifest.json'), '{"packages":[]}')
      }
      if (args[0] === 'lake' && args[1] === 'build') { started.resolve(); return gate.promise }
      return { code: 0, stdout: '', stderr: '' }
    },
    async shutdown() { runtimeStopped = true },
  }
  const config = { defaultModel: 'test', models: [{ id: 'test' }], provider: {}, lemex: {}, redact: String }
  const studio = await createStudio({ dataDir: root, runtime, config })
  t.after(() => studio.close())
  await new Promise(resolve => studio.server.listen(0, '127.0.0.1', resolve))
  const project = await studio.workspaces.create('owner', { preset: 'lean' })
  await studio.workspaces.jobs.get(project.id)
  const token = (await fs.readFile(path.join(root, 'auth', 'owner.token'), 'utf8')).trim()
  const url = `http://127.0.0.1:${studio.server.address().port}`
  const checked = await fetch(`${url}/api/projects/${project.id}/check`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'Main.lean' }),
  })
  assert.equal(checked.status, 202)
  const job = await checked.json()
  await started.promise
  let databaseClosed = false, updatesAfterClose = 0, closeFinished = false
  const originalUpdate = studio.events.update.bind(studio.events), originalClose = studio.events.close.bind(studio.events)
  studio.events.update = (...args) => { if (databaseClosed) updatesAfterClose++; return originalUpdate(...args) }
  studio.events.close = () => { databaseClosed = true; originalClose() }
  const closing = studio.close()
  assert.equal(studio.close(), closing)
  closing.then(() => { closeFinished = true })
  await new Promise(setImmediate)
  assert.equal(studio.server.listening, false)
  assert.equal(runtimeStopped, true)
  assert.equal(closeFinished, false)
  assert.equal(databaseClosed, false)
  assert.equal(studio.events.get(job.id, 'owner').status, 'running')
  gate.resolve({ code: 0, stdout: 'build done', stderr: '' })
  await closing
  assert.equal(databaseClosed, true)
  assert.equal(updatesAfterClose, 0)
  const persisted = new EventStore(root)
  try { assert.equal(persisted.get(job.id, 'owner').status, 'completed') } finally { persisted.close() }
});
