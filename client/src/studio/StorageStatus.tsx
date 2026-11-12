import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type StorageStatusSnapshot } from './api'

export function StorageStatus({
  initial,
  enabled,
}: {
  initial?: StorageStatusSnapshot
  enabled: boolean
}) {
  const [status, setStatus] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    if (!enabled || request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const updated = await api<StorageStatusSnapshot>('/api/storage', {
        signal: controller.signal,
      })
      if (request.current !== controller) return
      setStatus(updated)
      setError('')
    } catch {
      if (request.current === controller)
        setError('Storage status could not be refreshed. Try again shortly.')
    } finally {
      clearTimeout(timer)
      if (request.current === controller) {
        request.current = null
        setBusy(false)
      }
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !initial) return
    const initialCheck = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 15000)
    return () => {
      clearTimeout(initialCheck)
      clearInterval(timer)
      request.current?.abort()
      request.current = null
      setBusy(false)
    }
  }, [enabled, initial, refresh])

  if (!status || status.state === 'ready') return null
  return (
    <output className="workspace-alert" aria-label="Project storage status">
      <span>
        {status.message}
        {error && <> {error}</>}
      </span>
      <button
        className="button small secondary"
        disabled={!enabled || busy}
        onClick={() => void refresh()}
      >
        {busy ? 'Checking storage…' : 'Refresh storage status'}
      </button>
    </output>
  )
}
