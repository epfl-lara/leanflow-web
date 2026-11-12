import { clusterError } from './state.mjs'
import { dependencyFailureMessage } from '../pinned-lake.mjs'

// Pure checks only. Canonical writers remain on the coordinator.
export class ClusterChecks {
  constructor({
    controller,
    inputs,
    mode,
    maxQueue = 128,
    maxPerActor = 8,
    maxCaptures = 2,
    shadowDeadlineMs = 120000,
  }) {
    Object.assign(this, {
      controller,
      inputs,
      mode,
      maxQueue,
      maxPerActor,
      maxCaptures,
      shadowDeadlineMs,
    })
    this.audit = []
    this.admitted = 0
    this.actors = new Map()
    this.captures = 0
    this.captureQueue = []
    this.background = new Map()
    this.remoteResults = new WeakSet()
    this.inflight = new Map()
    this.closing = false
  }

  isRemoteResult(result) {
    return this.remoteResults.has(result)
  }

  #record(value) {
    this.audit.push(value)
    this.audit = this.audit.slice(-100)
    try {
      this.controller.recordAudit?.(this.audit)
    } catch {
      /* Diagnostics cannot replace an authoritative result. */
    }
  }

  #admit(owner, optional = false) {
    const count = this.actors.get(owner) || 0
    if (this.admitted >= this.maxQueue || count >= this.maxPerActor) {
      if (optional) return null
      throw clusterError(
        'Too many checks are waiting. Wait for one to finish, then retry.',
        'cluster_queue_full',
        429,
      )
    }
    this.admitted++
    this.actors.set(owner, count + 1)
    return () => {
      this.admitted--
      const remaining = this.actors.get(owner) - 1
      if (remaining) this.actors.set(owner, remaining)
      else this.actors.delete(owner)
    }
  }

  async execute(context, local) {
    if (this.closing)
      throw clusterError(
        'Distributed checks are stopping.',
        'cluster_stopping',
        503,
      )
    const operation = context.kernelCheck ? 'check.kernel' : 'check.build'
    if (
      this.mode === 'off' ||
      this.controller.canRun?.(operation, context.file) === false
    )
      return local()
    context.options.signal?.throwIfAborted()
    if (this.mode === 'shadow') return this.#shadow(context, local)
    const release = this.#admit(context.owner)
    const abort = new AbortController()
    const copy = {
      ...context,
      options: {
        ...context.options,
        signal: AbortSignal.any([
          abort.signal,
          ...(context.options.signal ? [context.options.signal] : []),
        ]),
      },
    }
    const task = this.#serve(copy, local)
    this.inflight.set(abort, task)
    try {
      return await task
    } finally {
      release()
      this.inflight.delete(abort)
    }
  }

  async #serve(context, local) {
    const result = await this.#remote(context, context.options.onOutput)
    if (result === null) return local()
    this.#record({
      jobId: context.jobId,
      mode: 'serve',
      reason: 'remote-completed',
      remoteCode: result.code,
    })
    return result
  }

  #shadow(context, local) {
    // Start authoritative local work immediately. Optional shadow admission or
    // its deadline can never delay or replace that result.
    const primary = Promise.resolve().then(local)
    const release = this.#admit(context.owner, true)
    if (!release) return primary
    const abort = new AbortController()
    const signal = AbortSignal.any([
      abort.signal,
      ...(context.options.signal ? [context.options.signal] : []),
    ])
    const timer = setTimeout(
      () =>
        abort.abort(
          clusterError('Shadow check deadline reached.', 'shadow_timeout', 504),
        ),
      Math.min(this.shadowDeadlineMs, context.options.timeoutMs),
    )
    timer.unref?.()
    const copy = { ...context, options: { ...context.options, signal } }
    const task = Promise.allSettled([
      primary,
      Promise.resolve().then(() => this.#remote(copy, () => {})),
    ])
      .then(([localResult, remoteResult]) => {
        this.#record({
          jobId: context.jobId,
          mode: 'shadow',
          localCode:
            localResult.status === 'fulfilled' ? localResult.value.code : null,
          remoteCode:
            remoteResult.status === 'fulfilled'
              ? (remoteResult.value?.code ?? null)
              : null,
          matched:
            localResult.status === 'fulfilled' &&
            remoteResult.status === 'fulfilled' &&
            !!remoteResult.value &&
            localResult.value.code === remoteResult.value.code &&
            !!localResult.value.timedOut === !!remoteResult.value.timedOut &&
            !!localResult.value.cancelled === !!remoteResult.value.cancelled,
          reason:
            remoteResult.status === 'rejected'
              ? remoteResult.reason.workerCleanup
                ? 'remote-cleanup-unconfirmed'
                : 'remote-failed'
              : remoteResult.value
                ? 'compared'
                : 'no-eligible-worker',
        })
      })
      .finally(() => {
        clearTimeout(timer)
        release()
        this.background.delete(task)
      })
    this.background.set(task, abort)
    task.catch(() => {})
    return primary
  }

  #capture(signal, action) {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const entry = { signal, action, resolve, reject, onAbort: null }
      entry.onAbort = () => {
        const index = this.captureQueue.indexOf(entry)
        if (index >= 0) {
          this.captureQueue.splice(index, 1)
          reject(signal.reason)
        }
      }
      signal?.addEventListener('abort', entry.onAbort, { once: true })
      this.captureQueue.push(entry)
      this.#drainCaptures()
    })
  }

  #drainCaptures() {
    while (this.captures < this.maxCaptures && this.captureQueue.length) {
      const entry = this.captureQueue.shift()
      entry.signal?.removeEventListener('abort', entry.onAbort)
      if (entry.signal?.aborted) {
        entry.reject(entry.signal.reason)
        continue
      }
      this.captures++
      Promise.resolve()
        .then(entry.action)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.captures--
          this.#drainCaptures()
        })
    }
  }

  async #remote(context, onOutput) {
    const { project, owner, jobId, file, kernelCheck, fingerprint, options } =
      context
    let input
    try {
      input = await this.#capture(options.signal, () =>
        this.inputs.capture(project.root, {
          fingerprint,
          signal: options.signal,
        }),
      )
    } catch (error) {
      options.signal?.throwIfAborted()
      if (error.code === 'source_changed') throw error
      this.#record({ jobId, reason: 'snapshot-unavailable', mode: this.mode })
      return null
    }
    if (!input) return null
    options.signal?.throwIfAborted()
    const result = await this.controller.run(input, {
      operation: kernelCheck ? 'check.kernel' : 'check.build',
      ...(file?.endsWith('.lean') ? { file } : {}),
      actor: owner,
      projectId: project.id,
      jobId,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onOutput,
    })
    if (result === null) return null
    this.remoteResults.add(result)
    if (result.code !== 0 && dependencyFailureMessage(result)) {
      // Output is untrusted. Quarantine this exact frozen input on its worker;
      // a crafted diagnostic cannot disable a shared environment for everyone.
      this.controller.quarantineResult?.(result)
      throw clusterError(
        'A check worker could not use the prepared dependencies. Retry the check or ask the administrator to inspect worker setup.',
        'worker_environment',
        503,
      )
    }
    return result
  }

  async settleShadows() {
    await Promise.allSettled([...this.background.keys()])
  }

  async close() {
    this.closing = true
    for (const abort of this.inflight.keys())
      abort.abort(
        clusterError(
          'Distributed check stopped during shutdown.',
          'cluster_stopping',
          503,
        ),
      )
    for (const abort of this.background.values())
      abort.abort(
        clusterError('Shadow check stopped during shutdown.', 'cancelled', 499),
      )
    const shutdown =
      this.controller.shutdown?.() || Promise.resolve({ unresolved: 0 })
    const [report] = await Promise.all([
      shutdown,
      this.settleShadows(),
      Promise.allSettled([...this.inflight.values()]),
    ])
    this.inputs.blobs?.close()
    return report
  }
}
