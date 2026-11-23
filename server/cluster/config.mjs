import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { memoryBytes } from '../worker-memory.mjs'
import { clusterError, identifier, digest } from './state.mjs'
import { slicePath } from './boundary.mjs'
import { PROTOCOL_VERSION } from './protocol.mjs'

export const bundleRoot = fileURLToPath(new URL('../../', import.meta.url))

export async function workerBundleDigest(root = bundleRoot) {
  const hash = createHash('sha256')
  async function walk(relative) {
    const entries = await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    })
    for (const entry of entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      if (['node_modules', 'tests', '__pycache__'].includes(entry.name))
        continue
      const name = path.posix.join(relative, entry.name)
      if (entry.isSymbolicLink())
        throw clusterError('Worker release contains a symbolic link.')
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile()) {
        hash.update(name + '\0')
        hash.update(await fs.readFile(path.join(root, name)))
        hash.update('\0')
      }
    }
  }
  for (const relative of ['server', 'shared', 'deploy']) await walk(relative)
  return hash.digest('hex')
}

function pinnedExecutionProfile(value) {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== PROTOCOL_VERSION ||
    typeof value.imageDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest)
  )
    throw clusterError(
      'An execution profile must pin a supported worker protocol, bundle and image.',
    )
  return {
    version: PROTOCOL_VERSION,
    bundleDigest: digest(value.bundleDigest),
    imageDigest: value.imageDigest,
  }
}

export async function resolveExecutionProfile(config, localImageDigest) {
  const selected = pinnedExecutionProfile(config.executionProfile)
  if (selected) return selected
  if (!/^sha256:[a-f0-9]{64}$/.test(localImageDigest || ''))
    throw clusterError(
      'Initialize the pinned coordinator image before distributed execution.',
    )
  return {
    version: PROTOCOL_VERSION,
    bundleDigest: await workerBundleDigest(),
    imageDigest: localImageDigest,
  }
}

function positive(value, fallback, label, { integer = true } = {}) {
  value ??= fallback
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw clusterError(`Invalid ${label}.`)
  return value
}

export function nodeConfig(value) {
  if (!value || value.version !== 1)
    throw clusterError('Unsupported worker configuration version.')
  identifier(value.nodeId, 'node identifier')
  identifier(value.controllerLineage, 'controller lineage')
  if (
    typeof value.dataDir !== 'string' ||
    !path.isAbsolute(value.dataDir) ||
    /[,\x00-\x1f]/.test(value.dataDir)
  )
    throw clusterError('Worker storage must be an absolute local path.')
  if (
    typeof value.image !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.image)
  )
    throw clusterError('The worker image must be pinned by digest.')
  const engineKind = value.engineKind || 'docker'
  if (!['docker', 'podman'].includes(engineKind))
    throw clusterError('Unsupported worker engine.')
  if (value.role !== undefined && !['primary', 'reserve'].includes(value.role))
    throw clusterError('Invalid worker role.')
  const engineExecutable = value.engineExecutable || engineKind
  if (
    typeof engineExecutable !== 'string' ||
    !engineExecutable ||
    /[\x00-\x1f]/.test(engineExecutable)
  )
    throw clusterError('Invalid worker engine executable.')
  const dataDir = path.resolve(value.dataDir)
  const cgroupParent = value.cgroupParent || 'leanflow-workers.slice'
  slicePath(cgroupParent)
  const socketPath = value.socketPath || path.join(dataDir, 'worker.sock')
  if (
    !path.isAbsolute(socketPath) ||
    path.normalize(socketPath) !== socketPath ||
    Buffer.byteLength(socketPath) > 100 ||
    !socketPath.startsWith(dataDir + path.sep)
  )
    throw clusterError(
      'The private worker socket must be inside its data directory.',
    )
  const memory = value.workerMemory || '6g'
  const memoryBudget = value.memoryBudget || '42g'
  const memoryLimit = memoryBytes(memory, 'workerMemory')
  const budgetBytes = memoryBytes(memoryBudget, 'memoryBudget')
  const parentMemoryBytes = memoryBytes(
    value.parentMemoryMax || '48g',
    'parentMemoryMax',
  )
  const parentTasksMax = positive(
    value.parentTasksMax,
    8192,
    'parent task limit',
  )
  if (parentMemoryBytes < budgetBytes || parentTasksMax < 512)
    throw clusterError('The worker budget does not fit its container slice.')
  if (memoryLimit > budgetBytes)
    throw clusterError('A worker does not fit its memory budget.')
  const maxCpus = positive(
    value.maxCpus,
    os.availableParallelism(),
    'worker CPU budget',
    { integer: false },
  )
  const workerCpus = positive(value.workerCpus, 2, 'per-job CPU limit', {
    integer: false,
  })
  const parentMaxCpus = positive(
    value.parentMaxCpus,
    os.availableParallelism(),
    'parent CPU limit',
    { integer: false },
  )
  if (parentMaxCpus < maxCpus)
    throw clusterError(
      'The worker CPU budget does not fit its container slice.',
    )
  if (workerCpus > maxCpus)
    throw clusterError('A worker does not fit its CPU budget.')
  const editors = value.editors
  if (
    editors !== undefined &&
    (!editors || typeof editors !== 'object' || Array.isArray(editors))
  )
    throw clusterError('Invalid worker editor policy.')
  const maxEditors = editors
    ? positive(editors.maxConcurrent, 1, 'remote editor limit')
    : 0
  const editorMemory = editors?.memory || '3g'
  const editorMemoryBytes = memoryBytes(editorMemory, 'remote editor memory')
  const editorCpus = positive(editors?.cpus, 2, 'remote editor CPU cap', {
    integer: false,
  })
  const editorCpuReservation = positive(
    editors?.cpuReservation,
    editorCpus,
    'remote editor CPU reservation',
    { integer: false },
  )
  const editorBatchMemory = editors?.reservedBatchMemory || memory
  const editorBatchMemoryBytes = memoryBytes(
    editorBatchMemory,
    'remote editor batch reserve',
  )
  const editorBatchCpus = positive(
    editors?.reservedBatchCpus,
    workerCpus,
    'remote editor batch CPU reserve',
    { integer: false },
  )
  if (
    maxEditors &&
    (editorMemoryBytes * maxEditors + editorBatchMemoryBytes > budgetBytes ||
      editorCpuReservation * maxEditors + editorBatchCpus > maxCpus ||
      editorCpuReservation > editorCpus ||
      editorCpus > maxCpus ||
      editorBatchMemoryBytes < memoryLimit ||
      editorBatchCpus < workerCpus ||
      maxEditors > 12)
  )
    throw clusterError(
      'Remote editors must fit the worker pool while preserving an ordinary batch worker.',
    )
  if (
    maxEditors &&
    editorCpus * maxEditors + editorBatchCpus > maxCpus &&
    parentMaxCpus !== maxCpus
  )
    throw clusterError(
      'Editor CPU bursts must fit the agreed pool or an equally sized enforced parent slice.',
    )
  const leaseMs = positive(value.leaseMs, 30000, 'worker lease duration')
  if (leaseMs < 5000 || leaseMs > 120000)
    throw clusterError(
      'Worker lease duration must be between 5 and 120 seconds.',
    )
  const maxOutputBytes = positive(
    value.maxOutputBytes,
    4 * 1024 ** 2,
    'output limit',
  )
  if (maxOutputBytes > 16 * 1024 ** 2)
    throw clusterError('Worker output limit exceeds its bound.')
  if (
    value.startUserService !== undefined &&
    typeof value.startUserService !== 'boolean'
  )
    throw clusterError('Invalid user-service startup policy.')
  if (
    value.certifyToolchain !== undefined &&
    !/^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/.test(
      value.certifyToolchain,
    )
  )
    throw clusterError(
      'Automatic certification requires an official pinned toolchain.',
    )
  const maxConcurrent = Math.min(
    positive(
      value.maxConcurrent,
      maxEditors ? maxEditors + 1 : Math.floor(budgetBytes / memoryLimit),
      'worker concurrency',
    ),
    Math.floor(
      budgetBytes /
        (maxEditors ? Math.min(memoryLimit, editorMemoryBytes) : memoryLimit),
    ),
  )
  if (maxEditors && maxConcurrent < maxEditors + 1)
    throw clusterError(
      'Worker concurrency must fit the editor limit and an ordinary batch worker.',
    )
  return {
    version: 1,
    nodeId: value.nodeId,
    controllerLineage: value.controllerLineage,
    dataDir,
    socketPath,
    image: value.image,
    engineKind,
    engineExecutable,
    cgroupParent,
    workerMemory: memory,
    memoryBudget,
    memoryBytes: memoryLimit,
    budgetBytes,
    parentMemoryBytes,
    parentTasksMax,
    parentMaxCpus,
    workerCpus,
    maxCpus,
    maxEditors,
    editorMemory,
    editorMemoryBytes,
    editorCpus,
    editorCpuReservation,
    editorBatchMemory,
    editorBatchMemoryBytes,
    editorBatchCpus,
    ...(maxEditors
      ? {
          editors: {
            maxConcurrent: maxEditors,
            memory: editorMemory,
            cpus: editorCpus,
            cpuReservation: editorCpuReservation,
            reservedBatchMemory: editorBatchMemory,
            reservedBatchCpus: editorBatchCpus,
          },
        }
      : {}),
    leaseMs,
    maxConcurrent,
    scratchBytes: positive(
      value.scratchBytes,
      128 * 1024 ** 3,
      'scratch budget',
    ),
    role: value.role === 'reserve' ? 'reserve' : 'primary',
    maxOutputBytes,
    startUserService: value.startUserService === true,
    certifyToolchain: value.certifyToolchain || undefined,
    maxStoreBytes: positive(
      value.maxStoreBytes,
      128 * 1024 ** 3,
      'worker object-store budget',
    ),
    maxStoreFiles: positive(value.maxStoreFiles, 500000, 'worker object count'),
    reserveBytes: positive(
      value.reserveBytes,
      1024 ** 3,
      'worker disk reserve',
    ),
  }
}

export async function readNodeConfig(filename) {
  const stat = await fs.lstat(filename)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 256 * 1024 ||
    stat.mode & 0o022
  )
    throw clusterError('Worker configuration must be a protected regular file.')
  return nodeConfig(JSON.parse(await fs.readFile(filename, 'utf8')))
}

export async function registeredToolchainRoot(dataDir, version) {
  if (
    typeof dataDir !== 'string' ||
    !path.isAbsolute(dataDir) ||
    (await fs.realpath(dataDir)) !== dataDir
  )
    throw clusterError('Use the real absolute coordinator data directory.')
  if (
    !/^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/.test(
      version || '',
    )
  )
    throw clusterError('Choose an exact official toolchain.')
  const filename = path.join(dataDir, 'runtime/toolchains.json')
  const stat = await fs.lstat(filename)
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o022 ||
    stat.size > 256 * 1024 ||
    (await fs.realpath(filename)) !== filename
  )
    throw clusterError('The coordinator toolchain registry must be protected.')
  const root = JSON.parse(await fs.readFile(filename, 'utf8'))[version]
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    (await fs.realpath(root)) !== root
  )
    throw clusterError(
      'Prepare this official toolchain in the coordinator runtime first.',
    )
  return root
}

export async function readControllerConfig(filename) {
  if (!path.isAbsolute(filename))
    throw clusterError('The cluster configuration path must be absolute.')
  const stat = await fs.lstat(filename)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 256 * 1024 ||
    stat.mode & 0o022
  )
    throw clusterError(
      'Cluster configuration must be a protected regular file.',
    )
  return controllerConfig(JSON.parse(await fs.readFile(filename, 'utf8')))
}

export function controllerConfig(value) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 64
  )
    throw clusterError('Invalid cluster configuration.')
  identifier(value.lineage, 'controller lineage')
  const ids = new Set()
  const nodes = value.nodes.map((node) => {
    identifier(node?.id, 'node identifier')
    if (ids.has(node.id))
      throw clusterError('Duplicate cluster node identifier.')
    ids.add(node.id)
    if (
      typeof node.host !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(node.host) ||
      typeof node.user !== 'string' ||
      !/^[a-z_][a-z0-9_-]{0,63}$/i.test(node.user)
    )
      throw clusterError('Invalid worker SSH destination.')
    for (const field of ['identityFile', 'knownHostsFile'])
      if (
        typeof node[field] !== 'string' ||
        !path.isAbsolute(node[field]) ||
        /[\x00-\x1f]/.test(node[field])
      )
        throw clusterError(`Worker ${field} must be an absolute path.`)
    if (
      node.port !== undefined &&
      (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535)
    )
      throw clusterError('Invalid worker SSH port.')
    if (node.role !== undefined && !['primary', 'reserve'].includes(node.role))
      throw clusterError('Invalid worker role.')
    if (
      node.imageDigest !== undefined &&
      (typeof node.imageDigest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(node.imageDigest))
    )
      throw clusterError('Worker image identity must be an exact digest.')
    return {
      ...node,
      role: node.role || 'primary',
      enabled: node.enabled !== false,
      port: node.port || 22,
    }
  })
  const mode = value.mode || 'off'
  if (!['off', 'shadow', 'serve'].includes(mode))
    throw clusterError('Invalid cluster execution mode.')
  const executionProfile = pinnedExecutionProfile(value.executionProfile)
  const editorPlacement = value.editors?.placement || 'off'
  if (!['off', 'prefer'].includes(editorPlacement))
    throw clusterError('Invalid remote editor placement policy.')
  if (
    value.editors?.repositories !== undefined &&
    typeof value.editors.repositories !== 'boolean'
  )
    throw clusterError('Invalid repository editor placement policy.')
  return {
    version: 1,
    lineage: value.lineage,
    mode,
    executionProfile,
    editors: {
      placement: editorPlacement,
      repositories: value.editors?.repositories === true,
    },
    nodes,
    allowReserve: value.allowReserve === true,
    maxQueue: positive(value.maxQueue, 128, 'cluster queue limit'),
    maxPerActor: positive(value.maxPerActor, 8, 'per-account queue limit'),
    maxStoreBytes: positive(
      value.maxStoreBytes,
      32 * 1024 ** 3,
      'coordinator snapshot budget',
    ),
    maxStoreFiles: positive(
      value.maxStoreFiles,
      250000,
      'coordinator snapshot file budget',
    ),
    reserveBytes: positive(
      value.reserveBytes,
      8 * 1024 ** 3,
      'coordinator disk reserve',
    ),
  }
}
