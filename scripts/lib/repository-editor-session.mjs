// A real Lean session. A queued socket cannot answer initialize or elaborate a file.
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'

export async function waitForEvidence(check, label, timeout = 120_000) {
  const deadline = Date.now() + timeout
  do {
    const result = await check()
    if (result) return result
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for ' + label)
}

export class RepositoryEditor {
  constructor(origin, account, project, file) {
    const url = new URL('/websocket/' + project.id, origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('expectedUserId', account.id)
    this.uri = 'file:///workspace/' + file
    this.account = account
    this.project = project
    this.file = file
    this.version = 0
    this.id = 0
    this.responses = new Map()
    this.diagnostics = new Map()
    this.socket = new WebSocket(url, {
      headers: { Authorization: 'Bearer ' + account.token, Origin: origin },
      handshakeTimeout: 30000,
    })
    this.socket.on('error', (error) => {
      this.error = error
    })
    this.socket.on('close', (code) => {
      this.error ||= new Error('Editor socket closed: ' + code)
    })
    this.socket.on('message', (bytes) => {
      const m = JSON.parse(bytes.toString())
      if (m.id !== undefined && m.method)
        return this.send({ id: m.id, result: null })
      if (m.id !== undefined) this.responses.set(m.id, m)
      if (
        m.method === 'textDocument/publishDiagnostics' &&
        m.params.uri === this.uri
      ) {
        const { version, diagnostics, isIncremental } = m.params
        this.diagnostics.set(
          version,
          isIncremental
            ? [...(this.diagnostics.get(version) || []), ...diagnostics]
            : diagnostics,
        )
      }
    })
  }
  send(message) {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
  }
  async wait(check, label) {
    return waitForEvidence(() => {
      if (this.error) throw this.error
      return check()
    }, label)
  }
  async request(method, params) {
    const id = ++this.id
    this.send({ id, method, params })
    const response = await this.wait(() => this.responses.get(id), method)
    this.responses.delete(id)
    if (response.error) throw new Error(method + ': ' + response.error.message)
    return response.result
  }
  async initialize(text) {
    await this.wait(
      () => this.socket.readyState === WebSocket.OPEN,
      'repository socket',
    )
    const result = await this.request('initialize', {
      processId: null,
      rootUri: 'file:///workspace',
      workspaceFolders: [{ name: 'workspace', uri: 'file:///workspace' }],
      capabilities: {
        textDocument: { publishDiagnostics: { versionSupport: true } },
      },
    })
    assert(result?.capabilities)
    this.send({ method: 'initialized', params: {} })
    this.open(text)
  }
  open(text) {
    this.send({
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: this.uri,
          version: ++this.version,
          languageId: 'lean4',
          text,
        },
      },
    })
  }
  change(text) {
    this.send({
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: this.uri, version: ++this.version },
        contentChanges: [{ text }],
      },
    })
  }
  refresh(text) {
    this.send({
      method: 'textDocument/didClose',
      params: { textDocument: { uri: this.uri } },
    })
    this.open(text)
  }
  async checked() {
    const version = this.version
    await this.request('textDocument/waitForDiagnostics', {
      uri: this.uri,
      version,
    })
    return this.wait(
      () => this.diagnostics.get(version),
      'diagnostics for the current document',
    )
  }
  async goal(text) {
    const line = text.split('\n').indexOf('  rfl')
    assert(line >= 0)
    const result = await this.request('$/lean/plainGoal', {
      textDocument: { uri: this.uri },
      position: { line, character: 2 },
    })
    assert(
      result?.goals?.some((goal) => /n\s*=\s*n/.test(goal)),
      'Expected an interactive n = n goal',
    )
  }
}
