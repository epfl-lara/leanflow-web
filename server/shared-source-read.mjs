// Stops one caller's wait. The shared task keeps running for other callers.
export function waitFor(task, signal) {
  if (!signal) return task
  let abort
  return Promise.race([
    task,
    new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    }),
  ]).finally(() => signal.removeEventListener('abort', abort))
}

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
    try {
      return await waitFor(this.task, signal)
    } finally {
      this.waiters--
      if (!this.waiters && this.active) {
        this.controller.abort(signal?.reason)
        await this.task.catch(() => {})
      }
    }
  }
}
