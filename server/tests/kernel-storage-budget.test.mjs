import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StorageCapacity } from '../storage-capacity.mjs'
import { KernelStorageBudget } from '../kernel-storage-budget.mjs'

const MiB = 1024 ** 2

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-kernel-storage-'),
  )
  const runtimeDir = path.join(dataDir, 'runtime')
  const directory = path.join(
    runtimeDir,
    'homes',
    'a'.repeat(64),
    'kernel-check-tmp',
  )
  const exported = path.join(directory, 'leanflow-project-kernel-fixture')
  const filename = path.join(exported, 'project.ndjson')
  await fs.mkdir(exported, { recursive: true })
  const state = { free: 12 * MiB, sample: null, calls: 0 }
  const storage = new StorageCapacity({
    dataDir,
    minimumFreeBytes: 2 * MiB,
    warningFreeBytes: 8 * MiB,
    allocationBytes: MiB / 2,
    sample: async () => {
      state.calls++
      await state.sample?.()
      return { bavail: BigInt(state.free), bsize: 1n }
    },
  })
  const budget = new KernelStorageBudget({
    storage,
    runtimeDir,
    maximumBytes: 8 * MiB,
  })
  const claim = await budget.acquire()
  claim.track(directory)
  t.after(async () => {
    state.sample = null
    await claim.release()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const allocated = async () =>
    Number((await fs.stat(filename, { bigint: true })).blocks * 512n)
  return {
    dataDir,
    directory,
    exported,
    filename,
    state,
    storage,
    budget,
    claim,
    allocated,
  }
}

test('sparse logical export size never receives allocated-block credit', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.filename, '')
  await fs.truncate(f.filename, 8 * MiB)
  assert.equal(await f.allocated(), 0)
  const status = await f.storage.status({ refresh: true })
  assert.equal(status.reservedBytes, 8 * MiB)
})

test('stable allocated export blocks are counted once and bounded by the funded peak', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.filename, Buffer.alloc(4 * MiB, 'x'))
  const allocated = await f.allocated()
  assert(allocated > 0 && allocated <= 4 * MiB)
  f.state.free = 12 * MiB - allocated
  const status = await f.storage.status({ refresh: true })
  assert.equal(status.reservedBytes + allocated, 8 * MiB)
  assert.equal(status.availableBytes, 2 * MiB)
  const another = await f.storage.reserve({ bytes: 2 * MiB })
  await assert.rejects(f.storage.reserve({ bytes: 1 }), {
    code: 'STORAGE_PRESSURE',
  })
  another.release()
  await f.claim.release()
  assert.equal(f.storage.reservedBytes, 0)
  assert.equal(f.storage.allocationObservers.size, 0)
})

test('a truncate between capacity samples never retains the previous larger export credit', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.filename, Buffer.alloc(4 * MiB, 'x'))
  f.state.free = 12 * MiB - (await f.allocated())
  await f.storage.status({ refresh: true })
  let changed = false
  f.state.sample = async () => {
    if (!changed) {
      changed = true
      await fs.truncate(f.filename, 1024)
      f.state.free = 12 * MiB - (await f.allocated())
    }
  }
  const status = await f.storage.status({ refresh: true })
  assert.equal(changed, true)
  assert(status.reservedBytes >= 8 * MiB - 1024)
  assert.equal(f.storage.leases.size, 1)
})

test('continuously changing export metadata grants no credit and retries at most once', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.filename, Buffer.alloc(2 * MiB, 'x'))
  let count = 0
  f.state.sample = async () => {
    count++
    await fs.writeFile(f.filename, Buffer.alloc((count % 2 ? 1 : 2) * MiB, 'x'))
    f.state.free = 12 * MiB - (await f.allocated())
  }
  const status = await f.storage.status({ refresh: true })
  assert.equal(count, 2)
  assert.equal(status.reservedBytes, 8 * MiB)
})

test('unlink during capacity sampling keeps credited blocks pinned until verified cleanup', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.filename, Buffer.alloc(4 * MiB, 'x'))
  const allocated = await f.allocated()
  f.state.free = 12 * MiB - allocated
  let removed = false
  f.state.sample = async () => {
    if (!removed) {
      removed = true
      await fs.unlink(f.filename)
    }
  }
  const status = await f.storage.status({ refresh: true })
  assert.equal(status.reservedBytes + allocated, 8 * MiB)
  const retained = async () => {
    for (const fd of await fs.readdir('/proc/self/fd')) {
      try {
        if (
          (await fs.readlink(`/proc/self/fd/${fd}`)) ===
          `${f.filename} (deleted)`
        )
          return true
      } catch {
        /* A descriptor can close during enumeration. */
      }
    }
    return false
  }
  assert.equal(await retained(), true)
  await f.claim.release()
  assert.equal(await retained(), false)
  assert.equal(f.storage.reservedBytes, 0)
})

for (const alias of ['symlink', 'hardlink'])
  test(`an export ${alias} cannot credit unrelated data`, async (t) => {
    const f = await fixture(t)
    const outside = path.join(f.dataDir, 'unrelated-project-data')
    await fs.writeFile(outside, Buffer.alloc(MiB, 's'))
    if (alias === 'symlink') await fs.symlink(outside, f.filename)
    else await fs.link(outside, f.filename)
    assert.equal(
      (await f.storage.status({ refresh: true })).reservedBytes,
      8 * MiB,
    )
    await f.claim.release()
    assert.equal((await fs.stat(outside)).size, MiB)
  })

test('an export replaced during sampling grants no stale-inode credit', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(f.filename, Buffer.alloc(MiB, 'x'))
  let changed = false
  f.state.sample = async () => {
    if (!changed) {
      changed = true
      await fs.rename(f.filename, path.join(f.exported, 'retained-original'))
      await fs.writeFile(f.filename, Buffer.alloc(MiB, 'y'))
    }
  }
  assert.equal(
    (await f.storage.status({ refresh: true })).reservedBytes,
    8 * MiB,
  )
})

test('cancelling one shared initialization leaves another caller funded', async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-kernel-budget-wait-'),
  )
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  let complete
  const wait = new Promise((resolve) => {
    complete = resolve
  })
  const storage = new StorageCapacity({
    dataDir,
    minimumFreeBytes: 2 * MiB,
    warningFreeBytes: 8 * MiB,
    allocationBytes: MiB / 2,
    sample: async () => {
      await wait
      return { bavail: BigInt(12 * MiB), bsize: 1n }
    },
  })
  const budget = new KernelStorageBudget({
    storage,
    runtimeDir: dataDir,
    maximumBytes: 8 * MiB,
  })
  const controller = new AbortController()
  const first = budget.acquire({ signal: controller.signal })
  const cancelled = assert.rejects(first, { name: 'AbortError' })
  const second = budget.acquire()
  controller.abort()
  await cancelled
  complete()
  const claim = await second
  assert.equal(storage.reservedBytes, 8 * MiB)
  await claim.release()
  assert.equal(storage.reservedBytes, 0)
})

test('an export on another filesystem never credits the sampled data volume', async (t) => {
  const f = await fixture(t)
  const other = await fs.stat('/dev/shm', { bigint: true }).catch(() => null)
  const current = await fs.stat(f.dataDir, { bigint: true })
  if (!other || other.dev === current.dev)
    return t.skip('A separate temporary filesystem is unavailable.')
  await fs.writeFile(f.filename, Buffer.alloc(MiB, 'x'))
  await f.claim.release()
  f.storage.dataDir = '/dev/shm'
  const otherClaim = await f.budget.acquire()
  otherClaim.track(f.directory)
  try {
    assert.equal(
      (await f.storage.status({ refresh: true })).reservedBytes,
      8 * MiB,
    )
  } finally {
    await otherClaim.release()
  }
})

test('an export first created during statfs is remeasured before admitting other work', async (t) => {
  const f = await fixture(t)
  let created = false
  f.state.sample = async () => {
    if (!created) {
      created = true
      await fs.writeFile(f.filename, Buffer.alloc(4 * MiB, 'x'))
      f.state.free = 12 * MiB - (await f.allocated())
    }
  }
  const other = await f.storage.reserve({ bytes: MiB / 2 })
  assert.equal(created, true)
  assert.equal(
    f.storage.reservedBytes + (await f.allocated()),
    8 * MiB + MiB / 2,
  )
  other.release()
})
