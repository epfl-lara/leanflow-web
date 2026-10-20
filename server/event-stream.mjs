// Replay from durable storage in small pages. A slow tab must not accumulate
// the whole run in the HTTP write buffer or in a separate in-memory queue.
export function streamRunEvents(request, response, events, id, after) {
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
    if (!closed && !waiting) write(': heartbeat\n\n')
  }, 15_000)
  heartbeat.unref()
  events.on(id, schedule)
  response.once('close', close)
  request.once('aborted', close)
  schedule()
}
