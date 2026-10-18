import { api, type RunEvent } from './api'

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
  constructor(url: string) {
    super()
    const [endpoint, query] = url.split('?')
    this.endpoint = endpoint
    this.cursor = Number(new URLSearchParams(query).get('after') || 0)
    queueMicrotask(() => {
      void this.read()
    })
  }
  private async read() {
    if (this.controller.signal.aborted) return
    let delay = 750
    try {
      const result = await api<{ events: RunEvent[] }>(
        `${this.endpoint}?transport=poll&after=${this.cursor}`,
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

export function openRunEvents(url: string): EventSource | PollingRunEvents {
  return transport === 'poll' ? new PollingRunEvents(url) : new EventSource(url)
}
