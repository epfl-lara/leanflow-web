import { listenForUserActivity } from './userActivity'

export const EDITOR_IDLE_MS = 30 * 60_000

// One deadline, rescheduled only when it expires. High-frequency editing does
// not create a timer per keypress, and server traffic never touches this clock.
export function editorIdle(
  sleep: () => void,
  wake: () => void,
  idleMs = EDITOR_IDLE_MS,
) {
  let lastActivity = Date.now()
  let sleeping = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout>
  function check() {
    const remaining = lastActivity + idleMs - Date.now()
    if (remaining > 0) timer = setTimeout(check, remaining)
    else {
      sleeping = true
      sleep()
    }
  }
  timer = setTimeout(check, idleMs)
  return {
    activity() {
      if (disposed) return
      lastActivity = Date.now()
      if (sleeping) {
        sleeping = false
        timer = setTimeout(check, idleMs)
        wake()
      }
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
    },
  }
}
export function watchEditorIdle(
  target: Document,
  infoview: HTMLElement,
  sleep: () => void,
  wake: () => void,
) {
  const idle = editorIdle(sleep, wake)
  const stopActivity = listenForUserActivity(target, () => idle.activity())
  // Infoview controls live in a same-origin iframe; their interaction events
  // do not bubble into the parent document.
  const frameCleanups = new Map<HTMLIFrameElement, () => void>()
  const attachFrames = () => {
    for (const [frame, cleanup] of frameCleanups)
      if (!frame.isConnected) {
        cleanup()
        frameCleanups.delete(frame)
      }
    for (const frame of infoview.querySelectorAll('iframe')) {
      if (frameCleanups.has(frame)) continue
      let stopFrameActivity: (() => void) | undefined
      const attach = () => {
        stopFrameActivity?.()
        if (frame.contentDocument)
          stopFrameActivity = listenForUserActivity(frame.contentDocument, () =>
            idle.activity(),
          )
      }
      frame.addEventListener('load', attach)
      attach()
      frameCleanups.set(frame, () => {
        frame.removeEventListener('load', attach)
        stopFrameActivity?.()
      })
    }
  }
  const frames = new MutationObserver(attachFrames)
  frames.observe(infoview, { childList: true, subtree: true })
  attachFrames()
  return () => {
    idle.dispose()
    stopActivity()
    frames.disconnect()
    frameCleanups.forEach((cleanup) => cleanup())
    frameCleanups.clear()
  }
}
