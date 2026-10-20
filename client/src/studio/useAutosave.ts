import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, errorText, type OpenFile } from './api'
import { WorkspaceBuffers, type WorkspaceScope } from './workspaceBuffers'

interface SaveIssue {
  scope: WorkspaceScope
  message: string
  retrying: boolean
}
interface FailedSave extends SaveIssue {
  snapshots: OpenFile[]
  attempts: number
  retryAt: number
}

// Debounce only buffer changes, not chat streams or Lean diagnostics. All writes
// use the same serialized, hash-checked save path as the explicit Save action.
export function useAutosave({
  store,
  scope,
  enabled,
  save,
}: {
  store: WorkspaceBuffers
  scope: WorkspaceScope
  enabled: boolean
  save: () => Promise<void>
}) {
  const [issue, setIssue] = useState<SaveIssue | null>(null)
  const failed = useRef<FailedSave | null>(null)
  const wake = useRef<(() => void) | null>(null)
  const retry = useCallback(() => {
    failed.current = null
    setIssue(null)
    wake.current?.()
  }, [])

  useEffect(() => {
    if (failed.current?.scope !== scope) failed.current = null
    if (!enabled || !scope.projectId) return
    let disposed = false,
      running = false,
      composing = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let dirtySince: number | undefined
    const current = () => !disposed && store.isCurrent(scope)
    const clearTimer = () => {
      clearTimeout(timer)
      timer = undefined
    }
    const clearIssue = () => {
      failed.current = null
      setIssue(null)
    }

    function schedule() {
      clearTimer()
      if (!current()) return
      const dirty = store.dirty()
      if (!dirty.length) {
        dirtySince = undefined
        clearIssue()
        return
      }
      // A manual save, reload, or discard resolves a paused failure. Typing
      // against the same stale hash must never retry a conflicting overwrite.
      if (
        failed.current &&
        !failed.current.snapshots.some((previous) =>
          dirty.some(
            (file) =>
              file.path === previous.path && file.hash === previous.hash,
          ),
        )
      )
        clearIssue()
      if (running || composing) return
      if (!navigator.onLine) {
        setIssue({
          scope,
          message:
            'Offline. Edits are kept in this tab; autosave will resume when connected.',
          retrying: true,
        })
        return
      }
      const failure = failed.current
      if (failure && !failure.retrying) {
        setIssue(failure)
        return
      }
      dirtySince ??= Date.now()
      const wait = failure
        ? Math.max(0, failure.retryAt - Date.now())
        : Math.max(0, Math.min(1500, 10_000 - (Date.now() - dirtySince)))
      timer = setTimeout(() => void run(), wait)
    }

    async function run() {
      clearTimer()
      if (!current() || running || composing) return
      const snapshots = store.dirty()
      if (!snapshots.length) {
        clearIssue()
        return
      }
      if (!navigator.onLine) {
        schedule()
        return
      }
      if (failed.current && !failed.current.retrying) {
        setIssue(failed.current)
        return
      }
      running = true
      dirtySince = undefined
      try {
        await save()
        if (current()) clearIssue()
      } catch (error) {
        if (!current()) return
        const retrying =
          !(error instanceof ApiError) ||
          error.status >= 500 ||
          [200, 401, 408, 429].includes(error.status)
        const attempts = (failed.current?.attempts || 0) + 1
        const failure = {
          scope,
          snapshots,
          retrying,
          attempts,
          retryAt:
            Date.now() +
            Math.min(30_000, 2000 * 2 ** Math.min(attempts - 1, 4)),
          message: `${retrying ? 'Autosave will retry' : 'Autosave paused'}: ${errorText(error)} Your edits are kept in this tab.`,
        }
        failed.current = failure
        setIssue(failure)
      } finally {
        running = false
        if (current()) schedule()
      }
    }

    const flush = () => {
      if (failed.current?.retrying) failed.current.retryAt = 0
      void run()
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    const compositionStart = () => {
      composing = true
      clearTimer()
    }
    const compositionEnd = () => {
      composing = false
      schedule()
    }
    wake.current = flush
    const unsubscribe = store.subscribe(schedule)
    window.addEventListener('online', flush)
    window.addEventListener('offline', schedule)
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('compositionstart', compositionStart, true)
    document.addEventListener('compositionend', compositionEnd, true)
    schedule()
    return () => {
      disposed = true
      clearTimer()
      unsubscribe()
      if (wake.current === flush) wake.current = null
      window.removeEventListener('online', flush)
      window.removeEventListener('offline', schedule)
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('compositionstart', compositionStart, true)
      document.removeEventListener('compositionend', compositionEnd, true)
    }
  }, [store, scope, enabled, save])

  return { issue: issue?.scope === scope ? issue : null, retry }
}
