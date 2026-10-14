// Bound editor requests while leaving document processing under the user's control.
export class LeanRequests {
  constructor({ sendToClient }) {
    this.sendToClient = sendToClient
    this.pending = new Map()
    this.expired = new Set()
  }

  track(message) {
    if (message.method === '$/cancelRequest') {
      const id = message.params?.id
      if (this.retire(id))
        this.sendToClient({
          jsonrpc: '2.0',
          id,
          error: { code: -32800, message: 'Lean request cancelled.' },
        })
      return
    }
    if (!message.method || !('id' in message)) return
    if (this.pending.has(message.id)) throw new Error('Duplicate Lean request.')
    if (this.pending.size >= 1000)
      throw new Error('Too many outstanding Lean requests.')
    this.expired.delete(message.id)
    this.pending.set(message.id, { method: message.method })
  }

  retire(id) {
    const pending = this.pending.get(id)
    if (!pending) return false
    this.pending.delete(id)
    this.expired.add(id)
    if (this.expired.size > 1000)
      this.expired.delete(this.expired.values().next().value)
    return true
  }

  receive(message) {
    if (message.method || !('id' in message)) return true
    if (this.expired.has(message.id)) return false
    const pending = this.pending.get(message.id)
    if (pending) {
      this.pending.delete(message.id)
      if (
        pending.method === 'textDocument/completion' &&
        message.result?.items?.length > 300
      ) {
        message.result.items = message.result.items.slice(0, 300)
        message.result.isIncomplete = true
      }
    }
    return true
  }

  dispose() {
    this.pending.clear()
    this.expired.clear()
  }
}
