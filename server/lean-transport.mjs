import { frame } from './rpc.mjs'

// Bound queued traffic in both directions to the backlog allowance plus one
// already validated frame. Large valid frames can follow small progress packets.
export function leanTransport(
  ws,
  child,
  {
    maxBufferedBytes = 16 * 1024 * 1024,
    isWaiting = () => false,
    waitingBufferedBytes = 256 * 1024,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxBufferedBytes) ||
    maxBufferedBytes <= 0 ||
    !Number.isSafeInteger(waitingBufferedBytes) ||
    waitingBufferedBytes <= 0 ||
    typeof isWaiting !== 'function'
  )
    throw new Error('Lean transport buffer limit must be a positive integer.')
  let closed = false
  const stop = () => {
    if (closed) return false
    closed = true
    ws.close(1013, 'Lean connection is busy. Reopen the project to reconnect.')
    child.kill()
    return false
  }
  return {
    sendToClient(message) {
      if (closed || ws.readyState !== 1) return false
      if (ws.bufferedAmount > maxBufferedBytes) return stop()
      const text = JSON.stringify(message)
      ws.send(text)
      return true
    },
    sendToLean(message) {
      if (closed || ws.readyState !== 1 || child.stdin.destroyed) return false
      const limit = isWaiting()
        ? Math.min(maxBufferedBytes, waitingBufferedBytes)
        : maxBufferedBytes
      if (child.stdin.writableLength > limit) return stop()
      const text = frame(message)
      if (
        isWaiting() &&
        child.stdin.writableLength + Buffer.byteLength(text) > limit
      )
        return stop()
      child.stdin.write(text)
      return true
    },
    dispose() {
      closed = true
    },
  }
}
