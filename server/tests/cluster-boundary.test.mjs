import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { slicePath, inspectBoundary } from '../cluster/boundary.mjs'

test('worker slices resolve systemd hierarchy and exclude broad host slices', () => {
  assert.equal(
    slicePath('leanflow-workers.slice'),
    'leanflow.slice/leanflow-workers.slice',
  )
  for (const name of [
    'system.slice',
    'user.slice',
    '-.slice',
    '../x.slice',
    'leanflow--workers.slice',
  ])
    assert.throws(() => slicePath(name))
})

test('the actual container parent must enforce finite memory, zero swap and finite tasks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-boundary-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = {
    cgroupParent: 'leanflow-workers.slice',
    budgetBytes: 42 * 1024 ** 3,
    parentMemoryBytes: 48 * 1024 ** 3,
    parentTasksMax: 8192,
    maxCpus: 16,
    parentMaxCpus: 16,
  }
  const directory = path.join(root, slicePath(config.cgroupParent))
  await fs.mkdir(directory, { recursive: true })
  const set = async (memory, swap, tasks) => {
    for (const [name, value] of Object.entries({
      'memory.max': memory,
      'memory.swap.max': swap,
      'pids.max': tasks,
      'cpu.max': '1600000 100000',
    }))
      await fs.writeFile(path.join(directory, name), String(value))
  }
  await assert.rejects(inspectBoundary(config, root))
  for (const args of [
    ['max', 0, 8192],
    [40 * 1024 ** 3, 0, 8192],
    [64 * 1024 ** 3, 0, 8192],
    [48 * 1024 ** 3, 'max', 8192],
    [48 * 1024 ** 3, 0, 'max'],
  ]) {
    await set(...args)
    await assert.rejects(inspectBoundary(config, root), {
      code: 'boundary_unavailable',
    })
  }
  await set(48 * 1024 ** 3, 0, 8192)
  assert.equal(
    (await inspectBoundary(config, root)).memoryBytes,
    48 * 1024 ** 3,
  )
  await fs.writeFile(path.join(directory, 'cpu.max'), 'max 100000')
  await assert.rejects(inspectBoundary(config, root), {
    code: 'boundary_unavailable',
  })
})
