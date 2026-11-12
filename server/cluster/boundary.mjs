import fs from 'node:fs/promises'
import path from 'node:path'
import { clusterError } from './state.mjs'

export function slicePath(name) {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*\.slice$/.test(name) ||
    ['system.slice', 'user.slice'].includes(name)
  )
    throw clusterError('Worker containers require a dedicated systemd slice.')
  const parts = name.slice(0, -6).split('-')
  return parts
    .map((_, index) => parts.slice(0, index + 1).join('-') + '.slice')
    .join('/')
}

// Docker-created containers are children of the daemon's cgroups, not of the
// connecting user's service. Check their actual parent, not the user slice.
export async function inspectBoundary(config, root = '/sys/fs/cgroup') {
  const relative = slicePath(config.cgroupParent)
  const directory = path.join(root, relative)
  const [memory, swap, tasks, cpu] = await Promise.all(
    ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'].map((name) =>
      fs.readFile(path.join(directory, name), 'utf8'),
    ),
  )
  const finite = (text) =>
    /^\d+\s*$/.test(text) &&
    Number.isSafeInteger(Number(text)) &&
    Number(text) > 0
  if (
    !finite(memory) ||
    Number(memory) > config.parentMemoryBytes ||
    Number(memory) < config.budgetBytes
  )
    throw clusterError(
      'The container slice must enforce its configured memory boundary and fit the worker budget.',
      'boundary_unavailable',
      503,
    )
  const [quota, period] = cpu.trim().split(/\s+/).map(Number)
  const cpus = quota / period
  if (
    !Number.isSafeInteger(quota) ||
    !Number.isSafeInteger(period) ||
    quota <= 0 ||
    period <= 0 ||
    cpus < config.maxCpus ||
    cpus > config.parentMaxCpus
  )
    throw clusterError(
      'The container slice must enforce the enrolled CPU boundary.',
      'boundary_unavailable',
      503,
    )
  if (
    swap.trim() !== '0' ||
    !finite(tasks) ||
    Number(tasks) > config.parentTasksMax ||
    Number(tasks) < 512
  )
    throw clusterError(
      'The container slice must enforce zero swap and a finite task boundary.',
      'boundary_unavailable',
      503,
    )
  return {
    relative,
    memoryBytes: Number(memory),
    swapBytes: 0,
    tasks: Number(tasks),
    cpus,
  }
}
