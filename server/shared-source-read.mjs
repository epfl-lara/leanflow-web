// Several authorized checks can wait for the same in-flight filesystem read.
// The last cancellation stops the helper and waits for it to release its slot.
export class SharedSourceRead {
  constructor(start) {
    this.controller = new AbortController()
    this.waiters = 0
    this.settled = false
    this.task = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  get active() {
    return !this.settled && !this.controller.signal.aborted
  }

  async wait(signal) {
    signal?.throwIfAborted()
    this.waiters++
    let abort
    try {
      if (!signal) return await this.task
      return await Promise.race([
        this.task,
        new Promise((_, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
        }),
      ])
    } finally {
      signal?.removeEventListener('abort', abort)
      this.waiters--
      if (!this.waiters && this.active) {
        this.controller.abort(signal?.reason)
        await this.task.catch(() => {})
      }
    }
  }
}
