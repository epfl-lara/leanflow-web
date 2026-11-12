import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StorageCapacity, loadStorageCapacity } from '../storage-capacity.mjs'

function fixture({
  bytes = 1000,
  minimum = 100,
  allocation = 200,
  sample,
} = {}) {
  const state = { bytes, calls: 0, fail: false }
  const storage = new StorageCapacity({
    dataDir: '/fixture/private-data',
    minimumFreeBytes: minimum,
    warningFreeBytes: 800,
    allocationBytes: allocation,
    resolve: async () => '/canonical/data-volume',
    sample:
      sample ||
      (async (filename, options) => {
        assert.equal(filename, '/canonical/data-volume')
        assert.deepEqual(options, { bigint: true })
        state.calls++
        if (state.fail)
          throw Object.assign(new Error('/private/path unavailable'), {
            code: 'EIO',
          })
        return { bavail: BigInt(state.bytes), bsize: 1n, bfree: 99999n }
      }),
  })
  return { storage, state }
}

test('storage configuration validates byte counts and emergency/warning thresholds', () => {
  assert.deepEqual(loadStorageCapacity({}), {
    minimumFreeBytes: 2 * 1024 ** 3,
    warningFreeBytes: 8 * 1024 ** 3,
    allocationBytes: 512 * 1024 ** 2,
  })
  for (const name of [
    'STUDIO_STORAGE_MIN_FREE_BYTES',
    'STUDIO_STORAGE_WARNING_FREE_BYTES',
    'STUDIO_STORAGE_ALLOCATION_BYTES',
  ]) {
    for (const invalid of ['-1', 'NaN', 'Infinity', '0.5', '9007199254740992'])
      assert.throws(
        () => loadStorageCapacity({ [name]: invalid }),
        new RegExp(name),
      )
  }
  assert.throws(
    () => loadStorageCapacity({ STUDIO_STORAGE_ALLOCATION_BYTES: '0' }),
    /ALLOCATION/,
  )
  assert.throws(
    () =>
      loadStorageCapacity({
        STUDIO_STORAGE_MIN_FREE_BYTES: '20',
        STUDIO_STORAGE_WARNING_FREE_BYTES: '10',
      }),
    /WARNING/,
  )
  assert.equal(
    loadStorageCapacity({
      STUDIO_STORAGE_MIN_FREE_BYTES: '0',
      STUDIO_STORAGE_WARNING_FREE_BYTES: '0',
    }).minimumFreeBytes,
    0,
  )
  assert.equal(
    loadStorageCapacity({ STUDIO_STORAGE_MIN_FREE_BYTES: '17179869184' })
      .warningFreeBytes,
    17179869184,
  )
})

test('storage checks the real data filesystem and exposes no host path', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-storage-'))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const target = path.join(base, 'mounted-data')
  const alias = path.join(base, 'configured-data')
  await fs.mkdir(target)
  await fs.symlink(target, alias)
  const canonical = await fs.realpath(target)
  const storage = new StorageCapacity({
    dataDir: alias,
    minimumFreeBytes: 1,
    warningFreeBytes: 2,
    allocationBytes: 1,
    sample: async (filename) => {
      assert.equal(filename, canonical)
      return fs.statfs(filename, { bigint: true })
    },
  })
  const lease = await storage.reserve()
  assert.equal(lease.bytes, 1)
  lease.release()
  const status = await storage.status()
  assert.equal(status.state, 'ready')
  assert.ok(status.freeBytes > 0)
  assert.equal(JSON.stringify(status).includes(base), false)
})

test('simultaneous reservations cannot spend the same free space', async () => {
  const { storage } = fixture({ bytes: 500 })
  const results = await Promise.allSettled([
    storage.reserve({ bytes: 250 }),
    storage.reserve({ bytes: 250 }),
  ])
  const accepted = results.filter((result) => result.status === 'fulfilled')
  const refused = results.filter((result) => result.status === 'rejected')
  assert.equal(accepted.length, 1)
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason.status, 503)
  assert.equal(refused[0].reason.code, 'STORAGE_PRESSURE')
  assert.equal((await storage.status()).reservedBytes, 250)
  accepted[0].value.release()
  assert.equal((await storage.status()).reservedBytes, 0)
})

test('ordinary-user available blocks leave filesystem administrator blocks untouched', async () => {
  const { storage } = fixture({ bytes: 250 })
  await assert.rejects(storage.reserve({ bytes: 151 }), {
    code: 'STORAGE_PRESSURE',
  })
  const lease = await storage.reserve({ bytes: 150 })
  assert.equal((await storage.status()).availableBytes, 0)
  lease.release()
})

test('admission observes disk expansion and depletion without waiting for status cache', async () => {
  const { storage, state } = fixture({ bytes: 200 })
  assert.equal((await storage.status()).state, 'blocked')
  state.bytes = 1000
  const lease = await storage.reserve({ bytes: 500 })
  state.bytes = 120
  await assert.rejects(storage.reserve({ bytes: 1 }), {
    code: 'STORAGE_PRESSURE',
  })
  lease.release()
  state.bytes = 1000
  assert.equal((await storage.status({ refresh: true })).state, 'ready')
})

test('reservation resizing is atomic and released reservations cannot reappear', async () => {
  const { storage } = fixture()
  const first = await storage.reserve({ bytes: 200 })
  const second = await storage.reserve({ bytes: 200 })
  const grown = await Promise.allSettled([
    first.resize(600),
    second.resize(600),
  ])
  assert.equal(
    grown.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  assert.equal((await storage.status()).reservedBytes, 800)
  first.release()
  first.release()
  await assert.rejects(first.resize(1), /released/)
  second.release()
  assert.equal((await storage.status()).reservedBytes, 0)
})

test('cancelled disk work retains its reservation until cleanup finishes', async () => {
  const { storage } = fixture()
  const controller = new AbortController()
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  let settle
  const pending = storage.withReservation(
    { bytes: 700, signal: controller.signal },
    async () => {
      entered()
      await new Promise((resolve) => {
        settle = resolve
      })
      controller.signal.throwIfAborted()
    },
  )
  await started
  controller.abort()
  await assert.rejects(storage.reserve({ bytes: 201 }), {
    code: 'STORAGE_PRESSURE',
  })
  assert.equal((await storage.status()).reservedBytes, 700)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  settle()
  await rejected
  assert.equal((await storage.status()).reservedBytes, 0)
  const replacement = await storage.reserve({ bytes: 700 })
  replacement.release()
})

test('cancellation while probing or growing creates no leaked allocation', async () => {
  let complete
  const wait = new Promise((resolve) => {
    complete = resolve
  })
  const { storage } = fixture({
    sample: async () => {
      await wait
      return { bavail: 1000n, bsize: 1n }
    },
  })
  const controller = new AbortController()
  const pending = storage.reserve({ bytes: 700, signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  complete()
  assert.equal((await storage.status()).reservedBytes, 0)
  const lease = await storage.reserve({ bytes: 200 })
  const growing = lease.resize(700, { signal: controller.signal })
  await assert.rejects(growing, { name: 'AbortError' })
  assert.equal(lease.bytes, 200)
  lease.release()
})

test('a released allocation cannot be revived by an in-flight resize', async () => {
  const { storage } = fixture()
  const lease = await storage.reserve({ bytes: 200 })
  let complete
  storage.sample = async () => {
    await new Promise((resolve) => {
      complete = resolve
    })
    return { bavail: 1000n, bsize: 1n }
  }
  const growing = lease.resize(700)
  await new Promise((resolve) => setImmediate(resolve))
  lease.release()
  complete()
  await assert.rejects(growing, /released/)
  assert.equal((await storage.status()).reservedBytes, 0)
})

test('failed admission and failed work preserve leases and expose actionable errors without paths', async () => {
  const { storage, state } = fixture()
  const lease = await storage.reserve({ bytes: 200 })
  state.fail = true
  await assert.rejects(storage.reserve({ bytes: 10 }), (error) => {
    assert.equal(error.status, 503)
    assert.equal(error.code, 'STORAGE_UNAVAILABLE')
    assert.match(error.message, /server administrator/)
    assert.doesNotMatch(error.message, /private|EIO/)
    return true
  })
  const status = await storage.status({ refresh: true })
  assert.equal(status.state, 'unavailable')
  assert.equal(status.freeBytes, null)
  assert.equal(status.availableBytes, null)
  assert.equal(JSON.stringify(status).includes('/private'), false)
  await lease.resize(50)
  assert.equal(lease.bytes, 50)
  lease.release()
  state.fail = false
  const original = new Error('A project copy failed')
  await assert.rejects(
    storage.withReservation({ bytes: 200 }, async () => {
      throw original
    }),
    (error) => error === original,
  )
  assert.equal((await storage.status()).reservedBytes, 0)
})

test('storage pressure status distinguishes warning, refusal and restored headroom', async () => {
  const { storage, state } = fixture({ bytes: 700 })
  assert.equal((await storage.status()).state, 'warning')
  const lease = await storage.reserve({ bytes: 500 })
  assert.equal((await storage.status()).state, 'blocked')
  assert.match((await storage.status()).message, /recovery remain available/)
  lease.release()
  state.bytes = 1000
  assert.equal((await storage.status({ refresh: true })).state, 'ready')
})

test('reservation metadata and probes stay bounded under request floods', async () => {
  const { storage, state } = fixture({ bytes: 1000, allocation: 1 })
  const leases = await Promise.all(
    Array.from({ length: 128 }, () => storage.reserve({ bytes: 1 })),
  )
  assert.equal(state.calls, 1)
  await assert.rejects(storage.reserve({ bytes: 0 }), { code: 'STORAGE_BUSY' })
  for (const lease of leases) lease.release()
  const resumed = await storage.reserve({ bytes: 1 })
  resumed.release()
  assert.equal((await storage.status()).reservedBytes, 0)
})

test('extreme filesystem and configured byte counts cannot overflow admission', async () => {
  const storage = new StorageCapacity({
    dataDir: '/fixture',
    minimumFreeBytes: Number.MAX_SAFE_INTEGER - 1,
    warningFreeBytes: Number.MAX_SAFE_INTEGER,
    allocationBytes: 10,
    resolve: async (value) => value,
    sample: async () => ({ bavail: 2n ** 63n, bsize: 4096n }),
  })
  await assert.rejects(storage.reserve({ bytes: 2 }), {
    code: 'STORAGE_PRESSURE',
  })
  const lease = await storage.reserve({ bytes: 1 })
  assert.equal((await storage.status()).availableBytes, 0)
  lease.release()
})

test('filesystem exhaustion with negative available blocks is refused as storage pressure', async () => {
  const { storage } = fixture({
    sample: async () => ({ bavail: -100n, bsize: 4096n, bfree: 200n }),
  })
  await assert.rejects(storage.reserve({ bytes: 1 }), {
    code: 'STORAGE_PRESSURE',
  })
  assert.equal((await storage.status()).freeBytes, 0)
  assert.equal((await storage.status()).state, 'blocked')
})

test('a stalled filesystem cannot hang cancellation or start unlimited probes', async () => {
  let finish
  let calls = 0
  const storage = new StorageCapacity({
    dataDir: '/fixture',
    minimumFreeBytes: 100,
    warningFreeBytes: 800,
    allocationBytes: 200,
    probeTimeoutMs: 5,
    resolve: async (value) => value,
    sample: async () => {
      calls++
      await new Promise((resolve) => {
        finish = resolve
      })
      return { bavail: 1000n, bsize: 1n }
    },
  })
  await assert.rejects(storage.reserve(), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal((await storage.status()).state, 'unavailable')
  await assert.rejects(storage.reserve(), { code: 'STORAGE_UNAVAILABLE' })
  assert.equal(calls, 1)
  finish()
  await new Promise((resolve) => setImmediate(resolve))
  storage.sample = async () => ({ bavail: 1000n, bsize: 1n })
  const resumed = await storage.reserve()
  resumed.release()
  assert.equal((await storage.status()).state, 'ready')
})

test('disk exhaustion during accepted allocation is actionable and releases the reservation after failure', async () => {
  const { storage } = fixture()
  for (const code of ['ENOSPC', 'EDQUOT']) {
    await assert.rejects(
      storage.withReservation({}, async () => {
        throw Object.assign(
          new Error('write failed at /private/project/path'),
          { code },
        )
      }),
      (error) => {
        assert.equal(error.status, 503)
        assert.equal(error.code, 'STORAGE_PRESSURE')
        assert.match(error.message, /server administrator/)
        assert.doesNotMatch(error.message, /private/)
        return true
      },
    )
    assert.equal((await storage.status()).reservedBytes, 0)
  }
})
