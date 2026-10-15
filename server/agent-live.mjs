import { createHash } from 'node:crypto'
import { PROJECT_CONFIGURATION_FILES } from '../shared/project-configuration.mjs'

// The candidate remains isolated. Only permitted plaintext edits are mirrored
// into saved sources; the workspace store owns atomic context checks/backups.
export class LiveMirror {
  constructor({
    snapshot,
    workspaces,
    signal,
    onChanges,
    onConflict,
    onNotice,
    intervalMs = 1000,
    previousChanges = [],
    allowProjectFiles = false,
  }) {
    Object.assign(this, {
      snapshot,
      workspaces,
      signal,
      onChanges,
      onConflict,
      onNotice,
      intervalMs,
      allowProjectFiles,
    })
    this.liveChanges = previousChanges
    this.pending = null
    this.fingerprint = null
    this.stopped = false
    this.paused = false
    this.notices = new Set()
  }
  start() {
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => {
      void this.poll()
    }, this.intervalMs)
    this.timer.unref?.()
  }
  poll(force = false) {
    if (this.pending) return this.pending
    if (this.paused || this.signal?.aborted || (this.stopped && !force))
      return Promise.resolve()
    const task = this.#poll(force)
      .catch((error) => {
        if (error.status === 409 || error.statusCode === 409) {
          this.paused = true
          clearInterval(this.timer)
          this.onConflict?.(error)
        } else this.#notice(error, 'update')
      })
      .finally(() => {
        if (this.pending === task) this.pending = null
      })
    this.pending = task
    return task
  }
  async #poll(force) {
    let all
    try {
      all = await this.workspaces.changes(this.snapshot)
    } catch (error) {
      this.#notice(error, 'candidate')
      return
    }
    if (this.signal?.aborted || (this.stopped && !force)) return
    const changes = all.filter((change) => {
      if (
        change.path
          .split('/')
          .some((part) =>
            ['.git', '.lake', ...PROJECT_CONFIGURATION_FILES].includes(part),
          )
      )
        return false
      const lean = change.path.endsWith('.lean')
      return (
        (this.allowProjectFiles || lean) &&
        (typeof change.after === 'string' ||
          (this.allowProjectFiles && !lean && change.after === null))
      )
    })
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(changes.map(({ path, after }) => [path, after])))
      .digest('hex')
    if (fingerprint === this.fingerprint) return
    if (!changes.length && !this.liveChanges.length) {
      this.fingerprint = fingerprint
      return
    }
    const previous = this.liveChanges
    const next = await this.workspaces.syncLive(
      this.snapshot,
      changes,
      previous,
      { allowProjectFiles: this.allowProjectFiles },
    )
    const old = new Map(previous.map((change) => [change.path, change.after]))
    const fresh = new Map(next.map((change) => [change.path, change.after]))
    const paths = [...new Set([...old.keys(), ...fresh.keys()])].filter(
      (file) => old.get(file) !== fresh.get(file),
    )
    this.liveChanges = next
    this.fingerprint = fingerprint
    if (paths.length) this.onChanges?.(next, paths)
  }
  #notice(error, phase) {
    const key = `${phase}:${error.message}`
    if (this.notices.has(key) || this.notices.size >= 16) return
    this.notices.add(key)
    this.onNotice?.(error, phase)
  }
  async stop({ flush = false } = {}) {
    this.stopped = true
    clearInterval(this.timer)
    await this.pending
    if (flush) await this.poll(true)
  }
}
