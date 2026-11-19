export function createAgentToolCallbacks({
  active,
  rpc,
  invoke,
  redact = String,
  label,
  accepts,
}) {
  const controller = new AbortController()
  const signal = AbortSignal.any([active.controller.signal, controller.signal])
  const pending = new Set()
  const calls = new Set()

  async function respond({ id, params }) {
    let response
    try {
      signal.throwIfAborted()
      if (
        !params ||
        active.completed === true ||
        !active.threadId ||
        params.threadId !== active.threadId ||
        (active.previousTurnId && params.turnId === active.previousTurnId) ||
        (active.turnId && params.turnId !== active.turnId) ||
        (params.namespace != null && params.namespace !== '') ||
        typeof params.callId !== 'string' ||
        !params.callId ||
        calls.has(params.callId)
      )
        throw new Error(
          `This ${label} tool call is outside the active assistant turn.`,
        )
      calls.add(params.callId)
      const result = await invoke(params, signal)
      signal.throwIfAborted()
      response = {
        success: true,
        contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
      }
    } catch (error) {
      response = {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: redact(
              error.message || `The ${label} tool could not finish.`,
            ),
          },
        ],
      }
    }
    if (!rpc.closed) {
      try {
        rpc.respond(id, response)
      } catch {}
    }
  }

  return {
    handle(request) {
      if (request.method !== 'item/tool/call' || !accepts(request.params?.tool))
        return false
      const task = respond(request)
      pending.add(task)
      void task.finally(() => pending.delete(task))
      return true
    },
    async dispose() {
      controller.abort(new Error('The assistant session ended.'))
      await Promise.allSettled([...pending])
    },
  }
}
