interface EntraCompletion {
  type: 'leanflow-entra-complete'
  ok: boolean
  error?: string
  linkToken?: string
}

export interface EntraPopupResult {
  linkToken?: string
}

function completionMessage(value: unknown): value is EntraCompletion {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'leanflow-entra-complete' &&
    'ok' in value &&
    typeof value.ok === 'boolean' &&
    (!('error' in value) || typeof value.error === 'string') &&
    (!('linkToken' in value) || typeof value.linkToken === 'string')
  )
}

/** Open during the click, before requesting an authorization URL. */
export function entraPopup(
  begin: () => Promise<{ url: string }>,
  {
    signal,
    timeoutMs = 5 * 60_000,
  }: { signal: AbortSignal; timeoutMs?: number },
): Promise<EntraPopupResult> {
  if (signal.aborted) return Promise.reject(signal.reason)
  const popup = window.open(
    'about:blank',
    '_blank',
    'popup,width=520,height=720',
  )
  if (!popup)
    return Promise.reject(
      new Error('Allow pop-ups for LeanFlow, then try EPFL sign-in again.'),
    )
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (error?: unknown, result: EntraPopupResult = {}) => {
      if (finished) return
      finished = true
      window.removeEventListener('message', receive)
      signal.removeEventListener('abort', abort)
      clearInterval(closed)
      clearTimeout(deadline)
      try {
        popup.close()
      } catch {
        // The provider may already have closed its window.
      }
      if (error) reject(error)
      else resolve(result)
    }
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== popup ||
        event.origin !== window.location.origin ||
        !completionMessage(event.data)
      )
        return
      finish(
        event.data.ok
          ? undefined
          : new Error(event.data.error || 'EPFL sign-in failed. Try again.'),
        event.data.linkToken ? { linkToken: event.data.linkToken } : {},
      )
    }
    const abort = () =>
      finish(signal.reason || new DOMException('Aborted', 'AbortError'))
    const closed = setInterval(() => {
      if (popup.closed)
        finish(
          new Error('EPFL sign-in was closed. Try again when you are ready.'),
        )
    }, 250)
    const deadline = setTimeout(
      () => finish(new Error('EPFL sign-in timed out. Please try again.')),
      timeoutMs,
    )
    window.addEventListener('message', receive)
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve()
      .then(async () => {
        if (finished) return
        const { url } = await begin()
        if (finished) return
        let destination: URL
        try {
          if (typeof url !== 'string') throw new Error()
          destination = new URL(url)
        } catch {
          throw new Error('EPFL sign-in could not be opened. Please try again.')
        }
        if (
          destination.origin !== 'https://login.microsoftonline.com' ||
          destination.username ||
          destination.password
        )
          throw new Error('EPFL sign-in could not be opened. Please try again.')
        popup.location.replace(destination.href)
      })
      .catch(finish)
  })
}
