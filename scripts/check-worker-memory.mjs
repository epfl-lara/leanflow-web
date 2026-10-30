#!/usr/bin/env node
// Exercise real memory containment with small offline fixtures, never user projects.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Runtime } from '../server/runtime.mjs'

const reportDir = path.resolve('.runtime/worker-memory-check')
await fs.mkdir(reportDir, { recursive: true })
const dataDir = await fs.mkdtemp(path.join(reportDir, 'fixture-'))
const root = path.join(dataDir, 'project')
await fs.mkdir(root)
const runtime = new Runtime({
  dataDir,
  maxConcurrent: 2,
  cpus: 1,
  memory: '96m',
  memoryBudget: '192m',
})
const controller = new AbortController()
let survivorTask
try {
  const info = await runtime.init()
  assert.equal(info.ready, true, info.error)
  assert.equal(info.maxConcurrent, 2)
  assert.equal(info.limits.memoryBudgetBytes, 192 * 1024 ** 2)
  const limits = await runtime.run(
    root,
    [
      'python3',
      '-I',
      '-c',
      String.raw`
import json
from pathlib import Path
base = Path('/sys/fs/cgroup')
if (base / 'memory.max').exists():
    memory = int((base / 'memory.max').read_text())
    swap = int((base / 'memory.swap.max').read_text())
    quota, period = map(int, (base / 'cpu.max').read_text().split())
    pids = int((base / 'pids.max').read_text())
else:
    memory = int((base / 'memory/memory.limit_in_bytes').read_text())
    swap = int((base / 'memory/memory.memsw.limit_in_bytes').read_text()) - memory
    quota = int((base / 'cpu/cpu.cfs_quota_us').read_text())
    period = int((base / 'cpu/cpu.cfs_period_us').read_text())
    pids = int((base / 'pids/pids.max').read_text())
assert memory == 96 * 1024 ** 2
assert swap == 0
assert quota == period
assert pids == 512
print(json.dumps(dict(memory=memory, swap=swap, cpus=quota / period, pids=pids)))
`,
    ],
    { timeoutMs: 30_000 },
  )
  assert.equal(limits.code, 0, limits.stderr)

  const started = Promise.withResolvers()
  let survivor
  survivorTask = runtime.run(
    root,
    [
      'python3',
      '-I',
      '-u',
      '-c',
      'import time; print("ready"); time.sleep(60)',
    ],
    {
      signal: controller.signal,
      timeoutMs: 30_000,
      onSpawn: (child) => {
        survivor = child
      },
      onOutput: (chunk) => {
        if (chunk.includes('ready')) started.resolve()
      },
    },
  )
  survivorTask.then(
    () =>
      started.reject(
        new Error('The other worker stopped before the memory check finished.'),
      ),
    (error) => started.reject(error),
  )
  await started.promise

  const overflow = await runtime.run(
    root,
    [
      'python3',
      '-I',
      '-c',
      'payload = bytearray(256 * 1024 ** 2); print("unexpected allocation")',
    ],
    { timeoutMs: 30_000 },
  )
  assert.equal(
    overflow.code,
    137,
    `Expected a memory kill, got ${JSON.stringify(overflow)}`,
  )
  assert.equal(survivor.exitCode, null, 'The other worker must keep running')
  assert.equal(runtime.info().usedSlots, 1)
  const recovery = await runtime.run(
    root,
    ['python3', '-I', '-c', 'print("worker recovered")'],
    { timeoutMs: 30_000 },
  )
  assert.equal(recovery.code, 0, recovery.stderr)
  assert.equal(recovery.stdout.trim(), 'worker recovered')
  controller.abort()
  assert.equal((await survivorTask).cancelled, true)
  assert.equal(runtime.info().usedSlots, 0)
  const report = {
    limits: JSON.parse(limits.stdout),
    memoryBudgetBytes: info.limits.memoryBudgetBytes,
    overflowExitCode: overflow.code,
    otherWorkerUnaffected: true,
    subsequentWorkerSucceeded: true,
    providerCalls: 0,
  }
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(
    'Verified worker memory limits, zero swap, isolated memory failure, and worker recovery.',
  )
} finally {
  controller.abort()
  await survivorTask?.catch(() => {})
  await runtime.shutdown()
  await fs.rm(dataDir, { recursive: true, force: true })
}
