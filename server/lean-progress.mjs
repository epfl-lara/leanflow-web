// Report stationary document processing without cancelling slow, valid requests.
export class LeanProgress {
  constructor(send, delayMs = 60_000) {
    this.send = send
    this.delayMs = delayMs
    this.documents = new Map()
    this.processing = new Map()
  }

  client(message) {
    const uri = message.params?.textDocument?.uri
    if (typeof uri !== 'string') return
    if (message.method === 'textDocument/didClose') {
      this.documents.delete(uri)
      this.clear(uri)
    } else if (message.method === 'textDocument/didOpen') {
      if (typeof message.params.textDocument.text === 'string')
        this.documents.set(uri, message.params.textDocument.text)
    } else if (message.method === 'textDocument/didChange') {
      this.clear(uri)
      const changes = message.params?.contentChanges
      if (
        changes?.length === 1 &&
        !changes[0].range &&
        typeof changes[0].text === 'string'
      )
        this.documents.set(uri, changes[0].text)
      else this.documents.delete(uri)
    }
  }

  server(message) {
    if (message.method !== '$/lean/fileProgress') return
    const uri = message.params?.textDocument?.uri
    const line = message.params?.processing?.find((item) => item.kind !== 2)
      ?.range?.start?.line
    if (!Number.isSafeInteger(line) || line < 0) return this.clear(uri)
    if (this.processing.get(uri)?.line === line) return
    this.clear(uri)
    const timer = setTimeout(() => {
      const entry = this.processing.get(uri)
      if (!entry) return
      entry.notified = true
      const sourceLine = this.documents.get(uri)?.split('\n')[line] || ''
      const hint = /^\s*#eval\b/.test(sourceLine)
        ? ' If this #eval waits for keyboard input or runs an event loop, remove it and restart Lean. Interactive programs need a terminal.'
        : ' Large imports and proofs can take time. You can keep editing, or restart Lean if it seems stuck.'
      this.send({
        jsonrpc: '2.0',
        method: '$/leanflow/processing',
        params: {
          uri,
          message: `Lean is still processing line ${line + 1}.${hint}`,
        },
      })
    }, this.delayMs)
    this.processing.set(uri, { line, timer, notified: false })
  }

  clear(uri) {
    const entry = this.processing.get(uri)
    if (!entry) return
    clearTimeout(entry.timer)
    this.processing.delete(uri)
    if (entry.notified)
      this.send({
        jsonrpc: '2.0',
        method: '$/leanflow/processing',
        params: { uri, message: '' },
      })
  }

  dispose() {
    for (const entry of this.processing.values()) clearTimeout(entry.timer)
    this.processing.clear()
    this.documents.clear()
  }
}
