import { startTransition, useEffect, useRef, useState } from 'react'
import { api, runIsActive, type Run, type RunEvent } from './api'
import { appendRunEvents, mergeRunSnapshot } from './runStream'
import { hydrateReasoningHistory } from './reasoningHistory'

/** Follow the active project run independently of which chat or turn is open. */
export function useRunStream(
  id: string | null,
  callbacks: {
    onRun: (run: Run) => void
    onFilesUpdated: (paths: string[], runId: string) => Promise<void>
    onTerminal: () => void
    onError: (error: unknown) => void
    onRecovered: () => void
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
    const historyController = new AbortController()
    let cancelled = false,
      current: Run | null = null,
      stream: EventSource | undefined
    let poll: ReturnType<typeof setInterval> | undefined,
      timer: ReturnType<typeof setTimeout> | undefined
    let pending: RunEvent[] = [],
      revision: string | undefined
    let filesPending = false,
      snapshotRequest = 0
    let historyRequest: Promise<void> | undefined
    let historyBase: Run | null = null
    let historyEvents: RunEvent[] = []
    const updateFiles = async (paths: string[]) => {
      try {
        // The caller tracks file failures together with its project refreshes,
        // which can outlive this stream when a terminal snapshot arrives.
        await callbacksRef.current.onFilesUpdated(paths, runId)
        return true
      } catch {
        return false
      }
    }
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
      if (
        current.liveEdits &&
        current.liveRevision &&
        revision !== nextRevision &&
        !filesPending
      ) {
        filesPending = true
        void updateFiles(
          (current.liveChanges || []).map((change) => change.path),
        )
          .then((success) => {
            if (success) revision = nextRevision
          })
          .finally(() => {
            filesPending = false
          })
      }
      if (!runIsActive(current)) {
        stream?.close()
        if (poll) clearInterval(poll)
        setConnection('')
        callbacksRef.current.onTerminal()
        setFollowingId(null)
      }
    }
    const recoverHistory = (snapshot: Run) => {
      if (cancelled || snapshot.reasoningBlocks !== undefined || historyRequest)
        return
      historyEvents = []
      historyRequest = hydrateReasoningHistory(
        snapshot,
        historyBase,
        historyController.signal,
      )
        .then((value) => {
          if (cancelled) return
          historyBase = appendRunEvents(value, historyEvents)
          if (
            current &&
            (historyBase.eventCursor || 0) >= (current.eventCursor || 0)
          ) {
            current = {
              ...current,
              reasoningBlocks: historyBase.reasoningBlocks,
              reasoningHistoryCursor: historyBase.eventCursor,
            }
            callbacksRef.current.onRun(current)
          }
        })
        .catch(() => {
          // Optional history must not block status, file updates or cancellation.
          // An explicitly opened trace reports its own actionable load error.
        })
        .finally(() => {
          historyRequest = undefined
          historyEvents = []
        })
    }
    const refresh = async () => {
      if (cancelled) return
      const request = ++snapshotRequest
      try {
        const snapshot = await api<Run>(
          `/api/runs/${encodeURIComponent(runId)}`,
        )
        if (!cancelled) {
          if (request === snapshotRequest) callbacksRef.current.onRecovered()
          publish(snapshot)
          recoverHistory(snapshot)
          if (
            current &&
            runIsActive(current) &&
            (!stream || stream.readyState === EventSource.CLOSED)
          ) {
            stream?.close()
            connect()
          }
        }
      } catch (error) {
        if (!cancelled && request === snapshotRequest)
          callbacksRef.current.onError(error)
      }
    }
    const flush = () => {
      clearTimeout(timer)
      timer = undefined
      if (cancelled || !current || !pending.length) return
      const batch = pending
      pending = []
      if (historyRequest) historyEvents.push(...batch)
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
      if (paths.size) void updateFiles([...paths])
      if (
        batch.some((event) => ['status', 'files-updated'].includes(event.type))
      )
        void refresh()
    }
    const connect = () => {
      if (!current || !Number.isSafeInteger(current.eventCursor)) return
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
    }
    // Begin retrying before the first fetch: an initial network failure must not
    // leave the active run permanently disconnected.
    poll = setInterval(() => void refresh(), 4000)
    void refresh()
    return () => {
      cancelled = true
      historyController.abort()
      stream?.close()
      if (poll) clearInterval(poll)
      clearTimeout(timer)
      pending = []
    }
  }, [followingId])
  return connection
}
