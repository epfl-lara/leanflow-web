// Source durability and notifications never depend on this optional activity log.
export class SaveEvents {
  constructor({ append, onError = () => {}, delayMs = 500, maximum = 256 }) {
    Object.assign(this, { append, onError, delayMs, maximum })
    this.pending = new Map()
    this.timer = null
    this.closed = false
  }

  record(projectId, filename) {
    if (this.closed) return
    const key = JSON.stringify([projectId, filename])
    const previous = this.pending.get(key)
    if (!previous && this.pending.size >= this.maximum) return
    this.pending.set(key, {
      projectId,
      filename,
      count: (previous?.count || 0) + 1,
    })
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.delayMs)
      this.timer.unref?.()
    }
  }

  flush() {
    clearTimeout(this.timer)
    this.timer = null
    const entries = [...this.pending.values()]
    this.pending.clear()
    if (!entries.length) return
    try {
      this.append(entries)
    } catch (error) {
      try {
        this.onError(error)
      } catch {
        /* Optional diagnostics cannot fail a timer or close. */
      }
    }
  }

  close() {
    this.closed = true
    this.flush()
  }
}
