#!/usr/bin/env node
import net from 'node:net'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { Runtime } from '../runtime.mjs'
import { removeDisposableTree } from '../temporary-workspaces.mjs'
import { toolchainName } from '../lean-check.mjs'
import { FramedRpc, PROTOCOL_VERSION } from './protocol.mjs'
import {
  ClusterState,
  clusterError,
  digest,
  identifier,
  resourceVector,
  executionDigest,
  sha256,
} from './state.mjs'
import { BlobStore, contentPath, snapshotDirectory } from './blobs.mjs'
import { nodeConfig, readNodeConfig, workerBundleDigest } from './config.mjs'
import { certifyWorker } from './conformance.mjs'
import { inspectBoundary } from './boundary.mjs'
import { acquireServerLease } from '../lease.mjs'
import { StorageCapacity } from '../storage-capacity.mjs'

const execute = promisify(execFile)
const terminal = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'lost',
])
const operations = new Set(['check.build', 'check.kernel', 'lean.file'])

function safeWorkerError(error) {
  if (
    error?.status &&
    typeof error.code === 'string' &&
    !error.code.startsWith('E')
  )
    return error
  return clusterError(
    'The execution worker could not finish this operation.',
    'worker_failed',
    503,
  )
}

export class WorkerNode {
  constructor({
    config,
    runtime,
    bundleDigest,
    certifier = certifyWorker,
    reap,
    boundaryInspector = inspectBoundary,
    leaseAcquire = acquireServerLease,
    verifyToolchain,
  } = {}) {
    this.config = nodeConfig(config)
    this.runtime =
      runtime ||
      new Runtime({
        dataDir: this.config.dataDir,
        image: this.config.image,
        docker: this.config.engineExecutable,
        engineKind: this.config.engineKind,
        memory: this.config.workerMemory,
        memoryBudget: this.config.memoryBudget,
        cpus: this.config.workerCpus,
        maxConcurrent: this.config.maxConcurrent,
        cgroupParent: this.config.cgroupParent,
        scope: 'node',
        hostToolchainDir: path.join(
          this.config.dataDir,
          'runtime/elan/toolchains',
        ),
      })
    this.expectedBundle = bundleDigest
    this.certifier = certifier
    this.boundaryInspector = boundaryInspector
    this.leaseAcquire = leaseAcquire
    this.verifyToolchain =
      verifyToolchain ||
      (async (version, directory) => {
        const binary = await fs.realpath(path.join(directory, 'bin/lean'))
        if (
          !binary.startsWith(directory + path.sep) ||
          !(await fs.stat(binary)).isFile()
        )
          throw clusterError(
            'The toolchain manifest has no owned Lean executable.',
          )
        await this.runtime.prepareToolchain(version)
      })
    this.reap = reap || (() => this.#reapOwnedContainers())
    this.nodeEpoch = randomUUID()
    this.running = new Map()
    this.peers = new Set()
    this.preparing = new Map()
    this.closed = false
    this.operations = new Set()
    this.shutdownController = new AbortController()
    this.storage = new StorageCapacity({
      dataDir: this.config.dataDir,
      minimumFreeBytes: this.config.reserveBytes,
      warningFreeBytes: this.config.reserveBytes,
      allocationBytes: 16 * 1024 ** 2,
    })
  }

  async init() {
    if (process.getuid?.() === 0)
      throw clusterError(
        'Run the worker daemon as its dedicated non-root service account.',
      )
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 })
    const storage = await fs.stat(this.config.dataDir)
    if (storage.uid !== process.getuid() || storage.mode & 0o077)
      throw clusterError(
        'Worker state must be owned privately by its service account.',
      )
    if ((await fs.realpath(this.config.dataDir)) !== this.config.dataDir)
      throw clusterError('Worker state must use a real local directory.')
    this.lease = await this.leaseAcquire(this.config.dataDir, {
      scriptPath: fileURLToPath(import.meta.url),
    })
    try {
      this.state = new ClusterState({
        filename: path.join(this.config.dataDir, 'node.sqlite'),
      })
      this.blobs = await new BlobStore(
        path.join(this.config.dataDir, 'blobs'),
        {
          maxBytes: this.config.maxStoreBytes,
          maxFiles: this.config.maxStoreFiles,
          reserveBytes: this.config.reserveBytes,
        },
      ).init()
      this.bundleDigest = this.expectedBundle || (await workerBundleDigest())
      try {
        this.boundary = await this.boundaryInspector(this.config)
      } catch {
        this.recoveryError =
          'The dedicated container resource boundary is unavailable.'
      }
      if (this.boundary) await this.#initializeRuntime()
      const installed = this.state.meta('toolchains') || {}
      for (const [version, hash] of Object.entries(installed)) {
        const root = path.join(
          this.config.dataDir,
          'runtime/elan/toolchains',
          toolchainName(version),
        )
        try {
          if ((await fs.realpath(root)) !== root) continue
          digest(hash)
          this.runtime.toolchains.set(version, root)
        } catch {
          /* An incomplete asset is prepared again, never advertised. */
        }
      }
      this.timer = setInterval(() => {
        for (const [id, running] of this.running)
          if (running.deadline < performance.now())
            void this.cancel(id, 'lease-expired').catch(() => {})
      }, 500)
      this.timer.unref()
      if (
        this.config.certifyToolchain &&
        this.runtime.toolchains.has(this.config.certifyToolchain) &&
        this.runtime.info().ready &&
        !this.recoveryError
      ) {
        const task = Promise.resolve()
          .then(() => {
            if (!this.closed)
              return this.certify({ toolchain: this.config.certifyToolchain })
          })
          .catch((error) => {
            this.certificationError = safeWorkerError(error).message
          })
          .finally(() => this.operations.delete(task))
        this.operations.add(task)
        this.certificationTask = task
      }
      return this
    } catch (error) {
      await this.close().catch(() => {})
      throw error
    }
  }

  async #initializeRuntime() {
    await this.runtime.init()
    try {
      await this.reap()
      for (const attempt of this.state.list({ active: true }))
        this.state.transition(attempt.id, 'lost', {
          reason: 'worker-restarted',
        })
      this.recoveryError = null
      const info = this.runtime.info()
      if (info.cgroupDriver !== 'systemd' || info.cgroupVersion !== '2')
        this.recoveryError =
          'Workers require the systemd cgroup driver on cgroup v2.'
    } catch {
      this.recoveryError =
        'Owned worker processes require reconciliation before new work.'
    }
  }

  status() {
    const runtime = this.runtime.info()
    const certification = this.state.meta('certification')
    const certified =
      certification?.nodeEpoch === this.nodeEpoch &&
      certification?.bundleDigest === this.bundleDigest &&
      certification?.imageDigest === runtime.imageId &&
      certification?.engineKind === this.config.engineKind
    return {
      version: PROTOCOL_VERSION,
      nodeId: this.config.nodeId,
      nodeEpoch: this.nodeEpoch,
      bundleDigest: this.bundleDigest,
      imageDigest: runtime.imageId || this.config.image,
      status:
        runtime.ready && !this.recoveryError && !this.maintenance
          ? 'ready'
          : 'unavailable',
      capabilities: certified
        ? certification.capabilities.filter((value) => operations.has(value))
        : [],
      budget: {
        memoryBytes: this.config.budgetBytes,
        cpus: this.config.maxCpus,
        scratchBytes: this.config.scratchBytes,
      },
      role: this.config.role,
      running: this.running.size,
      leaseMs: this.config.leaseMs,
      workerResources: {
        memoryBytes: this.config.memoryBytes,
        cpus: this.config.workerCpus,
      },
      boundary: this.boundary || null,
      certified: !!certified,
      error:
        this.recoveryError ||
        (runtime.ready
          ? null
          : 'Worker engine or pinned image is unavailable.'),
    }
  }

  attach(readable, writable) {
    const rpc = new FramedRpc(readable, writable)
    const context = { identity: null }
    this.peers.add(rpc)
    rpc.on('close', () => this.peers.delete(rpc))
    const handle = (method, action, authenticated = true) =>
      rpc.handle(method, async (value) => {
        try {
          if (this.closed)
            throw clusterError(
              'Worker is shutting down.',
              'worker_stopping',
              503,
            )
          if (authenticated) this.#authorize(context)
          const task = Promise.resolve(action(value, context))
          this.operations.add(task)
          try {
            return await task
          } finally {
            this.operations.delete(task)
          }
        } catch (error) {
          throw safeWorkerError(error)
        }
      })
    handle(
      'hello',
      async (value) => {
        if (
          value?.version !== PROTOCOL_VERSION ||
          value.bundleDigest !== this.bundleDigest ||
          value.imageDigest !== this.config.image
        )
          throw clusterError(
            'Worker release or image does not match the controller.',
            'release_mismatch',
            409,
          )
        context.identity = this.state.acceptController(
          { lineage: value.lineage, epoch: value.epoch },
          this.config.controllerLineage,
        )
        return this.status()
      },
      false,
    )
    handle('status', () => this.status())
    handle('objects.has', (value) => this.blobs.has(value?.hashes))
    handle('objects.offset', (value) => this.blobs.offset(value?.hash))
    handle('objects.put', (value) => this.blobs.writeChunk(value))
    handle('objects.get', (value) =>
      this.blobs.readChunk(value?.hash, value?.offset, value?.length),
    )
    handle('assets.prepare', (value) => this.prepareAssets(value))
    handle('history.compact', async (_value, current) => {
      if (
        this.running.size ||
        this.preparing.size ||
        this.maintenance ||
        this.recoveryError
      )
        throw clusterError(
          'Drain and reconcile the worker before cache maintenance.',
          'worker_busy',
          409,
        )
      this.maintenance = true
      try {
        for (const hash of Object.keys(this.state.meta('dependencies') || {})) {
          digest(hash)
          await removeDisposableTree(
            path.join(this.config.dataDir, 'runtime/shared-dependencies', hash),
          )
        }
        this.state.setMeta('dependencies', {})
        await this.blobs.reset()
        return this.state.compactHistory(current.identity.epoch)
      } finally {
        this.maintenance = false
      }
    })
    handle('images.load', async (value) => {
      if (this.running.size || this.maintenance)
        throw clusterError(
          'Drain the worker before loading its image.',
          'worker_busy',
          409,
        )
      if (value?.imageDigest !== this.config.image)
        throw clusterError(
          'The image is not enrolled for this worker.',
          'release_mismatch',
          409,
        )
      digest(value.archive)
      this.maintenance = true
      try {
        if (!(await this.blobs.has([value.archive])).length)
          throw clusterError(
            'The image archive is not uploaded.',
            'assets_missing',
            409,
          )
        this.state.setMeta('certification', null)
        await this.blobs.verify(value.archive)
        this.boundary = await this.boundaryInspector(this.config)
        await execute(
          this.config.engineExecutable,
          ['load', '--input', this.blobs.object(value.archive)],
          { timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
        )
        await this.#initializeRuntime()
        if (this.runtime.info().imageId !== this.config.image)
          throw clusterError(
            'Loaded image identity does not match its enrollment.',
            'release_mismatch',
            409,
          )
      } finally {
        this.maintenance = false
      }
      return this.status()
    })
    handle('attempt.start', (value, current) =>
      this.start(value, current.identity),
    )
    handle('attempt.get', (value) => {
      const attempt = this.state.get(value?.id)
      if (!attempt)
        throw clusterError('Unknown worker attempt.', 'attempt_missing', 404)
      return {
        attempt,
        events: this.state.events(value.id, value.after || 0, 16),
      }
    })
    handle('attempt.cancel', (value, current) =>
      this.cancel(value?.id, 'requested', current.identity),
    )
    handle('lease.renew', (value, current) => {
      if (!Array.isArray(value?.attempts) || value.attempts.length > 128)
        throw clusterError('Invalid worker lease renewal.')
      const renewed = []
      for (const id of value.attempts) {
        identifier(id, 'attempt identifier')
        const record = this.running.get(id)
        if (
          record &&
          record.lineage === current.identity.lineage &&
          record.epoch === current.identity.epoch
        ) {
          record.deadline = performance.now() + this.config.leaseMs
          renewed.push(id)
        }
      }
      return { renewed }
    })
    handle('worker.certify', (value) => this.certify(value))
    return rpc
  }

  async certify(value) {
    if (
      this.closed ||
      this.running.size ||
      this.preparing.size ||
      this.maintenance
    )
      throw clusterError(
        'Drain the worker before certification.',
        'worker_busy',
        409,
      )
    this.maintenance = true
    try {
      const report = await this.certifier(this, value)
      if (this.closed)
        throw clusterError('Worker is stopping.', 'worker_stopping', 503)
      this.state.setMeta('certification', report)
      this.certificationError = null
      return report
    } finally {
      this.maintenance = false
    }
  }

  #authorize(context) {
    const latest = this.state.meta('acceptedController')
    if (
      !context.identity ||
      context.identity.lineage !== latest?.lineage ||
      context.identity.epoch !== latest?.epoch
    )
      throw clusterError(
        'Worker connection is not enrolled or is stale.',
        'stale_generation',
        403,
      )
  }

  async prepareAssets(value) {
    if (this.maintenance)
      throw clusterError('The worker is in maintenance.', 'worker_busy', 409)
    if (!value || typeof value !== 'object')
      throw clusterError('Invalid worker assets.')
    if (value.toolchain) {
      const { version, manifest } = value.toolchain
      if (
        typeof version !== 'string' ||
        !/^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/.test(
          version,
        )
      )
        throw clusterError('Invalid pinned toolchain.')
      digest(manifest)
      const destination = path.join(
        this.config.dataDir,
        'runtime/elan/toolchains',
        toolchainName(version),
      )
      await this.#prepareOnce(
        'toolchain:' + version + ':' + manifest,
        async () => {
          const existing = (this.state.meta('toolchains') || {})[version]
          if (
            existing === manifest &&
            (await fs.realpath(destination).catch(() => null)) === destination
          )
            return
          if (existing && existing !== manifest)
            throw clusterError(
              'The installed pinned toolchain changed.',
              'asset_conflict',
              409,
            )
          const metadata = await this.blobs.manifest(manifest)
          if (metadata.kind !== 'toolchain')
            throw clusterError('Invalid toolchain manifest kind.')
          await fs.mkdir(path.dirname(destination), {
            recursive: true,
            mode: 0o700,
          })
          await this.#installManifest(manifest, destination)
          await this.verifyToolchain(version, destination)
          this.state.setMeta('toolchains', {
            ...this.state.meta('toolchains'),
            [version]: manifest,
          })
        },
      )
      this.runtime.toolchains.set(version, destination)
    }
    if (value.dependencies) {
      digest(value.dependencies)
      await this.#prepareOnce(
        'dependencies:' + value.dependencies,
        async () => {
          const installed = this.state.meta('dependencies') || {}
          const root = snapshotDirectory(
            path.join(this.config.dataDir, 'runtime/shared-dependencies'),
            value.dependencies,
          )
          if (
            installed[value.dependencies] &&
            (await fs.realpath(root).catch(() => null)) === root
          )
            return
          const metadata = await this.blobs.manifest(value.dependencies)
          if (metadata.kind !== 'dependencies')
            throw clusterError('Invalid dependency manifest kind.')
          await fs.mkdir(path.dirname(root), {
            recursive: true,
            mode: 0o700,
          })
          await this.#installManifest(value.dependencies, root)
          this.state.setMeta('dependencies', {
            ...this.state.meta('dependencies'),
            [value.dependencies]: true,
          })
        },
      )
    }
    return { ready: true }
  }

  async #prepareOnce(key, action) {
    if (this.preparing.has(key)) return this.preparing.get(key)
    const task = Promise.resolve().then(action)
    this.preparing.set(key, task)
    try {
      return await task
    } finally {
      this.preparing.delete(key)
    }
  }

  async #installManifest(hash, destination) {
    const manifest = await this.blobs.manifest(hash)
    return this.storage.withReservation(
      { bytes: manifest.totalBytes, signal: this.shutdownController.signal },
      () => this.#publishManifest(hash, destination),
    )
  }

  async #publishManifest(hash, destination) {
    const stage = destination + '.stage-' + randomUUID()
    const abandoned = destination + '.abandoned-' + randomUUID()
    await this.blobs.materialize(hash, stage, {
      signal: this.shutdownController.signal,
    })
    let displaced = false
    try {
      try {
        await fs.rename(stage, destination)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        if ((await fs.realpath(destination)) !== destination)
          throw clusterError('An interrupted asset is not an owned directory.')
        await fs.rename(destination, abandoned)
        displaced = true
        try {
          await fs.rename(stage, destination)
        } catch (replacementError) {
          await fs.rename(abandoned, destination)
          displaced = false
          throw replacementError
        }
      }
    } finally {
      await removeDisposableTree(stage)
      if (displaced) await removeDisposableTree(abandoned)
    }
    const parent = await fs.open(path.dirname(destination), 'r')
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  }

  start(value, identity) {
    const status = this.status()
    if (
      !value ||
      value.lineage !== identity.lineage ||
      value.epoch !== identity.epoch ||
      value.nodeId !== this.config.nodeId ||
      value.nodeEpoch !== this.nodeEpoch ||
      value.bundleDigest !== this.bundleDigest ||
      value.imageDigest !== status.imageDigest
    )
      throw clusterError(
        'Attempt identity or release does not match this worker.',
        'stale_attempt',
        409,
      )
    const existing = this.state.get(value.id)
    if (existing)
      return this.state.create({ ...value, state: 'assigned' }).attempt
    if (
      status.status !== 'ready' ||
      !status.capabilities.includes(value.operation)
    )
      throw clusterError(
        'This worker has not certified the required operation.',
        'capability_unavailable',
        503,
      )
    digest(value.sourceManifest)
    if (value.inputDigest !== executionDigest(value))
      throw clusterError(
        'Attempt digest does not match its complete execution inputs.',
      )
    if (
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1 ||
      value.timeoutMs > 6 * 60 * 60 * 1000
    )
      throw clusterError('Invalid worker deadline.')
    const slots = value.operation === 'check.kernel' ? 3 : 1
    const resources = resourceVector(value.resources)
    if (
      resources.memoryBytes !== this.config.memoryBytes * slots ||
      resources.cpus !== this.config.workerCpus * slots ||
      resources.scratchBytes < (slots === 3 ? 9 * 1024 ** 3 : 256 * 1024 ** 2)
    )
      throw clusterError(
        'Worker resource grant does not match the certified operation.',
      )
    if (
      (value.operation === 'lean.file' || value.file != null) &&
      (typeof value.file !== 'string' || !value.file.endsWith('.lean'))
    )
      throw clusterError('Invalid Lean file check.')
    if (value.file != null) {
      contentPath(value.file)
      if (!status.capabilities.includes('lean.file'))
        throw clusterError(
          'This worker has not certified the selected file check.',
          'capability_unavailable',
          503,
        )
    }
    if (
      value.operation === 'check.kernel' &&
      [...this.running.values()].some(
        (record) => record.operation === 'check.kernel',
      )
    )
      throw clusterError('The native checker is busy.', 'worker_busy', 429)
    const used = [...this.running.values()].reduce(
      (sum, item) => ({
        memoryBytes: sum.memoryBytes + item.resources.memoryBytes,
        cpus: sum.cpus + item.resources.cpus,
        scratchBytes: sum.scratchBytes + item.resources.scratchBytes,
      }),
      { memoryBytes: 0, cpus: 0, scratchBytes: 0 },
    )
    if (
      used.memoryBytes + resources.memoryBytes > status.budget.memoryBytes ||
      used.cpus + resources.cpus > status.budget.cpus ||
      used.scratchBytes + resources.scratchBytes > status.budget.scratchBytes
    )
      throw clusterError('Worker resource budget is busy.', 'worker_busy', 429)
    const { attempt } = this.state.create({ ...value, state: 'assigned' })
    const record = {
      ...identity,
      resources,
      operation: value.operation,
      controller: new AbortController(),
      deadline: performance.now() + this.config.leaseMs,
      task: null,
      child: null,
    }
    this.running.set(attempt.id, record)
    record.task = this.#execute(value, record)
      .catch((error) => {
        this.recoveryError =
          'Worker storage requires reconciliation before new work.'
        record.cleanupFailed = true
        throw error
      })
      .finally(() => {
        if (!record.cleanupFailed) this.running.delete(attempt.id)
      })
    record.task.catch(() => {})
    return attempt
  }

  async #execute(value, record) {
    const workspace = snapshotDirectory(
      path.join(this.config.dataDir, 'workspaces'),
      value.id,
    )
    try {
      this.state.transition(value.id, 'starting')
      await fs.mkdir(path.dirname(workspace), { recursive: true, mode: 0o700 })
      const source = await this.blobs.manifest(value.sourceManifest)
      if (source.kind !== 'source')
        throw clusterError('Invalid source manifest kind.')
      if (source.totalBytes + 16 * 1024 ** 2 > value.resources.scratchBytes)
        throw clusterError(
          'The source snapshot exceeds its scratch grant.',
          'scratch_exceeded',
          413,
        )
      record.diskReservation = await this.storage.reserve({
        bytes: source.totalBytes,
        signal: record.controller.signal,
      })
      await this.blobs.materialize(value.sourceManifest, workspace, {
        signal: record.controller.signal,
      })
      const version = (
        await fs.readFile(path.join(workspace, 'lean-toolchain'), 'utf8')
      ).trim()
      if (
        !this.runtime.toolchains.has(version) ||
        value.toolchain?.version !== version ||
        (this.state.meta('toolchains') || {})[version] !==
          value.toolchain?.manifest
      )
        throw clusterError(
          'The pinned toolchain is not prepared on this worker.',
          'assets_missing',
          409,
        )
      if (value.dependencies) {
        digest(value.dependencies)
        const environment = snapshotDirectory(
          path.join(this.config.dataDir, 'runtime/shared-dependencies'),
          value.dependencies,
        )
        if (!(this.state.meta('dependencies') || {})[value.dependencies])
          throw clusterError(
            'Pinned dependency assets are not prepared.',
            'assets_missing',
            409,
          )
        await this.runtime.inheritDependencies(environment, workspace)
      }
      record.controller.signal.throwIfAborted()
      this.state.transition(value.id, 'running')
      let sequence = 0,
        outputBytes = 0,
        truncated = false
      const options = {
        signal: record.controller.signal,
        timeoutMs: value.timeoutMs,
        network: 'none',
        readOnlyWorkspace: true,
        writeLakeCache: true,
        freshHome: true,
        cleanHome: true,
        maxOutputBytes: this.config.maxOutputBytes,
        boundedScratchBytes: value.resources.scratchBytes - source.totalBytes,
        ...(value.file && value.operation !== 'lean.file'
          ? { postCheckFile: value.file }
          : {}),
        onSpawn: (child) => {
          record.child = child
        },
        onOutput: (text, stream) => {
          if (record.outputError) return
          try {
            this.state.transaction(() => {
              if (outputBytes >= 16 * 1024 ** 2 || sequence >= 16384) {
                if (!truncated)
                  this.state.appendEvent(value.id, ++sequence, {
                    text: '\nWorker output truncated after its retained limit.\n',
                    stream: 'stderr',
                  })
                truncated = true
                return
              }
              for (let offset = 0; offset < text.length; offset += 2048) {
                const chunk = text.slice(offset, offset + 2048)
                outputBytes += Buffer.byteLength(chunk)
                this.state.appendEvent(value.id, ++sequence, {
                  text: chunk,
                  stream: stream === 'stderr' ? 'stderr' : 'stdout',
                })
                if (outputBytes >= 16 * 1024 ** 2 || sequence >= 16384) break
              }
            })
          } catch {
            record.outputError = clusterError(
              'Worker output storage is unavailable.',
              'storage_unavailable',
              503,
            )
            this.recoveryError =
              'Worker output storage is unavailable. Reconcile storage before new work.'
            record.controller.abort(record.outputError)
          }
        },
      }
      let result =
        value.operation === 'check.kernel'
          ? await this.runtime.checkProject(workspace, options)
          : await this.runtime.run(
              workspace,
              value.operation === 'lean.file'
                ? [
                    'lake',
                    'env',
                    'lean',
                    '--json',
                    '-Dwarn.sorry=true',
                    './' + value.file,
                  ]
                : ['lake', 'build'],
              options,
            )
      const object = await this.blobs.put(Buffer.from(JSON.stringify(result)))
      await this.#cleanupWorkspace(value.id, record)
      const current = this.state.get(value.id)
      if (record.deadline < performance.now())
        record.controller.abort(
          clusterError('Worker lease expired.', 'lease_expired'),
        )
      if (record.controller.signal.aborted) {
        if (current.state !== 'stopping')
          this.state.transition(value.id, 'stopping')
        this.state.transition(value.id, 'cancelled', {
          result: object,
          lastSequence: sequence,
        })
      } else {
        this.state.assertFence(value.id, value)
        this.state.transition(value.id, 'validating')
        this.state.transition(value.id, 'completed', {
          result: object,
          lastSequence: sequence,
        })
      }
    } catch (error) {
      if (error.workerCleanup) record.cleanupFailed = true
      if (!record.cleanupFailed) {
        try {
          await this.#cleanupWorkspace(value.id, record)
        } catch {
          record.cleanupFailed = true
        }
      }
      const current = this.state.get(value.id)
      if (!terminal.has(current.state)) {
        if (record.controller.signal.aborted && !record.cleanupFailed) {
          if (current.state !== 'stopping')
            this.state.transition(value.id, 'stopping')
          this.state.transition(value.id, 'cancelled')
        } else
          this.state.transition(
            value.id,
            record.cleanupFailed ? 'lost' : 'failed',
            { error: safeWorkerError(error).message },
          )
      }
    }
  }

  async #cleanupWorkspace(id, record) {
    if (record.workspaceCleaned) return
    const workspace = snapshotDirectory(
      path.join(this.config.dataDir, 'workspaces'),
      id,
    )
    try {
      // An aborted materialization may already have removed its destination.
      if (
        await fs.lstat(workspace).catch((error) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
      ) {
        await this.runtime.clearInheritedDependencies?.(workspace, {
          force: true,
        })
        await removeDisposableTree(workspace)
      }
      record.workspaceCleaned = true
      record.diskReservation?.release()
    } catch {
      throw Object.assign(
        clusterError(
          'Worker storage cleanup could not be confirmed.',
          'worker_cleanup',
          503,
        ),
        { workerCleanup: true },
      )
    }
  }

  async cancel(id, reason, identity) {
    identifier(id, 'attempt identifier')
    const record = this.running.get(id)
    const attempt = this.state.get(id)
    if (!attempt) {
      if (!identity)
        throw clusterError('Unknown worker attempt.', 'attempt_missing', 404)
      this.state.cancelBeforeStart(id, identity)
      return { stopped: true, state: 'cancelled', tombstoned: true }
    }
    if (!record)
      return {
        stopped: !this.recoveryError && terminal.has(attempt.state),
        state: attempt.state,
      }
    if (!terminal.has(attempt.state) && attempt.state !== 'stopping')
      this.state.transition(id, 'stopping', { reason })
    record.controller.abort(
      clusterError('Worker operation cancelled.', 'cancelled'),
    )
    await record.task
    if (record.cleanupFailed) {
      if (typeof record.child?.cleanupWorker !== 'function')
        throw clusterError(
          'Worker shutdown could not be confirmed.',
          'worker_cleanup',
          503,
        )
      try {
        await record.child.cleanupWorker()
        await this.#cleanupWorkspace(id, record)
      } catch {
        throw clusterError(
          'Worker shutdown could not be confirmed.',
          'worker_cleanup',
          503,
        )
      }
      record.cleanupFailed = false
      this.state.transition(id, 'reconciling')
      this.state.transition(id, 'cancelled')
      this.running.delete(id)
    }
    return { stopped: true, state: this.state.get(id).state }
  }

  async #reapOwnedContainers() {
    const instance = this.runtime.instance
    if (!instance) return
    await this.#reapInstance(instance, 'node')
    const conformance = path.join(this.config.dataDir, 'conformance')
    for (const entry of await fs
      .readdir(conformance, { withFileTypes: true })
      .catch((error) => {
        if (error.code === 'ENOENT') return []
        throw error
      })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue
      const directory = path.join(conformance, entry.name)
      if ((await fs.realpath(directory)) !== directory)
        throw clusterError('Invalid abandoned conformance directory.')
      await this.#reapInstance(
        sha256(directory + '\0conformance'),
        'conformance',
      )
      await removeDisposableTree(directory)
    }
    for (const attempt of this.state.list())
      await this.#cleanupWorkspace(attempt.id, {})
    const homes = path.join(this.config.dataDir, 'runtime/homes')
    for (const entry of await fs.readdir(homes, { withFileTypes: true }))
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
        await removeDisposableTree(path.join(homes, entry.name))
    for (const base of [
      'runtime/elan/toolchains',
      'runtime/shared-dependencies',
    ]) {
      const directory = path.join(this.config.dataDir, base)
      for (const entry of await fs
        .readdir(directory, { withFileTypes: true })
        .catch((error) => {
          if (error.code === 'ENOENT') return []
          throw error
        }))
        if (
          entry.isDirectory() &&
          /\.(?:stage|abandoned)-[a-f0-9-]{36}$/.test(entry.name)
        )
          await removeDisposableTree(path.join(directory, entry.name))
    }
  }

  async #reapInstance(instance, scope) {
    const engineArgs = (args) => this.runtime.engine?.args(args) || args
    const env = this.runtime.engine?.environment(process.env) || process.env
    const { stdout } = await execute(
      this.config.engineExecutable,
      engineArgs([
        'ps',
        '-aq',
        '--filter',
        'label=lemex-web.instance=' + instance,
        '--filter',
        'label=lemex-web.scope=' + scope,
      ]),
      { timeout: 15000, maxBuffer: 1024 * 1024, env },
    )
    for (const id of stdout.trim().split(/\s+/).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id))
        throw clusterError('Invalid owned-container inventory.')
      await execute(
        this.config.engineExecutable,
        engineArgs(['rm', '-f', id]),
        {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          env,
        },
      )
    }
  }

  close() {
    this.closePromise ||= this.#close()
    return this.closePromise
  }

  async #close() {
    this.closed = true
    this.shutdownController.abort(
      clusterError('Worker is stopping.', 'worker_stopping', 503),
    )
    clearInterval(this.timer)
    const cancelled = await Promise.allSettled(
      [...this.running.keys()].map((id) => this.cancel(id, 'worker-shutdown')),
    )
    await Promise.allSettled([...this.operations])
    let shutdownError
    try {
      await this.runtime.shutdown()
    } catch (error) {
      shutdownError = error
    }
    for (const rpc of this.peers) rpc.close()
    this.state?.close()
    this.blobs?.close()
    await this.lease?.release()
    if (
      shutdownError ||
      cancelled.some((result) => result.status === 'rejected')
    )
      throw clusterError(
        'Worker shutdown requires reconciliation.',
        'worker_cleanup',
        503,
      )
  }
}

export async function serveNode(config) {
  const worker = await new WorkerNode({ config }).init()
  config = worker.config
  try {
    const stat = await fs.lstat(config.socketPath)
    if (!stat.isSocket())
      throw clusterError('Worker socket path is not a socket.')
    await new Promise((resolve, reject) => {
      const connection = net.createConnection(config.socketPath)
      connection.once('connect', () => {
        connection.destroy()
        reject(clusterError('A worker service is already listening.'))
      })
      connection.once('error', (error) =>
        error.code === 'ECONNREFUSED' ? resolve() : reject(error),
      )
    })
    await fs.unlink(config.socketPath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await worker.close()
      throw error
    }
  }
  const server = net.createServer((socket) => worker.attach(socket, socket))
  server.maxConnections = 16
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.socketPath, resolve)
    })
  } catch (error) {
    await worker.close()
    throw error
  }
  await fs.chmod(config.socketPath, 0o600)
  const close = async () => {
    server.close()
    await worker.close()
    await fs.unlink(config.socketPath).catch(() => {})
  }
  return { worker, server, close }
}

export async function bridgeNode(
  config,
  input = process.stdin,
  output = process.stdout,
  {
    startUserService = () =>
      execute(
        '/usr/bin/systemctl',
        ['--user', 'start', 'leanflow-node.service'],
        { timeout: 12000, maxBuffer: 65536 },
      ),
  } = {},
) {
  const command = process.env.SSH_ORIGINAL_COMMAND || ''
  if (!['leanflow-node-control', 'leanflow-node-bulk'].includes(command))
    throw clusterError('Only the LeanFlow worker protocol is available.')
  if (config.startUserService) await startUserService()
  const deadline = performance.now() + (config.startUserService ? 12000 : 0)
  let socket
  for (;;) {
    socket = net.createConnection(config.socketPath)
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      break
    } catch (error) {
      socket.destroy()
      if (
        !['ENOENT', 'ECONNREFUSED'].includes(error.code) ||
        performance.now() >= deadline
      )
        throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  input.pipe(socket)
  socket.pipe(output)
  input.once('end', () => socket.end())
  await new Promise((resolve, reject) => {
    socket.once('close', resolve)
    socket.once('error', reject)
  })
}

if (
  process.argv[1] &&
  (await fs.realpath(path.resolve(process.argv[1])).catch(() => null)) ===
    fileURLToPath(import.meta.url)
) {
  try {
    const mode = process.argv[2]
    if (
      !['serve', 'bridge'].includes(mode) ||
      process.argv[3] !== '--config' ||
      !process.argv[4] ||
      process.argv.length !== 5
    )
      throw clusterError(
        'Usage: node server/cluster/node.mjs serve|bridge --config /absolute/node.json',
      )
    const config = await readNodeConfig(path.resolve(process.argv[4]))
    if (mode === 'bridge') await bridgeNode(config)
    else {
      const service = await serveNode(config)
      for (const name of ['SIGTERM', 'SIGINT'])
        process.once(
          name,
          () =>
            void service.close().catch(() => {
              process.exitCode = 1
            }),
        )
    }
  } catch (error) {
    process.stderr.write(
      (error.status ? error.message : 'The worker service could not start.') +
        '\n',
    )
    process.exitCode = 1
  }
}
