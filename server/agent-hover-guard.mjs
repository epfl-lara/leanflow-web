// Bound failed coordinate searches without limiting useful hover lookups elsewhere.
export function createHoverLookupGuard({ active, rpc, onNotice, onFailure }) {
  const failures = new Map(),
    seen = new Set()
  const running = () =>
    !active.completed &&
    !active.controller.signal.aborted &&
    active.accepting !== false
  function fail(message) {
    if (!running()) return
    active.accepting = false
    onFailure(new Error(message))
    rpc.close()
  }
  async function recover(location) {
    if (!running()) return
    if (!active.threadId || !active.turnId) {
      fail(
        'Stopped repeated hover lookups because recovery guidance could not be delivered. Read the source or select the identifier before retrying.',
      )
      return
    }
    const expectedTurnId = active.turnId
    try {
      const response = await rpc.call(
        'turn/steer',
        {
          threadId: active.threadId,
          expectedTurnId,
          input: [
            {
              type: 'text',
              text: `Hover lookups repeatedly returned no information at ${location}. Stop scanning columns or retrying hover on this line. Read the source, locate the actual identifier, or use lean_local_search. For an explanation, answer from the available source and state any remaining uncertainty. Continue the user's task without repeating these failed lookups.`,
              textElements: [],
            },
          ],
        },
        10_000,
      )
      if (response.turnId !== expectedTurnId)
        throw new Error('Recovery guidance was not acknowledged for this turn.')
    } catch {
      fail(
        'Stopped repeated hover lookups because recovery guidance could not be delivered. Read the source or select the identifier before retrying.',
      )
    }
  }
  return {
    handle(item) {
      if (!running()) return
      if (item.type === 'fileChange' && item.status === 'completed') {
        failures.clear()
        return
      }
      if (item.type !== 'mcpToolCall' || item.tool !== 'lean_hover_info') return
      if (typeof item.id === 'string') {
        if (seen.has(item.id)) return
        if (seen.size >= 4096) seen.delete(seen.values().next().value)
        seen.add(item.id)
      }
      const args = item.arguments
      if (
        !args ||
        typeof args !== 'object' ||
        typeof args.file_path !== 'string' ||
        !Number.isSafeInteger(args.line) ||
        args.line < 1
      )
        return
      const key = JSON.stringify([item.server, args.file_path, args.line])
      const text = [
        item.error?.message,
        ...(Array.isArray(item.result?.content)
          ? item.result.content.map((part) => part?.text)
          : []),
      ]
        .filter((value) => typeof value === 'string')
        .join('\n')
      if (!/no hover information/i.test(text)) {
        if (item.status === 'completed' && !item.error && item.result)
          failures.delete(key)
        return
      }
      if (!failures.has(key) && failures.size >= 128)
        failures.delete(failures.keys().next().value)
      const count = (failures.get(key) || 0) + 1
      failures.set(key, count)
      const location = `${args.file_path}:${args.line}`
      if (count === 3) {
        onNotice(
          'Repeated hover lookups found no information. Asking Lemex to read the source instead.\n',
        )
        void recover(location)
      } else if (count >= 6) {
        fail(
          `Stopped after repeated hover lookups found no information at ${location}. Read the source or select the identifier before retrying.`,
        )
      }
    },
  }
}
