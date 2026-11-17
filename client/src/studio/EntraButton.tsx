import { useEffect, useRef, useState } from 'react'
import { api, errorText } from './api'
import { entraPopup } from './entraPopup'

export function EntraButton({
  mode = 'login',
  expectedUserId,
  label = 'Sign in with EPFL',
  disabled = false,
  className = 'button secondary',
  onComplete,
  onBusyChange,
  onAvailabilityChange,
}: {
  mode?: 'login' | 'link'
  expectedUserId?: string
  label?: string
  disabled?: boolean
  /** Presentation only: classes for the sign-in button. */
  className?: string
  onComplete: () => Promise<void>
  onBusyChange?: (busy: boolean) => void
  /** Lets a surrounding layout show or hide content tied to EPFL sign-in. */
  onAvailabilityChange?: (enabled: boolean) => void
}) {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [popupBusy, setPopupBusy] = useState(false)
  const [error, setError] = useState('')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const mounted = useRef(false)
  const pending = useRef<AbortController | null>(null)
  const popupController = useRef<AbortController | null>(null)
  const availabilityListener = useRef(onAvailabilityChange)
  useEffect(() => {
    availabilityListener.current = onAvailabilityChange
  }, [onAvailabilityChange])
  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    void api<{ enabled: boolean }>('/api/auth/entra', {
      signal: controller.signal,
    })
      .then((status) => {
        if (mounted.current && !controller.signal.aborted) {
          const available = status.enabled === true
          setEnabled(available)
          availabilityListener.current?.(available)
        }
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

  useEffect(() => {
    if (enabled && !busy && !disabled && restoreFocus.current) {
      restoreFocus.current = false
      buttonRef.current?.focus()
    }
  }, [enabled, busy, disabled])

  function release(controller: AbortController) {
    if (pending.current !== controller) return
    pending.current = null
    popupController.current = null
    if (mounted.current) {
      setBusy(false)
      setPopupBusy(false)
    }
    onBusyChange?.(false)
  }

  function cancel() {
    const controller = popupController.current
    if (!controller) return
    restoreFocus.current = true
    controller.abort()
    release(controller)
  }

  async function start() {
    if (disabled || pending.current) return
    const controller = new AbortController()
    pending.current = controller
    popupController.current = controller
    setBusy(true)
    setPopupBusy(true)
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
      if (popupController.current === controller) {
        popupController.current = null
        if (mounted.current) setPopupBusy(false)
      }
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
      release(controller)
    }
  }

  if (!enabled) return null
  return (
    <div>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        disabled={disabled || busy}
        onClick={() => void start()}
      >
        {busy && <span className="spinner" />}
        {busy ? 'Waiting for EPFL…' : label}
      </button>
      {popupBusy && (
        <button type="button" className="button subtle small" onClick={cancel}>
          Cancel EPFL sign-in
        </button>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
