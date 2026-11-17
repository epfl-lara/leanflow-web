import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { clusterEditor } from '../cluster/editors.mjs'

async function until(check) {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert(Date.now() < deadline, 'Editor action timed out.')
    await delay(5)
  }
}

function child() {
  const value = new EventEmitter()
  value.stdout = new PassThrough()
  value.stderr = new PassThrough()
  value.input = []
  value.saved = []
  value.sync = async () => {}
  value.syncMain = async (content, revision) => {
    await value.sync(content, revision)
    value.saved.push({ content, revision })
  }
  value.stdin = new Writable({
    write(bytes, _encoding, callback) {
      Promise.resolve()
        .then(() => value.beforeInput?.())
        .then(() => {
          value.input.push(bytes.toString())
          callback()
        }, callback)
    },
  })
  value.stdin.on('error', () => {})
  value.kill = () => {
    if (value.killed) return false
    value.killed = true
    queueMicrotask(() => {
      value.stdout.end()
      value.stderr.end()
      value.emit('close')
    })
    return true
  }
  return value
}

function fixture(t, patch = {}, startLocal = (worker) => worker) {
  const remote = child(),
    local = child()
  const project = {
    id: 'project',
    root: '/private/fixture',
    kind: 'single-file',
    status: 'ready',
  }
  const data = {
    content: 'saved initially',
    denied: false,
    localStarts: 0,
    remoteStarts: 0,
  }
  const listeners = new Set()
  const workspaces = {
    get(id, actor) {
      assert.equal(id, project.id)
      assert.equal(actor, 'alice')
      if (data.denied) throw new Error('No access.')
      return project
    },
    async readFile() {
      return { content: data.content }
    },
    subscribeChanges(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const checks = {
    mode: 'serve',
    closing: false,
    inputs: {
      blobs: {
        async manifest() {
          return {
            kind: 'source',
            totalBytes: 100,
            entries: [{ type: 'file', path: 'Main.lean' }],
          }
        },
      },
    },
    async captureEditor() {
      return { sourceManifest: 'snapshot' }
    },
    controller: {
      canRun: () => true,
      async openEditor() {
        data.remoteStarts++
        return remote
      },
    },
    ...patch,
  }
  const result = clusterEditor(
    checks,
    { project, actor: 'alice', workspaces },
    (fallback) => {
      data.localStarts++
      return startLocal(local, fallback)
    },
  )
  result.stdin.on('error', () => {})
  t.after(() => result.kill())
  return {
    result,
    remote,
    local,
    checks,
    project,
    data,
    listeners,
    change(event) {
      for (const listener of listeners)
        listener({
          projectId: project.id,
          paths: [],
          kind: 'files',
          removedPaths: [],
          ...event,
        })
    },
  }
}

test('cancelling initial synchronization retains the remote cleanup confirmation', async (t) => {
  const f = fixture(t)
  const syncing = Promise.withResolvers(),
    released = Promise.withResolvers()
  f.remote.workerReleased = released.promise
  f.remote.sync = () => syncing.promise
  await until(() => f.data.remoteStarts === 1)
  const rejected = assert.rejects(
    f.result.ready,
    (error) => error.workerReleased === released.promise,
  )
  f.result.kill()
  syncing.resolve()
  await rejected
  released.resolve()
})

test('initialize waits for capture and the newest canonical save without changing browser text', async (t) => {
  const captured = Promise.withResolvers()
  const f = fixture(t, { captureEditor: () => captured.promise })
  f.result.stdin.write('unsaved browser text')
  await delay(5)
  assert.equal(f.remote.input.length, 0)
  f.data.content = 'saved during preparation'
  f.change({ paths: ['Main.lean'] })
  captured.resolve({ sourceManifest: 'snapshot' })
  await f.result.ready
  await until(() => f.remote.input.length === 1)
  assert.deepEqual(f.remote.saved, [
    { content: 'saved during preparation', revision: 1 },
  ])
  assert.deepEqual(f.remote.input, ['unsaved browser text'])
  assert.equal(f.data.content, 'saved during preparation')
})

test('later messages wait for an in-flight save acknowledgement and sync continues after idle writes', async (t) => {
  const f = fixture(t)
  await f.result.ready
  f.result.stdin.write('before save')
  await until(() => f.remote.input.length === 1)
  const saving = Promise.withResolvers()
  f.remote.sync = () => saving.promise
  f.data.content = 'second save'
  f.change({ paths: ['Main.lean'] })
  f.result.stdin.write('didOpen after save')
  await delay(10)
  assert.deepEqual(f.remote.input, ['before save'])
  saving.resolve()
  await until(() => f.remote.input.length === 2)
  assert.deepEqual(f.remote.saved.at(-1), {
    content: 'second save',
    revision: 2,
  })
  f.remote.sync = async () => {}
  f.data.content = 'third save'
  f.change({ paths: ['Main.lean'] })
  await until(() => f.remote.saved.length === 3)
  assert.equal(f.remote.saved.at(-1).content, 'third save')
  assert.equal(
    f.remote.input.length,
    2,
    'disk changes must not synthesize LSP document messages',
  )
})

test('private or unsupported captures fall back locally and remove their source subscription', async (t) => {
  const f = fixture(t, { captureEditor: async () => null })
  assert.equal(await f.result.ready, f.local)
  assert.equal(f.data.remoteStarts, 0)
  assert.equal(f.data.localStarts, 1)
  assert.equal(f.listeners.size, 0)
})

test('a busy local-only fallback reports one failed start to the waiting list', async (t) => {
  const busy = Object.assign(new Error('Local editor busy'), { status: 503 })
  const f = fixture(
    t,
    { captureEditor: async () => null },
    (_child, fallback) => {
      assert.deepEqual(fallback, { unsupported: true })
      throw busy
    },
  )
  await assert.rejects(f.result.ready, (error) => error === busy)
  assert.equal(f.data.localStarts, 1)
  assert.equal(f.listeners.size, 0)
})

test('closing a browser during manifest inspection never starts a fallback editor', async (t) => {
  const inspecting = Promise.withResolvers()
  const manifest = Promise.withResolvers()
  const f = fixture(t, {
    inputs: {
      blobs: {
        manifest: () => {
          inspecting.resolve()
          return manifest.promise
        },
      },
    },
  })
  await inspecting.promise
  f.result.kill()
  manifest.resolve({ kind: 'source', totalBytes: 0, entries: [] })
  await assert.rejects(f.result.ready)
  assert.equal(f.data.localStarts, 0)
  assert.equal(f.data.remoteStarts, 0)
  assert.equal(f.listeners.size, 0)
})

for (const [label, event] of [
  ['configuration', { paths: ['lean-toolchain'] }],
  ['added module', { paths: ['Helper.lean'] }],
  ['deleted main', { paths: ['Main.lean'], removedPaths: ['Main.lean'] }],
])
  test(`${label} changes close the disposable editor instead of serving a stale mirror`, async (t) => {
    const f = fixture(t)
    await f.result.ready
    f.change(event)
    await until(() => f.remote.killed)
    assert.equal(f.listeners.size, 0)
    assert.equal(f.data.localStarts, 0)
  })

test('access revocation stops the remote child immediately', async (t) => {
  const f = fixture(t)
  await f.result.ready
  f.data.denied = true
  f.change({ kind: 'access' })
  await until(() => f.remote.killed)
  assert.equal(f.listeners.size, 0)
})

test('disconnect while a remote launch is pending kills its late child', async (t) => {
  const launched = Promise.withResolvers()
  let opening = false
  const f = fixture(t, {
    controller: {
      canRun: () => true,
      openEditor: () => {
        opening = true
        return launched.promise
      },
    },
  })
  await until(() => opening)
  f.result.kill()
  launched.resolve(f.remote)
  await assert.rejects(f.result.ready)
  assert.equal(f.remote.killed, true)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.data.localStarts, 0)
})
