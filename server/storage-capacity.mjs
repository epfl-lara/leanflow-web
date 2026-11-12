import { realpath, statfs } from 'node:fs/promises'
import path from 'node:path'

const GiB = 1024 ** 3
const maximumReservations = 128
const pressureMessage =
  'Project storage is running low. Ask the server administrator to add space, then retry. Existing work is kept; downloads and recovery remain available.'
const unavailableMessage =
  'Project storage could not be checked. Ask the server administrator to check storage, then retry. Existing files can still be downloaded.'

function byteCount(value, label, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new Error(
      `${label} must be a ${zero ? 'nonnegative' : 'positive'} integer byte count.`,
    )
  return value
}

function setting(env, name, fallback, options) {
  const raw = env[name]?.trim()
  return raw ? byteCount(Number(raw), name, options) : fallback
}

export function loadStorageCapacity(env = process.env) {
  const minimumFreeBytes = setting(
    env,
    'STUDIO_STORAGE_MIN_FREE_BYTES',
    2 * GiB,
    { zero: true },
  )
  const warningFreeBytes = setting(
    env,
    'STUDIO_STORAGE_WARNING_FREE_BYTES',
    Math.max(8 * GiB, minimumFreeBytes),
    { zero: true },
  )
  const allocationBytes = setting(
    env,
    'STUDIO_STORAGE_ALLOCATION_BYTES',
    GiB / 2,
  )
  if (warningFreeBytes < minimumFreeBytes)
    throw new Error(
      'STUDIO_STORAGE_WARNING_FREE_BYTES must be at least STUDIO_STORAGE_MIN_FREE_BYTES.',
    )
  return { minimumFreeBytes, warningFreeBytes, allocationBytes }
}

function storageError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    status: 503,
    storagePressure: true,
  })
}

export function storageFailure(error) {
  return ['ENOSPC', 'EDQUOT'].includes(error?.code)
    ? storageError(pressureMessage, 'STORAGE_PRESSURE', error)
    : error
}

function availableBytes(sample) {
  // bavail excludes blocks reserved for the filesystem administrator. A
  // service running as root must still leave that reserve alone.
  const blocks = BigInt(sample.bavail)
  const size = BigInt(sample.bsize)
  if (size <= 0n) throw new Error('Invalid storage capacity.')
  const bytes = blocks > 0n ? blocks * size : 0n
  return Number(
    bytes > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : bytes,
  )
}

function cancellable(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(signal.reason)
    signal.addEventListener('abort', cancelled, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', cancelled)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', cancelled)
        reject(error)
      },
    )
  })
}

/**
 * Admission for new disk allocations, never a user-data retention policy.
 * A reservation is intentionally held until all filesystem work settles, even
 * when its request is cancelled. Releasing on abort would admit a replacement
 * while the original copy or its cleanup still consumes space.
 */
export class StorageCapacity {
  constructor({
    dataDir,
    minimumFreeBytes = 2 * GiB,
    warningFreeBytes = Math.max(8 * GiB, minimumFreeBytes),
    allocationBytes = GiB / 2,
    sample = statfs,
    resolve = realpath,
    now = Date.now,
    statusCacheMs = 1000,
    probeTimeoutMs = 5000,
  }) {
    if (!dataDir) throw new Error('Storage capacity requires a data directory.')
    this.dataDir = path.resolve(dataDir)
    this.minimumFreeBytes = byteCount(minimumFreeBytes, 'minimumFreeBytes', {
      zero: true,
    })
    this.warningFreeBytes = byteCount(warningFreeBytes, 'warningFreeBytes', {
      zero: true,
    })
    this.allocationBytes = byteCount(allocationBytes, 'allocationBytes')
    if (warningFreeBytes < minimumFreeBytes)
      throw new Error('warningFreeBytes must be at least minimumFreeBytes.')
    this.sample = sample
    this.resolve = resolve
    this.now = now
    this.statusCacheMs = byteCount(statusCacheMs, 'statusCacheMs', {
      zero: true,
    })
    this.probeTimeoutMs = byteCount(probeTimeoutMs, 'probeTimeoutMs')
    this.leases = new Map()
    this.reservedBytes = 0
    this.observed = null
    this.probing = null
    this.allocationObservers = new Set()
  }

  observeAllocations(prepare) {
    if (typeof prepare !== 'function' || this.allocationObservers.size >= 16)
      throw new Error('Storage allocation observers must be bounded functions.')
    this.allocationObservers.add(prepare)
    return () => this.allocationObservers.delete(prepare)
  }

  #setReservation(key, bytes) {
    if (bytes === undefined) this.leases.delete(key)
    else this.leases.set(key, bytes)
    let total = 0n
    for (const amount of this.leases.values()) total += BigInt(amount)
    // Restoring funded claims can exceed current free space after unrelated
    // writes. Saturate for refusal rather than overflowing into false capacity.
    this.reservedBytes = Number(
      total > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : total,
    )
  }

  async #probe({ refresh = false } = {}) {
    if (
      !refresh &&
      this.observed &&
      this.now() - this.observed.time < this.statusCacheMs
    )
      return this.observed
    if (this.probing) return this.probing
    const operation = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const confirmations = []
        try {
          const canonical = await this.resolve(this.dataDir)
          for (const prepare of this.allocationObservers)
            confirmations.push(await prepare())
          const result = await this.sample(canonical, { bigint: true })
          let coherent = true
          for (const confirm of confirmations)
            if ((await confirm(true)) === false) coherent = false
          if (!coherent && attempt === 0) continue
          return { freeBytes: availableBytes(result), time: this.now() }
        } catch (cause) {
          for (const confirm of confirmations) {
            try {
              await confirm(false)
            } catch {
              /* Failed checks grant no new admission. */
            }
          }
          return { freeBytes: null, time: this.now(), cause }
        }
      }
    })()
    let timer
    const deadline = new Promise((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            freeBytes: null,
            time: this.now(),
            cause: Object.assign(
              new Error('Storage capacity check timed out.'),
              { code: 'ETIMEDOUT' },
            ),
          }),
        this.probeTimeoutMs,
      )
    })
    const probe = Promise.race([operation, deadline])
    this.probing = probe
    // A timed-out operating-system request may still be pending. Keep its
    // settled refusal as the shared result until it ends, rather than starting
    // unlimited statfs requests against a stalled mount.
    void operation.then(() => {
      clearTimeout(timer)
      if (this.probing === probe) this.probing = null
    })
    this.observed = await probe
    return this.observed
  }

  #check(observed, bytes, previous = 0) {
    if (observed.freeBytes === null)
      throw storageError(
        unavailableMessage,
        'STORAGE_UNAVAILABLE',
        observed.cause,
      )
    let total = -BigInt(previous)
    for (const amount of this.leases.values()) total += BigInt(amount)
    const available = BigInt(observed.freeBytes) - BigInt(this.minimumFreeBytes)
    // Funded claims can return from already allocated blocks. Compare their
    // exact total even when public byte counts have saturated the safe range.
    if (
      available < 0n ||
      total > available ||
      BigInt(bytes) > available - total
    )
      throw storageError(pressureMessage, 'STORAGE_PRESSURE')
  }

  async reserve({ bytes = this.allocationBytes, signal } = {}) {
    byteCount(bytes, 'reservation bytes', { zero: true })
    signal?.throwIfAborted()
    // Admission always gets a fresh asynchronous measurement. Display status
    // can be cached, but a recently expanded or newly full disk cannot be.
    const observed = await cancellable(this.#probe({ refresh: true }), signal)
    signal?.throwIfAborted()
    if (this.leases.size >= maximumReservations)
      throw storageError(
        'Project storage work is busy. Wait for current imports or project jobs to finish, then retry.',
        'STORAGE_BUSY',
      )
    this.#check(observed, bytes)
    const key = Symbol('storage reservation')
    this.#setReservation(key, bytes)
    let fundedBytes = bytes
    let allocatedBytes = 0
    const storage = this
    return Object.freeze({
      get bytes() {
        return storage.leases.get(key) || 0
      },
      release() {
        const previous = storage.leases.get(key)
        if (previous === undefined) return
        storage.#setReservation(key, undefined)
      },
      accountAllocatedBytes(nextAllocated) {
        byteCount(nextAllocated, 'allocated bytes', { zero: true })
        if (nextAllocated > fundedBytes || !storage.leases.has(key))
          throw new Error(
            'Allocated storage must belong to a funded reservation.',
          )
        allocatedBytes = nextAllocated
        // The caller verifies these blocks around the filesystem sample. They
        // are already charged to statfs, so only future allocation stays held.
        storage.#setReservation(key, fundedBytes - allocatedBytes)
      },
      async resize(nextBytes, { signal: resizeSignal } = {}) {
        byteCount(nextBytes, 'reservation bytes', { zero: true })
        resizeSignal?.throwIfAborted()
        if (!storage.leases.has(key))
          throw new Error('This storage reservation has already been released.')
        if (allocatedBytes)
          throw new Error(
            'Reset allocated storage accounting before resizing its budget.',
          )
        const current = storage.leases.get(key)
        // Shrinking is always possible, including after the filesystem fails.
        // Do not await here: release/resize must remain atomic with admission.
        if (nextBytes <= current) {
          fundedBytes = nextBytes
          storage.#setReservation(key, nextBytes)
          return
        }
        const updated = await cancellable(
          storage.#probe({ refresh: true }),
          resizeSignal,
        )
        resizeSignal?.throwIfAborted()
        const previous = storage.leases.get(key)
        if (previous === undefined)
          throw new Error('This storage reservation has already been released.')
        if (allocatedBytes)
          throw new Error(
            'Reset allocated storage accounting before resizing its budget.',
          )
        storage.#check(updated, nextBytes, previous)
        fundedBytes = nextBytes
        storage.#setReservation(key, nextBytes)
      },
    })
  }

  async withReservation(options, operation) {
    if (typeof operation !== 'function')
      throw new Error('Storage reservation requires an operation.')
    const reservation = await this.reserve(options)
    try {
      return await operation(reservation)
    } catch (error) {
      throw storageFailure(error)
    } finally {
      reservation.release()
    }
  }

  async status(options) {
    const observed = await this.#probe(options)
    const effective =
      observed.freeBytes === null
        ? null
        : Math.max(0, observed.freeBytes - this.reservedBytes)
    const state =
      effective === null
        ? 'unavailable'
        : effective < this.minimumFreeBytes ||
            effective - this.minimumFreeBytes < this.allocationBytes
          ? 'blocked'
          : effective < this.warningFreeBytes
            ? 'warning'
            : 'ready'
    return {
      state,
      freeBytes: observed.freeBytes,
      reservedBytes: this.reservedBytes,
      availableBytes:
        effective === null
          ? null
          : Math.max(0, effective - this.minimumFreeBytes),
      minimumFreeBytes: this.minimumFreeBytes,
      warningFreeBytes: this.warningFreeBytes,
      message:
        state === 'unavailable'
          ? unavailableMessage
          : state === 'blocked'
            ? pressureMessage
            : state === 'warning'
              ? 'Project storage is running low. Ask the server administrator to add space before starting large imports or project jobs.'
              : null,
    }
  }
}
