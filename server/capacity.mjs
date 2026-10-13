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

export function loadCapacity(env = process.env) {
  const workerMemory = env.STUDIO_WORKER_MEMORY?.trim() || '4g'
  if (!/^[1-9][0-9]*[bkmg]?$/i.test(workerMemory))
    throw new Error(
      'STUDIO_WORKER_MEMORY must be a positive Docker memory size, such as 4g or 8192m.',
    )
  return {
    workers: positiveNumber(env, 'STUDIO_MAX_WORKERS', 6),
    workerQueue: positiveNumber(env, 'STUDIO_MAX_WORKER_QUEUE', 24),
    editors: positiveNumber(env, 'STUDIO_MAX_EDITORS', 4),
    editorsPerProject: positiveNumber(env, 'STUDIO_MAX_EDITORS_PER_PROJECT', 2),
    agents: positiveNumber(env, 'STUDIO_MAX_AGENTS', 2),
    agentQueue: positiveNumber(env, 'STUDIO_MAX_AGENT_QUEUE', 12),
    searches: positiveNumber(env, 'STUDIO_MAX_SEARCHES', 4),
    workerCpus: positiveNumber(env, 'STUDIO_WORKER_CPUS', 2, false),
    workerMemory,
  }
}
