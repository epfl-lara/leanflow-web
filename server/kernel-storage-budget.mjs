import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

function cancellable(promise, signal) {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

const sameFileState = (a, b) =>
  a &&
  b &&
  ['dev', 'ino', 'size', 'blocks', 'mtimeNs', 'ctimeNs', 'nlink'].every(
    (key) => a[key] === b[key],
  )

// Inspect only the dedicated export path of the trusted check driver. Never
// walk project files or follow aliases supplied by a project or its agent.
class OwnedKernelExport {
  constructor(runtimeDir, directory, maximumBytes, dataDir) {
    const relative = path
      .relative(runtimeDir, directory)
      .split(path.sep)
      .join('/')
    if (!/^homes\/[a-f0-9]{64}\/kernel-check-tmp$/.test(relative))
      throw new Error('Kernel export storage must use an owned worker home.')
    Object.assign(this, { runtimeDir, directory, maximumBytes, dataDir })
    this.reading = Promise.resolve()
  }

  measure() {
    const operation = this.reading.then(() => this.#measure()).catch(() => null)
    this.reading = operation.then(() => {})
    return operation
  }

  async #measure() {
    if (!this.root) {
      this.root = await fs.open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
    }
    if ((await fs.realpath(`/proc/self/fd/${this.root.fd}`)) !== this.directory)
      return null
    if (!this.file) {
      const entries = await fs.opendir(`/proc/self/fd/${this.root.fd}`)
      let selected,
        count = 0
      for await (const entry of entries) {
        if (++count > 16) return null
        if (!/^leanflow-project-kernel-[a-zA-Z0-9_-]{1,128}$/.test(entry.name))
          continue
        if (selected || !entry.isDirectory()) return null
        selected = entry.name
      }
      if (!selected) return null
      if (!this.parent) {
        this.parent = await fs.open(
          `/proc/self/fd/${this.root.fd}/${selected}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        this.parentPath = path.join(this.directory, selected)
      }
      if (
        (await fs.realpath(`/proc/self/fd/${this.parent.fd}`)) !==
        this.parentPath
      )
        return null
      this.file = await fs.open(
        `/proc/self/fd/${this.parent.fd}/project.ndjson`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const initial = await this.file.stat({ bigint: true })
      const root = await this.root.stat({ bigint: true })
      const owned = await fs.stat(this.runtimeDir, { bigint: true })
      const volume = await fs.stat(this.dataDir, { bigint: true })
      if (
        !initial.isFile() ||
        initial.nlink !== 1n ||
        initial.dev !== root.dev ||
        root.dev !== owned.dev ||
        root.dev !== volume.dev
      )
        return null
      this.identity = { dev: initial.dev, ino: initial.ino }
    }
    const stat = await this.file.stat({ bigint: true })
    const volume = await fs.stat(this.dataDir, { bigint: true })
    if (
      !this.identity ||
      !stat.isFile() ||
      stat.dev !== this.identity.dev ||
      stat.dev !== volume.dev ||
      stat.ino !== this.identity.ino ||
      stat.nlink > 1n ||
      stat.size > BigInt(this.maximumBytes) ||
      stat.blocks < 0n ||
      stat.size < 0n
    )
      return null
    try {
      const current = await fs.lstat(
        `/proc/self/fd/${this.parent.fd}/project.ndjson`,
        { bigint: true },
      )
      if (
        !current.isFile() ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.nlink !== 1n ||
        (await fs.realpath(`/proc/self/fd/${this.file.fd}`)) !==
          path.join(this.parentPath, 'project.ndjson')
      )
        return null
    } catch (error) {
      // Keep the verified inode open after the driver's unlink. Its allocated
      // blocks remain charged to statfs until cleanup restores the full budget.
      if (error.code !== 'ENOENT' || stat.nlink !== 0n) return null
    }
    return stat
  }

  async close() {
    await this.reading
    for (const name of ['file', 'parent', 'root']) {
      if (this[name]) {
        await this[name].close()
        this[name] = null
      }
    }
  }
}

/** One funded peak export, shared by queued checks and the one running check. */
export class KernelStorageBudget {
  constructor({ storage, runtimeDir, maximumBytes }) {
    Object.assign(this, { storage, runtimeDir, maximumBytes })
    this.group = null
  }

  async acquire({ signal } = {}) {
    signal?.throwIfAborted()
    while (this.group?.closing) await cancellable(this.group.transition, signal)
    let group = this.group
    if (!group) {
      group = {
        claims: new Set(),
        controller: new AbortController(),
        lease: null,
        export: null,
        owner: null,
        generation: 0,
        transition: Promise.resolve(),
        closing: false,
      }
      this.group = group
    }
    const claim = { released: false, releasing: null }
    group.claims.add(claim)
    if (!group.initialization) {
      group.initialization = this.storage
        .reserve({ bytes: this.maximumBytes, signal: group.controller.signal })
        .then((lease) => {
          group.lease = lease
          if (this.storage.observeAllocations && lease.accountAllocatedBytes)
            group.unsubscribe = this.storage.observeAllocations(() =>
              this.#prepareProbe(group),
            )
        })
      group.initialization.catch(() => {})
    }
    try {
      await cancellable(group.initialization, signal)
      signal?.throwIfAborted()
    } catch (error) {
      await this.#release(group, claim)
      throw error
    }
    return Object.freeze({
      track: (directory) => {
        if (claim.released || group.owner)
          throw new Error('A kernel export already owns this storage budget.')
        group.export = new OwnedKernelExport(
          this.runtimeDir,
          directory,
          this.maximumBytes,
          this.storage.dataDir,
        )
        group.owner = claim
        group.generation++
      },
      release: () => this.#release(group, claim),
    })
  }

  async #prepareProbe(group) {
    await group.transition.catch(() => {})
    const tracker = group.export,
      generation = group.generation
    const before = tracker && !group.resetting ? await tracker.measure() : null
    return async (validSample) => {
      await group.transition.catch(() => {})
      if (!group.lease || group.closing || generation !== group.generation)
        return false
      const after =
        validSample && tracker && !group.resetting
          ? await tracker.measure()
          : null
      if (generation !== group.generation || group.closing) return false
      const stable = validSample && sameFileState(before, after)
      const allocated = stable
        ? Number(
            [after.blocks * 512n, after.size, BigInt(this.maximumBytes)].reduce(
              (a, b) => (a < b ? a : b),
            ),
          )
        : 0
      group.lease.accountAllocatedBytes(allocated)
      return stable || (!before && !after)
    }
  }

  #release(group, claim) {
    if (claim.releasing) return claim.releasing
    if (claim.released) return Promise.resolve()
    const ownsExport = group.owner === claim
    if (!ownsExport) {
      group.claims.delete(claim)
      claim.released = true
      if (!group.claims.size) {
        group.closing = true
        group.controller.abort(new Error('Queued full checks were cancelled.'))
      }
    }
    const previous = group.transition
    const transition = previous
      .catch(() => {})
      .then(async () => {
        if (ownsExport) {
          group.resetting = true
          group.generation++
          group.lease?.accountAllocatedBytes?.(0)
          await group.export.close()
          group.export = null
          group.owner = null
          group.resetting = false
          group.claims.delete(claim)
          claim.released = true
        }
        if (!group.claims.size) {
          group.closing = true
          await group.initialization.catch(() => {})
          group.lease?.release()
          group.lease = null
          group.unsubscribe?.()
          if (this.group === group) this.group = null
        }
      })
    group.transition = transition
    claim.releasing = transition.catch((error) => {
      claim.releasing = null
      throw error
    })
    return claim.releasing
  }
}
