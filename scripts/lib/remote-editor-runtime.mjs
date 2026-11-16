import assert from 'node:assert/strict'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WorkerNode } from '../../server/cluster/node.mjs'
import { ClusterController } from '../../server/cluster/controller.mjs'
import { BlobStore, captureTree } from '../../server/cluster/blobs.mjs'
import { FramedRpc } from '../../server/cluster/protocol.mjs'
import { LspFrames, frame } from '../../server/rpc.mjs'
import { sha256 } from '../../server/cluster/state.mjs'

const execute = promisify(execFile)

// Real WorkerNode -> real Runtime/container, over loopback FramedRpc. Only host
// enrollment and its outer slice are simulated; this is not PC certification.
export async function clusterEditorRuntime(
  runtime,
  directory,
  root,
  toolchain,
) {
  const bundle = sha256('isolated-loopback-runtime-fixture')
  const image = runtime.info().imageId
  const worker = new WorkerNode({
    config: {
      version: 1,
      nodeId: 'loopback',
      controllerLineage: 'runtime-fixture',
      dataDir: directory,
      image,
      workerMemory: '1g',
      workerCpus: 2,
      memoryBudget: '6g',
      parentMemoryMax: '8g',
      maxCpus: 4,
      parentMaxCpus: 8,
      maxConcurrent: 3,
      editors: {
        maxConcurrent: 1,
        memory: '3g',
        cpus: runtime.editorCpus,
        cpuReservation: runtime.editorCpus,
      },
    },
    runtime,
    bundleDigest: bundle,
    reap: async () => {},
    boundaryInspector: async () => ({ testFixture: true }),
    leaseAcquire: async () => ({ release: async () => {} }),
  })
  const blobs = await new BlobStore(
    path.join(directory, 'loopback-objects'),
  ).init()
  let controller,
    editor,
    stderr = ''
  const until = async (condition, label) => {
    const deadline = Date.now() + 30000
    while (!condition()) {
      assert(
        Date.now() < deadline,
        'Timed out: ' + label + ' ' + stderr.slice(-1000),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  try {
    await worker.init()
    // The caller already prepared this actual official toolchain in Runtime.
    // Use a test-only identity to avoid making a second binary payload copy.
    const toolchainManifest = (await blobs.seal([], 'toolchain')).hash
    worker.state.setMeta('toolchains', { [toolchain]: toolchainManifest })
    worker.state.setMeta('certification', {
      nodeEpoch: worker.nodeEpoch,
      bundleDigest: bundle,
      imageDigest: image,
      engineKind: 'docker',
      capabilities: ['check.build', 'lean.file', 'lean.session'],
    })
    controller = new ClusterController({
      config: {
        version: 1,
        lineage: 'runtime-fixture',
        mode: 'serve',
        editors: { placement: 'prefer' },
        nodes: [
          {
            id: 'loopback',
            host: 'fixture.invalid',
            user: 'leanflow',
            identityFile: '/unused/test-key',
            knownHostsFile: '/unused/known-hosts',
          },
        ],
      },
      dataDir: path.join(directory, 'loopback-controller'),
      blobs,
      bundleDigest: bundle,
      imageDigest: image,
      timing: { pollMs: 100, eventPollMs: 20, renewMs: 100 },
      transportFactory: () => {
        const upstream = new PassThrough(),
          downstream = new PassThrough()
        worker.attach(upstream, downstream)
        return new FramedRpc(downstream, upstream)
      },
    })
    await controller.init()
    await until(
      () => controller.status().ready === 1,
      'loopback worker readiness',
    )
    const source = await captureTree(blobs, root, { ignoreLake: true })
    editor = await controller.openEditor(
      {
        sourceManifest: source.hash,
        toolchain: { version: toolchain, manifest: toolchainManifest },
      },
      {
        actor: 'fixture-account',
        projectId: 'fixture-project',
        jobId: 'fixture-editor',
        timeoutMs: 30000,
      },
    )
    assert(editor)
    let protocolError,
      stdout = ''
    const responses = new Map()
    const frames = new LspFrames((message) => {
      if (message.id != null) responses.set(message.id, message)
    })
    editor.stdout.on('data', (bytes) => {
      stdout += bytes.toString()
      try {
        frames.push(bytes)
      } catch (error) {
        protocolError = error
        editor.kill()
      }
    })
    editor.stderr.on('data', (bytes) => {
      stderr = (stderr + bytes.toString()).slice(-2000)
    })
    editor.stdin.write(
      frame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          processId: null,
          rootUri: 'file:///workspace',
          capabilities: {},
        },
      }),
    )
    await until(
      () => responses.has(1) || protocolError,
      'production-path initialization',
    )
    assert.ifError(protocolError)
    assert(responses.get(1).result.capabilities)
    editor.stdin.write(
      frame({ jsonrpc: '2.0', method: 'initialized', params: {} }),
    )
    const child = [...worker.running.values()][0].child
    const inspected = JSON.parse(
      (
        await execute(
          runtime.docker,
          ['inspect', '--format', '{{json .}}', child.containerName],
          { maxBuffer: 1024 * 1024, timeout: 5000 },
        )
      ).stdout,
    )
    assert(
      !inspected.Config.Cmd.includes('--then-lean'),
      'editor must not invoke a post-elaboration compiler',
    )
    assert.deepEqual(inspected.Config.Cmd.slice(-3), ['lake', 'serve', '--'])
    assert.equal(inspected.HostConfig.Memory, 3 * 1024 ** 3)
    assert.equal(inspected.HostConfig.MemorySwap, 3 * 1024 ** 3)
    assert.equal(
      inspected.HostConfig.NanoCpus,
      Math.round(runtime.editorCpus * 1e9),
    )
    assert.equal(inspected.HostConfig.NetworkMode, 'none')
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true)
    assert(!inspected.Mounts.some((mount) => mount.Type === 'bind' && mount.RW))
    editor.stdin.write(
      frame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }),
    )
    await until(
      () => responses.has(2) || protocolError,
      'graceful LSP shutdown',
    )
    assert.ifError(protocolError)
    editor.stdin.end(frame({ jsonrpc: '2.0', method: 'exit', params: {} }))
    await until(
      () => controller.status().active === 0 && worker.running.size === 0,
      'confirmed editor cleanup',
    )
    assert.ifError(protocolError)
    assert.equal(frames.bytes, 0, 'no non-LSP compiler output follows exit')
    assert(!stdout.includes('NO_POST_CHECK_ALLOWED'))
    const attempt = worker.state
      .list()
      .find((value) => value.operation === 'lean.session')
    assert.equal(attempt.state, 'completed')
    assert.equal(
      JSON.parse((await worker.blobs.read(attempt.result.hash)).toString())
        .code,
      0,
    )
    assert.equal(controller.status().held, 0)
    return {
      passed: true,
      hostEnrollmentSimulated: true,
      transport: 'loopback-framed-rpc',
      realWorkerNodeAndRuntime: true,
      noPostCompiler: true,
      memoryBytes: inspected.HostConfig.Memory,
      cpus: runtime.editorCpus,
      gracefulExit: true,
      cleanupConfirmed: true,
    }
  } finally {
    editor?.kill()
    await controller?.shutdown()
    await worker.close()
    blobs.close()
  }
}
