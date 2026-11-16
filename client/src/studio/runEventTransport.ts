import { api, sessionBoundUrl, type RunEvent } from './api'

let transport: 'sse' | 'poll' = 'sse'
export function setRunEventTransport(value?: 'sse' | 'poll') {
  transport = value === 'poll' ? 'poll' : 'sse'
}

// Some temporary HTTPS relays buffer SSE. Replay the same durable event cursor
// with bounded JSON requests so assistant output and reasoning remain live.
export class PollingRunEvents extends EventTarget {
  readyState = 0
  private controller = new AbortController()
  private timer?: ReturnType<typeof setTimeout>
  private cursor: number
  private endpoint: string
  private query: URLSearchParams
  constructor(url: string) {
    super()
    const [endpoint, query] = url.split('?')
    this.endpoint = endpoint
    this.query = new URLSearchParams(query)
    this.cursor = Number(this.query.get('after') || 0)
    this.query.set('transport', 'poll')
    queueMicrotask(() => {
      void this.read()
    })
  }
  private async read() {
    if (this.controller.signal.aborted) return
    let delay = 750
    try {
      this.query.set('after', String(this.cursor))
      const result = await api<{ events: RunEvent[] }>(
        `${this.endpoint}?${this.query}`,
        { signal: this.controller.signal },
      )
      if (this.controller.signal.aborted) return
      if (this.readyState !== 1) {
        this.readyState = 1
        this.dispatchEvent(new Event('open'))
      }
      for (const event of result.events) {
        if (this.controller.signal.aborted) return
        if (event.seq <= this.cursor) continue
        this.cursor = event.seq
        this.dispatchEvent(
          new MessageEvent('message', { data: JSON.stringify(event) }),
        )
      }
      if (result.events.length === 100) delay = 0
    } catch {
      if (this.controller.signal.aborted) return
      this.readyState = 0
      this.dispatchEvent(new Event('error'))
      delay = 2000
    }
    if (!this.controller.signal.aborted)
      this.timer = setTimeout(() => {
        void this.read()
      }, delay)
  }
  close() {
    this.readyState = 2
    this.controller.abort()
    clearTimeout(this.timer)
  }
}

// Native EventSource closes permanently on HTTP errors such as capacity 429s.
// Keep its retry state separate so metadata refreshes cannot reopen it in a loop.
export class LiveRunEvents extends EventTarget {
  readyState = 0
  readonly url: string
  private source?: EventSource | PollingRunEvents
  private timer?: ReturnType<typeof setTimeout>
  private failures = 0
  private cursor: number
  private endpoint: string
  private query: URLSearchParams
  constructor(url: string) {
    super()
    this.url = url
    const [endpoint, query] = url.split('?')
    this.endpoint = endpoint
    this.query = new URLSearchParams(query)
    this.cursor = Number(this.query.get('after') || 0)
    this.connect()
  }
  private connect() {
    if (this.readyState === 2) return
    this.timer = undefined
    this.query.set('after', String(this.cursor))
    const url = `${this.endpoint}?${this.query}`
    const source =
      this.failures >= 3 ? new PollingRunEvents(url) : new EventSource(url)
    this.source = source
    const current = () => this.readyState !== 2 && this.source === source
    source.addEventListener('open', () => {
      if (!current()) return
      this.readyState = 1
      this.failures = 0
      this.dispatchEvent(new Event('open'))
    })
    source.addEventListener('message', (raw) => {
      if (!current()) return
      const data = (raw as MessageEvent<string>).data
      try {
        const event: unknown = JSON.parse(data)
        if (
          event &&
          typeof event === 'object' &&
          'seq' in event &&
          typeof event.seq === 'number' &&
          Number.isSafeInteger(event.seq) &&
          event.seq > this.cursor
        )
          this.cursor = event.seq
      } catch {
        // Consumers retain their existing malformed-event recovery.
      }
      this.dispatchEvent(new MessageEvent('message', { data }))
    })
    source.addEventListener('error', () => {
      if (!current()) return
      this.readyState = 0
      if (!(source instanceof PollingRunEvents)) {
        source.close()
        this.source = undefined
        this.failures++
        this.timer = setTimeout(
          () => this.connect(),
          Math.min(30_000, 2000 * 2 ** (this.failures - 1)),
        )
      }
      this.dispatchEvent(new Event('error'))
    })
  }
  close() {
    this.readyState = 2
    clearTimeout(this.timer)
    this.source?.close()
    this.source = undefined
  }
}

export function openRunEvents(url: string): LiveRunEvents | PollingRunEvents {
  const endpoint = sessionBoundUrl(url)
  return transport === 'poll'
    ? new PollingRunEvents(endpoint)
    : new LiveRunEvents(endpoint)
}
