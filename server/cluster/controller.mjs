import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { FramedRpc, PROTOCOL_VERSION } from './protocol.mjs'
import {
  ClusterState,
  chooseNode,
  clusterError,
  digest,
  executionDigest,
  identifier,
  resourceVector,
} from './state.mjs'
import { contentPath } from './blobs.mjs'
import { controllerConfig } from './config.mjs'

export const SSH_BINARY = '/usr/bin/ssh'
const REMOTE_COMMANDS = new Map([
  ['control', 'leanflow-node-control'],
  ['bulk', 'leanflow-node-bulk'],
])
// ssh splits whitespace and expands % and ~ in file options, so only plain
// absolute paths reach its command line.
const SSH_PATH = /^(?:\/[A-Za-z0-9._][A-Za-z0-9._-]*)+$/
const MAX_DIAGNOSTIC = 2048

const GIB = 1024 ** 3
const CHUNK_BYTES = 256 * 1024
const HAS_BATCH = 2048
const RENEW_BATCH = 128
const MIN_SCRATCH_BYTES = 16 * GIB
// Runtime writes kernel exports of up to 8 GiB to scratch by default.
const KERNEL_EXPORT_BYTES = 8 * GIB
const MAX_RESULT_BYTES = 64 * 1024 ** 2
const MAX_STREAM_CHARS = 32 * 1024 ** 2
const MAX_EVENT_CHARS = 8192
const MAX_EVENTS = 16385
const MAX_EVENT_BYTES = 16 * 1024 ** 2 + 16384
const MAX_EVENT_PAGES = 16
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000
const WATCHDOG_GRACE_MS = 15 * 60 * 1000
const MAX_PREPARED = 1024
const TIMEOUTS = {
  hello: 15_000,
  status: 10_000,
  renew: 10_000,
  get: 15_000,
  start: 30_000,
  cancel: 120_000,
  chunk: 60_000,
  prepare: 30 * 60_000,
  certify: 60 * 60_000,
}
const DEFAULT_TIMING = {
  pollMs: 5000,
  eventPollMs: 500,
  renewMs: 5000,
  minBackoffMs: 1000,
  maxBackoffMs: 60_000,
}
const TOOLCHAIN =
  /^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/
const IMAGE = /^sha256:[a-f0-9]{64}$/
const LABEL = /^[^\x00-\x1f\x7f]{1,200}$/
const operations = new Set(['check.build', 'check.kernel', 'lean.file'])
// Codes a worker sends when it refused attempt.start before recording it.
const startRefusals = new Set([
  'stale_attempt',
  'capability_unavailable',
  'worker_busy',
  'cluster_error',
  'release_mismatch',
  'stale_generation',
  'worker_stopping',
  'attempt_cancelled',
])
// Failures raised by the local transport rather than by the worker.
const transportFailures = new Set([
  'connection_closed',
  'connection_failed',
  'protocol_error',
  'frame_too_large',
  'listener_failed',
  'queue_full',
  'too_many_requests',
  'invalid_message',
  'timeout',
  'aborted',
])
const fencedCodes = new Set(['stale_generation', 'lineage_changed'])
const REQUEUE = Symbol('requeue')
const noop = () => {}

// Every error a run can reject with after assignment. Worker and SSH details
// stay out of these messages.
const FAILURES = {
  worker_cleanup: [
    503,
    'The remote worker did not confirm that this check stopped. Its capacity stays reserved until the worker reconnects.',
  ],
  worker_upload_failed: [
    503,
    "The remote worker could not receive this check's files. Try again shortly.",
  ],
  worker_rejected: [
    503,
    'The remote worker declined this check. Try again shortly.',
  ],
  worker_failed: [
    503,
    'The remote worker could not finish this check. Run it again.',
  ],
  worker_stopped: [
    503,
    'The remote worker stopped this check before it finished. Run it again.',
  ],
  invalid_result: [
    502,
    'The remote worker returned an invalid result. Run the check again.',
  ],
  result_unavailable: [
    503,
    "The remote worker's result could not be downloaded. Run the check again.",
  ],
  cluster_timeout: [504, 'The remote check did not finish in time.'],
  cluster_busy: [429, 'The remote workers are busy. Try again shortly.'],
  cluster_queue_full: [429, 'Too many checks are waiting. Try again shortly.'],
  cluster_actor_limit: [
    429,
    'Too many of your checks are waiting. Wait for one to finish, then try again.',
  ],
  cluster_stopping: [
    503,
    'LeanFlow stopped this check while restarting. Run it again.',
  ],
}

function failure(code) {
  const [status, message] = FAILURES[code]
  const error = clusterError(message, code, status)
  if (code === 'worker_cleanup') error.workerCleanup = true
  return error
}

const invalidRequest = (message) =>
  clusterError(message, 'invalid_request', 400)
const invalidReply = () =>
  clusterError('The worker sent an invalid reply.', 'invalid_reply', 502)
const snapshotInvalid = () =>
  clusterError(
    'The frozen check inputs are incomplete or corrupt. Run the check again.',
    'snapshot_invalid',
    409,
  )
const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const safeCode = (error) =>
  typeof error?.code === 'string' && /^[a-z][a-z_]{0,47}$/.test(error.code)
    ? error.code
    : 'connection_failed'

function pinnedToolchain(value) {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    !TOOLCHAIN.test(value.version)
  )
    throw invalidRequest('The check must pin a Lean toolchain.')
  return { version: value.version, manifest: digest(value.manifest) }
}

function timingOptions(value) {
  if (!isRecord(value)) throw clusterError('Invalid cluster timing.')
  const timing = { ...DEFAULT_TIMING }
  for (const [key, ms] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_TIMING, key))
      throw clusterError('Invalid cluster timing.')
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 600_000)
      throw clusterError(`Invalid cluster timing ${key}.`)
    timing[key] = ms
  }
  timing.heartbeatMs = Math.max(15_000, timing.pollMs * 3)
  return timing
}

// Copies only the documented result fields, so decoded keys such as
// __proto__ or extra worker fields never reach the caller.
function parseResult(data) {
  let value
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
  } catch {
    throw failure('invalid_result')
  }
  if (!isRecord(value)) throw failure('invalid_result')
  const own = (key) => (Object.hasOwn(value, key) ? value[key] : undefined)
  const flags = {}
  for (const key of ['timedOut', 'cancelled', 'truncated']) {
    const flag = own(key)
    if (flag !== undefined && typeof flag !== 'boolean')
      throw failure('invalid_result')
    flags[key] = flag === true
  }
  const code = own('code')
  const stdout = own('stdout')
  const stderr = own('stderr')
  if (
    !(
      Number.isSafeInteger(code) ||
      (code === null && (flags.timedOut || flags.cancelled))
    ) ||
    typeof stdout !== 'string' ||
    typeof stderr !== 'string' ||
    stdout.length > MAX_STREAM_CHARS ||
    stderr.length > MAX_STREAM_CHARS
  )
    throw failure('invalid_result')
  return { code, stdout, stderr, ...flags }
}

// The arguments are built only from validated destination fields. Callers
// cannot add ssh options or choose the remote command.
export function sshArguments(node, channel = 'control') {
  const command = REMOTE_COMMANDS.get(channel)
  if (!command) throw clusterError('Unknown worker channel.')
  const [{ host, user, port, identityFile, knownHostsFile }] = controllerConfig(
    { version: 1, lineage: 'transport', nodes: [node] },
  ).nodes
  for (const file of [identityFile, knownHostsFile])
    if (
      !SSH_PATH.test(file) ||
      file.split('/').some((part) => part === '.' || part === '..')
    )
      throw clusterError('Worker SSH files must be plain absolute paths.')
  const options = [
    'BatchMode=yes',
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile=${knownHostsFile}`,
    'GlobalKnownHostsFile=/dev/null',
    'UpdateHostKeys=no',
    'IdentitiesOnly=yes',
    'IdentityAgent=none',
    `IdentityFile=${identityFile}`,
    'PreferredAuthentications=publickey',
    'RequestTTY=no',
    'ClearAllForwardings=yes',
    'ForwardAgent=no',
    'ForwardX11=no',
    'PermitLocalCommand=no',
    'ProxyCommand=none',
    'ControlMaster=no',
    'ControlPath=none',
    'ConnectTimeout=15',
    'ServerAliveInterval=10',
    'ServerAliveCountMax=3',
    'LogLevel=ERROR',
  ]
  return [
    '-F',
    '/dev/null',
    ...options.flatMap((option) => ['-o', option]),
    '-p',
    String(port),
    '-l',
    user,
    '-T',
    '--',
    host,
    command,
  ]
}

// Opens one worker channel over ssh. The returned FramedRpc owns the child:
// closing it ends ssh's input, and a child that does not exit is killed.
export function openSshRpc(node, channel = 'control') {
  const args = sshArguments(node, channel)
  const child = spawn(SSH_BINARY, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    // ssh needs no inherited secrets, agent sockets or locale settings.
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  })
  let diagnostic = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => {
    if (diagnostic.length < MAX_DIAGNOSTIC)
      diagnostic = (diagnostic + text).slice(0, MAX_DIAGNOSTIC)
  })
  child.stderr.on('error', noop)
  const rpc = new FramedRpc(child.stdout, child.stdin)
  const failed = () =>
    rpc.close(
      clusterError('The worker connection failed.', 'connection_failed', 503),
    )
  child.once('error', failed)
  child.once('exit', () => {
    if (!rpc.closed) failed()
  })
  rpc.once('close', () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const stop = setTimeout(() => child.kill('SIGTERM'), 2000)
    const kill = setTimeout(() => child.kill('SIGKILL'), 7000)
    stop.unref()
    kill.unref()
    child.once('exit', () => {
      clearTimeout(stop)
      clearTimeout(kill)
    })
  })
  // For administrators only; it is never part of a run's error.
  Object.defineProperty(rpc, 'diagnostic', {
    get: () => diagnostic.replace(/[^\x20-\x7e\n]+/g, ' ').trim(),
  })
  return rpc
}

// SQLite keeps this exclusive lock until the connection closes or the process
// exits, so a crashed controller never leaves a stale owner behind.
function lockController(filename) {
  try {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.nlink !== 1)
      throw clusterError('The controller lock must be a private regular file.')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const db = new DatabaseSync(filename)
  try {
    db.exec(
      'PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;',
    )
    fs.chmodSync(filename, 0o600)
    return db
  } catch (error) {
    db.close()
    if (
      error?.errcode === 5 ||
      error?.errcode === 6 ||
      /database (?:table )?is locked/i.test(error?.message ?? '')
    )
      throw clusterError(
        'Another LeanFlow controller is using this cluster database.',
        'controller_locked',
        409,
      )
    throw error
  }
}

// Schedules pure checks on enrolled workers. A run resolves to the remote
// result, resolves to null before assignment when no certified worker can take
// it, or rejects once the worker's attempt is known to be stopped. When that
// cannot be confirmed it rejects with workerCleanup and keeps the capacity
// reserved until the worker is reconciled.
export class ClusterController {
  #config
  #dataDir
  #blobs
  #bundleDigest
  #imageDigest
  #transportFactory
  #timing
  #state = null
  #lock = null
  #identity = null
  #nodes = new Map()
  #queues = new Map()
  #queued = 0
  #actorLoad = new Map()
  #served = new Map()
  #turn = 0
  #active = new Map()
  #grants = new Map()
  #tasks = new Set()
  #pumping = false
  #started = false
  #accepting = false
  #stopping = false
  #shutdown = null
  #resultNodes = new WeakMap()
  #uploads = new WeakMap()

  constructor({
    config,
    dataDir,
    blobs,
    bundleDigest,
    imageDigest,
    transportFactory = openSshRpc,
    timing = {},
  } = {}) {
    this.#config = controllerConfig(config)
    if (
      typeof dataDir !== 'string' ||
      !path.isAbsolute(dataDir) ||
      /[\x00-\x1f]/.test(dataDir)
    )
      throw clusterError('The cluster controller needs an absolute data path.')
    this.#dataDir = path.resolve(dataDir)
    if (
      typeof blobs?.manifest !== 'function' ||
      typeof blobs.read !== 'function' ||
      typeof blobs.readChunk !== 'function'
    )
      throw clusterError('The cluster controller needs its local object store.')
    this.#blobs = blobs
    this.#bundleDigest = digest(bundleDigest)
    if (typeof imageDigest !== 'string' || !IMAGE.test(imageDigest))
      throw clusterError('The worker image must be pinned by digest.')
    this.#imageDigest = imageDigest
    if (typeof transportFactory !== 'function')
      throw clusterError('Invalid worker transport.')
    this.#transportFactory = transportFactory
    this.#timing = timingOptions(timing)
    // Reserve workers are never contacted unless the configuration allows it.
    for (const node of this.#config.nodes)
      if (
        node.enabled &&
        (node.role !== 'reserve' || this.#config.allowReserve)
      )
        this.#nodes.set(node.id, {
          config: node,
          control: null,
          bulk: null,
          bulkOpening: null,
          connecting: null,
          status: null,
          nodeEpoch: null,
          seenAt: 0,
          prepared: new Set(),
          badInputs: new Set(),
          timers: new Set(),
          retryTimer: null,
          backoffMs: this.#timing.minBackoffMs,
          busyUntil: 0,
          quarantined: false,
          fenced: false,
          error: null,
        })
  }

  async init() {
    if (this.#started) throw clusterError('The cluster controller has started.')
    this.#started = true
    if (this.#config.mode === 'off') return this
    fs.mkdirSync(this.#dataDir, { recursive: true, mode: 0o700 })
    this.#lock = lockController(
      path.join(this.#dataDir, 'cluster-controller.lock'),
    )
    try {
      this.#state = new ClusterState({
        filename: path.join(this.#dataDir, 'cluster-controller.sqlite'),
      })
      this.#identity = this.#state.startController(this.#config.lineage)
      this.#holdUnreconciled()
    } catch (error) {
      this.#state?.close()
      this.#state = null
      this.#lock.close()
      this.#lock = null
      throw error
    }
    this.#accepting = true
    for (const node of this.#nodes.values()) this.#connect(node)
    return this
  }

  async run(input, options = {}) {
    if (this.#config.mode === 'off' || !this.#accepting) return null
    const request = this.#request(input, options)
    request.signal?.throwIfAborted()
    if (!this.canRun(request.operation, request.file)) return null
    const { actor } = request
    const load = this.#actorLoad.get(actor) ?? 0
    if (load >= this.#config.maxPerActor) throw failure('cluster_actor_limit')
    if (this.#queued >= this.#config.maxQueue)
      throw failure('cluster_queue_full')
    this.#actorLoad.set(actor, load + 1)
    return new Promise((resolve, reject) => {
      const entry = {
        request,
        job: null,
        assigned: false,
        busyRetries: 0,
        ready: false,
      }
      const settle = (action) => (value) => {
        if (entry.settled) return
        entry.settled = true
        request.signal?.removeEventListener('abort', entry.onAbort)
        const remaining = (this.#actorLoad.get(actor) ?? 1) - 1
        if (remaining > 0) this.#actorLoad.set(actor, remaining)
        else {
          this.#actorLoad.delete(actor)
          this.#served.delete(actor)
        }
        action(value)
      }
      entry.resolve = settle(resolve)
      entry.reject = settle(reject)
      entry.onAbort = () => {
        if (entry.job) this.#halt(entry.job, request.signal.reason)
        else if (this.#dequeue(entry)) {
          entry.reject(request.signal.reason)
          this.#pump()
        }
      }
      request.signal?.addEventListener('abort', entry.onAbort, { once: true })
      this.#enqueue(entry)
      // Reserve a bounded queue position before asynchronous reads. Otherwise
      // a later request from this account can finish validation and overtake it.
      const validate = async () => {
        try {
          request.sourceBytes = await this.#environment(request)
          request.signal?.throwIfAborted()
          if (entry.settled) return
          entry.ready = true
          this.#pump()
        } catch (error) {
          if (this.#dequeue(entry)) entry.reject(error)
          this.#pump()
        }
      }
      this.#track(validate())
    })
  }

  // Uploads a pinned environment to one worker and, when asked, has the worker
  // certify itself with that toolchain. Capabilities come only from the
  // worker's own report.
  async prepareNode(nodeId, input, { certify = false, signal } = {}) {
    if (this.#config.mode === 'off')
      throw clusterError('Cluster execution is off.', 'cluster_off', 409)
    if (!this.#accepting)
      throw clusterError(
        'The cluster controller is not running.',
        'cluster_stopping',
        503,
      )
    if (typeof certify !== 'boolean')
      throw invalidRequest('Choose whether to certify the worker.')
    const node = typeof nodeId === 'string' ? this.#nodes.get(nodeId) : null
    if (!node)
      throw clusterError(
        'This worker is not enabled for this controller.',
        'node_unavailable',
        404,
      )
    if (!isRecord(input)) throw invalidRequest('Invalid worker environment.')
    const environment = {
      toolchain: pinnedToolchain(input.toolchain),
      dependencies:
        input.dependencies == null ? null : digest(input.dependencies),
      sourceManifest:
        input.sourceManifest == null ? null : digest(input.sourceManifest),
    }
    if (!node.control) {
      clearTimeout(node.retryTimer)
      node.retryTimer = null
      this.#connect(node)
      await node.connecting
    }
    const control = node.control
    if (!control)
      throw clusterError(
        'The worker is unavailable. Check its service and SSH enrollment.',
        'node_unavailable',
        503,
      )
    try {
      await this.#prepare(node, environment, signal)
      if (certify) {
        const bulk = await this.#bulkChannel(node)
        const report = await bulk.request(
          'worker.certify',
          { toolchain: environment.toolchain.version },
          { timeoutMs: TIMEOUTS.certify, signal },
        )
        if (!isRecord(report)) throw invalidReply()
        await this.#poll(node, control)
      }
    } catch (error) {
      const code = safeCode(error)
      throw clusterError(
        `The worker could not be prepared (${code}).`,
        code,
        error?.status === 409 ? 409 : 503,
      )
    }
    return {
      nodeId: node.config.id,
      ready: this.#ready(node),
      capabilities: [...(node.status?.capabilities ?? [])],
    }
  }

  status() {
    const workers = [...this.#nodes.values()].map((node) => ({
      id: node.config.id,
      role: node.config.role,
      state: this.#ready(node)
        ? 'ready'
        : node.connecting
          ? 'connecting'
          : 'unavailable',
      capabilities: [...(node.status?.capabilities ?? [])],
      active: [...this.#active.values()].filter((job) => job.node === node)
        .length,
      held: [...this.#grants.values()].filter(
        (grant) => grant.held && grant.nodeId === node.config.id,
      ).length,
      error: node.error,
    }))
    return {
      mode: this.#config.mode,
      accepting: this.#accepting,
      epoch: this.#identity?.epoch ?? null,
      queued: this.#queued,
      active: this.#active.size,
      held: [...this.#grants.values()].filter((grant) => grant.held).length,
      configured: this.#config.nodes.length,
      ready: workers.filter((worker) => worker.state === 'ready').length,
      workers,
    }
  }

  canRun(operation, file) {
    return (
      this.#accepting &&
      [...this.#nodes.values()].some(
        (node) =>
          this.#ready(node) &&
          node.status.capabilities.includes(operation) &&
          (!file?.endsWith('.lean') ||
            node.status.capabilities.includes('lean.file')),
      )
    )
  }

  recordAudit(value) {
    this.#state?.setMeta('checkAudit', value)
  }

  async compactCaches({ nodeId } = {}) {
    if (this.#active.size || this.#queued || this.#grants.size)
      throw clusterError(
        'Drain and reconcile checks before cache maintenance.',
        'worker_busy',
        409,
      )
    let worker = null
    if (nodeId) {
      const node = this.#nodes.get(nodeId)
      if (!node)
        throw clusterError(
          'This worker is not enrolled.',
          'node_unavailable',
          404,
        )
      if (!node.control) {
        clearTimeout(node.retryTimer)
        node.retryTimer = null
        this.#connect(node)
        await node.connecting
      }
      if (!node.control)
        throw clusterError(
          'The worker is unavailable.',
          'node_unavailable',
          503,
        )
      node.maintenance = true
      try {
        worker = await node.control.request(
          'history.compact',
          {},
          { timeoutMs: 20 * 60_000 },
        )
        node.prepared.clear()
        node.badInputs.clear()
      } finally {
        node.maintenance = false
      }
    }
    await this.#blobs.reset()
    const local = this.#state.compactHistory(this.#identity.epoch)
    return { local, worker }
  }

  quarantineResult(result) {
    const origin = this.#resultNodes.get(result)
    if (!origin) return
    if (origin.node.badInputs.size >= 128)
      origin.node.badInputs.delete(origin.node.badInputs.values().next().value)
    origin.node.badInputs.add(origin.inputDigest)
  }

  async loadImage(nodeId, archive, { signal } = {}) {
    digest(archive)
    if (!this.#accepting) throw failure('cluster_stopping')
    const node = this.#nodes.get(nodeId)
    if (!node)
      throw clusterError(
        'This worker is not enrolled.',
        'node_unavailable',
        404,
      )
    if (
      node.maintenance ||
      node.quarantined ||
      [...this.#grants.values()].some((grant) => grant.nodeId === nodeId)
    )
      throw clusterError(
        'Drain and reconcile the worker before loading its image.',
        'worker_busy',
        409,
      )
    node.maintenance = true
    try {
      if (!node.control) {
        clearTimeout(node.retryTimer)
        node.retryTimer = null
        this.#connect(node)
        await node.connecting
      }
      if (!node.control)
        throw clusterError(
          'The worker is unavailable.',
          'node_unavailable',
          503,
        )
      const bulk = await this.#bulkChannel(node)
      await this.#send(bulk, archive, undefined, signal)
      const reply = await bulk.request(
        'images.load',
        { archive, imageDigest: this.#imageDigest },
        { signal, timeoutMs: 25 * 60_000 },
      )
      this.#observe(node, this.#workerStatus(node, reply))
      node.prepared.clear()
      return {
        nodeId,
        imageDigest: this.#imageDigest,
        loaded: node.status.ready,
        capabilities: node.status.capabilities,
      }
    } finally {
      node.maintenance = false
      this.#pump()
    }
  }

  // Stops accepting work, resolves queued runs with null, and cancels active
  // attempts. `unresolved` counts attempts whose stop was not confirmed; they
  // stay durable for the next controller to reconcile.
  shutdown() {
    this.#shutdown ??= this.#close()
    return this.#shutdown
  }

  async #close() {
    this.#accepting = false
    this.#stopping = true
    for (const queue of [...this.#queues.values()])
      for (const entry of [...queue]) {
        this.#dequeue(entry)
        if (entry.assigned) entry.reject(failure('cluster_stopping'))
        else entry.resolve(null)
      }
    for (const node of this.#nodes.values()) {
      clearTimeout(node.retryTimer)
      node.retryTimer = null
    }
    const jobs = [...this.#active.values()]
    for (const job of jobs) this.#halt(job, failure('cluster_stopping'))
    await Promise.allSettled(jobs.map((job) => job.task))
    for (const node of this.#nodes.values()) {
      node.control?.close()
      node.bulk?.close()
    }
    while (this.#tasks.size) await Promise.allSettled([...this.#tasks])
    for (const node of this.#nodes.values())
      for (const timer of node.timers) clearTimeout(timer)
    const unresolved = [...this.#grants.values()].filter(
      (grant) => grant.held,
    ).length
    this.#state?.close()
    this.#lock?.close()
    return { cancelled: jobs.length, unresolved }
  }

  #request(input, options) {
    if (!isRecord(input) || !isRecord(options))
      throw invalidRequest('Invalid cluster check request.')
    const { operation, file, actor, projectId, jobId, timeoutMs } = options
    const { signal, onOutput } = options
    if (!operations.has(operation))
      throw invalidRequest('Unsupported cluster operation.')
    const execution = {
      sourceManifest: digest(input.sourceManifest),
      dependencies:
        input.dependencies == null ? null : digest(input.dependencies),
      toolchain: pinnedToolchain(input.toolchain),
      operation,
      file: null,
    }
    if (operation === 'lean.file' || file != null) {
      if (typeof file !== 'string' || !file.endsWith('.lean'))
        throw invalidRequest('Choose a Lean file to check.')
      execution.file = contentPath(file)
    }
    if (typeof actor !== 'string' || !LABEL.test(actor))
      throw invalidRequest('Invalid cluster account.')
    if (
      projectId !== undefined &&
      projectId !== null &&
      (typeof projectId !== 'string' || !LABEL.test(projectId))
    )
      throw invalidRequest('Invalid cluster project.')
    identifier(jobId, 'job identifier')
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    )
      throw invalidRequest('Invalid cluster check deadline.')
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw invalidRequest('Invalid cancellation signal.')
    if (onOutput !== undefined && typeof onOutput !== 'function')
      throw invalidRequest('Invalid output handler.')
    return {
      ...execution,
      inputDigest: executionDigest(execution),
      actor,
      projectId: projectId ?? null,
      jobId,
      timeoutMs,
      signal,
      onOutput,
    }
  }

  async #localManifest(hash, kind) {
    let manifest
    try {
      manifest = await this.#blobs.manifest(hash)
    } catch {
      throw snapshotInvalid()
    }
    if (manifest.kind !== kind) throw snapshotInvalid()
    return manifest
  }

  // Checks the frozen environment before it is queued, so a worker never
  // receives inputs that disagree with their pinned toolchain.
  async #environment(request) {
    const source = await this.#localManifest(request.sourceManifest, 'source')
    const pin = source.entries.find((entry) => entry.path === 'lean-toolchain')
    let pinned = null
    if (pin?.type === 'file')
      pinned = await this.#blobs.read(pin.hash, 4096).then(
        (data) => data.toString('utf8').trim(),
        () => null,
      )
    if (pinned !== request.toolchain.version) throw snapshotInvalid()
    if (
      request.file &&
      !source.entries.some(
        (entry) => entry.path === request.file && entry.type === 'file',
      )
    )
      throw invalidRequest('Choose a Lean file in this project.')
    await this.#localManifest(request.toolchain.manifest, 'toolchain')
    if (request.dependencies)
      await this.#localManifest(request.dependencies, 'dependencies')
    return source.totalBytes
  }

  #holdUnreconciled() {
    const rows = this.#state.db
      .prepare(
        "SELECT payload FROM cluster_attempts WHERE state IN ('lost','reconciling') ORDER BY rowid",
      )
      .all()
    for (const { payload } of rows) {
      const attempt = JSON.parse(payload)
      if (this.#nodes.has(attempt.nodeId) && attempt.nodeEpoch)
        this.#grants.set(attempt.id, {
          nodeId: attempt.nodeId,
          nodeEpoch: attempt.nodeEpoch,
          resources: attempt.resources,
          operation: attempt.operation,
          held: true,
          reconciling: false,
        })
    }
  }

  #track(promise) {
    const task = promise.catch(noop)
    this.#tasks.add(task)
    task.finally(() => this.#tasks.delete(task))
    return task
  }

  // Queueing and placement

  #enqueue(entry, front = false) {
    const { actor } = entry.request
    let queue = this.#queues.get(actor)
    if (!queue) this.#queues.set(actor, (queue = []))
    if (front) queue.unshift(entry)
    else queue.push(entry)
    this.#queued++
  }

  #dequeue(entry) {
    const { actor } = entry.request
    const queue = this.#queues.get(actor)
    const index = queue ? queue.indexOf(entry) : -1
    if (index < 0) return false
    queue.splice(index, 1)
    if (!queue.length) this.#queues.delete(actor)
    this.#queued--
    return true
  }

  // Serves the account that was served least recently, one assignment per
  // turn. Each account's own checks stay in submission order.
  #pump() {
    if (this.#pumping || !this.#accepting) return
    this.#pumping = true
    try {
      for (let progress = true; progress && this.#queued;) {
        progress = false
        const actors = [...this.#queues.keys()].sort(
          (left, right) =>
            (this.#served.get(left) ?? 0) - (this.#served.get(right) ?? 0),
        )
        for (const actor of actors) {
          const entry = this.#queues.get(actor)[0]
          if (!entry.ready) continue
          if (!this.#compatible(entry.request)) {
            this.#dequeue(entry)
            if (entry.assigned) entry.reject(failure('cluster_busy'))
            else entry.resolve(null)
            progress = true
            break
          }
          const placement = this.#place(entry.request)
          if (!placement) continue
          this.#dequeue(entry)
          this.#served.set(actor, ++this.#turn)
          this.#assign(entry, placement)
          progress = true
          break
        }
      }
    } finally {
      this.#pumping = false
    }
  }

  #ready(node) {
    return !!(
      node.control &&
      node.status?.ready &&
      node.status.capabilities.length > 0 &&
      !node.quarantined &&
      !node.maintenance
    )
  }

  #view(node) {
    const { status } = node
    if (!node.control || !status) return null
    return {
      id: node.config.id,
      role:
        node.config.role === 'reserve' || status.role === 'reserve'
          ? 'reserve'
          : 'primary',
      status: this.#ready(node) ? 'ready' : 'unavailable',
      draining: false,
      capabilities: status.capabilities,
      bundleDigest: status.bundleDigest,
      imageDigest: status.imageDigest,
      lastSeen: node.seenAt,
      heartbeatTimeoutMs: this.#timing.heartbeatMs,
      budget: status.budget,
    }
  }

  // Kernel checks reserve three worker slots. Writable scratch is a sized
  // tmpfs charged to the job's RAM; host source copies also fit this grant
  // and the administrator's aggregate filesystem boundary.
  #grantFor(node, { operation, sourceBytes }) {
    const slots = operation === 'check.kernel' ? 3 : 1
    const { memoryBytes, cpus } = node.status.workerResources
    return {
      memoryBytes: memoryBytes * slots,
      cpus: cpus * slots,
      scratchBytes: Math.max(
        MIN_SCRATCH_BYTES,
        sourceBytes * 2 + (slots === 3 ? KERNEL_EXPORT_BYTES : 0),
      ),
    }
  }

  #fits(node, request, grants) {
    const view = this.#view(node)
    if (!view) return null
    if (node.badInputs.has(request.inputDigest)) return null
    if (request.file && !view.capabilities.includes('lean.file')) return null
    const resources = this.#grantFor(node, request)
    const chosen = chooseNode(
      [view],
      {
        operation: request.operation,
        bundleDigest: this.#bundleDigest,
        imageDigest: this.#imageDigest,
        inputDigest: request.inputDigest,
        resources,
      },
      grants,
      { allowReserve: this.#config.allowReserve },
    )
    return chosen ? resources : null
  }

  #compatible(request) {
    for (const node of this.#nodes.values())
      if (this.#fits(node, request, [])) return true
    return false
  }

  #place(request) {
    const now = Date.now()
    const grants = [...this.#grants.values()].map((grant) => ({
      nodeId: grant.nodeId,
      operation: grant.operation,
      state: 'running',
      resources: grant.resources,
    }))
    let best = null
    for (const node of this.#nodes.values()) {
      if (node.busyUntil > now) continue
      const resources = this.#fits(node, request, grants)
      if (!resources) continue
      const { budget } = node.status
      const used = grants.filter((grant) => grant.nodeId === node.config.id)
      const share = Math.max(
        used.reduce((sum, grant) => sum + grant.resources.memoryBytes, 0) /
          budget.memoryBytes,
        used.reduce((sum, grant) => sum + grant.resources.cpus, 0) /
          budget.cpus,
      )
      if (!best || share < best.share) best = { node, resources, share }
    }
    return best
  }

  // Records the durable attempt and its grant before any worker sees it.
  #assign(entry, { node, resources }) {
    const { request } = entry
    entry.assigned = true
    const payload = {
      id: randomUUID(),
      jobId: request.jobId,
      lineage: this.#identity.lineage,
      epoch: this.#identity.epoch,
      inputDigest: request.inputDigest,
      operation: request.operation,
      resources,
      actor: request.actor,
      projectId: request.projectId,
      nodeId: node.config.id,
      nodeEpoch: node.status.nodeEpoch,
      bundleDigest: this.#bundleDigest,
      imageDigest: this.#imageDigest,
      sourceManifest: request.sourceManifest,
      dependencies: request.dependencies,
      toolchain: request.toolchain,
      ...(request.file ? { file: request.file } : {}),
      timeoutMs: request.timeoutMs,
    }
    try {
      this.#state.create({ ...payload, state: 'assigned' })
    } catch {
      entry.reject(failure('worker_failed'))
      return
    }
    const grant = {
      nodeId: payload.nodeId,
      nodeEpoch: payload.nodeEpoch,
      resources,
      operation: payload.operation,
      held: false,
      reconciling: false,
    }
    this.#grants.set(payload.id, grant)
    const job = {
      id: payload.id,
      entry,
      node,
      payload,
      grant,
      cursor: 0,
      eventBytes: 0,
      eventHashes: new Map(),
      misses: 0,
      started: false,
      lost: false,
      stop: null,
      wake: null,
      transfer: new AbortController(),
      deadline: performance.now() + request.timeoutMs + WATCHDOG_GRACE_MS,
    }
    entry.job = job
    this.#active.set(job.id, job)
    if (request.signal?.aborted) this.#halt(job, request.signal.reason)
    job.task = this.#execute(job)
      .then(
        (result) => {
          this.#active.delete(job.id)
          if (result !== REQUEUE) return entry.resolve(result)
          entry.job = null
          if (request.signal?.aborted)
            return entry.reject(request.signal.reason)
          this.#enqueue(entry, true)
        },
        (error) => {
          this.#active.delete(job.id)
          entry.reject(error)
        },
      )
      .finally(() => this.#pump())
    this.#track(job.task)
  }

  #halt(job, error) {
    job.stop ??= { error }
    job.transfer.abort()
    job.wake?.()
  }

  #sleep(job, ms) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        if (job.wake === wake) job.wake = null
        resolve()
      }
      const timer = setTimeout(wake, ms)
      job.wake = wake
    })
  }

  // Attempt lifecycle

  async #execute(job) {
    const { node, entry } = job
    try {
      await this.#prepare(node, entry.request, job.transfer.signal)
      if (job.lost) throw failure('worker_upload_failed')
    } catch (error) {
      // attempt.start was never sent, so nothing runs on the worker.
      this.#release(job, job.stop ? 'cancelled' : 'failed', {
        reason: 'prepare-failed',
      })
      if (job.stop) throw job.stop.error
      throw error?.code === 'snapshot_invalid'
        ? error
        : failure('worker_upload_failed')
    }
    if (job.stop) {
      this.#release(job, 'cancelled', { reason: 'cancelled' })
      throw job.stop.error
    }
    if ((await this.#start(job)) === REQUEUE) return REQUEUE
    return this.#follow(job)
  }

  async #start(job) {
    const { node, payload } = job
    let retried = false
    for (;;) {
      const control = node.control
      try {
        if (!control) throw clusterError('closed', 'connection_closed', 503)
        this.#checkAttempt(
          job,
          await control.request('attempt.start', payload, {
            timeoutMs: TIMEOUTS.start,
          }),
        )
        break
      } catch (error) {
        if (startRefusals.has(error?.code)) {
          this.#release(job, 'failed', { reason: 'start-refused' })
          if (fencedCodes.has(error.code))
            this.#disconnect(node, control, error)
          if (job.stop) throw job.stop.error
          if (
            error.code === 'worker_busy' &&
            this.#accepting &&
            job.entry.busyRetries++ < 3
          ) {
            node.busyUntil = Date.now() + this.#timing.pollMs
            return REQUEUE
          }
          throw failure(
            error.code === 'worker_busy' ? 'cluster_busy' : 'worker_rejected',
          )
        }
        // The worker may have recorded the attempt. Only the same attempt may
        // be retried, and only on the same worker process.
        if (
          !retried &&
          error?.code === 'timeout' &&
          !job.stop &&
          node.control === control
        ) {
          retried = true
          const same = await this.#refresh(node, control).then(
            (status) => status.nodeEpoch === payload.nodeEpoch,
            () => false,
          )
          if (same && node.control === control) continue
        }
        return this.#stopRemote(
          job,
          job.stop?.error || failure('worker_failed'),
        )
      }
    }
    job.started = true
    this.#state.transition(job.id, 'running')
  }

  async #follow(job) {
    for (;;) {
      if (job.lost) return this.#stopRemote(job, failure('worker_stopped'))
      if (job.stop) return this.#stopRemote(job, job.stop.error)
      if (performance.now() > job.deadline) {
        this.#halt(job, failure('cluster_timeout'))
        continue
      }
      const before = job.cursor
      let attempt
      try {
        attempt = await this.#pollAttempt(job)
        job.misses = 0
      } catch (error) {
        if (job.lost || job.stop) continue
        if (!transportFailures.has(error?.code))
          this.#halt(job, failure('invalid_result'))
        else {
          if (++job.misses >= 3)
            this.#disconnect(job.node, job.node.control, error)
          await this.#sleep(job, this.#timing.eventPollMs)
        }
        continue
      }
      if (attempt.state === 'completed') {
        if (job.cursor === attempt.lastSequence)
          return this.#accept(job, attempt)
        // Drain the remaining events only while the worker still sends them.
        if (
          !Number.isSafeInteger(attempt.lastSequence) ||
          job.cursor > attempt.lastSequence ||
          job.cursor === before
        )
          this.#halt(job, failure('invalid_result'))
        continue
      }
      if (['cancelled', 'failed'].includes(attempt.state))
        return this.#ended(job, attempt.state)
      if (['lost', 'interrupted'].includes(attempt.state)) {
        // The worker itself could not confirm that its container stopped.
        this.#hold(job, 'worker-' + attempt.state)
        job.node.quarantined = true
        throw failure('worker_cleanup')
      }
      await this.#sleep(job, this.#timing.eventPollMs)
    }
  }

  // Reads bounded event pages and returns the newest attempt record.
  async #pollAttempt(job) {
    const control = job.node.control
    if (!control) throw clusterError('closed', 'connection_closed', 503)
    for (let page = 1; ; page++) {
      const reply = await control.request(
        'attempt.get',
        { id: job.id, after: job.cursor },
        { timeoutMs: TIMEOUTS.get },
      )
      if (
        !isRecord(reply) ||
        !Array.isArray(reply.events) ||
        reply.events.length > 512
      )
        throw invalidReply()
      const attempt = this.#checkAttempt(job, reply.attempt)
      const before = job.cursor
      const batches = []
      for (const event of reply.events) {
        const value = this.#record(job, event)
        if (!value) continue
        const last = batches.at(-1)
        if (last?.stream === value.stream) last.text += value.text
        else batches.push({ ...value })
      }
      for (const { text, stream } of batches) {
        try {
          job.entry.request.onOutput?.(text, stream)
        } catch {
          /* A sink cannot change the attempt. */
        }
      }
      if (job.cursor === before || page >= MAX_EVENT_PAGES) return attempt
    }
  }

  // EventStore is the durable user log. This bounded replay index avoids a
  // second fsync-heavy copy; interrupted pure checks are not resumed on boot.
  #record(job, event) {
    if (
      !isRecord(event) ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 1 ||
      event.sequence > MAX_EVENTS ||
      event.sequence > job.cursor + 1 ||
      !isRecord(event.value)
    )
      throw invalidReply()
    const { text, stream } = event.value
    if (
      typeof text !== 'string' ||
      text.length > MAX_EVENT_CHARS ||
      (stream !== 'stdout' && stream !== 'stderr')
    )
      throw invalidReply()
    const hash = createHash('sha256')
      .update(JSON.stringify({ text, stream }))
      .digest('hex')
    if (event.sequence <= job.cursor) {
      if (job.eventHashes.get(event.sequence) !== hash) throw invalidReply()
      return null
    }
    const bytes = Buffer.byteLength(text)
    if (job.eventBytes + bytes > MAX_EVENT_BYTES) throw invalidReply()
    job.eventBytes += bytes
    job.eventHashes.set(event.sequence, hash)
    job.cursor = event.sequence
    return { text, stream }
  }

  #checkAttempt(job, attempt) {
    const { payload } = job
    if (!isRecord(attempt) || typeof attempt.state !== 'string')
      throw invalidReply()
    for (const key of [
      'id',
      'jobId',
      'lineage',
      'epoch',
      'inputDigest',
      'operation',
      'actor',
      'projectId',
      'nodeId',
      'nodeEpoch',
      'bundleDigest',
      'imageDigest',
      'sourceManifest',
      'dependencies',
      'file',
      'timeoutMs',
    ])
      if ((attempt[key] ?? null) !== (payload[key] ?? null))
        throw invalidReply()
    const { toolchain, resources } = attempt
    if (
      !isRecord(toolchain) ||
      toolchain.version !== payload.toolchain.version ||
      toolchain.manifest !== payload.toolchain.manifest ||
      !isRecord(resources) ||
      ['memoryBytes', 'cpus', 'scratchBytes'].some(
        (key) => resources[key] !== payload.resources[key],
      )
    )
      throw invalidReply()
    return attempt
  }

  // Accepts a completed attempt only after the durable fence, the worker's
  // current identity and the downloaded result all match.
  async #accept(job, attempt) {
    const { node, payload } = job
    let result
    try {
      this.#state.transition(job.id, 'validating')
      this.#state.assertFence(job.id, payload)
      const status = node.status
      if (
        !node.control ||
        status?.nodeEpoch !== payload.nodeEpoch ||
        status.bundleDigest !== payload.bundleDigest ||
        status.imageDigest !== payload.imageDigest
      )
        throw failure('result_unavailable')
      const reference = attempt.result
      if (
        !isRecord(reference) ||
        typeof reference.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(reference.hash) ||
        !Number.isSafeInteger(reference.size) ||
        reference.size < 1 ||
        reference.size > MAX_RESULT_BYTES
      )
        throw failure('invalid_result')
      result = parseResult(
        await this.#download(
          node,
          reference.hash,
          reference.size,
          job.transfer.signal,
        ),
      )
      if (job.stop) throw job.stop.error
      if (job.lost || !node.control) throw failure('result_unavailable')
      const current = await this.#refresh(node, node.control)
      if (current.nodeEpoch !== payload.nodeEpoch)
        throw failure('result_unavailable')
      this.#state.assertFence(job.id, payload)
      this.#release(job, 'completed', {
        result: { hash: reference.hash, size: reference.size },
        lastSequence: job.cursor,
      })
      this.#resultNodes.set(result, { node, inputDigest: payload.inputDigest })
      return result
    } catch (error) {
      // The worker already finished this attempt, so nothing remains to stop.
      this.#release(job, 'failed', { reason: 'result-rejected' })
      if (job.stop) throw job.stop.error
      throw ['invalid_result', 'stale_attempt', 'stale_generation'].includes(
        error?.code,
      )
        ? failure('invalid_result')
        : failure('result_unavailable')
    }
  }

  #ended(job, state) {
    // The worker records these states only after its container has exited.
    if (state === 'cancelled') {
      this.#state.transition(job.id, 'stopping', { reason: 'worker-cancelled' })
      this.#release(job, 'cancelled')
    } else this.#release(job, 'failed', { reason: 'worker-failed' })
    if (job.stop) throw job.stop.error
    throw failure(state === 'cancelled' ? 'worker_stopped' : 'worker_failed')
  }

  // Rejects with `error` once the worker confirms the attempt stopped.
  // Otherwise the grant stays held and the worker takes no new work.
  async #stopRemote(job, error) {
    if (this.#state.get(job.id)?.state !== 'stopping')
      this.#state.transition(job.id, 'stopping', { reason: 'stop-requested' })
    if (await this.#confirmStopped(job.node, job.id, job.payload.nodeEpoch)) {
      this.#release(job, 'cancelled')
      throw error
    }
    this.#hold(job, job.lost ? 'connection-lost' : 'stop-unconfirmed')
    if (job.node.control) job.node.quarantined = true
    throw failure('worker_cleanup')
  }

  async #confirmStopped(node, id, nodeEpoch) {
    const control = node.control
    if (!control || node.status?.nodeEpoch !== nodeEpoch) return false
    try {
      const reply = await control.request(
        'attempt.cancel',
        { id },
        { timeoutMs: TIMEOUTS.cancel },
      )
      return isRecord(reply) && reply.stopped === true
    } catch {
      // A missing record cannot prove that a delayed start frame will not
      // arrive. Current workers install a durable tombstone before confirming.
      return false
    }
  }

  #release(job, state, patch) {
    this.#state.transition(job.id, state, patch)
    this.#grants.delete(job.id)
  }

  #hold(job, reason) {
    this.#state.transition(job.id, 'lost', { reason })
    job.grant.held = true
  }

  #settleHeld(id) {
    let state = this.#state.get(id)?.state
    if (state === 'lost')
      state = this.#state.transition(id, 'reconciling').state
    if (state === 'reconciling')
      this.#state.transition(id, 'interrupted', { reason: 'reconciled' })
    this.#grants.delete(id)
  }

  // Releases held grants once the worker proves their attempts stopped: a
  // cancel confirmed by the same worker process, or a restarted worker that
  // reaped its old containers before reporting ready.
  async #reconcile(node) {
    const control = node.control
    for (const [id, grant] of this.#grants) {
      if (!grant.held || grant.nodeId !== node.config.id || grant.reconciling)
        continue
      if (node.control !== control || !node.status) return
      grant.reconciling = true
      try {
        const stopped =
          grant.nodeEpoch === node.status.nodeEpoch
            ? await this.#confirmStopped(node, id, grant.nodeEpoch)
            : node.status.ready
        if (stopped) this.#settleHeld(id)
      } finally {
        grant.reconciling = false
      }
    }
    if (
      node.control === control &&
      ![...this.#grants.values()].some(
        (grant) => grant.held && grant.nodeId === node.config.id,
      )
    )
      node.quarantined = false
  }

  // Transfers

  async #prepare(node, environment, signal) {
    const { sourceManifest, dependencies, toolchain } = environment
    const nodeEpoch = node.status?.nodeEpoch
    const bulk = await this.#bulkChannel(node)
    await this.#upload(node, bulk, toolchain.manifest, 'toolchain', signal)
    if (dependencies)
      await this.#upload(node, bulk, dependencies, 'dependencies', signal)
    if (sourceManifest)
      await this.#upload(node, bulk, sourceManifest, 'source', signal)
    const key = `${nodeEpoch}:assets:${toolchain.version}:${toolchain.manifest}:${dependencies ?? ''}`
    if (!node.prepared.has(key)) {
      const reply = await bulk.request(
        'assets.prepare',
        { toolchain, ...(dependencies ? { dependencies } : {}) },
        { signal, timeoutMs: TIMEOUTS.prepare },
      )
      if (!isRecord(reply) || reply.ready !== true) throw invalidReply()
      this.#remember(node, nodeEpoch, key)
    }
    if (!node.control || node.status?.nodeEpoch !== nodeEpoch)
      throw clusterError('The worker restarted.', 'connection_closed', 503)
  }

  #remember(node, nodeEpoch, key) {
    if (node.nodeEpoch !== nodeEpoch) return
    if (node.prepared.size >= MAX_PREPARED) node.prepared.clear()
    node.prepared.add(key)
  }

  // Uploads one manifest and every object it names, then confirms that the
  // worker holds all of them. The local object store is only read here; it is
  // never mounted into a sandbox.
  async #upload(node, bulk, hash, kind, signal) {
    const nodeEpoch = node.status?.nodeEpoch
    const key = `${nodeEpoch}:${hash}`
    if (node.prepared.has(key)) return
    const manifest = await this.#localManifest(hash, kind)
    const sizes = new Map()
    for (const entry of manifest.entries)
      if (entry.type === 'file') sizes.set(entry.hash, entry.size)
    const hashes = [...new Set([...sizes.keys(), hash])]
    for (const object of await this.#missing(bulk, hashes, signal))
      await this.#send(bulk, object, sizes.get(object), signal)
    if ((await this.#missing(bulk, hashes, signal)).length)
      throw clusterError('The worker lost an input.', 'upload_failed', 502)
    this.#remember(node, nodeEpoch, key)
  }

  async #missing(bulk, hashes, signal) {
    const missing = []
    for (let index = 0; index < hashes.length; index += HAS_BATCH) {
      const batch = hashes.slice(index, index + HAS_BATCH)
      const reply = await bulk.request(
        'objects.has',
        { hashes: batch },
        { signal, timeoutMs: TIMEOUTS.chunk },
      )
      if (!Array.isArray(reply) || reply.length > batch.length)
        throw invalidReply()
      const requested = new Set(batch)
      const present = new Set(reply)
      for (const value of present)
        if (!requested.has(value)) throw invalidReply()
      for (const value of batch) if (!present.has(value)) missing.push(value)
    }
    return missing
  }

  async #send(bulk, hash, size, signal) {
    signal?.throwIfAborted()
    let table = this.#uploads.get(bulk)
    if (!table) {
      table = new Map()
      this.#uploads.set(bulk, table)
    }
    let task = table.get(hash)
    if (!task) {
      task = this.#sendBlob(bulk, hash, size).finally(() => table.delete(hash))
      table.set(hash, task)
      this.#track(task)
    }
    if (!signal) return task
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      task.then(
        (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      )
      if (signal.aborted) abort()
    })
  }

  async #sendBlob(bulk, hash, size) {
    try {
      return await this.#sendFrom(bulk, hash, size)
    } catch (error) {
      // Another writer moved the partial object; resume once from its offset.
      if (error?.code !== 'offset_conflict') throw error
      return this.#sendFrom(bulk, hash, size)
    }
  }

  // Resumes at the worker's partial offset. Every local byte is hashed,
  // including the prefix the worker already holds, before the final chunk.
  async #sendFrom(bulk, hash, size, signal) {
    const remote = await bulk.request(
      'objects.offset',
      { hash },
      { signal, timeoutMs: TIMEOUTS.chunk },
    )
    if (!isRecord(remote) || typeof remote.complete !== 'boolean')
      throw invalidReply()
    if (remote.complete) return
    let offset = remote.offset
    if (!Number.isSafeInteger(offset) || offset < 0) throw invalidReply()
    const hasher = createHash('sha256')
    let total = size
    for (let position = 0; ;) {
      signal?.throwIfAborted()
      let chunk
      try {
        chunk = await this.#blobs.readChunk(hash, position, CHUNK_BYTES)
      } catch {
        throw snapshotInvalid()
      }
      total ??= chunk.totalBytes
      const data = Buffer.from(chunk.data, 'base64')
      const end = position + data.length
      if (
        chunk.totalBytes !== total ||
        end > total ||
        (!data.length && end < total)
      )
        throw snapshotInvalid()
      if (offset > total) throw invalidReply()
      hasher.update(data)
      const final = end === total
      if (final && hasher.digest('hex') !== hash) throw snapshotInvalid()
      const from = Math.max(offset, position)
      if (from < end || final) {
        const part = data.subarray(from - position)
        const ack = await bulk.request(
          'objects.put',
          {
            hash,
            offset: from,
            data: part.toString('base64'),
            totalBytes: total,
            final,
          },
          { signal, timeoutMs: TIMEOUTS.chunk },
        )
        if (!isRecord(ack) || typeof ack.complete !== 'boolean')
          throw invalidReply()
        if (ack.complete) {
          if (ack.offset !== total) throw invalidReply()
          return
        }
        if (final || ack.offset !== from + part.length) throw invalidReply()
        offset = ack.offset
      }
      position = end
    }
  }

  async #download(node, hash, size, signal) {
    const bulk = await this.#bulkChannel(node)
    const hasher = createHash('sha256')
    const chunks = []
    for (let offset = 0; offset < size;) {
      const reply = await bulk.request(
        'objects.get',
        { hash, offset, length: CHUNK_BYTES },
        { signal, timeoutMs: TIMEOUTS.chunk },
      )
      if (
        !isRecord(reply) ||
        typeof reply.data !== 'string' ||
        reply.totalBytes !== size
      )
        throw failure('invalid_result')
      const data = Buffer.from(reply.data, 'base64')
      if (
        !data.length ||
        data.length > CHUNK_BYTES ||
        data.toString('base64') !== reply.data ||
        reply.offset !== offset + data.length ||
        reply.complete !== (reply.offset === size)
      )
        throw failure('invalid_result')
      hasher.update(data)
      chunks.push(data)
      offset = reply.offset
    }
    if (hasher.digest('hex') !== hash) throw failure('invalid_result')
    return Buffer.concat(chunks)
  }

  // Connections

  async #transport(node, channel) {
    const rpc = await this.#transportFactory({ ...node.config }, channel)
    if (
      typeof rpc?.request !== 'function' ||
      typeof rpc.close !== 'function' ||
      typeof rpc.once !== 'function'
    ) {
      rpc?.close?.()
      throw clusterError('Invalid worker transport.', 'connection_failed', 503)
    }
    return rpc
  }

  async #hello(node, rpc) {
    const reply = await rpc.request(
      'hello',
      {
        version: PROTOCOL_VERSION,
        lineage: this.#identity.lineage,
        epoch: this.#identity.epoch,
        bundleDigest: this.#bundleDigest,
        imageDigest: this.#imageDigest,
      },
      { timeoutMs: TIMEOUTS.hello },
    )
    return this.#workerStatus(node, reply)
  }

  #workerStatus(node, value) {
    if (
      !isRecord(value) ||
      value.version !== PROTOCOL_VERSION ||
      value.nodeId !== node.config.id ||
      value.bundleDigest !== this.#bundleDigest ||
      value.imageDigest !== this.#imageDigest
    )
      throw clusterError(
        'The worker release or identity does not match this controller.',
        'release_mismatch',
        409,
      )
    let budget, workerResources
    try {
      identifier(value.nodeEpoch, 'node epoch')
      budget = resourceVector(value.budget)
      workerResources = resourceVector({
        memoryBytes: value.workerResources?.memoryBytes,
        cpus: value.workerResources?.cpus,
      })
    } catch {
      throw invalidReply()
    }
    if (
      !Number.isSafeInteger(value.leaseMs) ||
      value.leaseMs < 5000 ||
      value.leaseMs > 120_000
    )
      throw invalidReply()
    // An uncertified worker advertises nothing, whatever its list says.
    const claimed =
      value.certified === true &&
      Array.isArray(value.capabilities) &&
      value.capabilities.length <= 16
        ? value.capabilities
        : []
    const capabilities = [
      ...new Set(claimed.filter((name) => operations.has(name))),
    ]
    return {
      nodeEpoch: value.nodeEpoch,
      ready: value.status === 'ready',
      role: value.role === 'reserve' ? 'reserve' : 'primary',
      capabilities,
      budget,
      workerResources,
      leaseMs: value.leaseMs,
      bundleDigest: value.bundleDigest,
      imageDigest: value.imageDigest,
    }
  }

  #observe(node, status) {
    if (node.nodeEpoch !== status.nodeEpoch) {
      node.prepared.clear()
      node.nodeEpoch = status.nodeEpoch
    }
    node.status = status
    node.seenAt = Date.now()
  }

  #connect(node) {
    if (this.#stopping || node.fenced || node.connecting || node.control) return
    node.connecting = this.#open(node)
      .catch((error) => {
        node.error = safeCode(error)
        if (fencedCodes.has(error?.code)) node.fenced = true
      })
      .finally(() => {
        node.connecting = null
        if (!node.control) this.#scheduleConnect(node)
      })
    this.#track(node.connecting)
  }

  #scheduleConnect(node) {
    if (this.#stopping || node.fenced || node.retryTimer || node.connecting)
      return
    if (node.control) return
    const delay = node.backoffMs
    node.backoffMs = Math.min(delay * 2, this.#timing.maxBackoffMs)
    node.retryTimer = setTimeout(() => {
      node.retryTimer = null
      this.#connect(node)
    }, delay)
    node.retryTimer.unref()
  }

  // Both channels must reach the same worker process with the pinned release
  // before the node takes work.
  async #open(node) {
    let control, bulk
    try {
      control = await this.#transport(node, 'control')
      const status = await this.#hello(node, control)
      bulk = await this.#transport(node, 'bulk')
      if ((await this.#hello(node, bulk)).nodeEpoch !== status.nodeEpoch)
        throw clusterError(
          'The worker channels reached different processes.',
          'release_mismatch',
          409,
        )
      if (this.#stopping || control.closed || bulk.closed)
        throw clusterError('closed', 'connection_closed', 503)
      node.control = control
      node.bulk = bulk
      control.once('close', () => this.#lost(node, control))
      bulk.once('close', () => {
        if (node.bulk === bulk) node.bulk = null
      })
      this.#observe(node, status)
    } catch (error) {
      control?.close()
      bulk?.close()
      throw error
    }
    node.backoffMs = this.#timing.minBackoffMs
    node.error = null
    this.#schedule(node, control, 'poll')
    this.#schedule(node, control, 'renew')
    await this.#reconcile(node)
    this.#pump()
  }

  // Reopens only the bulk channel; the control channel keeps leases and
  // cancellation going while it is down.
  #bulkChannel(node) {
    if (node.bulk && !node.bulk.closed) return Promise.resolve(node.bulk)
    node.bulkOpening ??= (async () => {
      const nodeEpoch = node.status?.nodeEpoch
      if (!node.control || !nodeEpoch)
        throw clusterError('closed', 'connection_closed', 503)
      const bulk = await this.#transport(node, 'bulk')
      try {
        const status = await this.#hello(node, bulk)
        if (
          !node.control ||
          status.nodeEpoch !== nodeEpoch ||
          node.status?.nodeEpoch !== nodeEpoch
        )
          throw clusterError('The worker restarted.', 'connection_closed', 503)
      } catch (error) {
        bulk.close()
        throw error
      }
      node.bulk = bulk
      bulk.once('close', () => {
        if (node.bulk === bulk) node.bulk = null
      })
      return bulk
    })().finally(() => {
      node.bulkOpening = null
    })
    return node.bulkOpening
  }

  #schedule(node, control, kind) {
    if (node.control !== control || this.#stopping) return
    const delay =
      kind === 'poll'
        ? this.#timing.pollMs
        : Math.max(
            10,
            Math.min(node.status.leaseMs / 3, 5000, this.#timing.renewMs),
          )
    const timer = setTimeout(() => {
      node.timers.delete(timer)
      const task =
        kind === 'poll' ? this.#poll(node, control) : this.#renew(node, control)
      this.#track(task.finally(() => this.#schedule(node, control, kind)))
    }, delay)
    timer.unref()
    node.timers.add(timer)
  }

  async #refresh(node, control) {
    const status = this.#workerStatus(
      node,
      await control.request('status', undefined, {
        timeoutMs: TIMEOUTS.status,
      }),
    )
    if (node.control !== control)
      throw clusterError('closed', 'connection_closed', 503)
    if (status.nodeEpoch !== node.status?.nodeEpoch)
      throw clusterError('The worker restarted.', 'release_mismatch', 409)
    this.#observe(node, status)
    return status
  }

  async #poll(node, control) {
    try {
      await this.#refresh(node, control)
      await this.#reconcile(node)
    } catch (error) {
      this.#disconnect(node, control, error)
    }
    this.#pump()
  }

  async #renew(node, control) {
    const ids = [...this.#active.values()]
      .filter((job) => job.node === node && job.started && !job.lost)
      .map((job) => job.id)
    try {
      for (let index = 0; index < ids.length; index += RENEW_BATCH) {
        const reply = await control.request(
          'lease.renew',
          { attempts: ids.slice(index, index + RENEW_BATCH) },
          { timeoutMs: TIMEOUTS.renew },
        )
        if (!isRecord(reply) || !Array.isArray(reply.renewed))
          throw invalidReply()
      }
    } catch (error) {
      this.#disconnect(node, control, error)
    }
  }

  #disconnect(node, control, error) {
    if (!control || node.control !== control) return
    node.error = safeCode(error)
    if (fencedCodes.has(error?.code)) node.fenced = true
    control.close(
      clusterError('The worker connection was closed.', 'connection_closed'),
    )
    this.#lost(node, control)
  }

  // Leases for this node stop with its control channel. Its running attempts
  // are stopped or held by their own tasks.
  #lost(node, control) {
    if (node.control !== control) return
    node.control = null
    node.bulk?.close()
    node.bulk = null
    node.status = null
    node.error ??= 'connection_lost'
    for (const timer of node.timers) clearTimeout(timer)
    node.timers.clear()
    for (const job of this.#active.values())
      if (job.node === node) {
        job.lost = true
        job.transfer.abort()
        job.wake?.()
      }
    this.#scheduleConnect(node)
    this.#pump()
  }
}
