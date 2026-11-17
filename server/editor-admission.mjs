const refusal = (message, status) =>
  Object.assign(new Error(message), { status })
const queueFull = () =>
  refusal(
    'Lean editors are busy and the waiting list is full. Close unused editor tabs or try again shortly.',
    429,
  )
const accountQueueFull = () =>
  refusal(
    'You already have the most Lean editor tabs allowed to wait. Close one or wait for an editor to start.',
    429,
  )
const expired = () =>
  refusal(
    'No Lean editor became free in time. Reopen the file to join the waiting list again.',
    429,
  )
const closing = () =>
  refusal('LeanFlow is restarting. Reopen the file in a moment.', 503)

const decrement = (counts, key) => {
  const remaining = counts.get(key) - 1
  if (remaining) counts.set(key, remaining)
  else counts.delete(key)
}

// Waiting editor sessions hold no worker. An entry keeps only its account,
// project id and the caller's callbacks, never editor traffic or project data.
export class EditorAdmission {
  #capacity
  #active = 0
  #users = new Map()
  #projects = new Map()
  #queue = []
  #poll = null
  #closed = false
  #draining = false
  #again = false
  #starting = null
  #sequence = 0

  constructor({
    capacity,
    maxPerUser,
    maxPerProject,
    maxQueued = 128,
    maxQueuedPerUser = 3,
    maxWaitMs = 3_600_000,
    pollMs = 500,
  } = {}) {
    const positive = (value) => Number.isSafeInteger(value) && value > 0
    const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0
    if (
      typeof capacity !== 'function' ||
      ![maxPerUser, maxPerProject, maxWaitMs, pollMs].every(positive) ||
      ![maxQueued, maxQueuedPerUser].every(nonnegative)
    )
      throw new Error(
        'Editor admission needs a capacity probe, positive active and wait limits and nonnegative queue limits.',
      )
    this.#capacity = capacity
    Object.assign(this, {
      maxPerUser,
      maxPerProject,
      maxQueued,
      maxQueuedPerUser,
      maxWaitMs,
      pollMs,
    })
  }

  #limit() {
    try {
      const value = this.#capacity()
      return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
    } catch {
      // An unavailable worker probe admits nothing new; the poll retries.
      return 0
    }
  }

  #waiting() {
    return this.#queue.filter((entry) => entry.waiting)
  }

  #remove(entry) {
    if (entry.settled) return false
    entry.settled = true
    const index = this.#queue.indexOf(entry)
    if (index >= 0) this.#queue.splice(index, 1)
    entry.signal?.removeEventListener('abort', entry.abort)
    return true
  }

  #settle(entry, error) {
    if (this.#remove(entry)) entry.reject(error)
  }

  #expire() {
    const now = Date.now()
    for (const entry of [...this.#queue])
      if (entry.deadline <= now) this.#settle(entry, expired())
  }

  // A request blocked by its project, account or worker placement holds back
  // only later requests that share its project or account.
  #next() {
    if (this.#closed || this.#starting || this.#active >= this.#limit())
      return null
    const projects = new Set(),
      actors = new Set()
    for (const entry of [...this.#queue]) {
      const { actor, projectId } = entry
      if (entry.settled || projects.has(projectId) || actors.has(actor))
        continue
      projects.add(projectId)
      actors.add(actor)
      if (
        (this.#users.get(actor) || 0) >= this.maxPerUser ||
        (this.#projects.get(projectId) || 0) >= this.maxPerProject
      )
        continue
      let ready = false
      try {
        ready = entry.canStart() === true
      } catch (error) {
        this.#settle(entry, error)
      }
      if (!entry.settled) {
        if (ready) return entry
        continue
      }
      // A refused or cancelled request no longer holds back later ones.
      projects.delete(projectId)
      actors.delete(actor)
    }
    return null
  }

  #start(entry) {
    this.#remove(entry)
    const { actor, projectId, signal } = entry
    this.#active++
    if (entry.reserveStart) this.#starting = entry
    this.#users.set(actor, (this.#users.get(actor) || 0) + 1)
    this.#projects.set(projectId, (this.#projects.get(projectId) || 0) + 1)
    let released = false
    let confirmed = !entry.reserveStart
    const free = () => {
      if (released) return false
      released = true
      if (this.#starting === entry) this.#starting = null
      this.#active--
      decrement(this.#users, actor)
      decrement(this.#projects, projectId)
      return true
    }
    const release = () => {
      if (!free()) return
      this.#drain()
    }
    // Do not probe the same unreserved worker for another tab until this
    // startup has actually acquired its runtime/controller resources.
    release.started = () => {
      if (released || confirmed) return
      confirmed = true
      if (this.#starting === entry) this.#starting = null
      this.#drain()
    }
    release.retry = () => {
      if (released || confirmed)
        return Promise.reject(
          new Error('Editor startup is no longer retryable.'),
        )
      free()
      if (this.#closed || signal?.aborted) {
        this.#drain()
        return Promise.reject(signal?.aborted ? signal.reason : closing())
      }
      return new Promise((resolve, reject) => {
        Object.assign(entry, { resolve, reject, settled: false, shown: '' })
        signal?.addEventListener('abort', entry.abort, { once: true })
        this.#queue.push(entry)
        this.#queue.sort((a, b) => a.order - b.order)
        this.#drain()
      })
    }
    try {
      entry.onStatus({ state: 'starting' })
      signal?.throwIfAborted()
    } catch (error) {
      // Nobody owns the slot before the promise resolves, so free it here.
      release()
      entry.reject(error)
      return
    }
    entry.resolve(release)
  }

  // New requests join the waiting list only after they could not start, so a
  // refused tab never receives a queue position.
  #bound() {
    const reserved = this.#starting?.waiting ? this.#starting : null
    let total = reserved ? 1 : 0
    const users = new Map()
    if (reserved) users.set(reserved.actor, 1)
    for (const entry of [...this.#queue]) {
      const mine = users.get(entry.actor) || 0
      if (!entry.waiting) {
        const refused =
          mine >= this.maxQueuedPerUser
            ? accountQueueFull()
            : total >= this.maxQueued
              ? queueFull()
              : null
        if (refused) {
          this.#settle(entry, refused)
          continue
        }
        entry.waiting = true
      }
      total++
      users.set(entry.actor, mine + 1)
    }
  }

  #publish() {
    const waiting = this.#waiting()
    for (const [index, entry] of waiting.entries()) {
      if (entry.settled) continue
      const notice = {
        state: 'waiting',
        position: index + 1,
        total: waiting.length,
      }
      const shown = `${notice.position}/${notice.total}`
      if (entry.shown === shown) continue
      entry.shown = shown
      try {
        entry.onStatus(notice)
      } catch (error) {
        this.#settle(entry, error)
        this.#again = true
      }
      // A callback that changed the queue makes the remaining positions stale.
      if (this.#again) return
    }
  }

  #schedule() {
    if (this.#queue.length && !this.#closed) {
      if (this.#poll) return
      this.#poll = setInterval(() => this.#drain(), this.pollMs)
      this.#poll.unref?.()
    } else if (this.#poll) {
      clearInterval(this.#poll)
      this.#poll = null
    }
  }

  #drain() {
    if (this.#draining) {
      this.#again = true
      return
    }
    this.#draining = true
    try {
      do {
        this.#again = false
        this.#expire()
        for (let entry = this.#next(); entry; entry = this.#next())
          this.#start(entry)
        this.#bound()
        // Positions are sent only after callbacks have stopped changing the queue.
        if (!this.#again) this.#publish()
      } while (this.#again)
    } finally {
      this.#draining = false
      this.#schedule()
    }
  }

  // Resolves with the slot's release. The caller owns it even if the signal
  // aborts later and calls it only after the editor process has stopped.
  acquire({
    actor,
    projectId,
    signal,
    canStart = () => true,
    onStatus = () => {},
    deadline = Date.now() + this.maxWaitMs,
    reserveStart = false,
  }) {
    if (this.#closed) return Promise.reject(closing())
    if (
      typeof actor !== 'string' ||
      !actor ||
      typeof projectId !== 'string' ||
      !projectId
    )
      return Promise.reject(
        new TypeError('Editor admission needs an account and a project.'),
      )
    if (signal?.aborted) return Promise.reject(signal.reason)
    return new Promise((resolve, reject) => {
      const entry = {
        actor,
        order: ++this.#sequence,
        reserveStart,
        projectId,
        signal,
        canStart,
        onStatus,
        resolve,
        reject,
        deadline: Math.min(deadline, Date.now() + this.maxWaitMs),
        waiting: false,
        settled: false,
        shown: '',
      }
      entry.abort = () => {
        this.#settle(entry, signal.reason)
        this.#drain()
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.#queue.push(entry)
      this.#drain()
    })
  }

  // Runs before a WebSocket upgrade and reserves nothing; acquire repeats the
  // checks. A full waiting list refuses only accounts that would have to wait.
  assertCanQueue(actor) {
    if (this.#closed) throw closing()
    const waiting = this.#waiting()
    if (this.#starting?.waiting) waiting.push(this.#starting)
    const mine = waiting.filter((entry) => entry.actor === actor).length
    if (waiting.length < this.maxQueued && mine < this.maxQueuedPerUser) return
    if (
      !this.#starting &&
      !mine &&
      this.#active < this.#limit() &&
      (this.#users.get(actor) || 0) < this.maxPerUser
    )
      return
    throw mine >= this.maxQueuedPerUser ? accountQueueFull() : queueFull()
  }

  info() {
    return {
      active: this.#active,
      queued: this.#waiting().length,
      maxQueued: this.maxQueued,
    }
  }

  // Running editors keep their slots until the caller has stopped them and
  // called release; only waiting requests are refused.
  close() {
    this.#closed = true
    for (const entry of [...this.#queue]) this.#settle(entry, closing())
    this.#schedule()
  }
}
