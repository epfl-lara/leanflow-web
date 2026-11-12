import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'

const invalid = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}

// Cursor state stays in memory and shares the document's causal text positions.
// It never writes a workspace file or accepts an identity from the browser.
export class ProjectPresence {
  constructor({
    clients,
    workspaces,
    authenticated,
    displayName,
    record,
    send,
  }) {
    Object.assign(this, {
      clients,
      workspaces,
      authenticated,
      displayName,
      record,
      send,
    })
    this.timers = new Map()
  }

  set(client, request, record) {
    this.workspaces.requireEditor(client.projectId, client.actor)
    if (
      client.ws.readyState !== 1 ||
      !client.paths.has(record.path) ||
      record.invalidated ||
      request.documentId !== record.id
    )
      invalid('Reopen the shared file before sending its cursor.', 409)
    const source = record.doc.getText('source')
    if (
      ![request.anchor, request.head].every(
        (offset) =>
          Number.isSafeInteger(offset) &&
          offset >= 0 &&
          offset <= source.length,
      )
    )
      invalid('Invalid shared cursor position.')
    client.presenceId ??= randomUUID()
    client.presence = {
      path: record.path,
      documentId: record.id,
      anchor: Y.createRelativePositionFromTypeIndex(source, request.anchor),
      head: Y.createRelativePositionFromTypeIndex(source, request.head),
    }
    this.schedule(client.projectId)
  }

  clear(client) {
    client.presenceRevision = (client.presenceRevision || 0) + 1
    if (!client.presence) return
    client.presence = null
    this.broadcast(client.projectId)
  }

  clearDocument(record) {
    for (const client of this.clients)
      if (
        client.projectId === record.projectId &&
        client.presence?.documentId === record.id
      ) {
        client.presenceRevision = (client.presenceRevision || 0) + 1
        client.presence = null
      }
    this.broadcast(record.projectId)
  }

  schedule(projectId) {
    if (this.closed || this.timers.has(projectId)) return
    const timer = setTimeout(() => {
      this.timers.delete(projectId)
      this.broadcast(projectId)
    }, 40)
    timer.unref?.()
    this.timers.set(projectId, timer)
  }

  broadcast(projectId) {
    if (this.closed) return
    const recipients = []
    const peers = []
    for (const client of this.clients) {
      if (client.projectId !== projectId || client.ws.readyState !== 1) continue
      try {
        if (!this.authenticated(client)) throw new Error('Signed out')
        this.workspaces.get(projectId, client.actor)
        recipients.push(client)
        if (!client.presence) continue
        this.workspaces.requireEditor(projectId, client.actor)
        const presence = client.presence
        const record = this.record(projectId, presence.path)
        if (
          !record ||
          record.invalidated ||
          record.id !== presence.documentId ||
          !client.paths.has(presence.path)
        )
          throw new Error('Cursor document changed')
        const anchor = Y.createAbsolutePositionFromRelativePosition(
          presence.anchor,
          record.doc,
        )
        const head = Y.createAbsolutePositionFromRelativePosition(
          presence.head,
          record.doc,
        )
        if (!anchor || !head) throw new Error('Cursor text changed')
        peers.push({
          client,
          cursor: {
            clientId: client.presenceId,
            userId: client.actor,
            name: this.displayName(client.actor),
            path: presence.path,
            documentId: presence.documentId,
            anchor: anchor.index,
            head: head.index,
          },
        })
      } catch {
        client.presence = null
      }
    }
    for (const client of recipients) {
      const snapshot = {
        type: 'presence',
        peers: peers
          .filter(
            (peer) =>
              peer.client !== client && client.paths.has(peer.cursor.path),
          )
          .map((peer) => peer.cursor),
      }
      const serialized = JSON.stringify(snapshot)
      if (client.presenceSnapshot === serialized) continue
      client.presenceSnapshot = serialized
      this.send(client, snapshot)
    }
  }

  close() {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
