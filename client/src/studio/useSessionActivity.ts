import { useCallback, useEffect, useRef } from 'react'
import { api } from './api'
import { listenForUserActivity } from './userActivity'

const RENEW_INTERVAL_MS = 60_000
const LOGOUT_DRAIN_TIMEOUT_MS = 5000

interface ActivityControls {
  pause: () => Promise<void>
  resume: () => void
}

// Background model, project, and run polling must not extend an idle session.
export function useSessionActivity(
  userId: string | undefined,
  expired: boolean,
) {
  const controls = useRef<ActivityControls | null>(null)
  useEffect(() => {
    if (!userId || expired) return
    let disposed = false
    let paused = false
    let pending = document.visibilityState === 'visible'
    let lastActivity = Date.now()
    let lastAttempt = -Infinity
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let inFlight: Promise<void> | undefined

    function startRenewal() {
      const task = renew()
      inFlight = task
      void task.finally(() => {
        if (inFlight === task) inFlight = undefined
      })
    }

    function schedule() {
      if (disposed || paused || !pending || controller || timer !== undefined)
        return
      const delay = Math.max(0, lastAttempt + RENEW_INTERVAL_MS - Date.now())
      if (!delay) {
        startRenewal()
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        startRenewal()
      }, delay)
    }

    async function renew() {
      if (disposed || paused || !pending || controller) return
      pending = false
      // A suspended computer may resume long after the queued interaction.
      if (Date.now() - lastActivity > 2 * RENEW_INTERVAL_MS) return
      lastAttempt = Date.now()
      controller = new AbortController()
      try {
        await api('/api/session/activity', {
          method: 'POST',
          body: '{}',
          signal: controller.signal,
        })
      } catch {
        // A 401 opens the existing recovery dialog. Other failures retry only
        // after further user activity, never from an unattended retry loop.
      } finally {
        controller = undefined
        schedule()
      }
    }

    function activity() {
      if (paused) return
      lastActivity = Date.now()
      pending = true
      schedule()
    }

    const stopActivity = listenForUserActivity(document, activity)
    const currentControls: ActivityControls = {
      async pause() {
        paused = true
        pending = false
        clearTimeout(timer)
        timer = undefined
        const active = inFlight
        if (!active) return
        // Finish the renewal before logout clears its cookie. A delayed
        // renewal response must not sign the browser back in afterwards.
        const timeout = setTimeout(
          () => controller?.abort(),
          LOGOUT_DRAIN_TIMEOUT_MS,
        )
        try {
          await active
        } finally {
          clearTimeout(timeout)
        }
      },
      resume() {
        if (disposed) return
        paused = false
        pending = document.visibilityState === 'visible'
        lastActivity = Date.now()
        schedule()
      },
    }
    controls.current = currentControls
    // Visiting the workspace upgrades a still-valid legacy sign-in cookie.
    schedule()
    return () => {
      disposed = true
      if (controls.current === currentControls) controls.current = null
      clearTimeout(timer)
      controller?.abort()
      stopActivity()
    }
  }, [userId, expired])

  const pause = useCallback(async () => {
    await controls.current?.pause()
  }, [])
  const resume = useCallback(() => controls.current?.resume(), [])
  return { pause, resume }
}
