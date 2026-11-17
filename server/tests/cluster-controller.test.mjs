import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { BlobStore, captureTree } from '../cluster/blobs.mjs'
import {
  ClusterController,
  SSH_BINARY,
  sshArguments,
} from '../cluster/controller.mjs'
import { WorkerNode } from '../cluster/node.mjs'
import { FramedRpc, RpcError } from '../cluster/protocol.mjs'
import { sha256 } from '../cluster/state.mjs'
import { LspFrames, frame } from '../rpc.mjs'

const GIB = 1024 ** 3
const IMAGE = `sha256:${'a'.repeat(64)}`
const BUNDLE = 'b'.repeat(64)
const LINEAGE = 'leanflow-test'
const VERSION = 'leanprover/lean4:v4.20.0'
const ALL = ['check.build', 'check.kernel', 'lean.file']
const FAST = {
  pollMs: 40,
  eventPollMs: 10,
  editorPollMs: 10,
  renewMs: 40,
  minBackoffMs: 10,
  maxBackoffMs: 80,
}

async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for the cluster.')
    await delay(5)
  }
}

const options = (overrides = {}) => ({
  operation: 'check.build',
  actor: 'alice',
  projectId: 'project-1',
  jobId: 'job-1',
  timeoutMs: 60_000,
  ...overrides,
})

const counts = ({ active, held, queued }) => ({ active, held, queued })

const editorNode = (patch = {}) => ({
  id: 'node-a',
  capabilities: [...ALL, 'lean.session'],
  editors: { maxConcurrent: 2, memory: '1g', cpus: 1, cpuReservation: 1 },
  ...patch,
})

test('remote editors stream framed messages, mirror bounded saves, and retain canonical snapshots', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  assert.equal(f.controller.editorCapacity(), 2)
  const editor = await f.controller.openEditor(
    f.input,
    options({ jobId: 'editor-a' }),
  )
  assert(editor)
  const messages = []
  const frames = new LspFrames((message) => messages.push(message))
  editor.stdout.on('data', (bytes) => frames.push(bytes))
  editor.stderr.resume()
  const message = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { rootUri: 'file:///workspace' },
  }
  editor.stdin.write(frame(message))
  await until(() => messages.length === 1)
  assert.deepEqual(messages[0].result, message.params)
  const { worker, runtime } = f.workers.get('node-a')
  const child = runtime.editorChildren[0]
  const original = await fsp.readFile(
    path.join(child.workspace, 'Main.lean'),
    'utf8',
  )
  const saved = ' -- unicode λ\n'.repeat(140000)
  await editor.syncMain(saved, 1)
  assert.equal(
    await fsp.readFile(path.join(child.workspace, 'Main.lean'), 'utf8'),
    saved,
  )
  const source = await f.blobs.manifest(f.input.sourceManifest, 'source')
  const canonical = source.entries.find((entry) => entry.path === 'Main.lean')
  assert.equal((await f.blobs.read(canonical.hash)).toString(), original)
  await assert.rejects(editor.syncMain('stale', 1), { code: 'editor_protocol' })
  const attempt = [...worker.running.keys()][0]
  const control = f.transport.opened.find(
    (entry) => entry.channel === 'control',
  ).rpc
  await assert.rejects(
    control.request('editor.input', {
      id: attempt,
      sequence: 2,
      data: Buffer.from('x').toString('base64'),
    }),
    { code: 'editor_protocol', status: 403 },
  )
  assert.equal(
    worker.state.events(attempt, 0, 100).length,
    0,
    'LSP content must not be retained in the check journal',
  )
  editor.kill()
  await until(
    () => f.controller.status().active === 0 && worker.running.size === 0,
  )
  assert.equal(f.controller.status().held, 0)
  await assert.rejects(fsp.stat(child.workspace), { code: 'ENOENT' })
})

test('dependency bytes do not advertise editor slots before environment diagnostics pass, including after restart', async (t) => {
  let calls = 0
  let release = Promise.withResolvers()
  const qualified = {
    compilerPassed: true,
    initialized: true,
    invalidDiagnostic: true,
    correctedDiagnostic: true,
    savedMirror: true,
  }
  const spec = editorNode({
    certifyToolchain: VERSION,
    editorEnvironmentVerifier: async (_runtime, root) => {
      calls++
      assert.equal(
        (await fsp.readFile(path.join(root, 'lean-toolchain'), 'utf8')).trim(),
        VERSION,
      )
      await release.promise
      return qualified
    },
  })
  const f = await cluster(t, {
    nodes: [spec],
    files: { 'Main.lean': 'import Lean\nexample : True := by trivial\n' },
  })
  await f.ready()
  const dependencies = (await f.blobs.seal([], 'dependencies')).hash
  const input = {
    ...f.input,
    dependencies,
    editorSource: f.input.sourceManifest,
  }
  await f.controller.prepareNode(
    'node-a',
    { ...f.input, dependencies },
    { certify: true },
  )
  assert.equal(f.controller.editorCapacity(input), 0)
  const prepared = f.controller.prepareNode('node-a', input)
  await until(() => calls === 1)
  await until(() => f.controller.status().ready === 0)
  assert.equal(f.controller.editorCapacity(input), 0)
  release.resolve()
  const report = await prepared
  assert(
    report.capabilities.includes('check.kernel'),
    'warming preserves native certification',
  )
  assert.equal(f.controller.editorCapacity(input), 2)
  assert.equal(
    f.controller.editorCapacity({ ...input, editorSource: 'f'.repeat(64) }),
    0,
  )
  assert.equal(
    f.controller.editorCapacity({ ...input, editorSource: undefined }),
    0,
  )
  await f.controller.prepareNode('node-a', input)
  assert.equal(
    calls,
    1,
    'a verified environment is not warmed for each browser open',
  )
  const opened = await f.controller.openEditor(
    input,
    options({ jobId: 'qualified-editor' }),
  )
  assert(opened)
  opened.stdout.resume()
  opened.stderr.resume()
  opened.kill()
  await until(() => f.controller.status().active === 0)

  // Persisted assets survive, but a new process must earn fresh qualification.
  await f.workers.get('node-a').worker.close()
  await until(() => f.controller.status().ready === 0)
  release = Promise.withResolvers()
  f.workers.set('node-a', await startWorker(f.root, spec))
  await until(() => calls === 2)
  assert.equal(f.controller.editorCapacity(input), 0)
  release.resolve()
  await f.ready()
  assert.equal(f.controller.editorCapacity(input), 2)
  assert.equal(calls, 2)

  const { worker } = f.workers.get('node-a')
  const certifier = worker.certifier
  worker.certifier = async () => {
    throw new Error('recertification failed')
  }
  await assert.rejects(worker.certify({ toolchain: VERSION }))
  await until(() => f.controller.editorCapacity(input) === 0)
  assert.equal(worker.state.meta('certification'), null)
  assert.deepEqual(worker.status().assets.editorEnvironments, [])
  worker.certifier = certifier
  await worker.certify({ toolchain: VERSION })
  await f.ready()
  assert.equal(f.controller.editorCapacity(input), 2)
  assert.equal(calls, 3)

  await f.controller.compactCaches({ nodeId: 'node-a' })
  await until(() => f.controller.editorCapacity(input) === 0)
  assert.deepEqual(worker.state.meta('editorEnvironments'), {})
  assert.deepEqual(worker.status().assets.editorEnvironments, [])

  const setMeta = worker.state.setMeta.bind(worker.state)
  worker.state.setMeta = () => {
    throw new Error('database unavailable')
  }
  await assert.rejects(worker.certify({ toolchain: VERSION }))
  assert.equal(worker.maintenance, false)
  assert.equal(worker.status().certified, false)
  assert(worker.certificationError)
  worker.state.setMeta = setMeta
  await worker.certify({ toolchain: VERSION })
  assert.equal(worker.status().certified, true)
})

test('failed environment diagnostics leave ordinary checks ready and no editor slots or workspace', async (t) => {
  const f = await cluster(t, {
    files: { 'Main.lean': 'import Lean\nexample : True := by trivial\n' },
    nodes: [
      editorNode({
        editorEnvironmentVerifier: async () => {
          throw new Error('diagnostics did not arrive')
        },
      }),
    ],
  })
  await f.ready()
  const dependencies = (await f.blobs.seal([], 'dependencies')).hash
  const input = {
    ...f.input,
    dependencies,
    editorSource: f.input.sourceManifest,
  }
  await f.controller.prepareNode(
    'node-a',
    { ...f.input, dependencies },
    { certify: true },
  )
  await assert.rejects(f.controller.prepareNode('node-a', input))
  await f.ready()
  assert.equal(f.controller.editorCapacity(input), 0)
  assert.deepEqual(
    await fsp.readdir(path.join(f.root, 'node-a', 'editor-warmups')),
    [],
  )
  assert.equal((await f.controller.run(f.input, options())).code, 0)
})

const editorEnvironmentProof = Object.freeze({
  compilerPassed: true,
  initialized: true,
  invalidDiagnostic: true,
  correctedDiagnostic: true,
  savedMirror: true,
})

async function preparedEnvironment(f) {
  await f.ready()
  const dependencies = (await f.blobs.seal([], 'dependencies')).hash
  await f.controller.prepareNode(
    'node-a',
    { ...f.input, dependencies },
    { certify: true },
  )
  return { ...f.input, dependencies, editorSource: f.input.sourceManifest }
}

test('a failed warm-up materialization keeps ordinary checks available after the copy removes its own destination', async (t) => {
  const f = await cluster(t, {
    files: { 'Main.lean': 'import Lean\nexample : True := by trivial\n' },
    nodes: [
      editorNode({
        editorEnvironmentVerifier: async () => editorEnvironmentProof,
      }),
    ],
  })
  const input = await preparedEnvironment(f)
  const { worker, runtime } = f.workers.get('node-a')
  runtime.clearInheritedDependencies = (root) => fsp.realpath(root)
  const materialize = worker.blobs.materialize.bind(worker.blobs)
  worker.blobs.materialize = async (hash, root, options) => {
    if (root.includes('/editor-warmups/')) {
      await fsp.mkdir(root, { recursive: true })
      await fsp.rm(root, { recursive: true })
      throw Object.assign(new Error('copy failed'), { code: 'EIO' })
    }
    return materialize(hash, root, options)
  }
  await assert.rejects(f.controller.prepareNode('node-a', input))
  await f.ready()
  assert.equal(worker.recoveryError, null)
  assert.equal(f.controller.editorCapacity(input), 0)
  assert.deepEqual(
    await fsp.readdir(path.join(f.root, 'node-a', 'editor-warmups')),
    [],
  )
  assert.equal((await f.controller.run(f.input, options())).code, 0)
})

test('an unconfirmed warm-up container quarantines the worker and prevents further warming', async (t) => {
  let calls = 0
  const f = await cluster(t, {
    files: { 'Main.lean': 'import Lean\nexample : True := by trivial\n' },
    nodes: [
      editorNode({
        editorEnvironmentVerifier: async (runtime, root) => {
          calls++
          runtime.children = new Set([{ workspaceRoot: root }])
          return editorEnvironmentProof
        },
      }),
    ],
  })
  const input = await preparedEnvironment(f)
  const { worker, runtime } = f.workers.get('node-a')
  await assert.rejects(f.controller.prepareNode('node-a', input))
  assert(worker.recoveryError)
  assert.equal(worker.maintenance, false)
  assert.deepEqual(worker.status().assets.editorEnvironments, [])
  await assert.rejects(f.controller.prepareNode('node-a', input), {
    code: 'worker_recovery',
  })
  assert.equal(calls, 1)
  runtime.children.clear()
})

test('restart removes an abandoned warm-up and keeps checks serving when fresh editor qualification fails', async (t) => {
  let fail = false
  const spec = editorNode({
    certifyToolchain: VERSION,
    editorEnvironmentVerifier: async () => {
      if (fail) throw new Error('cold diagnostics failed')
      return editorEnvironmentProof
    },
  })
  const f = await cluster(t, {
    files: { 'Main.lean': 'import Lean\nexample : True := by trivial\n' },
    nodes: [spec],
  })
  const input = await preparedEnvironment(f)
  await f.controller.prepareNode('node-a', input)
  const abandoned = path.join(
    f.root,
    'node-a',
    'editor-warmups',
    '11111111-1111-4111-8111-111111111111',
  )
  await fsp.mkdir(abandoned, { recursive: true })
  await fsp.writeFile(path.join(abandoned, 'Main.lean'), 'abandoned')
  await f.workers.get('node-a').worker.close()
  await until(() => f.controller.status().ready === 0)
  fail = true
  const restarted = await startWorker(f.root, spec)
  f.workers.set('node-a', restarted)
  await restarted.worker.certificationTask
  await f.ready()
  await assert.rejects(fsp.stat(abandoned), { code: 'ENOENT' })
  assert.equal(f.controller.editorCapacity(input), 0)
  assert.equal(restarted.worker.recoveryError, null)
  assert.equal((await f.controller.run(f.input, options())).code, 0)
})

test('persistent editor grants share the check pool and keep an ordinary batch reserve', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const one = await f.controller.openEditor(
    f.input,
    options({ jobId: 'editor-a' }),
  )
  const two = await f.controller.openEditor(
    f.input,
    options({ jobId: 'editor-b', actor: 'bob' }),
  )
  assert(one && two)
  one.stdout.resume()
  one.stderr.resume()
  two.stdout.resume()
  two.stderr.resume()
  assert.equal(
    await f.controller.openEditor(
      f.input,
      options({ jobId: 'editor-c', actor: 'carol' }),
    ),
    null,
  )
  assert.equal(
    f.controller.canRun('check.kernel'),
    false,
    'a native check must fall back rather than queue behind persistent holders',
  )
  assert.equal(
    await f.controller.run(f.input, options({ operation: 'check.kernel' })),
    null,
  )
  const result = await f.controller.run(f.input, options({ jobId: 'check-a' }))
  assert.equal(result.code, 0)
  assert.equal(f.controller.status().active, 2)
  one.kill()
  two.kill()
  await until(() => f.controller.status().active === 0)
  assert.equal(f.controller.canRun('check.kernel'), true)
})

test('closing a dedicated editor channel kills only its owner and confirms cleanup before releasing resources', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const first = await f.controller.openEditor(
    f.input,
    options({ jobId: 'editor-a' }),
  )
  const second = await f.controller.openEditor(
    f.input,
    options({ jobId: 'editor-b', actor: 'bob' }),
  )
  first.stdout.resume()
  first.stderr.resume()
  second.stdout.resume()
  second.stderr.resume()
  const { worker, runtime } = f.workers.get('node-a')
  const cleanup = Promise.withResolvers()
  runtime.editorCleanup = () => cleanup.promise
  let released = false
  void first.workerReleased.then(() => {
    released = true
  })
  first.rpc.close()
  await until(() => runtime.editorChildren[0].killed)
  assert.equal(runtime.editorChildren[1].killed, undefined)
  assert.equal(f.controller.status().active, 2)
  assert.equal(worker.running.size, 2)
  assert.equal(released, false)
  cleanup.resolve()
  await first.workerReleased
  assert.equal(released, true)
  await until(() => f.controller.status().active === 1)
  second.kill()
  await until(
    () => f.controller.status().active === 0 && worker.running.size === 0,
  )
})

test('an unavailable editor grant does not subtract healthy worker capacity twice', async (t) => {
  const f = await cluster(t, {
    nodes: [editorNode(), editorNode({ id: 'node-b' })],
  })
  await f.ready()
  for (const node of ['node-a', 'node-b'])
    await f.controller.prepareNode(node, f.input, { certify: true })
  const editor = await f.controller.openEditor(
    f.input,
    options({ jobId: 'lost-editor' }),
  )
  editor.stdout.resume()
  editor.stderr.resume()
  f.transport.hook = (call) =>
    call.node === 'node-a'
      ? refuseCancel(call)
      : call.request(call.method, call.params, call.options)
  editor.kill()
  await until(() => f.controller.status().held === 1)
  assert.equal(f.controller.editorCapacity(), 2)
  assert.equal(
    f.controller.editorAdmissionCapacity(),
    3,
    'Two healthy places plus one already held process',
  )
  assert.equal(f.controller.canOpenEditor(), true)
  const healthy = await f.controller.openEditor(
    f.input,
    options({ jobId: 'healthy-editor', actor: 'bob' }),
  )
  healthy.stdout.resume()
  healthy.stderr.resume()
  assert.equal(f.workers.get('node-b').runtime.editorChildren.length, 1)
  f.transport.hook = null
  await editor.workerReleased
  await f.ready()
  assert.equal(f.controller.editorAdmissionCapacity(), 4)
  healthy.kill()
})

test('unsupported repository snapshots never start a remote editor', async (t) => {
  const f = await cluster(t, {
    nodes: [editorNode()],
    files: { 'Main.lean': 'import Helper', 'Helper.lean': 'def value := 1' },
  })
  await f.ready()
  await assert.rejects(f.controller.openEditor(f.input, options()), {
    code: 'invalid_request',
  })
  assert.equal(f.workers.get('node-a').runtime.editorChildren.length, 0)
})

test('a cold editor environment falls back without uploading assets on the browser path', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  assert.equal(f.controller.editorCapacity(f.input), 0)
  assert.equal(await f.controller.openEditor(f.input, options()), null)
  assert.equal(
    f.transport.requests.some(
      (call) =>
        call.method === 'assets.prepare' || call.method === 'objects.put',
    ),
    false,
  )
  assert.equal(f.workers.get('node-a').runtime.editorChildren.length, 0)
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  assert.equal(f.controller.editorCapacity(f.input), 2)
  assert.equal(
    f.controller.editorCapacity({
      ...f.input,
      toolchain: { ...f.input.toolchain, manifest: 'f'.repeat(64) },
    }),
    0,
  )
})

test('read-only dependency and configuration documents remain usable through a remote editor', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const editor = await f.controller.openEditor(f.input, options())
  editor.stdout.resume()
  editor.stderr.resume()
  for (const filename of [
    '.lake/packages/mathlib/Mathlib.lean',
    'lakefile.lean',
    'Main.lean',
  ])
    editor.stdin.write(
      frame({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: 'file:///workspace/' + filename,
            languageId: 'lean4',
            version: 1,
            text: '-- read-only navigation',
          },
        },
      }),
    )
  const { runtime } = f.workers.get('node-a')
  await until(() => runtime.editorChildren[0].messages.length === 3)
  assert.equal(runtime.editorChildren[0].killed, undefined)
  editor.kill()
  await until(() => f.controller.status().active === 0)
})

test('late saves after a natural editor exit cannot race disposable workspace removal', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const editor = await f.controller.openEditor(f.input, options())
  editor.stdout.resume()
  editor.stderr.resume()
  const { runtime, worker } = f.workers.get('node-a')
  runtime.editorChildren[0].kill()
  await until(() =>
    [...worker.running.values()].every((record) => record.editor.closed),
  )
  await assert.rejects(editor.syncMain('late save', 1), (error) =>
    ['editor_protocol', 'connection_closed', 'connection_failed'].includes(
      error.code,
    ),
  )
  await until(
    () => f.controller.status().active === 0 && worker.running.size === 0,
  )
  assert.equal(f.controller.status().held, 0)
})

test('editor EOF is ordered after acknowledged input and remains bound to its channel', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const editor = await f.controller.openEditor(f.input, options())
  editor.stdout.resume()
  editor.stderr.resume()
  const { runtime, worker } = f.workers.get('node-a')
  const id = [...worker.running.keys()][0]
  const control = f.transport.opened.find(
    (entry) => entry.channel === 'control',
  ).rpc
  await assert.rejects(control.request('editor.end', { id, sequence: 0 }), {
    code: 'editor_protocol',
    status: 403,
  })
  editor.stdin.end(
    frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: 'file:///workspace' },
    }),
  )
  await until(
    () => f.controller.status().active === 0 && worker.running.size === 0,
  )
  assert.equal(runtime.editorChildren[0].messages.length, 1)
  assert.equal(f.controller.status().held, 0)
})

test('open editors do not consume the account check quota', async (t) => {
  const f = await cluster(t, {
    nodes: [editorNode()],
    config: { maxPerActor: 2 },
  })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const editor = await f.controller.openEditor(f.input, options())
  editor.stdout.resume()
  editor.stderr.resume()
  const gate = Promise.withResolvers()
  f.workers.get('node-a').runtime.behavior = async () => {
    await gate.promise
    return { code: 0, stdout: '', stderr: '' }
  }
  const first = f.controller.run(f.input, options({ jobId: 'first-check' }))
  const second = f.controller.run(f.input, options({ jobId: 'second-check' }))
  first.catch(() => {})
  second.catch(() => {})
  await until(() => f.controller.status().active === 3)
  gate.resolve()
  assert.equal((await first).code, 0)
  assert.equal((await second).code, 0)
  editor.kill()
  await until(() => f.controller.status().active === 0)
})

test('an editor bypasses its account queued native check when an interactive grant fits', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const gate = Promise.withResolvers()
  f.workers.get('node-a').runtime.behavior = async () => {
    await gate.promise
    return { code: 0, stdout: '', stderr: '' }
  }
  const running = f.controller.run(
    f.input,
    options({
      operation: 'check.kernel',
      actor: 'bob',
      jobId: 'running-native',
    }),
  )
  running.catch(() => {})
  await until(() => f.controller.status().active === 1)
  const queued = f.controller.run(
    f.input,
    options({ operation: 'check.kernel', jobId: 'queued-native' }),
  )
  queued.catch(() => {})
  await until(() => f.controller.status().queued === 1)
  const editor = await f.controller.openEditor(
    f.input,
    options({ jobId: 'interactive', signal: AbortSignal.timeout(3000) }),
  )
  assert(editor)
  editor.stdout.resume()
  editor.stderr.resume()
  assert.equal(f.controller.status().queued, 1)
  gate.resolve()
  assert.equal((await running).code, 0)
  assert.equal((await queued).code, 0)
  editor.kill()
  await until(() => f.controller.status().active === 0)
})

test('invalid workspace URIs are rejected on the node before the Lean process sees them', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const editor = await f.controller.openEditor(f.input, options())
  editor.stdout.resume()
  editor.stderr.resume()
  editor.stdin.write(
    frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { rootUri: 'file:///etc' },
    }),
  )
  await until(() => f.controller.status().active === 0)
  assert.equal(f.workers.get('node-a').runtime.editorChildren[0].killed, true)
  assert.equal(f.controller.status().held, 0)
})

test('editor leases expire when renewals stop while the channel stays open', async (t) => {
  const f = await cluster(t, { nodes: [editorNode()] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  const editor = await f.controller.openEditor(f.input, options())
  editor.stdout.resume()
  editor.stderr.resume()
  f.transport.hook = ({ method, request, params, options }) =>
    method === 'lease.renew'
      ? Promise.resolve({ renewed: [] })
      : request(method, params, options)
  const { worker } = f.workers.get('node-a')
  for (const record of worker.running.values()) record.deadline = 0
  await until(
    () => f.controller.status().active === 0 && worker.running.size === 0,
  )
  assert.equal(f.controller.status().held, 0)
})

const refuseCancel = ({ method, params, options, request }) =>
  method === 'attempt.cancel'
    ? Promise.reject(
        new RpcError('Worker shutdown could not be confirmed.', {
          code: 'worker_cleanup',
          status: 503,
        }),
      )
    : request(method, params, options)

// Stands in for the container runtime. Each test decides what a run does.
class FakeRuntime {
  toolchains = new Map()
  instance = null
  runs = []
  editorChildren = []
  editorCleanup = async () => {}
  behavior = async () => ({
    code: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    cancelled: false,
  })

  async init() {
    return this.info()
  }

  info() {
    return {
      ready: true,
      imageId: IMAGE,
      cgroupDriver: 'systemd',
      cgroupVersion: '2',
    }
  }

  run(workspace, args, options) {
    this.runs.push(path.basename(workspace))
    return this.behavior(options, args)
  }

  spawn(workspace, args, options) {
    assert.deepEqual(args, ['lake', 'serve', '--'])
    assert.equal(options.network, 'none')
    assert.equal(options.readOnlyWorkspace, true)
    assert.equal(options.editor, true)
    assert.equal(
      options.postCheckFile,
      undefined,
      'an editor must not run a compiler after lake serve',
    )
    const child = new EventEmitter()
    child.workspace = workspace
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.messages = []
    const frames = new LspFrames((message) => {
      child.messages.push(message)
      if (message.id != null)
        child.stdout.write(
          frame({
            jsonrpc: '2.0',
            id: message.id,
            result: message.params ?? null,
          }),
        )
    })
    child.stdin = new Writable({
      write(bytes, _encoding, callback) {
        try {
          frames.push(bytes)
          callback()
        } catch (error) {
          callback(error)
        }
      },
    })
    const closed = Promise.withResolvers()
    child.kill = () => {
      if (child.killed) return false
      child.killed = true
      queueMicrotask(() => {
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0)
        closed.resolve()
      })
      return true
    }
    child.cleanupWorker = async () => {
      await closed.promise
      await this.editorCleanup()
    }
    child.workerStopped = child.cleanupWorker()
    child.workerStopped.catch(() => {})
    child.stdin.on('finish', () => child.kill())
    options.signal.addEventListener('abort', () => child.kill(), { once: true })
    this.editorChildren.push(child)
    return child
  }

  checkProject(workspace, options) {
    return this.run(workspace, ['check-project'], options)
  }

  async inheritDependencies() {}
  async clearInheritedDependencies() {}
  async releaseVerificationWorkspace() {}
  async shutdown() {}
}

// Each run reports progress, then waits for its gate or for cancellation.
// Cancellation finishes once `stopping` resolves.
function hold(runtime, { stopping = Promise.resolve() } = {}) {
  const gates = []
  runtime.behavior = (options) =>
    new Promise((resolve) => {
      options.onOutput('started\n', 'stdout')
      const finish = (cancelled) =>
        resolve({
          code: cancelled ? 130 : 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          cancelled,
        })
      gates.push(() => finish(false))
      options.signal.addEventListener(
        'abort',
        () => stopping.then(() => finish(true)),
        { once: true },
      )
    })
  return gates
}

const certification = (worker, capabilities) => ({
  version: 1,
  nodeId: worker.config.nodeId,
  nodeEpoch: worker.nodeEpoch,
  bundleDigest: worker.bundleDigest,
  imageDigest: worker.config.image,
  engineKind: 'docker',
  checkedAt: new Date().toISOString(),
  capabilities,
  checks: {},
  failures: {},
})

async function startWorker(root, spec) {
  const { id, role, bundle = BUNDLE, memoryBudget = '4g' } = spec
  const capabilities = spec.capabilities ?? ALL
  const runtime = new FakeRuntime()
  if (spec.imageDigest) {
    const info = runtime.info.bind(runtime)
    runtime.info = () => ({ ...info(), imageId: spec.imageDigest })
  }
  const worker = new WorkerNode({
    config: {
      version: 1,
      nodeId: id,
      controllerLineage: LINEAGE,
      dataDir: path.join(root, id),
      image: spec.imageDigest ?? IMAGE,
      role,
      workerMemory: '1g',
      memoryBudget,
      parentMemoryMax: '8g',
      maxCpus: 8,
      parentMaxCpus: 8,
      workerCpus: 1,
      leaseMs: 5000,
      ...(spec.editors
        ? { editors: spec.editors, maxConcurrent: spec.maxConcurrent ?? 4 }
        : {}),
      ...(spec.certifyToolchain
        ? { certifyToolchain: spec.certifyToolchain }
        : {}),
    },
    runtime,
    verifyToolchain: async () => {},
    bundleDigest: bundle,
    certifier: async (node) => certification(node, capabilities),
    editorEnvironmentVerifier: spec.editorEnvironmentVerifier,
    reap: async () => {},
    boundaryInspector: async () => ({ relative: 'leanflow-workers.slice' }),
    leaseAcquire: async () => ({ release: async () => {} }),
  })
  await worker.init()
  worker.state.setMeta('certification', certification(worker, capabilities))
  return { worker, runtime }
}

async function snapshot(store, files) {
  const file = async (name, text, mode = 0o600) => ({
    path: name,
    type: 'file',
    ...(await store.put(Buffer.from(text))),
    mode,
  })
  const entries = [await file('lean-toolchain', `${VERSION}\n`)]
  for (const [name, text] of Object.entries(files))
    entries.push(await file(name, text))
  const source = await store.seal(entries, 'source')
  const toolchain = await store.seal(
    [
      { path: 'bin', type: 'directory' },
      await file('bin/lean', '#!/bin/sh\n', 0o700),
    ],
    'toolchain',
  )
  return {
    sourceManifest: source.hash,
    toolchain: { version: VERSION, manifest: toolchain.hash },
  }
}

// Real WorkerNode services behind in-memory FramedRpc pairs. The transport
// records every request and lets a test rewrite replies or go offline.
async function cluster(t, settings = {}) {
  const {
    nodes = [{ id: 'node-a' }],
    files = { 'Main.lean': 'theorem demo : True := trivial\n' },
    config: overrides = {},
  } = settings
  const root = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'lfc-')),
  )
  const workers = new Map()
  const controllers = []
  t.after(async () => {
    for (const controller of controllers) await controller.shutdown()
    for (const { worker } of workers.values()) await worker.close()
    await fsp.rm(root, { recursive: true, force: true })
  })
  const assetDataDir = settings.backedAssets ? path.join(root, 'managed') : null
  if (assetDataDir) await fsp.mkdir(assetDataDir, { mode: 0o700 })
  const local = await new BlobStore(path.join(root, 'local'), {
    assetDataDir,
  }).init()
  t.after(() => local.close())
  for (const spec of nodes) workers.set(spec.id, await startWorker(root, spec))
  const transport = {
    calls: 0,
    offline: new Set(),
    opened: [],
    requests: [],
    hook: null,
  }
  const transportFactory = (node, channel) => {
    transport.calls++
    if (transport.offline.has(node.id)) throw new Error('worker offline')
    const forward = new PassThrough()
    const backward = new PassThrough()
    workers.get(node.id).worker.attach(forward, backward)
    const rpc = new FramedRpc(backward, forward)
    const request = rpc.request.bind(rpc)
    rpc.request = (method, params, options) => {
      transport.requests.push({ node: node.id, channel, method, params })
      return transport.hook
        ? transport.hook({ node: node.id, method, params, options, request })
        : request(method, params, options)
    }
    transport.opened.push({ node: node.id, channel, rpc })
    return rpc
  }
  const config = {
    version: 1,
    lineage: LINEAGE,
    mode: 'serve',
    ...(nodes.some((node) => node.editors)
      ? { editors: { placement: 'prefer' } }
      : {}),
    nodes: nodes.map(({ id, role, imageDigest }) => ({
      id,
      role,
      ...(imageDigest ? { imageDigest } : {}),
      host: 'worker.test',
      user: 'leanflow',
      identityFile: '/etc/leanflow/id_ed25519',
      knownHostsFile: '/etc/leanflow/known_hosts',
    })),
    ...overrides,
  }
  const make = () => {
    const controller = new ClusterController({
      config,
      dataDir: path.join(root, 'controller'),
      blobs: local,
      bundleDigest: BUNDLE,
      imageDigest: IMAGE,
      transportFactory,
      timing: { ...FAST, ...settings.timing },
    })
    controllers.push(controller)
    return controller
  }
  const controller = make()
  await controller.init()
  const input = await snapshot(local, files)
  if (assetDataDir) {
    const toolchain = path.join(
      assetDataDir,
      'runtime/elan/toolchains',
      VERSION.replace('/', '--').replace(':', '---'),
    )
    await fsp.mkdir(path.join(toolchain, 'bin'), {
      recursive: true,
      mode: 0o700,
    })
    await fsp.writeFile(path.join(toolchain, 'bin/lean'), '#!/bin/sh\n', {
      mode: 0o700,
    })
    input.toolchain.manifest = (
      await captureTree(local, toolchain, { kind: 'toolchain' })
    ).hash
    await local.trimAssetCopies()
  }
  const ready = (count = nodes.length) =>
    until(() => controller.status().ready === count)
  return {
    root,
    workers,
    transport,
    controller,
    make,
    input,
    ready,
    blobs: local,
  }
}

test('queued input validation is bounded and cannot reorder an account behind a faster read', async (t) => {
  const { controller, workers, input, ready, blobs } = await cluster(t, {
    nodes: [{ id: 'node-a', memoryBudget: '1g' }],
    config: { maxQueue: 2 },
  })
  const { worker, runtime } = workers.get('node-a'),
    gates = hold(runtime)
  await ready()
  const first = controller.run(input, options({ jobId: 'first' }))
  await until(() => runtime.runs.length === 1)
  const source = await blobs.manifest(input.sourceManifest)
  const pin = source.entries.find(
    (entry) => entry.path === 'lean-toolchain',
  ).hash
  const gate = Promise.withResolvers(),
    read = blobs.read.bind(blobs)
  let pinReads = 0,
    laterRead = false
  blobs.read = async (hash, ...args) => {
    if (hash === pin) {
      if (++pinReads === 1) await gate.promise
      else laterRead = true
    }
    return read(hash, ...args)
  }
  const second = controller.run(input, options({ jobId: 'second' }))
  const third = controller.run(input, options({ jobId: 'third' }))
  assert.equal(controller.status().queued, 2)
  await assert.rejects(
    controller.run(input, options({ actor: 'bob', jobId: 'overflow' })),
    { code: 'cluster_queue_full' },
  )
  await until(() => laterRead)
  gates[0]()
  await first
  assert.equal(runtime.runs.length, 1)
  gate.resolve()
  await until(() => runtime.runs.length === 2)
  gates[1]()
  await second
  await until(() => runtime.runs.length === 3)
  gates[2]()
  await third
  assert.deepEqual(
    runtime.runs.map((id) => worker.state.get(id).jobId),
    ['first', 'second', 'third'],
  )
})

const closeChannel = (transport, node, channel) => {
  for (const entry of transport.opened)
    if (entry.node === node && entry.channel === channel)
      entry.rpc.close(new Error('link down'))
}

test('a delayed start cannot run after an unseen attempt was cancelled and its grant released', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  await ready()
  let rejectStart, deliverLate
  transport.hook = ({ method, params, options, request }) => {
    if (method !== 'attempt.start') return request(method, params, options)
    deliverLate = () => request(method, params, options)
    return new Promise((_resolve, reject) => {
      rejectStart = () => reject(new RpcError('timeout', { code: 'timeout' }))
    })
  }
  const abort = new AbortController()
  const run = controller.run(input, options({ signal: abort.signal }))
  const stopped = assert.rejects(run, /requested stop/)
  await until(() => !!rejectStart)
  abort.abort(new Error('requested stop'))
  rejectStart()
  await stopped
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
  await assert.rejects(deliverLate(), { code: 'attempt_cancelled' })
  assert.equal(workers.get('node-a').runtime.runs.length, 0)
})

test('a check runs remotely and each output event reaches the caller once, in order', async (t) => {
  const { controller, workers, transport, input, ready, root } =
    await cluster(t)
  const lines = Array.from({ length: 40 }, (_, index) => [
    `line ${index}\n`,
    index % 3 ? 'stdout' : 'stderr',
  ])
  workers.get('node-a').runtime.behavior = async (options) => {
    for (const [text, stream] of lines) options.onOutput(text, stream)
    return {
      code: 0,
      stdout: 'built',
      stderr: '',
      timedOut: false,
      cancelled: false,
    }
  }
  // Rewinding the cursor makes the worker resend events already recorded.
  transport.hook = ({ method, params, options, request }) =>
    request(
      method,
      method === 'attempt.get'
        ? { ...params, after: Math.max(0, params.after - 5) }
        : params,
      options,
    )
  await ready()
  const output = []
  const result = await controller.run(
    input,
    options({ onOutput: (text, stream) => output.push([text, stream]) }),
  )
  assert.deepEqual(result, {
    code: 0,
    stdout: 'built',
    stderr: '',
    timedOut: false,
    cancelled: false,
    truncated: false,
  })
  // Stream boundaries may be coalesced, but byte order and stream identity
  // must survive replay without duplication.
  const coalesce = (entries) =>
    entries.reduce((out, [text, stream]) => {
      if (out.at(-1)?.[1] === stream) out.at(-1)[0] += text
      else out.push([text, stream])
      return out
    }, [])
  assert.deepEqual(coalesce(output), coalesce(lines))
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
  for (const channel of ['control', 'bulk']) {
    const first = transport.requests.find((entry) => entry.channel === channel)
    assert.equal(first.method, 'hello')
    assert.deepEqual(first.params, {
      version: 2,
      lineage: LINEAGE,
      epoch: 1,
      bundleDigest: BUNDLE,
      imageDigest: IMAGE,
    })
  }
  for (const { method, channel } of transport.requests) {
    if (method.startsWith('objects.') || method === 'assets.prepare')
      assert.equal(channel, 'bulk')
    if (method.startsWith('attempt.') || method === 'lease.renew')
      assert.equal(channel, 'control')
  }
  await controller.shutdown()
  const db = new DatabaseSync(
    path.join(root, 'controller/cluster-controller.sqlite'),
  )
  try {
    const attempts = db.prepare('SELECT state FROM cluster_attempts').all()
    assert.deepEqual(
      attempts.map((row) => row.state),
      ['completed'],
    )
    const events = db.prepare('SELECT COUNT(*) AS count FROM cluster_events')
    assert.equal(events.get().count, 0)
  } finally {
    db.close()
  }
})

test('a completed attempt that fails its fence is rejected without a fallback', async (t) => {
  const { controller, transport, input, ready } = await cluster(t)
  await ready()
  for (const [field, value] of [
    ['nodeEpoch', 'another-process'],
    ['epoch', 99],
    ['inputDigest', 'c'.repeat(64)],
  ]) {
    transport.hook = async ({ method, params, options, request }) => {
      const reply = await request(method, params, options)
      return method === 'attempt.get' && reply.attempt.state === 'completed'
        ? { ...reply, attempt: { ...reply.attempt, [field]: value } }
        : reply
    }
    await assert.rejects(
      controller.run(input, options({ jobId: `fence-${field}` })),
      { code: 'invalid_result' },
    )
  }
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('a lost control channel keeps the grant until the worker confirms the attempt stopped', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t, {
    nodes: [{ id: 'node-a', memoryBudget: '1g' }],
  })
  const { worker, runtime } = workers.get('node-a')
  const gates = hold(runtime)
  await ready()
  const running = controller.run(input, options())
  await until(() => runtime.runs.length === 1)
  transport.offline.add('node-a')
  closeChannel(transport, 'node-a', 'control')
  await assert.rejects(running, (error) => {
    assert.equal(error.code, 'worker_cleanup')
    assert.equal(error.workerCleanup, true)
    assert.doesNotMatch(error.message, /link|offline|worker\.test|ssh/i)
    return true
  })
  assert.equal(controller.status().held, 1)
  assert.equal(
    await controller.run(input, options({ jobId: 'job-2' })),
    null,
    'an unassigned check may still run locally',
  )

  const cancel = Promise.withResolvers()
  transport.hook = async ({ method, params, options, request }) => {
    if (method === 'attempt.cancel') await cancel.promise
    return request(method, params, options)
  }
  transport.offline.delete('node-a')
  await ready()
  const queued = controller.run(
    input,
    options({ actor: 'bob', jobId: 'job-3' }),
  )
  await until(() => controller.status().queued === 1)
  assert.equal(controller.status().held, 1)
  assert.equal(runtime.runs.length, 1)
  cancel.resolve()
  await until(() => controller.status().held === 0)
  assert.equal(worker.state.list()[0].state, 'cancelled')
  await until(() => runtime.runs.length === 2)
  gates[1]()
  assert.equal((await queued).code, 0)
})

test('cancelling a running check waits for the worker to confirm it stopped', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  const { worker, runtime } = workers.get('node-a')
  const stopping = Promise.withResolvers()
  hold(runtime, { stopping: stopping.promise })
  await ready()
  const abort = new AbortController()
  let settled = false
  const running = controller.run(input, options({ signal: abort.signal }))
  running.then(
    () => (settled = true),
    () => (settled = true),
  )
  await until(() => runtime.runs.length === 1)
  const reason = new Error('Stopped by the user.')
  abort.abort(reason)
  await until(() =>
    transport.requests.some((entry) => entry.method === 'attempt.cancel'),
  )
  await delay(100)
  assert.equal(settled, false)
  assert.equal(controller.status().active, 1)
  stopping.resolve()
  await assert.rejects(running, (error) => error === reason)
  assert.equal(worker.state.list()[0].state, 'cancelled')
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('an unconfirmed cancellation keeps capacity reserved and takes the worker out of service', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  const { worker, runtime } = workers.get('node-a')
  hold(runtime)
  await ready()
  const abort = new AbortController()
  const running = controller.run(input, options({ signal: abort.signal }))
  await until(() => runtime.runs.length === 1)
  transport.hook = refuseCancel
  abort.abort(new Error('Stopped by the user.'))
  await assert.rejects(running, { code: 'worker_cleanup', workerCleanup: true })
  const status = controller.status()
  assert.equal(status.held, 1)
  assert.equal(status.workers[0].state, 'unavailable')
  assert.equal(await controller.run(input, options({ jobId: 'job-2' })), null)
  transport.hook = null
  await until(() => controller.status().held === 0)
  await ready()
  assert.equal(worker.state.list()[0].state, 'cancelled')
})

test('queued checks rotate between accounts within the queue and account caps', async (t) => {
  const { controller, workers, input, ready } = await cluster(t, {
    nodes: [{ id: 'node-a', memoryBudget: '1g' }],
    config: { maxQueue: 5, maxPerActor: 3 },
  })
  const { worker, runtime } = workers.get('node-a')
  const gates = hold(runtime)
  await ready()
  const runs = new Map()
  const submit = (actor, jobId, extra = {}) =>
    runs.set(jobId, controller.run(input, options({ actor, jobId, ...extra })))
  submit('alice', 'a1')
  await until(() => runtime.runs.length === 1)
  submit('alice', 'a2')
  submit('alice', 'a3')
  await until(() => controller.status().queued === 2)
  await assert.rejects(
    controller.run(input, options({ actor: 'alice', jobId: 'a4' })),
    { code: 'cluster_actor_limit', status: 429 },
  )
  const abort = new AbortController()
  submit('bob', 'b1')
  submit('bob', 'b2', { signal: abort.signal })
  submit('carol', 'c1')
  await until(() => controller.status().queued === 5)
  await assert.rejects(
    controller.run(input, options({ actor: 'dave', jobId: 'd1' })),
    { code: 'cluster_queue_full', status: 429 },
  )
  const reason = new Error('No longer needed.')
  abort.abort(reason)
  await assert.rejects(runs.get('b2'), (error) => error === reason)
  assert.equal(controller.status().queued, 4)
  for (let index = 0; index < 5; index++) {
    await until(() => runtime.runs.length === index + 1)
    gates[index]()
  }
  const finished = ['a1', 'a2', 'a3', 'b1', 'c1'].map((id) => runs.get(id))
  for (const result of await Promise.all(finished)) assert.equal(result.code, 0)
  assert.deepEqual(
    runtime.runs.map((id) => worker.state.get(id).jobId),
    ['a1', 'b1', 'c1', 'a2', 'a3'],
  )
})

test('a lost start reply retries the same attempt on the same worker process', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  let replies = 0
  transport.hook = async ({ method, params, options, request }) => {
    const reply = await request(method, params, options)
    if (method === 'attempt.start' && replies++ === 0)
      throw new RpcError('No reply arrived.', { code: 'timeout', status: 504 })
    return reply
  }
  await ready()
  assert.equal((await controller.run(input, options())).code, 0)
  const starts = transport.requests.filter(
    (entry) => entry.method === 'attempt.start',
  )
  assert.equal(starts.length, 2)
  assert.deepEqual(starts[0].params, starts[1].params)
  assert.equal(workers.get('node-a').worker.state.list().length, 1)
})

test('a busy refusal requeues the check as a new attempt', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  let refused = false
  transport.hook = ({ method, params, options, request }) => {
    if (method !== 'attempt.start' || refused)
      return request(method, params, options)
    refused = true
    return Promise.reject(
      new RpcError('Worker resource budget is busy.', {
        code: 'worker_busy',
        status: 429,
      }),
    )
  }
  await ready()
  assert.equal((await controller.run(input, options())).code, 0)
  const starts = transport.requests.filter(
    (entry) => entry.method === 'attempt.start',
  )
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].params.id, starts[1].params.id)
  assert.equal(workers.get('node-a').worker.state.list().length, 1)
})

test('mode off and reserve workers make no connections unless reserve use is explicit', async (t) => {
  const off = await cluster(t, { config: { mode: 'off' } })
  assert.equal(await off.controller.run(off.input, options()), null)
  await assert.rejects(off.controller.prepareNode('node-a', off.input), {
    code: 'cluster_off',
  })
  assert.equal(off.controller.status().mode, 'off')
  assert.equal(off.transport.calls, 0)

  const spare = [{ id: 'spare', role: 'reserve' }]
  const reserve = await cluster(t, { nodes: spare })
  await delay(100)
  assert.equal(await reserve.controller.run(reserve.input, options()), null)
  await assert.rejects(reserve.controller.prepareNode('spare', reserve.input), {
    code: 'node_unavailable',
  })
  assert.equal(reserve.transport.calls, 0)
  assert.equal(reserve.controller.status().workers.length, 0)

  const allowed = await cluster(t, {
    nodes: spare,
    config: { allowReserve: true },
  })
  await allowed.ready()
  const result = await allowed.controller.run(allowed.input, options())
  assert.equal(result.code, 0)
})

test('evicted coordinator asset payloads transfer again after worker cache loss without recreating local copies', async (t) => {
  const { controller, workers, input, ready, blobs, make, transport } =
    await cluster(t, { backedAssets: true })
  const hash = sha256('#!/bin/sh\n')
  await assert.rejects(fsp.stat(blobs.object(hash)), { code: 'ENOENT' })
  await ready()
  assert.equal((await controller.run(input, options())).code, 0)
  const { worker } = workers.get('node-a')
  assert.equal((await worker.blobs.read(hash)).toString(), '#!/bin/sh\n')
  await controller.shutdown()
  await worker.blobs.reset()
  await fsp.rm(worker.runtime.toolchains.get(VERSION), { recursive: true })
  const restarted = make()
  await restarted.init()
  await until(() => restarted.status().ready === 1)
  assert.equal(
    (await restarted.run(input, options({ jobId: 'after-worker-cache-loss' })))
      .code,
    0,
  )
  assert.equal((await worker.blobs.read(hash)).toString(), '#!/bin/sh\n')
  await assert.rejects(fsp.stat(blobs.object(hash)), { code: 'ENOENT' })
  assert.equal(
    transport.requests.filter(
      (entry) =>
        entry.method === 'objects.put' &&
        entry.params.hash === hash &&
        entry.params.final,
    ).length,
    2,
  )
})

test('a fresh controller reuses installed worker assets without scanning their object hashes', async (t) => {
  const f = await cluster(t)
  await f.ready()
  const dependency = await f.blobs.put('compiled dependency fixture')
  const dependencies = (
    await f.blobs.seal(
      [{ path: 'public.olean', type: 'file', ...dependency, mode: 0o600 }],
      'dependencies',
    )
  ).hash
  const input = { ...f.input, dependencies }
  await f.controller.prepareNode('node-a', input)
  await f.controller.shutdown()
  const controller = f.make()
  await controller.init()
  await until(() => controller.status().ready === 1)
  f.transport.requests.length = 0
  assert.equal((await controller.run(input, options())).code, 0)
  const assets = new Set([
    input.toolchain.manifest,
    dependencies,
    dependency.hash,
    sha256('#!/bin/sh\n'),
  ])
  assert(
    !f.transport.requests.some(
      (call) =>
        call.method === 'objects.has' &&
        call.params.hashes.some((hash) => assets.has(hash)),
    ),
  )
  assert(
    f.transport.requests.some((call) => call.method === 'objects.has'),
    'Fresh project source still gets checked and transferred',
  )
  assert.equal(
    f.transport.requests.filter((call) => call.method === 'assets.prepare')
      .length,
    1,
  )
})

test('immutable asset validation survives blob-LRU eviction without retaining another manifest array', async (t) => {
  const f = await cluster(t)
  await f.ready()
  const dependencies = (await f.blobs.seal([], 'dependencies')).hash
  const input = { ...f.input, dependencies }
  const counts = new Map()
  const manifest = f.blobs.manifest.bind(f.blobs)
  f.blobs.manifest = (hash, ...args) => {
    counts.set(hash, (counts.get(hash) || 0) + 1)
    return manifest(hash, ...args)
  }
  assert.equal((await f.controller.run(input, options())).code, 0)
  const before = new Map(counts)
  f.blobs.manifestCache.clear()
  f.blobs.manifestCacheBytes = 0
  assert.equal(
    (await f.controller.run(input, options({ jobId: 'again' }))).code,
    0,
  )
  assert.equal(
    counts.get(input.toolchain.manifest),
    before.get(input.toolchain.manifest),
  )
  assert.equal(counts.get(dependencies), before.get(dependencies))
  assert(
    counts.get(input.sourceManifest) > before.get(input.sourceManifest),
    'Project snapshot validation is never bypassed',
  )
})

test('held editors use fewer status polls while cancellation wakes cleanup immediately', async (t) => {
  const f = await cluster(t, {
    nodes: [editorNode()],
    timing: { editorPollMs: 10000 },
  })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input)
  f.transport.requests.length = 0
  const editor = await f.controller.openEditor(
    f.input,
    options({ jobId: 'quiet-editor' }),
  )
  assert(editor)
  editor.stdout.resume()
  editor.stderr.resume()
  await delay(200)
  const polls = f.transport.requests.filter(
    (call) => call.method === 'attempt.get',
  )
  assert(polls.length <= 3, `Unexpected editor polling: ${polls.length}`)
  editor.kill()
  await until(() => f.controller.status().active === 0, 1000)
  assert.deepEqual(counts(f.controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('shutdown keeps the controller lease until the owner has drained capture helpers', async (t) => {
  const f = await cluster(t)
  await f.ready()
  const drained = Promise.withResolvers()
  const stopped = f.controller.shutdown({ beforeRelease: drained.promise })
  await delay(20)
  const other = f.make()
  try {
    await assert.rejects(other.init(), { code: 'controller_locked' })
  } finally {
    drained.resolve()
    await stopped
  }
  const next = f.make()
  await next.init()
  await until(() => next.status().ready === 1)
})

test('storage exhaustion before start releases its grant and permits safe local fallback', async (t) => {
  const f = await cluster(t)
  await f.ready()
  f.transport.hook = ({ method, params, options, request }) => {
    if (method === 'objects.put')
      throw new RpcError('Storage full', { code: 'storage_full', status: 507 })
    return request(method, params, options)
  }
  assert.equal(await f.controller.run(f.input, options()), null)
  assert.equal(f.workers.get('node-a').runtime.runs.length, 0)
  assert(!f.transport.requests.some((call) => call.method === 'attempt.start'))
  assert.deepEqual(counts(f.controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
  const calls = f.transport.requests.filter((call) =>
    call.method.startsWith('objects.'),
  ).length
  assert.equal(
    await f.controller.run(f.input, options({ jobId: 'backoff' })),
    null,
  )
  assert.equal(
    f.transport.requests.filter((call) => call.method.startsWith('objects.'))
      .length,
    calls,
  )
})

test('uploads resume from the worker offset in bulk-channel chunks', async (t) => {
  const content = Buffer.from('x'.repeat(600 * 1024))
  const { controller, workers, transport, input, ready } = await cluster(t, {
    files: { 'Big.lean': content.toString() },
  })
  const { worker } = workers.get('node-a')
  const hash = sha256(content)
  await worker.blobs.writeChunk({
    hash,
    offset: 0,
    data: content.subarray(0, 256 * 1024).toString('base64'),
    totalBytes: content.length,
    final: false,
  })
  await ready()
  assert.equal((await controller.run(input, options())).code, 0)
  const puts = transport.requests.filter(
    (entry) => entry.method === 'objects.put' && entry.params.hash === hash,
  )
  assert.deepEqual(
    puts.map(({ channel, params }) => [channel, params.offset, params.final]),
    [
      ['bulk', 256 * 1024, false],
      ['bulk', 512 * 1024, true],
    ],
  )
  assert.deepEqual(await worker.blobs.has([hash]), [hash])
})

test('independent concurrent checks pipeline objects within one shared connection limit', async (t) => {
  const files = (prefix) =>
    Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `${prefix}${index}.lean`,
        `-- ${prefix}${index}\nexample : True := by trivial\n`,
      ]),
    )
  const firstFiles = files('First'),
    secondFiles = files('Second')
  const { controller, workers, transport, input, blobs, ready } = await cluster(
    t,
    { files: firstFiles },
  )
  const other = await snapshot(blobs, secondFiles)
  const hashes = new Set(
    Object.values({ ...firstFiles, ...secondFiles }).map((text) =>
      sha256(Buffer.from(text)),
    ),
  )
  const secondHashes = new Set(
    Object.values(secondFiles).map((text) => sha256(Buffer.from(text))),
  )
  const gate = Promise.withResolvers()
  let active = 0,
    peak = 0,
    secondStarted = false
  const offsets = new Map()
  transport.hook = async ({ method, params, options, request }) => {
    if (
      method === 'objects.has' &&
      params.hashes.some((hash) => secondHashes.has(hash))
    )
      secondStarted = true
    if (method === 'objects.offset' && hashes.has(params.hash)) {
      active++
      peak = Math.max(peak, active)
      offsets.set(params.hash, (offsets.get(params.hash) || 0) + 1)
      await gate.promise
    }
    const reply = await request(method, params, options)
    if (method === 'objects.put' && params.final && hashes.has(params.hash))
      active--
    return reply
  }
  await ready()
  const first = controller.run(input, options())
  const second = controller.run(
    other,
    options({ actor: 'bob', jobId: 'job-2' }),
  )
  first.catch(() => {})
  second.catch(() => {})
  try {
    await until(() => active === 4 && secondStarted)
    await delay(30)
    assert.equal(active, 4)
    assert.equal(peak, 4)
    assert.equal(workers.get('node-a').runtime.runs.length, 0)
  } finally {
    gate.resolve()
  }
  assert.deepEqual(
    (await Promise.all([first, second])).map((result) => result.code),
    [0, 0],
  )
  assert.equal(peak, 4)
  assert.equal(active, 0)
  assert.equal(offsets.size, 24)
  assert([...offsets.values()].every((count) => count === 1))
  const { worker } = workers.get('node-a')
  for (const text of [
    firstFiles['First0.lean'],
    secondFiles['Second11.lean'],
  ]) {
    assert.equal(
      (await worker.blobs.read(sha256(Buffer.from(text)))).toString(),
      text,
    )
  }
})

test('a failed pipelined object drains active transfers without sending the whole manifest or starting a check', async (t) => {
  const files = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [
      `File${index}.lean`,
      `-- ${index}\nexample : True := by trivial\n`,
    ]),
  )
  const { controller, workers, transport, input, ready } = await cluster(t, {
    files,
  })
  const hashes = new Set(
    Object.values(files).map((text) => sha256(Buffer.from(text))),
  )
  const gate = Promise.withResolvers()
  let firstHash = null,
    rejected = false
  const touched = new Set()
  transport.hook = async ({ method, params, options, request }) => {
    if (method === 'objects.offset' && hashes.has(params.hash)) {
      touched.add(params.hash)
      firstHash ??= params.hash
      if (params.hash !== firstHash) await gate.promise
    }
    const reply = await request(method, params, options)
    if (method === 'objects.put' && params.hash === firstHash) {
      rejected = true
      return { ...reply, offset: reply.offset + 1 }
    }
    return reply
  }
  await ready()
  const run = controller.run(input, options())
  const stopped = assert.rejects(run, { code: 'worker_upload_failed' })
  try {
    await until(() => rejected)
    await delay(30)
    assert(touched.size <= 4)
    assert.equal(workers.get('node-a').runtime.runs.length, 0)
  } finally {
    gate.resolve()
  }
  await stopped
  assert(touched.size <= 4)
  assert(!transport.requests.some((entry) => entry.method === 'attempt.start'))
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
  let active = 0,
    peak = 0
  transport.hook = async ({ method, params, options, request }) => {
    if (method !== 'objects.offset' || !hashes.has(params.hash))
      return request(method, params, options)
    active++
    peak = Math.max(peak, active)
    try {
      await delay(10)
      return await request(method, params, options)
    } finally {
      active--
    }
  }
  assert.equal(
    (await controller.run(input, options({ jobId: 'after-upload-failure' })))
      .code,
    0,
  )
  assert.equal(
    peak,
    4,
    'A failed transfer must release every slot on the same connection',
  )
})

test('concurrent checks share an input upload even when one waiting check is cancelled', async (t) => {
  const content = 'x'.repeat(600 * 1024),
    hash = sha256(content)
  const { controller, workers, transport, input, ready } = await cluster(t, {
    files: { 'Big.lean': content },
  })
  await ready()
  const gate = Promise.withResolvers()
  let paused = false
  transport.hook = async ({ method, params, options, request }) => {
    if (
      method === 'objects.put' &&
      params.hash === hash &&
      params.offset === 0
    ) {
      paused = true
      await gate.promise
    }
    return request(method, params, options)
  }
  const abort = new AbortController()
  const first = controller.run(input, options({ signal: abort.signal }))
  const stopped = assert.rejects(first, /upload cancelled/)
  await until(() => paused)
  const second = controller.run(
    input,
    options({ actor: 'bob', jobId: 'job-2' }),
  )
  await until(() => controller.status().active === 2)
  abort.abort(new Error('upload cancelled'))
  await stopped
  gate.resolve()
  assert.equal((await second).code, 0)
  assert.equal(workers.get('node-a').runtime.runs.length, 1)
  const chunks = transport.requests.filter(
    (r) => r.method === 'objects.put' && r.params.hash === hash,
  )
  assert.deepEqual(
    chunks.map((r) => r.params.offset),
    [0, 256 * 1024, 512 * 1024],
  )
})

test('native checks wait for the previous native check while ordinary work can fill remaining capacity', async (t) => {
  const { controller, workers, input, ready } = await cluster(t, {
    nodes: [{ id: 'node-a', memoryBudget: '8g' }],
  })
  const { runtime } = workers.get('node-a'),
    gates = hold(runtime)
  await ready()
  const first = controller.run(
    input,
    options({ operation: 'check.kernel', jobId: 'kernel-1' }),
  )
  await until(() => runtime.runs.length === 1)
  const next = controller.run(
    input,
    options({ operation: 'check.kernel', actor: 'bob', jobId: 'kernel-2' }),
  )
  const ordinary = controller.run(
    input,
    options({ actor: 'carol', jobId: 'ordinary' }),
  )
  await until(
    () => runtime.runs.length === 2 && controller.status().queued === 1,
  )
  gates[1]()
  assert.equal((await ordinary).code, 0)
  assert.equal(runtime.runs.length, 2)
  gates[0]()
  await first
  await until(() => runtime.runs.length === 3)
  gates[2]()
  assert.equal((await next).code, 0)
})

test('a wrong upload acknowledgement fails the check before it starts', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  transport.hook = async ({ method, params, options, request }) => {
    const reply = await request(method, params, options)
    return method === 'objects.put'
      ? { ...reply, offset: reply.offset + 1 }
      : reply
  }
  await ready()
  await assert.rejects(controller.run(input, options()), {
    code: 'worker_upload_failed',
  })
  assert.equal(workers.get('node-a').runtime.runs.length, 0)
  assert.ok(
    !transport.requests.some((entry) => entry.method === 'attempt.start'),
  )
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('a worker with another release or image is never used', async (t) => {
  const other = await cluster(t, {
    nodes: [{ id: 'node-a', bundle: 'c'.repeat(64) }],
  })
  await until(
    () => other.controller.status().workers[0].error === 'release_mismatch',
  )
  assert.equal(other.controller.status().ready, 0)
  assert.equal(await other.controller.run(other.input, options()), null)
  assert.ok(other.transport.requests.every((entry) => entry.method === 'hello'))

  const image = await cluster(t)
  image.transport.hook = async ({ method, params, options, request }) => {
    const reply = await request(method, params, options)
    return method === 'hello'
      ? { ...reply, imageDigest: `sha256:${'d'.repeat(64)}` }
      : reply
  }
  image.transport.opened.forEach(({ rpc }) => rpc.close(new Error('reset')))
  await until(
    () => image.controller.status().workers[0].error === 'release_mismatch',
  )
  assert.equal(await image.controller.run(image.input, options()), null)
})

test('a worker-specific image pin is enforced in handshakes, editor grants and check result fences', async (t) => {
  const imageDigest = `sha256:${'d'.repeat(64)}`
  const f = await cluster(t, { nodes: [editorNode({ imageDigest })] })
  await f.ready()
  await f.controller.prepareNode('node-a', f.input, { certify: true })
  assert.equal(f.controller.editorCapacity(), 2)
  const result = await f.controller.run(f.input, options())
  assert.equal(result.code, 0)
  const editor = await f.controller.openEditor(
    f.input,
    options({ jobId: 'pinned-editor' }),
  )
  assert(editor)
  editor.stdout.resume()
  editor.stderr.resume()
  const starts = f.transport.requests.filter(
    (r) => r.method === 'attempt.start',
  )
  assert.equal(starts.length, 2)
  assert(starts.every((r) => r.params.imageDigest === imageDigest))
  assert(
    f.transport.requests
      .filter((r) => r.method === 'hello')
      .every((r) => r.params.imageDigest === imageDigest),
  )
  editor.kill()
  await until(() => f.controller.status().active === 0)
  f.transport.hook = async ({ method, params, options, request }) => {
    const reply = await request(method, params, options)
    return method === 'attempt.get' && reply.attempt.state === 'completed'
      ? { ...reply, attempt: { ...reply.attempt, imageDigest: IMAGE } }
      : reply
  }
  await assert.rejects(
    f.controller.run(f.input, options({ jobId: 'wrong-result-pin' })),
    { code: 'invalid_result' },
  )
  const archive = await f.blobs.put(Buffer.from('mock image archive'))
  f.transport.hook = async ({ method, params, options, request }) => {
    if (method === 'images.load') {
      assert.equal(params.imageDigest, imageDigest)
      return f.workers.get('node-a').worker.status()
    }
    return request(method, params, options)
  }
  assert.equal(
    (await f.controller.loadImage('node-a', archive.hash)).imageDigest,
    imageDigest,
  )
  f.transport.hook = async ({ method, params, options, request }) => {
    const reply = await request(method, params, options)
    return method === 'hello' ? { ...reply, imageDigest: IMAGE } : reply
  }
  f.transport.opened.forEach(({ rpc }) => rpc.close(new Error('reset')))
  await until(
    () => f.controller.status().workers[0].error === 'release_mismatch',
  )
  assert.equal(
    await f.controller.run(f.input, options({ jobId: 'wrong-pin' })),
    null,
  )
})

test('mixed image stores keep each image pin bound to its enrolled worker', async (t) => {
  const alternate = `sha256:${'d'.repeat(64)}`
  const f = await cluster(t, {
    nodes: [{ id: 'node-a' }, { id: 'node-b', imageDigest: alternate }],
  })
  await f.ready()
  const gates = [...f.workers.values()].map(({ runtime }) => hold(runtime))
  const jobs = [0, 1].map((index) =>
    f.controller.run(
      f.input,
      options({
        operation: 'check.kernel',
        actor: 'user-' + index,
        jobId: 'mixed-' + index,
      }),
    ),
  )
  await until(() =>
    [...f.workers.values()].every(({ runtime }) => runtime.runs.length === 1),
  )
  for (const row of f.transport.requests.filter((r) =>
    ['hello', 'attempt.start'].includes(r.method),
  ))
    assert.equal(
      row.params.imageDigest,
      row.node === 'node-a' ? IMAGE : alternate,
    )
  gates.forEach((gate) => gate[0]())
  assert((await Promise.all(jobs)).every((result) => result.code === 0))
  f.transport.hook = async ({ node, method, params, options, request }) => {
    const reply = await request(method, params, options)
    return method === 'hello'
      ? { ...reply, imageDigest: node === 'node-a' ? alternate : IMAGE }
      : reply
  }
  f.transport.opened.forEach(({ rpc }) => rpc.close(new Error('swap pins')))
  await until(() =>
    f.controller
      .status()
      .workers.every((worker) => worker.error === 'release_mismatch'),
  )
  assert.equal(f.controller.status().ready, 0)
  assert.equal(
    await f.controller.run(f.input, options({ jobId: 'swapped' })),
    null,
  )
})

test('losing bulk while independent uploads have active and queued transfers permits a fresh four-way upload', async (t) => {
  const files = (prefix) =>
    Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `${prefix}${index}.lean`,
        `-- ${prefix}${index}\nexample : True := by trivial\n`,
      ]),
    )
  const firstFiles = files('First'),
    secondFiles = files('Second')
  const { controller, workers, transport, input, blobs, ready } = await cluster(
    t,
    { files: firstFiles },
  )
  const other = await snapshot(blobs, secondFiles)
  const hashes = new Set(
    Object.values({ ...firstFiles, ...secondFiles }).map((text) =>
      sha256(Buffer.from(text)),
    ),
  )
  const secondHash = sha256(Buffer.from(secondFiles['Second0.lean']))
  const { worker, runtime } = workers.get('node-a')
  const offset = worker.blobs.offset.bind(worker.blobs)
  const gate = Promise.withResolvers()
  let active = 0,
    peak = 0
  worker.blobs.offset = async (hash) => {
    if (!hashes.has(hash)) return offset(hash)
    active++
    peak = Math.max(peak, active)
    try {
      await gate.promise
      return await offset(hash)
    } finally {
      active--
    }
  }
  await ready()
  const first = controller.run(input, options())
  const second = controller.run(
    other,
    options({ actor: 'bob', jobId: 'other-upload' }),
  )
  const stopped = [first, second].map((run) =>
    assert.rejects(run, { code: 'worker_upload_failed' }),
  )
  try {
    await until(
      () =>
        active === 4 &&
        transport.requests.some(
          (entry) =>
            entry.method === 'objects.has' &&
            entry.params.hashes.includes(secondHash),
        ),
    )
    await delay(30)
    assert.equal(peak, 4)
    closeChannel(transport, 'node-a', 'bulk')
    await Promise.all(stopped)
    assert.equal(runtime.runs.length, 0)
  } finally {
    gate.resolve()
  }
  await until(() => active === 0)
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
  assert.equal(controller.status().ready, 1)
  peak = 0
  worker.blobs.offset = async (hash) => {
    if (!hashes.has(hash)) return offset(hash)
    active++
    peak = Math.max(peak, active)
    try {
      await delay(10)
      return await offset(hash)
    } finally {
      active--
    }
  }
  assert.equal(
    (
      await controller.run(
        input,
        options({ jobId: 'after-mid-upload-bulk-loss' }),
      )
    ).code,
    0,
  )
  assert.equal(peak, 4)
  assert.equal(
    transport.opened.filter((entry) => entry.channel === 'bulk').length,
    2,
  )
})

test('losing the bulk channel keeps leases and cancellation on the control channel', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t)
  const { worker, runtime } = workers.get('node-a')
  const gates = hold(runtime)
  await ready()
  const abort = new AbortController()
  const running = controller.run(input, options({ signal: abort.signal }))
  await until(() => runtime.runs.length === 1)
  closeChannel(transport, 'node-a', 'bulk')
  const renewals = () =>
    transport.requests.filter((entry) => entry.method === 'lease.renew').length
  const before = renewals()
  await until(() => renewals() >= before + 3)
  assert.equal(controller.status().ready, 1)
  const reason = new Error('Stopped by the user.')
  abort.abort(reason)
  await assert.rejects(running, (error) => error === reason)
  assert.equal(worker.state.list()[0].state, 'cancelled')
  for (const { method, channel } of transport.requests)
    if (['lease.renew', 'attempt.get', 'attempt.cancel'].includes(method))
      assert.equal(channel, 'control')

  const next = controller.run(input, options({ jobId: 'job-2' }))
  await until(() => runtime.runs.length === 2)
  gates[1]()
  assert.equal((await next).code, 0)
  const bulk = transport.opened.filter((entry) => entry.channel === 'bulk')
  assert.equal(bulk.length, 2)
})

test('worker results are validated and only documented fields are returned', async (t) => {
  const { controller, workers, input, ready } = await cluster(t)
  const { runtime } = workers.get('node-a')
  await ready()
  runtime.behavior = async () =>
    JSON.parse(
      '{"__proto__":{"polluted":true},"code":0,"stdout":"ok","stderr":"","extra":"ignored"}',
    )
  const result = await controller.run(input, options())
  assert.deepEqual(result, {
    code: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    cancelled: false,
    truncated: false,
  })
  assert.equal(Object.getPrototypeOf(result), Object.prototype)
  assert.equal(result.polluted, undefined)
  const malformed = [
    [1, 2],
    { code: '0', stdout: '', stderr: '' },
    { code: null, stdout: '', stderr: '' },
    { code: 0, stdout: 1, stderr: '' },
    { code: 0, stdout: '', stderr: '', timedOut: 'no' },
  ]
  for (const [index, value] of malformed.entries()) {
    runtime.behavior = async () => value
    await assert.rejects(
      controller.run(input, options({ jobId: `bad-${index}` })),
      { code: 'invalid_result' },
    )
  }
  assert.deepEqual(counts(controller.status()), {
    active: 0,
    held: 0,
    queued: 0,
  })
})

test('kernel checks reserve three slots and never fall back to a weaker check', async (t) => {
  const { controller, workers, transport, input, ready } = await cluster(t, {
    nodes: [
      { id: 'node-a', capabilities: ['check.build', 'lean.file'] },
      { id: 'node-b', memoryBudget: '2g' },
      { id: 'node-c' },
    ],
  })
  await ready(3)
  const kernel = await controller.run(
    input,
    options({ operation: 'check.kernel' }),
  )
  assert.equal(kernel.code, 0)
  const [attempt] = workers.get('node-c').worker.state.list()
  assert.equal(attempt.operation, 'check.kernel')
  assert.deepEqual(attempt.resources, {
    memoryBytes: 3 * GIB,
    cpus: 3,
    scratchBytes: 16 * GIB,
  })
  for (const id of ['node-a', 'node-b'])
    assert.deepEqual(workers.get(id).worker.state.list(), [])

  transport.offline.add('node-c')
  closeChannel(transport, 'node-c', 'control')
  await ready(2)
  assert.equal(
    await controller.run(
      input,
      options({ operation: 'check.kernel', jobId: 'job-2' }),
    ),
    null,
  )
  const file = await controller.run(
    input,
    options({ operation: 'lean.file', file: 'Main.lean', jobId: 'job-3' }),
  )
  assert.equal(file.code, 0)
})

test('one controller owns the database and each start advances its generation', async (t) => {
  const { controller, make, ready } = await cluster(t)
  assert.equal(controller.status().epoch, 1)
  const rival = make()
  await assert.rejects(rival.init(), { code: 'controller_locked' })
  await ready()
  await controller.shutdown()
  const next = make()
  await next.init()
  assert.equal(next.status().epoch, 2)
  await until(() => next.status().ready === 1)
})

test('shutdown resolves queued checks and leaves unconfirmed attempts to the next controller', async (t) => {
  const { controller, workers, transport, input, make, ready } = await cluster(
    t,
    { nodes: [{ id: 'node-a', memoryBudget: '1g' }] },
  )
  const { worker, runtime } = workers.get('node-a')
  hold(runtime)
  await ready()
  const active = controller.run(input, options())
  const interrupted = assert.rejects(active, {
    code: 'worker_cleanup',
    workerCleanup: true,
  })
  await until(() => runtime.runs.length === 1)
  const queued = controller.run(
    input,
    options({ actor: 'bob', jobId: 'job-2' }),
  )
  await until(() => controller.status().queued === 1)
  transport.hook = refuseCancel
  const summary = await controller.shutdown()
  assert.equal(await queued, null)
  await interrupted
  assert.deepEqual(summary, { cancelled: 1, unresolved: 1 })
  assert.equal(await controller.run(input, options({ jobId: 'job-3' })), null)

  transport.hook = null
  transport.offline.add('node-a')
  const next = make()
  await next.init()
  assert.equal(next.status().held, 1)
  transport.offline.delete('node-a')
  await until(() => next.status().held === 0 && next.status().ready === 1)
  assert.equal(worker.state.list()[0].state, 'cancelled')
})

test('shutdown rejects active checks only after the worker confirms they stopped', async (t) => {
  const { controller, workers, input, ready } = await cluster(t)
  const { worker, runtime } = workers.get('node-a')
  hold(runtime)
  await ready()
  const active = controller.run(input, options())
  await until(() => runtime.runs.length === 1)
  assert.deepEqual(await controller.shutdown(), {
    cancelled: 1,
    unresolved: 0,
  })
  await assert.rejects(active, { code: 'cluster_stopping' })
  assert.equal(worker.state.list()[0].state, 'cancelled')
})

test('worker SSH uses fixed options and only the protocol commands', () => {
  const node = {
    id: 'node-a',
    host: 'worker.example',
    user: 'leanflow',
    port: 2222,
    identityFile: '/etc/leanflow/.ssh/id_ed25519',
    knownHostsFile: '/etc/leanflow/known_hosts',
    sshOptions: ['-oProxyCommand=sh'],
    command: 'sh',
  }
  assert.equal(SSH_BINARY, '/usr/bin/ssh')
  const args = sshArguments(node)
  assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null'])
  assert.deepEqual(args.slice(-8), [
    '-p',
    '2222',
    '-l',
    'leanflow',
    '-T',
    '--',
    'worker.example',
    'leanflow-node-control',
  ])
  assert.equal(sshArguments(node, 'bulk').at(-1), 'leanflow-node-bulk')
  for (const option of [
    'StrictHostKeyChecking=yes',
    'UserKnownHostsFile=/etc/leanflow/known_hosts',
    'IdentitiesOnly=yes',
    'IdentityAgent=none',
    'IdentityFile=/etc/leanflow/.ssh/id_ed25519',
    'BatchMode=yes',
    'RequestTTY=no',
    'ClearAllForwardings=yes',
  ])
    assert.ok(args.includes(option), option)
  assert.ok(!args.includes('sh'))
  assert.ok(!args.some((arg) => arg.includes('ProxyCommand=sh')))
  assert.throws(() => sshArguments(node, 'shell'))
  for (const change of [
    { knownHostsFile: '/etc/known hosts' },
    { identityFile: '/etc/%d/id' },
    { identityFile: '/etc/leanflow/../id' },
    { host: '-oProxyCommand=sh' },
    { user: 'root;sh' },
  ])
    assert.throws(() => sshArguments({ ...node, ...change }))
})
