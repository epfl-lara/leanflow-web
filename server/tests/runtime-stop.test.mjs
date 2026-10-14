import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForFile(filename) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await fs.stat(filename)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Fixture worker did not request cleanup.')
}

async function fixture(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-worker-stop-'),
  )
  const dataDir = path.join(directory, 'data'),
    root = path.join(dataDir, 'project')
  const started = path.join(directory, 'removing'),
    released = path.join(directory, 'release'),
    failed = path.join(directory, 'fail')
  const lock = path.join(directory, 'cleanup-lock')
  const docker = path.join(directory, 'docker-fixture')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.join(dataDir, 'runtime'))
  await fs.writeFile(
    docker,
    `#!${process.execPath}
import fs from 'node:fs'
const command = process.argv[2]
if (command === 'run') { console.log('started'); setInterval(() => {}, 1000) }
if (command === 'rm') {
  fs.writeFileSync(${JSON.stringify(started)}, 'cleanup requested')
  if (fs.existsSync(${JSON.stringify(failed)})) { console.error('fixture cleanup unavailable'); process.exit(1) }
  try { fs.closeSync(fs.openSync(${JSON.stringify(lock)}, 'wx')) } catch { console.error('fixture removal already in progress'); process.exit(1) }
  const check = () => { if (fs.existsSync(${JSON.stringify(released)})) { fs.unlinkSync(${JSON.stringify(lock)}); process.exit(0) } }
  check(); setInterval(check, 10)
}
`,
    { mode: 0o700 },
  )
  const runtime = new Runtime({ dataDir, docker, maxConcurrent: 1 })
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  t.after(async () => {
    await fs.rm(failed, { force: true })
    await fs.writeFile(released, 'release cleanup')
    await runtime.shutdown()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { runtime, root, started, released, failed }
}

test('cancelled work and its capacity remain active until the worker is removed', async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    running = deferred()
  let finished = false
  const task = f.runtime
    .run(f.root, ['fixture'], {
      signal: controller.signal,
      onOutput: () => running.resolve(),
    })
    .then((result) => {
      finished = true
      return result
    })
  await running.promise
  controller.abort()
  await waitForFile(f.started)
  assert.equal(finished, false)
  assert.equal(f.runtime.children.size, 1)
  await fs.writeFile(f.released, 'cleanup is complete')
  assert.equal((await task).cancelled, true)
  assert.equal(f.runtime.children.size, 0)
})

test('a cleanup failure retains the worker for a safe project-stop retry', async (t) => {
  const f = await fixture(t),
    controller = new AbortController(),
    running = deferred()
  await fs.writeFile(f.failed, 'reject cleanup')
  const task = f.runtime.run(f.root, ['fixture'], {
    signal: controller.signal,
    onOutput: () => running.resolve(),
  })
  await running.promise
  controller.abort()
  await assert.rejects(task, { status: 503, workerCleanup: true })
  assert.equal(f.runtime.children.size, 1)
  await fs.rm(f.failed)
  await fs.writeFile(f.released, 'retry cleanup')
  await f.runtime.stopProject(f.root)
  assert.equal(f.runtime.children.size, 0)
})

test('cancelling a queued worker removes it without interrupting the active worker', async (t) => {
  const f = await fixture(t),
    running = deferred(),
    controller = new AbortController()
  const task = f.runtime.run(f.root, ['fixture'], {
    onOutput: () => running.resolve(),
  })
  await running.promise
  const queued = f.runtime.run(f.root, ['queued'], {
    signal: controller.signal,
  })
  assert.equal(f.runtime.queue.length, 1)
  controller.abort(new Error('Queued check stopped.'))
  await assert.rejects(queued, /Queued check stopped/)
  assert.equal(f.runtime.queue.length, 0)
  assert.equal(f.runtime.children.size, 1)
  await fs.writeFile(f.released, 'release active cleanup')
  await f.runtime.stopProject(f.root)
  assert.equal((await task).cancelled, true)
})

test('concurrent project-stop requests share cleanup instead of racing container removal', async (t) => {
  const f = await fixture(t),
    running = deferred()
  const task = f.runtime.run(f.root, ['fixture'], {
    onOutput: () => running.resolve(),
  })
  await running.promise
  const stops = [f.runtime.stopProject(f.root), f.runtime.stopProject(f.root)]
  await waitForFile(f.started)
  await fs.writeFile(f.released, 'release shared cleanup')
  await Promise.all(stops)
  assert.equal((await task).cancelled, true)
  assert.equal(f.runtime.children.size, 0)
})

test('project stop removes its queued workers and preserves an unrelated worker and queue', async (t) => {
  const f = await fixture(t),
    running = deferred()
  const otherRoot = path.join(path.dirname(f.root), 'other-project')
  await fs.mkdir(otherRoot)
  const task = f.runtime.run(otherRoot, ['fixture'], {
    onOutput: () => running.resolve(),
  })
  await running.promise
  let targetStarted = false
  const target = f.runtime.run(f.root, ['target-queued'], {
    onOutput: () => {
      targetStarted = true
    },
  })
  const unrelated = f.runtime.run(otherRoot, ['unrelated-queued'])
  assert.equal(f.runtime.queue.length, 2)
  await f.runtime.stopProject(f.root)
  await assert.rejects(target, { status: 409 })
  assert.equal(targetStarted, false)
  assert.equal(f.runtime.children.size, 1)
  assert.equal([...f.runtime.children][0].cancelled, undefined)
  assert.equal(f.runtime.queue.length, 1)
  assert.equal(f.runtime.queue[0].root, otherRoot)
  const cancelled = assert.rejects(unrelated, { status: 409 })
  await fs.writeFile(f.released, 'release unrelated cleanup')
  await f.runtime.stopProject(otherRoot)
  await cancelled
  assert.equal((await task).cancelled, true)
  assert.equal(targetStarted, false)
})
