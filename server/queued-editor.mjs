import { DeferredEditor } from './cluster/editor-stream.mjs'

function stopped(child) {
  if (child.workerReleased) return child.workerReleased
  if (child.workerStopped) return child.workerStopped
  if (child.closed || typeof child.exitCode === 'number')
    return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}

// Wait outside Lean/runtime worker pools. A lease stays held through confirmed
// process cleanup, including a disconnect while remote preparation is pending.
export function queuedEditor({
  admission,
  actor,
  projectId,
  canStart,
  start,
  onStatus,
}) {
  return new DeferredEditor(async (signal) => {
    let retryAfter = 0
    const deadline = Date.now() + admission.maxWaitMs
    let retry = null
    for (;;) {
      const release = await (retry ||
        admission.acquire({
          actor,
          projectId,
          signal,
          onStatus,
          deadline,
          reserveStart: true,
          canStart: () => Date.now() >= retryAfter && canStart(),
        }))
      retry = null
      let child, actual
      const abort = () => child?.kill()
      try {
        signal.throwIfAborted()
        child = start()
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        actual = child.ready ? await child.ready : child
        signal.throwIfAborted()
        onStatus({ state: 'active' })
        stopped(actual).then(release, () => {
          // Unconfirmed cleanup cannot release capacity for a second process.
          console.warn('[LeanFlow] Editor cleanup remains unconfirmed.')
        })
        release.started()
        return child
      } catch (error) {
        // Failed starts keep their own lease until cleanup is confirmed, but
        // an offline worker must not block startup on every healthy machine.
        release.startingDone()
        child?.kill()
        if (actual) {
          try {
            await stopped(actual)
          } catch {
            throw error
          }
        } else if (error?.workerReleased) {
          await error.workerReleased
        }
        retryAfter = Date.now() + 1000
        if (
          signal.aborted ||
          error?.workerCleanup ||
          !(
            error?.status === 503 ||
            ['cluster_busy', 'cluster_queue_full'].includes(error?.code)
          )
        ) {
          release()
          signal.throwIfAborted()
          throw error
        }
        // Reuse the same queue entry, deadline and reserved waiting place.
        retry = release.retry()
      } finally {
        signal.removeEventListener('abort', abort)
      }
    }
  })
}
