import { startTransition, useEffect, useRef, useState } from 'react'
import { api, runIsActive, type Run, type RunEvent } from './api'
import { appendRunEvents, mergeRunSnapshot } from './runStream'

/** Follow the active project run independently of which chat or turn is open. */
export function useRunStream(
  id: string | null,
  callbacks: {
    onRun: (run: Run) => void
    onFilesUpdated: (paths: string[]) => Promise<void>
    onTerminal: () => void
    onError: (error: unknown) => void
  },
) {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const [connection, setConnection] = useState('')
  const [followingId, setFollowingId] = useState(id)
  useEffect(() => {
    if (id) setFollowingId(id)
  }, [id])
  useEffect(() => {
    setConnection('')
    if (!followingId) return
    const runId = followingId
    let cancelled = false,
      current: Run | null = null,
      stream: EventSource | undefined
    let poll: ReturnType<typeof setInterval> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined
    let pending: RunEvent[] = [],
      revision: string | undefined
    const publish = (value: Run) => {
      if (
        current &&
        ((value.eventCursor || 0) < (current.eventCursor || 0) ||
          (!runIsActive(current) && runIsActive(value)))
      )
        return
      current = mergeRunSnapshot(current, value)
      callbacksRef.current.onRun(current)
      const nextRevision = `${current.liveRevision || 0}:${!!current.liveUndone}`
      if (current.liveEdits && revision !== nextRevision) {
        revision = nextRevision
        if (current.liveRevision)
          void callbacksRef.current
            .onFilesUpdated(
              (current.liveChanges || []).map((change) => change.path),
            )
            .catch(callbacksRef.current.onError)
      }
      if (!runIsActive(current)) {
        stream?.close()
        if (poll) clearInterval(poll)
        setConnection('')
        callbacksRef.current.onTerminal()
        setFollowingId(null)
      }
    }
    const refresh = async () => {
      try {
        const value = await api<Run>(`/api/runs/${encodeURIComponent(runId)}`)
        if (!cancelled) publish(value)
      } catch (error) {
        if (!cancelled) callbacksRef.current.onError(error)
      }
    }
    const flush = () => {
      clearTimeout(timer)
      timer = undefined
      if (cancelled || !current || !pending.length) return
      const batch = pending
      pending = []
      current = appendRunEvents(current, batch)
      const value = current
      // Wait for a full final snapshot before publishing a terminal status.
      // Native final output can be reconciled after the last streamed delta.
      if (runIsActive(value))
        startTransition(() => callbacksRef.current.onRun(value))
      const paths = new Set<string>()
      for (const event of batch)
        if (event.type === 'files-updated' && Array.isArray(event.data?.paths))
          for (const path of event.data.paths)
            if (typeof path === 'string') paths.add(path)
      if (paths.size)
        void callbacksRef.current
          .onFilesUpdated([...paths])
          .catch(callbacksRef.current.onError)
      if (batch.some((event) => event.type === 'status')) void refresh()
    }
    void api<Run>(`/api/runs/${encodeURIComponent(runId)}`)
      .then((value) => {
        if (cancelled) return
        publish(value)
        if (!current || !runIsActive(current)) return
        poll = setInterval(() => void refresh(), 4000)
        if (!Number.isSafeInteger(current.eventCursor)) return
        stream = new EventSource(
          `/api/runs/${encodeURIComponent(runId)}/events?after=${current.eventCursor}`,
        )
        stream.addEventListener('open', () => {
          if (!cancelled) setConnection('Live')
        })
        stream.addEventListener('message', (raw) => {
          if (cancelled) return
          try {
            const event = JSON.parse((raw as MessageEvent).data) as RunEvent
            if (!event || typeof event.type !== 'string') return
            pending.push(event)
            if (['status', 'followup', 'progress'].includes(event.type)) flush()
            else timer ||= setTimeout(flush, 250)
          } catch {
            void refresh()
          }
        })
        stream.addEventListener('error', () => {
          if (!cancelled) {
            setConnection('Reconnecting…')
            void refresh()
          }
        })
      })
      .catch((error) => {
        if (!cancelled) callbacksRef.current.onError(error)
      })
    return () => {
      cancelled = true
      stream?.close()
      if (poll) clearInterval(poll)
      clearTimeout(timer)
      pending = []
    }
  }, [followingId])
  return connection
}
