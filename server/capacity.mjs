import { memoryBytes } from './worker-memory.mjs'

function positiveNumber(env, name, fallback, integer = true) {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error(
      `${name} must be a positive ${integer ? 'integer' : 'number'}.`,
    )
  return value
}

function nonnegativeInteger(env, name, fallback) {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative integer.`)
  return value
}

export function validateSetupBuildTimeout(
  value,
  label = 'setupBuildTimeoutMs',
) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 6 * 60 * 60 * 1000)
    throw new Error(
      `${label} must be a positive integer of at most 21600000 milliseconds (6 hours).`,
    )
  return value
}

export function loadCapacity(env = process.env) {
  const workerMemory = env.STUDIO_WORKER_MEMORY?.trim() || '4g'
  memoryBytes(workerMemory, 'STUDIO_WORKER_MEMORY')
  const workerMemoryBudget = env.STUDIO_WORKER_MEMORY_BUDGET?.trim() || null
  if (workerMemoryBudget)
    memoryBytes(workerMemoryBudget, 'STUDIO_WORKER_MEMORY_BUDGET')
  const editorMemory = env.STUDIO_EDITOR_MEMORY?.trim() || null
  if (
    editorMemory &&
    memoryBytes(editorMemory, 'STUDIO_EDITOR_MEMORY') < 6 * 1024 ** 2
  )
    throw new Error('STUDIO_EDITOR_MEMORY must be at least 6 MiB.')
  const batchMemoryReserved = env.STUDIO_RESERVED_BATCH_MEMORY?.trim() || null
  if (batchMemoryReserved)
    memoryBytes(batchMemoryReserved, 'STUDIO_RESERVED_BATCH_MEMORY')
  return {
    workers: positiveNumber(env, 'STUDIO_MAX_WORKERS', 6),
    workerQueue: positiveNumber(env, 'STUDIO_MAX_WORKER_QUEUE', 24),
    interactiveWorkers: nonnegativeInteger(
      env,
      'STUDIO_RESERVED_INTERACTIVE_WORKERS',
      1,
    ),
    batchWorkers: nonnegativeInteger(env, 'STUDIO_RESERVED_BATCH_WORKERS', 3),
    editors: positiveNumber(env, 'STUDIO_MAX_EDITORS', 4),
    editorQueue: positiveNumber(env, 'STUDIO_MAX_EDITOR_QUEUE', 128),
    editorQueuePerUser: positiveNumber(
      env,
      'STUDIO_MAX_EDITOR_QUEUE_PER_USER',
      3,
    ),
    editorQueueWaitMs: positiveNumber(
      env,
      'STUDIO_EDITOR_QUEUE_WAIT_MS',
      60 * 60_000,
    ),
    editorsPerProject: positiveNumber(env, 'STUDIO_MAX_EDITORS_PER_PROJECT', 2),
    editorsPerUser: positiveNumber(
      env,
      'STUDIO_MAX_EDITORS_PER_USER',
      positiveNumber(env, 'STUDIO_MAX_EDITORS', 4),
    ),
    terminals: positiveNumber(env, 'STUDIO_MAX_TERMINALS', 2),
    terminalsPerProject: positiveNumber(
      env,
      'STUDIO_MAX_TERMINALS_PER_PROJECT',
      1,
    ),
    agents: positiveNumber(env, 'STUDIO_MAX_AGENTS', 2),
    agentQueue: positiveNumber(env, 'STUDIO_MAX_AGENT_QUEUE', 12),
    agentQueuePerUser: positiveNumber(
      env,
      'STUDIO_MAX_AGENT_QUEUE_PER_USER',
      4,
    ),
    searches: positiveNumber(env, 'STUDIO_MAX_SEARCHES', 4),
    eventStreams: positiveNumber(env, 'STUDIO_MAX_EVENT_STREAMS', 256),
    eventStreamsPerUser: positiveNumber(
      env,
      'STUDIO_MAX_EVENT_STREAMS_PER_USER',
      16,
    ),
    sourceRequests: positiveNumber(env, 'STUDIO_MAX_SOURCE_REQUESTS', 2),
    sourceRequestsPerUser: positiveNumber(
      env,
      'STUDIO_MAX_SOURCE_REQUESTS_PER_USER',
      1,
    ),
    smallSourceRequests: positiveNumber(
      env,
      'STUDIO_MAX_SMALL_SOURCE_REQUESTS',
      8,
    ),
    smallSourceRequestsPerUser: positiveNumber(
      env,
      'STUDIO_MAX_SMALL_SOURCE_REQUESTS_PER_USER',
      2,
    ),
    setupBuildTimeoutMs: validateSetupBuildTimeout(
      positiveNumber(env, 'STUDIO_SETUP_BUILD_TIMEOUT_MS', 1800000),
      'STUDIO_SETUP_BUILD_TIMEOUT_MS',
    ),
    checkTimeoutMs: validateSetupBuildTimeout(
      positiveNumber(
        env,
        'STUDIO_CHECK_TIMEOUT_MS',
        positiveNumber(env, 'STUDIO_SETUP_BUILD_TIMEOUT_MS', 1800000),
      ),
      'STUDIO_CHECK_TIMEOUT_MS',
    ),
    setupRepairTimeoutMs: validateSetupBuildTimeout(
      positiveNumber(env, 'STUDIO_SETUP_REPAIR_TIMEOUT_MS', 900000),
      'STUDIO_SETUP_REPAIR_TIMEOUT_MS',
    ),
    workerCpus: positiveNumber(env, 'STUDIO_WORKER_CPUS', 2, false),
    workerMemory,
    workerMemoryBudget,
    editorMemory,
    editorCpus: positiveNumber(
      env,
      'STUDIO_EDITOR_CPUS',
      positiveNumber(env, 'STUDIO_WORKER_CPUS', 2, false),
      false,
    ),
    batchMemoryReserved,
    kernelExportMaxBytes: positiveNumber(
      env,
      'STUDIO_KERNEL_EXPORT_MAX_BYTES',
      8 * 1024 ** 3,
    ),
  }
}
