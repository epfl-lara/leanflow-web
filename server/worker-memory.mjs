export function memoryBytes(value, label) {
  const match =
    typeof value === 'string' && /^([1-9][0-9]*)([bkmg]?)$/i.exec(value)
  if (match) {
    const multiplier = {
      '': 1n,
      b: 1n,
      k: 1024n,
      m: 1024n ** 2n,
      g: 1024n ** 3n,
    }
    const bytes = BigInt(match[1]) * multiplier[match[2].toLowerCase()]
    if (bytes <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(bytes)
  }
  throw new Error(
    `${label} must be a positive Docker memory size, such as 4g or 8192m, within the safe byte range.`,
  )
}

export function workerMemoryCapacity({ memory, memoryBudget, hostMemory }) {
  if (!Number.isSafeInteger(hostMemory) || hostMemory <= 0)
    throw new Error(
      'Cannot verify Docker host memory. Ask the server administrator to check Docker memory reporting before starting workers.',
    )
  const ceiling = Number((BigInt(hostMemory) * 3n) / 4n)
  const budget =
    memoryBudget == null
      ? ceiling
      : memoryBytes(memoryBudget, 'STUDIO_WORKER_MEMORY_BUDGET')
  if (budget > ceiling)
    throw new Error(
      'STUDIO_WORKER_MEMORY_BUDGET must leave at least 25% of Docker host memory for the app and system. Lower the budget before starting workers.',
    )
  const workerBytes = memoryBytes(memory, 'STUDIO_WORKER_MEMORY')
  if (workerBytes < 6 * 1024 ** 2)
    throw new Error(
      'STUDIO_WORKER_MEMORY must be at least 6 MiB, the Docker minimum.',
    )
  const slots = Math.floor(budget / workerBytes)
  if (slots < 1)
    throw new Error(
      'One worker does not fit the shared memory budget. Lower STUDIO_WORKER_MEMORY, increase STUDIO_WORKER_MEMORY_BUDGET within the host allowance, or use a larger server.',
    )
  return {
    slots,
    memoryBudgetBytes: budget,
    hostMemoryBytes: hostMemory,
  }
}
