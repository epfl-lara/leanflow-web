import { runIsActive, type Run, type RunEvent } from './api'

const OUTPUT_LIMIT = 250_000
const cursor = (run: Run) => Number(run.eventCursor) || 0

// A delayed poll must never replace newer streamed output or revive a finished
// run after the stream and polling have already been stopped.
export function mergeRunSnapshot(previous: Run | null, value: Run): Run {
  if (!previous || previous.id !== value.id) return value
  if (cursor(value) < cursor(previous)) return previous
  if (!runIsActive(previous) && runIsActive(value)) return previous
  return value
}

export function appendRunEvents(previous: Run, events: RunEvent[]): Run {
  let next = previous
  for (const event of events) {
    if (event.seq <= cursor(next)) continue
    if (next === previous) next = { ...previous }
    next.eventCursor = event.seq
    const data = event.data
    const text = typeof data?.text === 'string' ? data.text : ''
    const field = {
      message: 'message',
      reasoning: 'reasoning',
      'reasoning-summary': 'reasoningSummary',
      activity: 'log',
    }[event.type]
    if (field)
      next[field] = (String(next[field] || '') + text).slice(-OUTPUT_LIMIT)
    if (event.type === 'status' && typeof data?.status === 'string') {
      const updated = { ...next, status: data.status }
      if (runIsActive(next) || !runIsActive(updated)) next.status = data.status
    }
    if (event.type === 'error' && typeof data?.message === 'string')
      next.error = data.message
    if (event.type === 'verification') next.verification = data
    if (event.type === 'optimization') next.optimization = data
    if (event.type === 'changes' && Array.isArray(data?.changes))
      next.changes = data.changes as Run['changes']
    if (event.type === 'usage') next.usage = data
  }
  return next
}
