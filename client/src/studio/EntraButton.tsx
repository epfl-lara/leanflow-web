import { useEffect, useRef, useState } from 'react'
import { api, errorText } from './api'
import { entraPopup } from './entraPopup'

export function EntraButton({
  mode = 'login',
  expectedUserId,
  label = 'Sign in with EPFL',
  disabled = false,
  onComplete,
  onBusyChange,
}: {
  mode?: 'login' | 'link'
  expectedUserId?: string
  label?: string
  disabled?: boolean
  onComplete: () => Promise<void>
  onBusyChange?: (busy: boolean) => void
}) {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void api<{ enabled: boolean }>('/api/auth/entra', {
      signal: controller.signal,
    })
      .then((status) => {
        if (mounted.current && !controller.signal.aborted)
          setEnabled(status.enabled === true)
      })
      .catch(() => {
        // Token sign-in remains available if EPFL sign-in is unavailable.
      })
    return () => {
      mounted.current = false
      controller.abort()
      pending.current?.abort()
    }
  }, [])

  async function start() {
    if (disabled || pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError('')
    onBusyChange?.(true)
    try {
      const result = await entraPopup(
        () =>
          api<{ url: string }>('/api/auth/entra/start', {
            method: 'POST',
            body: JSON.stringify({
              mode,
              ...(expectedUserId ? { expectedUserId } : {}),
            }),
            signal: controller.signal,
          }),
        { signal: controller.signal },
      )
      if (controller.signal.aborted) return
      if (mode === 'link') {
        if (!result.linkToken || !/^[A-Za-z0-9_-]{43}$/.test(result.linkToken))
          throw new Error(
            'Your EPFL account could not be linked. Please try again.',
          )
        await api('/api/auth/entra/link', {
          method: 'POST',
          body: JSON.stringify({ token: result.linkToken }),
          signal: controller.signal,
        })
      }
      if (!controller.signal.aborted) await onComplete()
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        setError(errorText(error))
    } finally {
      pending.current = null
      if (mounted.current) setBusy(false)
      onBusyChange?.(false)
    }
  }

  if (!enabled) return null
  return (
    <div>
      <button
        type="button"
        className="button secondary"
        disabled={disabled || busy}
        onClick={() => void start()}
      >
        {busy && <span className="spinner" />}
        {busy ? 'Waiting for EPFL…' : label}
      </button>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
