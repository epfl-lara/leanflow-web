import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, errorText, type GitConnections } from './api'

const changedEvent = 'leanflow:git-connections-changed'

export function gitConnectionsChanged() {
  window.dispatchEvent(new Event(changedEvent))
}

export function repositoryHost(value?: string) {
  try {
    const url = new URL(value || '')
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : ''
  } catch {
    return ''
  }
}

export function useGitConnections() {
  const [data, setData] = useState<GitConnections | null>(null)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const request = useRef(0)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const id = ++request.current
    try {
      const value = await api<GitConnections>('/api/git-connections', {
        signal,
      })
      if (!signal?.aborted && id === request.current) {
        setData(value)
        setError('')
      }
    } catch (error) {
      if (!signal?.aborted && id === request.current) {
        setData(null)
        setError(
          error instanceof ApiError && error.status === 404
            ? ''
            : errorText(error),
        )
      }
    } finally {
      if (!signal?.aborted && id === request.current) setLoaded(true)
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    const update = () => void refresh(controller.signal)
    update()
    window.addEventListener(changedEvent, update)
    return () => {
      controller.abort()
      window.removeEventListener(changedEvent, update)
    }
  }, [refresh])
  return { data, error, loaded, refresh }
}
