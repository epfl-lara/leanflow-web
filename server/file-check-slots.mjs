// A slot covers capture, the worker queue, compilation, and cleanup.
// Remaining checks wait without allocating source trees.
export class FileCheckSlots {
  #active = 0
  #waiting = new Set()
  #poll

  constructor(capacity) {
    this.capacity = capacity
  }

  #drain() {
    const limit = Math.max(1, Math.min(6, this.capacity()))
    while (this.#active < limit && this.#waiting.size) {
      const next = this.#waiting.values().next().value
      this.#waiting.delete(next)
      this.#active++
      next()
    }
    if (this.#waiting.size && !this.#poll) {
      // An editor or assistant can return capacity while a check is still running.
      this.#poll = setInterval(() => this.#drain(), 500)
      this.#poll.unref()
    } else if (!this.#waiting.size && this.#poll) {
      clearInterval(this.#poll)
      this.#poll = undefined
    }
  }

  async run(signal, action) {
    signal?.throwIfAborted()
    if (this.#waiting.size >= 128)
      throw Object.assign(
        new Error(
          'The file check queue is full. Try again after a check finishes.',
        ),
        { status: 429 },
      )
    await new Promise((resolve, reject) => {
      const resume = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        this.#waiting.delete(resume)
        reject(signal.reason)
        this.#drain()
      }
      this.#waiting.add(resume)
      signal?.addEventListener('abort', abort, { once: true })
      this.#drain()
    })
    let deferredCleanup
    const free = () => {
      this.#active--
      this.#drain()
    }
    try {
      signal?.throwIfAborted()
      return await action((task) => {
        deferredCleanup = task
      })
    } finally {
      if (deferredCleanup)
        deferredCleanup.then(free, (error) => {
          // The durable ownership claim and this slot survive unconfirmed cleanup.
          console.warn('Deferred file check cleanup:', error.message)
        })
      else free()
    }
  }
}
