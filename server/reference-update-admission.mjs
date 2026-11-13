const busy = () =>
  Object.assign(
    new Error(
      'File reference updates are busy. Try the move again shortly, or turn off Update imports and file links.',
    ),
    { status: 429 },
  )

// A reservation covers discovery and application: waiting plans must not retain
// source-sized text after their scan releases its slot. The caller waits outside
// the workspace write queue so interactive saves can continue.
export class ReferenceUpdateAdmission {
  #active = 0
  #users = new Map()
  #projects = new Set()
  #queue = []

  constructor({
    maxConcurrent = 2,
    maxPerUser = 1,
    maxQueued = 24,
    maxWaitMs = 5000,
  } = {}) {
    if (
      !Number.isSafeInteger(maxConcurrent) ||
      maxConcurrent <= 0 ||
      !Number.isSafeInteger(maxPerUser) ||
      maxPerUser <= 0 ||
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 0 ||
      !Number.isSafeInteger(maxWaitMs) ||
      maxWaitMs <= 0
    )
      throw new Error(
        'Reference update capacity needs positive active and wait limits and a nonnegative queue limit.',
      )
    Object.assign(this, { maxConcurrent, maxPerUser, maxQueued, maxWaitMs })
  }

  #eligible(projectId, actor) {
    return (
      this.#active < this.maxConcurrent &&
      (this.#users.get(actor) || 0) < this.maxPerUser &&
      !this.#projects.has(projectId)
    )
  }

  #drain() {
    const now = Date.now()
    for (let index = this.#queue.length - 1; index >= 0; index--) {
      const entry = this.#queue[index]
      if (entry.deadline > now) continue
      this.#queue.splice(index, 1)
      clearTimeout(entry.timer)
      entry.reject(busy())
    }
    while (this.#active < this.maxConcurrent) {
      // A busy project or account must not hold up an unrelated eligible task.
      const waitingProjects = new Set()
      const index = this.#queue.findIndex(({ projectId, actor }) => {
        if (waitingProjects.has(projectId)) return false
        waitingProjects.add(projectId)
        return this.#eligible(projectId, actor)
      })
      if (index < 0) return
      const { projectId, actor, resolve, timer } = this.#queue.splice(
        index,
        1,
      )[0]
      clearTimeout(timer)
      this.#active++
      this.#users.set(actor, (this.#users.get(actor) || 0) + 1)
      this.#projects.add(projectId)
      let released = false
      resolve(() => {
        if (released) return
        released = true
        this.#active--
        const remaining = this.#users.get(actor) - 1
        if (remaining) this.#users.set(actor, remaining)
        else this.#users.delete(actor)
        this.#projects.delete(projectId)
        this.#drain()
      })
    }
  }

  #acquire(projectId, actor) {
    this.#drain()
    if (
      this.#queue.length >= this.maxQueued &&
      (!this.#eligible(projectId, actor) ||
        this.#queue.some((entry) => entry.projectId === projectId))
    )
      return Promise.reject(busy())
    return new Promise((resolve, reject) => {
      const entry = {
        projectId,
        actor,
        resolve,
        reject,
        deadline: Date.now() + this.maxWaitMs,
      }
      entry.timer = setTimeout(() => {
        const index = this.#queue.indexOf(entry)
        if (index < 0) return
        this.#queue.splice(index, 1)
        reject(busy())
        this.#drain()
      }, this.maxWaitMs)
      this.#queue.push(entry)
      this.#drain()
    })
  }

  async run(projectId, actor, operation) {
    const release = await this.#acquire(projectId, actor)
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
