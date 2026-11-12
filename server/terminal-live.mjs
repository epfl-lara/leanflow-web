// Terminal workers edit a private copy. Only short, checked source transactions
// reach the project, and shutdown never holds the workspace lock.
export class TerminalSourceMirror {
  constructor({
    workspaces,
    snapshot,
    assertAuthorized,
    onUnpublished,
    onConflict,
    onError,
    intervalMs = 500,
  }) {
    Object.assign(this, {
      workspaces,
      snapshot,
      assertAuthorized,
      onUnpublished,
      onConflict,
      onError,
      intervalMs,
    })
    this.changes = []
    this.pending = null
    this.paused = false
    this.stopped = false
  }
  start() {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
    this.timer.unref?.()
  }
  poll(force = false) {
    if (this.pending) return this.pending
    if (this.paused || (this.stopped && !force)) return Promise.resolve()
    const pending = Promise.resolve()
      .then(() =>
        this.workspaces.syncTerminal(this.snapshot, this.changes, {
          assertAuthorized: this.assertAuthorized,
          onUnpublished: this.onUnpublished,
        }),
      )
      .then((changes) => {
        this.changes = changes
      })
      .catch((error) => {
        this.paused = true
        clearInterval(this.timer)
        if ((error.status || error.statusCode) === 409) this.onConflict?.(error)
        else this.onError?.(error)
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null
      })
    this.pending = pending
    return pending
  }
  async stop({ flush = false } = {}) {
    this.stopped = true
    clearInterval(this.timer)
    await this.pending
    if (flush) await this.poll(true)
  }
}
