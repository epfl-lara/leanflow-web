// Keep a tab or account from consuming every live replay subscription. Polling
// remains available when live-stream capacity is full.
export function eventStreamAdmission({
  maxConcurrent = 256,
  maxPerUser = 16,
} = {}) {
  for (const limit of [maxConcurrent, maxPerUser])
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error('Event stream limits must be positive integers.')
  let active = 0
  const users = new Map()
  return (request, response) => {
    const actor = request.user.id
    const owned = users.get(actor) || 0
    if (active >= maxConcurrent || owned >= maxPerUser) {
      response.setHeader('Retry-After', '2')
      response.status(429).json({
        error:
          'Live updates are busy. They will reconnect automatically. Close unused tabs if this continues.',
      })
      return false
    }
    active++
    users.set(actor, owned + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      active--
      const remaining = users.get(actor) - 1
      if (remaining) users.set(actor, remaining)
      else users.delete(actor)
      response.off('close', release)
      response.off('finish', release)
    }
    response.once('close', release)
    response.once('finish', release)
    return true
  }
}

// Replay from durable storage in small pages. A slow tab must not accumulate
// the whole run in the HTTP write buffer or in a separate in-memory queue.
export function streamRunEvents(
  request,
  response,
  events,
  id,
  after,
  { isAuthorized = () => true } = {},
) {
  let cursor = after,
    scheduled,
    waiting = false,
    closed = false
  const schedule = () => {
    if (!closed && !waiting && !scheduled) scheduled = setImmediate(pump)
  }
  const onDrain = () => {
    waiting = false
    schedule()
  }
  const write = (text) => {
    if (!isAuthorized()) {
      close()
      response.end()
      return false
    }
    if (response.write(text)) return true
    waiting = true
    response.once('drain', onDrain)
    return false
  }
  const close = () => {
    if (closed) return
    closed = true
    clearImmediate(scheduled)
    clearInterval(heartbeat)
    events.off(id, schedule)
    response.off('drain', onDrain)
    response.off('close', close)
    request.off('aborted', close)
  }
  const pump = () => {
    scheduled = undefined
    if (closed || waiting) return
    try {
      const page = events.eventPage(id, cursor)
      for (const event of page) {
        cursor = event.seq
        if (
          !write(
            `id: ${event.seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`,
          )
        )
          return
      }
      if (page.length) schedule()
    } catch {
      close()
      response.destroy()
    }
  }
  const heartbeat = setInterval(() => {
    if (!closed && !isAuthorized()) {
      close()
      response.end()
      return
    }
    if (!closed && !waiting) write(': heartbeat\n\n')
  }, 15_000)
  heartbeat.unref()
  events.on(id, schedule)
  response.once('close', close)
  request.once('aborted', close)
  schedule()
}
