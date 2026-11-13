// Polling, infoview keepalives and synthetic events are not user activity.
export function listenForUserActivity(target: Document, activity: () => void) {
  const listener = (event: Event) => {
    if (event.isTrusted && target.visibilityState === 'visible') activity()
  }
  const events = ['pointerdown', 'keydown', 'wheel', 'touchstart']
  for (const name of events)
    target.addEventListener(name, listener, { capture: true, passive: true })
  return () => {
    for (const name of events) target.removeEventListener(name, listener, true)
  }
}
