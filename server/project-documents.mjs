import { createHash, randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import { validateWorkspaceFilePath } from './workspaces.mjs'
import { sourceFileByteLimit } from '../shared/source-limits.mjs'
import { PROJECT_CONFIGURATION_FILES } from '../shared/project-configuration.mjs'
const CONFIGURATION_FILES = new Set(PROJECT_CONFIGURATION_FILES)

const MAX_MESSAGE_BYTES = 12 * 1024 * 1024
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024
const MAX_SUBSCRIPTIONS = 16
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}

export { replaceDocumentText } from '../shared/document-text.mjs'
import { replaceDocumentText } from '../shared/document-text.mjs'

function encoded(update) {
  return Buffer.from(update).toString('base64')
}
function decoded(value) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > MAX_MESSAGE_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    fail('Invalid shared document update.')
  return new Uint8Array(Buffer.from(value, 'base64'))
}
function sourcePath(value) {
  const name = validateWorkspaceFilePath(value)
  if (CONFIGURATION_FILES.has(name))
    fail(
      'Save project configuration through the project editor save action.',
      403,
    )
  if (name.startsWith('.lake/')) fail('Dependency files are read only.', 403)
  return name
}

// Document queues never hold a workspace lock. Durable commits use the existing
// workspace CAS lock; post-commit notifications only schedule a later reread.
export class ProjectDocuments {
  constructor({
    workspaces,
    isAuthenticated = () => true,
    maxDocuments = 128,
    maxClients = 128,
    maxClientsPerActor = 12,
    maxDocumentsPerActor = 32,
    maxPendingPerActor = 32,
    maxPendingBytes = 32 * 1024 * 1024,
    maxDocumentBytes = 64 * 1024 * 1024,
    idleMs = 30_000,
  }) {
    Object.assign(this, {
      workspaces,
      isAuthenticated,
      maxDocuments,
      maxClients,
      maxClientsPerActor,
      maxDocumentsPerActor,
      maxPendingPerActor,
      maxPendingBytes,
      maxDocumentBytes,
      idleMs,
    })
    this.documents = new Map()
    this.clients = new Set()
    this.pendingPerActor = new Map()
    this.pendingBytes = 0
    this.closed = false
    this.watchers = new Map()
    this.poll = setInterval(() => this.pollExternalChanges(), 1000)
    this.poll.unref?.()
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE_BYTES,
    })
    this.unsubscribe = workspaces.subscribeChanges((event) =>
      this.changed(event),
    )
  }

  upgrade(req, socket, head, { projectId, actor }) {
    if (
      this.closed ||
      this.clients.size >= this.maxClients ||
      [...this.clients].filter((client) => client.actor === actor).length >=
        this.maxClientsPerActor
    ) {
      socket.end(
        'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      )
      return
    }
    this.workspaces.get(projectId, actor)
    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.connect(ws, projectId, actor, req),
    )
  }

  connect(ws, projectId, actor, request) {
    if (this.closed) {
      ws.terminate()
      return
    }
    const client = {
      ws,
      projectId,
      actor,
      request,
      paths: new Set(),
      openRequests: new Map(),
      vectors: new Map(),
      alive: true,
      pending: 0,
    }
    this.clients.add(client)
    this.watchDirectory(projectId, actor, '')
    const heartbeat = setInterval(() => {
      if (!client.alive) return ws.terminate()
      try {
        this.assertAuthenticated(client)
        this.workspaces.get(projectId, actor)
      } catch {
        return ws.close(1008, 'Project access changed.')
      }
      client.alive = false
      ws.ping()
    }, 20_000)
    heartbeat.unref?.()
    ws.on('pong', () => {
      client.alive = true
    })
    ws.on('message', (data) => {
      const actorPending = this.pendingPerActor.get(actor) || 0
      if (
        client.pending >= 32 ||
        actorPending >= this.maxPendingPerActor ||
        this.pendingBytes + data.length > this.maxPendingBytes
      ) {
        ws.close(
          1013,
          'Too many pending document updates. Reconnect to continue.',
        )
        return
      }
      client.pending++
      this.pendingPerActor.set(actor, actorPending + 1)
      this.pendingBytes += data.length
      const release = () => {
        client.pending--
        this.pendingBytes -= data.length
        const remaining = (this.pendingPerActor.get(actor) || 1) - 1
        if (remaining) this.pendingPerActor.set(actor, remaining)
        else this.pendingPerActor.delete(actor)
      }
      let request
      try {
        request = JSON.parse(data.toString())
      } catch {
        release()
        ws.close(1008, 'Invalid document message.')
        return
      }
      void this.message(client, request)
        .catch((error) =>
          this.send(client, {
            type: 'error',
            path: typeof request?.path === 'string' ? request.path : undefined,
            requestId:
              typeof request?.requestId === 'number'
                ? request.requestId
                : undefined,
            status: error.status || 400,
            message: error.status
              ? error.message
              : 'The shared edit could not be saved. Your edits remain in this tab. Reload the saved file before retrying.',
          }),
        )
        .finally(release)
    })
    ws.on('error', () => ws.terminate())
    ws.on('close', () => {
      clearInterval(heartbeat)
      this.clients.delete(client)
      client.openRequests.clear()
      for (const name of client.paths) this.detach(client, name)
      if (![...this.clients].some((item) => item.projectId === projectId))
        this.clearWatchers(projectId)
    })
    this.send(client, { type: 'ready' })
  }

  authenticated(client) {
    try {
      return this.isAuthenticated(client.request, client.actor)
    } catch {
      return false
    }
  }
  assertAuthenticated(client) {
    if (this.authenticated(client)) return
    client.ws.close(1008, 'Account access changed. Sign in again.')
    fail('Account access changed. Sign in again.', 401)
  }
  send(client, message) {
    if (client.ws.readyState !== 1) return
    if (!this.authenticated(client)) {
      client.ws.close(1008, 'Account access changed. Sign in again.')
      return
    }
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.ws.close(
        1013,
        'Shared updates are arriving too quickly. Reconnect to continue.',
      )
      return
    }
    client.ws.send(JSON.stringify(message))
  }

  key(projectId, name) {
    return JSON.stringify([projectId, name])
  }
  detach(client, name) {
    client.paths.delete(name)
    client.vectors.delete(name)
    const record = this.documents.get(this.key(client.projectId, name))
    if (!record) return
    record.clients.delete(client)
    if (!record.clients.size) {
      clearTimeout(record.idle)
      record.idle = setTimeout(() => {
        if (!record.clients.size && !record.pending) this.evict(record)
      }, this.idleMs)
      record.idle.unref?.()
    }
  }
  evict(record) {
    if (record.clients.size || record.pending) return false
    clearTimeout(record.idle)
    this.documents.delete(this.key(record.projectId, record.path))
    record.doc.destroy()
    return true
  }
  queue(record, action) {
    if (this.closed)
      return Promise.reject(
        Object.assign(
          new Error('Live editing is stopping. Your edits remain in this tab.'),
          { status: 503 },
        ),
      )
    if (record.pending >= 32)
      return Promise.reject(
        Object.assign(
          new Error('This file has too many pending edits. Try again shortly.'),
          { status: 429 },
        ),
      )
    record.pending++
    const next = record.queue.catch(() => {}).then(action)
    record.queue = next
    return next.finally(() => {
      record.pending--
    })
  }
  memoryBytes() {
    return [...this.documents.values()].reduce(
      (sum, item) => sum + item.bytes,
      0,
    )
  }

  async document(projectId, actor, name) {
    const key = this.key(projectId, name)
    let record = this.documents.get(key)
    if (record) return record
    for (const item of this.documents.values()) {
      if (
        this.documents.size < this.maxDocuments &&
        this.memoryBytes() < this.maxDocumentBytes
      )
        break
      this.evict(item)
    }
    if (
      this.documents.size >= this.maxDocuments ||
      this.memoryBytes() >= this.maxDocumentBytes
    )
      fail(
        'Live editing is busy. Close another file or retry shortly; normal saving remains available.',
        429,
      )
    // Reserve before awaiting the filesystem so simultaneous opens share IDs.
    record = {
      id: randomUUID(),
      projectId,
      path: name,
      doc: new Y.Doc(),
      hash: null,
      clients: new Set(),
      clientOwners: new Map(),
      pending: 0,
      queue: Promise.resolve(),
      bytes: 0,
    }
    this.documents.set(key, record)
    try {
      await this.queue(record, () => this.refresh(record, actor))
      this.watchDirectory(projectId, actor, path.posix.dirname(name))
      return record
    } catch (error) {
      this.evict(record)
      throw error
    }
  }

  // A moved file keeps its content, so peers are told through the structured
  // `files` message and carry their drafts to the destination. The old
  // document is still invalidated so no stale write can recreate its path.
  invalidate(record, { moved = false } = {}) {
    if (record.invalidated) return
    record.invalidated = true
    if (moved) return
    for (const client of record.clients)
      this.send(client, {
        type: 'error',
        path: record.path,
        status: 409,
        message:
          'This shared file was removed or moved. Your draft remains in this tab. Reopen the saved file before continuing.',
      })
  }
  assertDocumentCurrent(record, documentId = record.id) {
    if (record.invalidated || record.id !== documentId)
      fail(
        'This live file was removed or replaced. Reopen the saved file before editing.',
        409,
      )
  }
  resetDocument(record) {
    record.doc.destroy()
    record.doc = new Y.Doc()
    record.id = randomUUID()
    record.hash = null
    record.bytes = 0
    record.clientOwners.clear()
    record.invalidated = false
    for (const client of record.clients) client.vectors.delete(record.path)
  }
  readerProject(record, actor) {
    try {
      return this.workspaces.get(record.projectId, actor)
    } catch (error) {
      // A revoked reader says nothing about the lifetime of the file. Close
      // only that reader; another member may still use the same document.
      for (const client of record.clients)
        if (client.actor === actor)
          client.ws.close(1008, 'Project access changed.')
      error.documentReaderDenied = true
      throw error
    }
  }
  async refresh(record, actor) {
    this.assertDocumentCurrent(record)
    const root = this.readerProject(record, actor).root
    const signature = root
      ? await this.diskSignature(path.join(root, record.path))
      : undefined
    let source
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const read =
          this.workspaces.readCollaborativeFile || this.workspaces.readFile
        source = await read.call(
          this.workspaces,
          record.projectId,
          actor,
          record.path,
        )
        this.readerProject(record, actor)
        break
      } catch (error) {
        this.readerProject(record, actor)
        const status = error.status || error.statusCode
        if (status === 409 && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          continue
        }
        if (status === 404) this.invalidate(record)
        if (status === 409)
          fail(
            'The shared file is changing. Live editing will retry; your draft remains in this tab.',
            503,
          )
        throw error
      }
    }
    this.assertDocumentCurrent(record)
    if (record.hash !== source.hash) {
      let candidate = new Y.Doc()
      try {
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(record.doc))
        let newGeneration = false
        try {
          replaceDocumentText(candidate.getText('source'), source.content)
        } catch (error) {
          if (error.code !== 'DOCUMENT_DIFF_LIMIT') throw error
          // An authoritative REST change can exceed the exact diff budget.
          // Start a new identity instead of coarsely deleting old shared IDs;
          // dirty peers retain their drafts and old operations are rejected.
          candidate.destroy()
          candidate = new Y.Doc()
          candidate.getText('source').insert(0, source.content)
          newGeneration = true
        }
        const state = Y.encodeStateAsUpdate(candidate)
        if (
          state.byteLength >
            sourceFileByteLimit(record.path) * 2 + 1024 * 1024 ||
          this.memoryBytes() - record.bytes + state.byteLength >
            this.maxDocumentBytes
        )
          fail(
            'This file exceeds live editing capacity. Close the live file before continuing.',
            429,
          )
        if (newGeneration) this.resetDocument(record)
        Y.applyUpdate(record.doc, state)
        record.hash = source.hash
        record.bytes = state.byteLength
        this.broadcast(record)
      } finally {
        candidate.destroy()
      }
    }
    record.signature = signature
    return source
  }
  async diskSignature(filename) {
    try {
      const stat = await lstat(filename, { bigint: true })
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    } catch {
      return 'missing'
    }
  }
  watchDirectory(projectId, actor, relative) {
    const project = this.workspaces.get(projectId, actor)
    if (!project.root) return
    const directory = relative === '.' ? '' : relative
    const key = this.key(projectId, directory)
    if (this.watchers.has(key) || this.watchers.size >= 256) return
    try {
      // Nonrecursive directory watchers never traverse user-created symlinks.
      // Open file parents have already passed WorkspaceStore's guarded read.
      const watcher = watch(
        path.join(project.root, directory),
        { persistent: false },
        (_kind, filename) => {
          const name = filename?.toString()
          if (!name || name.startsWith('.lemex-write-')) return
          try {
            sourcePath(directory ? `${directory}/${name}` : name)
          } catch {
            return
          }
          clearTimeout(watcher.timer)
          watcher.timer = setTimeout(
            () => this.changed({ projectId, kind: 'files', paths: [] }),
            100,
          )
          watcher.timer.unref?.()
        },
      )
      watcher.on('error', () => {
        clearTimeout(watcher.timer)
        watcher.close()
        this.watchers.delete(key)
      })
      this.watchers.set(key, { projectId, watcher })
    } catch {
      /* The bounded metadata poll remains available on unsupported filesystems. */
    }
  }
  clearWatchers(projectId) {
    for (const [key, entry] of this.watchers)
      if (!projectId || entry.projectId === projectId) {
        clearTimeout(entry.watcher.timer)
        entry.watcher.close()
        this.watchers.delete(key)
      }
  }
  pollExternalChanges() {
    if (this.closed) return
    for (const record of this.documents.values()) {
      if (!record.clients.size || record.pending || record.polling) continue
      const client = [...record.clients][0]
      record.polling = true
      void (async () => {
        const root = this.workspaces.get(record.projectId, client.actor).root
        if (
          !root ||
          (await this.diskSignature(path.join(root, record.path))) ===
            record.signature
        )
          return
        await this.queue(record, () => this.refresh(record, client.actor))
      })()
        .catch(() => {})
        .finally(() => {
          record.polling = false
        })
    }
  }
  packet(record, ack, vector) {
    return {
      type: 'document',
      path: record.path,
      documentId: record.id,
      update: encoded(Y.encodeStateAsUpdate(record.doc, vector)),
      ...(vector ? {} : { content: record.doc.getText('source').toString() }),
      hash: record.hash,
      ...(ack === undefined ? {} : { ack }),
    }
  }
  broadcast(record, origin, ack) {
    const vector = Y.encodeStateVector(record.doc)
    for (const client of record.clients) {
      try {
        this.workspaces.get(record.projectId, client.actor)
      } catch {
        client.ws.close(1008, 'Project access changed.')
        continue
      }
      this.send(
        client,
        this.packet(
          record,
          client === origin ? ack : undefined,
          client.vectors.get(record.path),
        ),
      )
      client.vectors.set(record.path, vector)
    }
  }

  assertCanSubscribe(client, name) {
    if (client.paths.has(name)) return
    if (client.paths.size >= MAX_SUBSCRIPTIONS)
      fail('Open at most 16 files for live editing.', 429)
    const paths = new Set()
    for (const peer of this.clients) {
      if (peer.actor !== client.actor) continue
      for (const path of peer.paths) paths.add(this.key(peer.projectId, path))
    }
    if (
      !paths.has(this.key(client.projectId, name)) &&
      paths.size >= this.maxDocumentsPerActor
    )
      fail(
        'This account has too many live files open. Close an unused file and retry.',
        429,
      )
  }

  updateOwners(record, structs, actor) {
    const known = Y.decodeStateVector(Y.encodeStateVector(record.doc))
    const claims = new Set()
    for (const struct of structs) {
      const id = struct.id.client
      const end = struct.id.clock + struct.length
      if (end <= (known.get(id) || 0)) continue // Idempotent replay of accepted state.
      if (
        (record.clientOwners.has(id) &&
          record.clientOwners.get(id) !== actor) ||
        (!record.clientOwners.has(id) &&
          ((known.get(id) || 0) > 0 || id === record.doc.clientID))
      )
        fail(
          'This edit uses another collaborator’s live document identity. Reconnect before editing.',
          400,
        )
      claims.add(id)
    }
    const newIds = [...claims].filter((id) => !record.clientOwners.has(id))
    if (record.clientOwners.size + newIds.length > 1024)
      fail(
        'This file has reached live session capacity. Close unused views and reopen the file.',
        429,
      )
    return claims
  }

  integrateUpdate(record, client, update, claims, state, hash, ack) {
    for (const id of claims) record.clientOwners.set(id, client.actor)
    Y.applyUpdate(record.doc, update)
    record.hash = hash
    record.bytes = state.byteLength
    this.broadcast(record, client, ack)
  }

  async message(client, request) {
    if (this.closed)
      fail('Live editing is stopping. Your edits remain in this tab.', 503)
    if (!request || typeof request !== 'object' || Array.isArray(request))
      fail('Invalid shared document message.')
    this.assertAuthenticated(client)
    this.workspaces.get(client.projectId, client.actor)
    if (request.type === 'close') {
      const name = sourcePath(request.path)
      client.openRequests?.delete(name)
      this.detach(client, name)
      return
    }
    if (!['open', 'update'].includes(request.type))
      fail('Unknown shared document message.')
    const name = sourcePath(request.path)
    if (request.type === 'open') {
      if (
        request.requestId !== undefined &&
        (!Number.isSafeInteger(request.requestId) || request.requestId < 1)
      )
        fail('Invalid document request identifier.')
      const opening = Symbol('document subscription')
      const openings = (client.openRequests ??= new Map())
      openings.set(name, opening)
      try {
        this.assertCanSubscribe(client, name)
        const record = await this.document(client.projectId, client.actor, name)
        await this.queue(record, async () => {
          if (openings.get(name) !== opening) return
          if (record.invalidated) this.resetDocument(record)
          await this.refresh(record, client.actor)
          if (client.ws.readyState !== 1 || openings.get(name) !== opening)
            return
          this.assertCanSubscribe(client, name)
          clearTimeout(record.idle)
          record.clients.add(client)
          client.paths.add(name)
          this.send(client, {
            ...this.packet(record),
            ...(request.requestId === undefined
              ? {}
              : { openRequestId: request.requestId }),
          })
          client.vectors.set(record.path, Y.encodeStateVector(record.doc))
        })
      } finally {
        if (openings.get(name) === opening) openings.delete(name)
      }
      return
    }
    this.workspaces.requireEditor(client.projectId, client.actor)
    if (!client.paths.has(name))
      fail('Open the shared file before editing it.', 409)
    if (!Number.isSafeInteger(request.requestId) || request.requestId < 1)
      fail('Invalid document request identifier.')
    const record = this.documents.get(this.key(client.projectId, name))
    if (!record || request.documentId !== record.id)
      fail('The live document expired. Reconnect before saving.', 409)
    const update = decoded(request.update)
    const incoming = Y.decodeUpdate(update)
    await this.queue(record, async () => {
      this.assertDocumentCurrent(record, request.documentId)
      for (let attempt = 0; attempt < 4; attempt++) {
        this.assertAuthenticated(client)
        const project = this.workspaces.requireEditor(
          client.projectId,
          client.actor,
        )
        if (
          project.status === 'preparing' ||
          this.workspaces.jobs?.has(client.projectId)
        )
          fail(
            'Project setup is running. Live saving will resume when it finishes; your draft remains in this tab.',
            503,
          )
        await this.refresh(record, client.actor)
        const claims = this.updateOwners(record, incoming.structs, client.actor)
        const candidate = new Y.Doc()
        try {
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(record.doc))
          Y.applyUpdate(candidate, update)
          const integrated = Y.decodeStateVector(Y.encodeStateVector(candidate))
          // Every accepted operation must be fully resolved now. Dormant
          // structs or future delete ranges could otherwise activate against a
          // different user's later edits, even after their author is revoked.
          if (
            incoming.structs.some(
              (struct) =>
                struct.id.clock + struct.length >
                (integrated.get(struct.id.client) || 0),
            ) ||
            [...incoming.ds.clients].some(([id, ranges]) =>
              ranges.some(
                (range) => range.clock + range.len > (integrated.get(id) || 0),
              ),
            )
          )
            fail(
              'This update refers to shared text that has not been received. Reconnect before editing.',
              400,
            )
          if ([...candidate.share.keys()].some((key) => key !== 'source'))
            fail('Shared updates may only edit this file.', 400)
          const content = candidate.getText('source').toString()
          const state = Y.encodeStateAsUpdate(candidate)
          if (
            Buffer.byteLength(content) > sourceFileByteLimit(name) ||
            content.includes('\0')
          )
            fail(
              'This shared edit exceeds the source file limit. Reduce the file before saving.',
              413,
            )
          if (
            state.byteLength > sourceFileByteLimit(name) * 2 + 1024 * 1024 ||
            this.memoryBytes() - record.bytes + state.byteLength >
              this.maxDocumentBytes
          )
            fail(
              'Live editing memory is full. Reconnect after saving a smaller file.',
              429,
            )
          let saved
          try {
            this.assertAuthenticated(client)
            saved = await this.workspaces.writeFile(
              client.projectId,
              client.actor,
              name,
              content,
              record.hash,
              {
                assertAuthorized: () => {
                  this.assertAuthenticated(client)
                  this.assertDocumentCurrent(record, request.documentId)
                },
              },
            )
          } catch (error) {
            if (error.sourceCommitted === true) {
              // The atomic replacement is already visible, but its directory
              // fsync failed. Keep the exact causal IDs so refresh/reconnect
              // cannot re-import the same local text as unrelated remote ops.
              // No ACK is sent until a retry confirms the storage sync.
              this.integrateUpdate(
                record,
                client,
                update,
                claims,
                state,
                createHash('sha256').update(content).digest('hex'),
              )
            }
            if (
              (error.status || error.statusCode) === 409 &&
              (this.workspaces.get(client.projectId, client.actor).status ===
                'preparing' ||
                this.workspaces.jobs?.has(client.projectId))
            )
              fail(
                'Project setup is running. Live saving will resume when it finishes; your draft remains in this tab.',
                503,
              )
            if ((error.status || error.statusCode) === 409 && attempt < 3)
              continue
            throw error
          }
          // Membership may change during the CAS; store checks again inside its lock.
          this.integrateUpdate(
            record,
            client,
            update,
            claims,
            state,
            saved.hash,
            request.requestId,
          )
          return
        } finally {
          candidate.destroy()
        }
      }
    })
  }

  changed(event) {
    if (this.closed) return
    if (event.kind === 'access' || event.kind === 'project')
      this.closeAccess(event.projectId)
    for (const client of this.clients)
      if (client.projectId === event.projectId) {
        try {
          this.workspaces.get(event.projectId, client.actor)
          this.send(client, {
            type:
              event.kind === 'access'
                ? 'access'
                : event.kind === 'project'
                  ? 'project'
                  : 'files',
            paths: event.paths,
            ...(event.moves?.length && event.kind === 'files'
              ? { moves: event.moves }
              : {}),
          })
        } catch {
          client.ws.close(1008, 'Project access changed.')
        }
      }
    for (const record of this.documents.values()) {
      if (
        record.projectId === event.projectId &&
        event.removedPaths?.some(
          (name) => name === record.path || record.path.startsWith(name + '/'),
        )
      )
        this.invalidate(record, {
          moved: !!event.moves?.some(
            (move) =>
              record.path === move.from ||
              record.path.startsWith(move.from + '/'),
          ),
        })
      if (
        record.projectId !== event.projectId ||
        (event.paths?.length &&
          !event.paths.some(
            (name) =>
              name === record.path || record.path.startsWith(name + '/'),
          ))
      )
        continue
      const actor = [...record.clients].find((client) => {
        try {
          this.workspaces.get(event.projectId, client.actor)
          return true
        } catch {
          return false
        }
      })?.actor
      if (actor) this.scheduleRefresh(record, actor)
    }
  }
  scheduleRefresh(record, actor) {
    if (record.invalidated) return
    record.refreshNeeded = true
    if (record.refreshTask || this.closed) return
    record.refreshTask = (async () => {
      while (record.refreshNeeded && !this.closed) {
        record.refreshNeeded = false
        // Coalesce post-commit echoes behind current writes. refresh compares
        // disk hashes and returns without a Yjs transaction for our own saves.
        await record.queue.catch(() => {})
        if (this.closed || !record.clients.size) break
        if (record.pending >= 32) {
          record.refreshNeeded = true
          continue
        }
        await this.queue(record, () => {
          const active = [...record.clients].find((client) => {
            try {
              this.workspaces.get(record.projectId, client.actor)
              return true
            } catch {
              return false
            }
          })
          return active ? this.refresh(record, active.actor) : undefined
        })
      }
    })()
      .catch((error) => {
        if (error.documentReaderDenied) {
          record.refreshNeeded = [...record.clients].some((client) => {
            try {
              this.workspaces.get(record.projectId, client.actor)
              return true
            } catch {
              return false
            }
          })
          return
        }
        for (const client of record.clients)
          this.send(client, {
            type: 'error',
            path: record.path,
            status: error.status || 409,
            message:
              error.status === 429
                ? 'Live editing is busy. Reconnect to continue; your edits remain in this tab.'
                : 'This shared file changed or was removed. Your unsaved edits remain in this tab. Reload the file to continue.',
          })
      })
      .finally(() => {
        record.refreshTask = null
        if (record.refreshNeeded && !this.closed && record.clients.size)
          this.scheduleRefresh(record, actor)
      })
  }
  closeAccess(projectId, actor) {
    for (const client of this.clients) {
      if (client.projectId !== projectId || (actor && client.actor !== actor))
        continue
      try {
        this.workspaces.get(projectId, client.actor)
      } catch {
        client.ws.close(1008, 'Project access changed.')
        continue
      }
      if (actor) client.ws.close(1008, 'Project access changed.')
    }
  }
  close() {
    if (this.closePromise) return this.closePromise
    this.closed = true
    clearInterval(this.poll)
    this.clearWatchers()
    this.unsubscribe?.()
    for (const client of this.clients) client.ws.terminate()
    this.wss.close()
    this.closePromise = Promise.allSettled(
      [...this.documents.values()].flatMap((record) => [
        record.queue,
        record.refreshTask,
      ]),
    ).then(() => {
      for (const record of this.documents.values()) {
        clearTimeout(record.idle)
        record.doc.destroy()
      }
      this.documents.clear()
    })
    return this.closePromise
  }
}
