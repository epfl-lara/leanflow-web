import { useCallback, useEffect, useState } from 'react'
import { api, post, type Preset, type PlaygroundPreparationState } from './api'

export function usePlaygroundPreparation(
  preset: Preset | undefined,
  userId: string | undefined,
) {
  const [status, setStatus] = useState<PlaygroundPreparationState | null>(null)
  const initial =
    preset?.playgroundState ||
    (preset?.ready && preset.playgroundReady !== false
      ? 'ready'
      : 'unavailable')
  const state = status || initial
  useEffect(() => setStatus(null), [userId])
  const refresh = useCallback(async () => {
    const result = await api<{ state: PlaygroundPreparationState }>(
      '/api/playground',
    )
    setStatus(result.state)
  }, [])
  const retry = useCallback(async () => {
    setStatus('verifying')
    try {
      const result = await post<{ state: PlaygroundPreparationState }>(
        '/api/playground/prepare',
      )
      setStatus(result.state)
    } catch (error) {
      setStatus('failed')
      throw error
    }
  }, [])
  useEffect(() => {
    if (state !== 'verifying') return
    let cancelled = false
    const timer = setInterval(() => {
      void api<{ state: PlaygroundPreparationState }>('/api/playground')
        .then((result) => {
          if (!cancelled) setStatus(result.state)
        })
        .catch(() => {})
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [state])
  return { state, refresh, retry }
}
