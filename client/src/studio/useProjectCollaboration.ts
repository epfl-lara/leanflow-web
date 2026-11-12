import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { replaceDocumentText } from '../../../shared/document-text.mjs'
import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'
import { sourceFileByteLimit } from '../../../shared/source-limits.mjs'
const CONFIGURATION_FILES = new Set(PROJECT_CONFIGURATION_FILES)
const MAX_LIVE_DOCUMENTS = 16
const LIVE_EDITING_RECOVERY =
  'Switch to another project and back, or reload this page to retry live editing.'
const liveFile = (path: string) =>
  !path.startsWith('.lake/') && !CONFIGURATION_FILES.has(path)
import type { WorkspaceBuffers, WorkspaceScope } from './workspaceBuffers'
import { sessionBoundUrl, type OpenFile } from './api'
import { LocalDocumentHistory } from './localDocumentHistory'
import { pathMoves, remapMovedPath, type PathMove } from './projectPaths'

interface LiveDocument {
  doc: Y.Doc
  canonical: Y.Doc
  undo: Y.UndoManager
  id: string | null
  opened: boolean
  blocked: boolean
  generation: number
  // Agent/terminal HTTP refreshes can replace this baseline without a reload.
  bufferHash: string
  openRequestId: number
  pending: Set<number>
  sourceLimitFailure?: string
  failedLocalContent?: string
}
interface CollaborationControl {
  flush: () => Promise<boolean>
  undo: (path: string) => boolean
  redo: (path: string) => boolean
}
function encode(update: Uint8Array) {
  let binary = ''
  // Avoid spreading a large paste onto the JavaScript call stack.
  for (let start = 0; start < update.length; start += 16_384)
    binary += String.fromCharCode(...update.subarray(start, start + 16_384))
  return btoa(binary)
}
function decode(update: string) {
  return Uint8Array.from(atob(update), (character) => character.charCodeAt(0))
}
function documentMessage(value: unknown): value is {
  type: 'document'
  path: string
  documentId: string
  update: string
  content?: string
  hash: string
  ack?: number
  openRequestId?: number
} {
  return (
    !!value &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'document' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'documentId' in value &&
    typeof value.documentId === 'string' &&
    'update' in value &&
    typeof value.update === 'string' &&
    (!('content' in value) || typeof value.content === 'string') &&
    'hash' in value &&
    typeof value.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.hash) &&
    (!('ack' in value) ||
      (typeof value.ack === 'number' &&
        Number.isSafeInteger(value.ack) &&
        value.ack > 0)) &&
    (!('openRequestId' in value) ||
      (typeof value.openRequestId === 'number' &&
        Number.isSafeInteger(value.openRequestId) &&
        value.openRequestId > 0))
  )
}

// Each visit owns its sockets and document identities. Acknowledgements from a
// previous project visit can never attach to a new editor buffer.
export function useProjectCollaboration({
  store,
  scope,
  enabled,
  canEdit,
  onFilesChanged,
  onFilesMoved,
  onAccessChanged,
}: {
  store: WorkspaceBuffers
  scope: WorkspaceScope
  enabled: boolean
  canEdit: boolean
  onFilesChanged?: () => void | Promise<void>
  onFilesMoved?: (move: PathMove) => void
  onAccessChanged?: () => void | Promise<void>
}) {
  const [connected, setConnected] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const control = useRef<CollaborationControl | null>(null)
  // A permission/setup transition may recreate the live connection while
  // Monaco retains its model. Never expose an older native undo stack after
  // that model has imported shared edits during this workspace visit.
  const historyVisit = useRef({
    scope,
    paths: new Set<string>(),
    restPaths: new Set<string>(),
  })
  const callbacks = useRef({ onFilesChanged, onFilesMoved, onAccessChanged })
  useEffect(() => {
    callbacks.current = { onFilesChanged, onFilesMoved, onAccessChanged }
  }, [onFilesChanged, onFilesMoved, onAccessChanged])
  const flush = useCallback(
    () => control.current?.flush() ?? Promise.resolve(false),
    [],
  )
  const undo = useCallback(
    (path: string) => control.current?.undo(path) ?? false,
    [],
  )
  const redo = useCallback(
    (path: string) => control.current?.redo(path) ?? false,
    [],
  )

  useEffect(() => {
    if (!enabled || !scope.projectId) return
    if (historyVisit.current.scope !== scope)
      historyVisit.current = {
        scope,
        paths: new Set<string>(),
        restPaths: new Set<string>(),
      }
    const documents = new Map<string, LiveDocument>()
    const hasDocumentFailure = () =>
      [...documents.values()].some(
        (record) => record.blocked || record.sourceLimitFailure,
      )
    const fallbackPaths = historyVisit.current.restPaths
    const fallbackHistories = new Map<string, LocalDocumentHistory>()
    const managedHistory = historyVisit.current.paths
    const localOrigin = Symbol('local document edit')
    let socket: WebSocket | null = null
    let disposed = false,
      ready = false,
      applying = false,
      requestId = 0,
      retry = 0,
      failure: string | null = null,
      discardVersion = store.getSnapshot().discardVersion
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let listingTimer: ReturnType<typeof setTimeout> | undefined
    let sendTimer: ReturnType<typeof setTimeout> | undefined
    const waiters = new Set<() => void>()
    const current = () => !disposed && store.isCurrent(scope)
    const clearIssue = () =>
      setIssue(
        fallbackPaths.size
          ? `Some files use normal version-checked saving for this visit. ${LIVE_EDITING_RECOVERY}`
          : null,
      )
    const notify = () => {
      for (const done of [...waiters]) done()
    }
    const fail = (message: string) => {
      failure = message
      if (current()) setIssue(message)
      notify()
    }
    const filesChanged = () => {
      clearTimeout(listingTimer)
      listingTimer = setTimeout(() => {
        if (current())
          void Promise.resolve(callbacks.current.onFilesChanged?.()).catch(
            () => {},
          )
      }, 350)
    }
    // Paths whose live documents were retired by a move. Late errors for them
    // must not become a visit-wide failure; reopening a path clears the entry.
    const movedAway = new Set<string>()
    const send = (message: object) => {
      if (!ready || socket?.readyState !== WebSocket.OPEN) return false
      if (socket.bufferedAmount > 12 * 1024 * 1024) {
        fail('Live editing is catching up. Your edits are kept in this tab.')
        socket.close(1013, 'Live editing is catching up.')
        return false
      }
      socket.send(JSON.stringify(message))
      return true
    }

    const destroyRecord = (record: LiveDocument) => {
      record.undo.destroy()
      record.doc.destroy()
      record.canonical.destroy()
    }
    const retainHistory = (
      path: string,
      doc: Y.Doc,
      undo: Y.UndoManager,
      file: OpenFile,
    ) => {
      if (fallbackHistories.size >= MAX_LIVE_DOCUMENTS) {
        const oldest = fallbackHistories.keys().next().value
        if (oldest !== undefined) {
          fallbackHistories.get(oldest)?.dispose()
          fallbackHistories.delete(oldest)
        }
      }
      fallbackHistories.set(
        path,
        new LocalDocumentHistory(
          doc,
          undo,
          file,
          store.getSnapshot().discardVersion,
          localOrigin,
        ),
      )
      managedHistory.add(path)
    }
    const diffLimitFallback = (
      path: string,
      record: LiveDocument,
      error: unknown,
    ) => {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'DOCUMENT_DIFF_LIMIT' ||
        record.pending.size
      )
        return false
      // The diff failed atomically. Drop these identities before using REST;
      // reconnect must never import a saved edit into its former local Ydoc.
      send({ type: 'close', path })
      const file = store.getSnapshot().buffers.get(path)
      if (file) {
        retainHistory(path, record.doc, record.undo, file)
        record.canonical.destroy()
      } else destroyRecord(record)
      documents.delete(path)
      fallbackPaths.add(path)
      if (!hasDocumentFailure()) failure = null
      setIssue(
        `${path} uses normal version-checked saving because this edit is too complex to merge live. ${LIVE_EDITING_RECOVERY}`,
      )
      notify()
      return true
    }
    const localDocument = () => {
      const doc = new Y.Doc()
      return {
        doc,
        undo: new Y.UndoManager(doc.getText('source'), {
          trackedOrigins: new Set([localOrigin]),
        }),
      }
    }
    const open = (path: string, record: LiveDocument) => {
      record.opened = false
      record.openRequestId = ++requestId
      send({ type: 'open', path, requestId: record.openRequestId })
    }
    const restHandoff = () => {
      // Once flush hands a draft to the HTTP caller, that request can still
      // commit after live admission. Keep its path on version-checked saves for
      // the rest of this visit so the same insertion cannot enter both systems.
      for (const file of store.dirty()) {
        if (
          !liveFile(file.path) ||
          file.preview === 'pdf' ||
          fallbackPaths.has(file.path)
        )
          continue
        const record = documents.get(file.path)
        if (record?.id || record?.pending.size) continue
        if (record) {
          send({ type: 'close', path: file.path })
          destroyRecord(record)
          documents.delete(file.path)
        }
        fallbackPaths.add(file.path)
        const local = localDocument()
        local.doc.getText('source').insert(0, file.savedContent)
        retainHistory(file.path, local.doc, local.undo, file)
        setIssue(
          `Some files use normal version-checked saving for this visit. ${LIVE_EDITING_RECOVERY}`,
        )
      }
      for (const history of fallbackHistories.values()) history.markSubmitted()
      return !store.dirty().length
    }
    const replayUpdate = (record: LiveDocument) => {
      // Local undo keeps deleted source alive. A wire-only clone can collect
      // that payload without losing its causal IDs or changing local history.
      const wire = new Y.Doc()
      try {
        Y.applyUpdate(wire, Y.encodeStateAsUpdate(record.doc))
        return Y.encodeStateAsUpdate(
          wire,
          Y.encodeStateVector(record.canonical),
        )
      } finally {
        wire.destroy()
      }
    }
    const sourceFits = (path: string, content: string) => {
      const limit = sourceFileByteLimit(path)
      return (
        !content.includes('\0') &&
        content.length <= limit &&
        new TextEncoder().encode(content).byteLength <= limit
      )
    }
    const sendDelta = (
      path: string,
      record: LiveDocument,
      vector?: Uint8Array,
    ) => {
      const replay = record.sourceLimitFailure !== undefined
      if (replay) {
        if (!ready || socket?.readyState !== WebSocket.OPEN) return
        const content = record.doc.getText('source').toString()
        if (!sourceFits(path, content)) return
        // The rejected connection was closed. This replay covers every local
        // operation, including earlier writes whose durable ACK was lost.
        record.pending.clear()
      }
      const id = ++requestId
      record.pending.add(id)
      const sent = send({
        type: 'update',
        path,
        documentId: record.id,
        update: encode(
          replay || vector === undefined
            ? replayUpdate(record)
            : Y.encodeStateAsUpdate(record.doc, vector),
        ),
        requestId: id,
      })
      if (sent && replay) {
        record.sourceLimitFailure = undefined
        if (!hasDocumentFailure()) {
          failure = null
          clearIssue()
        }
      }
      if (!sent && socket?.readyState === WebSocket.OPEN) socket.close()
    }
    const captureLocal = (
      path: string,
      record: LiveDocument,
      content: string,
      publish = true,
    ) => {
      if (record.doc.getText('source').toString() === content) return
      const vector = Y.encodeStateVector(record.doc)
      // Only this account's buffer edits belong to its undo stack. Incoming
      // updates keep the default remote origin and are never undone locally.
      record.doc.transact(
        () => replaceDocumentText(record.doc.getText('source'), content),
        localOrigin,
      )
      if (publish) sendDelta(path, record, vector)
      return true
    }
    const managedDirty = () =>
      store.dirty().some((file) => documents.has(file.path))

    function publishLocal() {
      clearTimeout(sendTimer)
      if (!current() || applying) return
      const state = store.getSnapshot()
      const buffers = state.buffers
      for (const [path, history] of fallbackHistories) {
        const file = buffers.get(path)
        if (file) history.synchronize(file, state.discardVersion)
        else {
          history.dispose()
          fallbackHistories.delete(path)
        }
      }
      if (!ready) return
      const discarded = discardVersion !== state.discardVersion
      discardVersion = state.discardVersion
      const selected = new Set<string>()
      const eligible = (path: string) => {
        const file = buffers.get(path)
        return (
          !!file &&
          file.preview !== 'pdf' &&
          liveFile(path) &&
          !fallbackPaths.has(path)
        )
      }
      // Never evict an unacknowledged operation or a local draft. Remaining
      // capacity follows the visible file and then existing warm subscriptions.
      for (const [path, record] of documents)
        if (
          eligible(path) &&
          (record.pending.size ||
            buffers.get(path)?.content !== buffers.get(path)?.savedContent)
        )
          selected.add(path)
      const choose = (path: string | undefined) => {
        if (path && selected.size < MAX_LIVE_DOCUMENTS && eligible(path))
          selected.add(path)
      }
      choose(state.file?.path)
      for (const path of documents.keys()) choose(path)
      for (const path of buffers.keys()) choose(path)
      for (const [path, record] of documents) {
        if (selected.has(path)) continue
        send({ type: 'close', path })
        destroyRecord(record)
        documents.delete(path)
        // A buffer re-keyed by this tab's own move leaves late acknowledgements
        // for the old path; they must not fail the destination.
        if (!buffers.has(path)) movedAway.add(path)
      }
      for (const path of selected) {
        const file = buffers.get(path)
        if (!file) continue
        let record = documents.get(path)
        if (
          record?.failedLocalContent !== undefined &&
          record.failedLocalContent !== file.content
        ) {
          record.blocked = false
          record.failedLocalContent = undefined
          if (!hasDocumentFailure()) {
            failure = null
            clearIssue()
          }
        }
        if (
          record &&
          (record.generation !== file.generation ||
            record.bufferHash !== file.hash ||
            discarded)
        ) {
          send({ type: 'close', path })
          destroyRecord(record)
          documents.delete(path)
          record = undefined
          if (!hasDocumentFailure()) {
            failure = null
            clearIssue()
          }
        }
        if (!record) {
          const local = localDocument()
          record = {
            ...local,
            canonical: new Y.Doc(),
            id: null,
            opened: false,
            blocked: false,
            generation: file.generation,
            bufferHash: file.hash,
            openRequestId: 0,
            pending: new Set(),
          }
          documents.set(path, record)
          movedAway.delete(path)
          open(path, record)
          continue
        }
        if (!record.opened || record.blocked || !canEdit || file.readOnly)
          continue
        if (record.sourceLimitFailure && !sourceFits(path, file.content)) {
          fail(record.sourceLimitFailure)
          continue
        }
        try {
          if (record.sourceLimitFailure) {
            captureLocal(path, record, file.content, false)
            sendDelta(path, record)
          } else captureLocal(path, record, file.content)
        } catch (error) {
          if (diffLimitFallback(path, record, error)) continue
          record.blocked = true
          record.failedLocalContent = file.content
          fail(
            error instanceof Error
              ? error.message
              : 'This edit could not be merged live. Your draft remains in this tab.',
          )
          return
        }
      }
      notify()
    }
    const schedule = () => {
      if (applying || !current()) return
      clearTimeout(sendTimer)
      sendTimer = setTimeout(publishLocal, 60)
    }
    const unsubscribe = store.subscribe(schedule)

    // The file's bytes did not change, so buffers (including unacknowledged
    // typing) move to the destination and publish there as a new live document.
    // Calling this twice for the same move, as the mover does when its HTTP
    // receipt follows the broadcast, finds nothing left to move.
    function applyMove({ from, to }: PathMove) {
      // Validate destination drafts before releasing any live document state.
      try {
        store.move(from, to)
      } catch (error) {
        for (const [path, record] of documents)
          if (
            remapMovedPath(path, from, to) !== null ||
            remapMovedPath(path, to, from) !== null
          )
            record.blocked = true
        fail(
          error instanceof Error
            ? error.message
            : 'The moved file conflicts with a local draft. Your drafts are preserved; download or discard them, then reopen the moved file.',
        )
        return
      }
      for (const [path, record] of [...documents]) {
        if (remapMovedPath(path, from, to) === null) continue
        send({ type: 'close', path })
        destroyRecord(record)
        documents.delete(path)
        movedAway.add(path)
        if (!hasDocumentFailure()) {
          failure = null
          clearIssue()
        }
      }
      for (const path of [...fallbackPaths])
        if (remapMovedPath(path, from, to) !== null) fallbackPaths.delete(path)
      for (const [path, history] of [...fallbackHistories])
        if (remapMovedPath(path, from, to) !== null) {
          history.dispose()
          fallbackHistories.delete(path)
          managedHistory.delete(path)
        }
      for (const path of [...managedHistory])
        if (remapMovedPath(path, from, to) !== null) managedHistory.delete(path)
      callbacks.current.onFilesMoved?.({ from, to })
      schedule()
    }

    function receive(raw: string) {
      if (!current()) return
      const message: unknown = JSON.parse(raw)
      if (!message || typeof message !== 'object' || !('type' in message))
        return
      if (message.type === 'ready') {
        ready = true
        retry = 0
        setConnected(true)
        // Membership can change between a socket closing and reconnecting.
        // Refresh on admission as well as live access events so a promotion
        // in that interval cannot leave this tab with stale controls.
        void Promise.resolve(callbacks.current.onAccessChanged?.()).catch(
          () => {},
        )
        if (!store.dirty().length) {
          failure = null
          clearIssue()
        } else if (fallbackPaths.size && !failure) clearIssue()
        for (const [path, record] of documents) {
          open(path, record)
        }
        publishLocal()
        notify()
        return
      }
      if (message.type === 'files') {
        if ('moves' in message)
          for (const move of pathMoves(message.moves)) applyMove(move)
        filesChanged()
        return
      }
      if (message.type === 'access' || message.type === 'project') {
        if (message.type === 'project') filesChanged()
        void Promise.resolve(callbacks.current.onAccessChanged?.()).catch(
          () => {},
        )
        return
      }
      if (message.type === 'error') {
        const path =
          'path' in message && typeof message.path === 'string'
            ? message.path
            : undefined
        const record = path ? documents.get(path) : undefined
        if (path && !record && movedAway.has(path)) return
        const status =
          'status' in message && typeof message.status === 'number'
            ? message.status
            : 400
        const transient = status === 429 || status >= 500
        const failedRequest =
          'requestId' in message && typeof message.requestId === 'number'
            ? message.requestId
            : undefined
        if (
          status === 413 &&
          record &&
          failedRequest !== undefined &&
          record.pending.has(failedRequest)
        ) {
          record.pending.delete(failedRequest)
          record.sourceLimitFailure =
            'message' in message && typeof message.message === 'string'
              ? message.message
              : 'This shared edit exceeds the source file limit. Reduce the file before saving.'
          fail(record.sourceLimitFailure)
          // Later deltas on this connection can depend on the rejected text.
          // Reconnect before replaying a corrected source with all causal IDs.
          socket?.close(1013, 'Reduce the file before live saving resumes.')
          return
        }
        if (
          status === 429 &&
          path &&
          record &&
          record.id === null &&
          !record.pending.size
        ) {
          fallbackPaths.add(path)
          send({ type: 'close', path })
          destroyRecord(record)
          documents.delete(path)
          setIssue(
            `Some files use normal saving for this visit because live editing capacity is full. ${LIVE_EDITING_RECOVERY}`,
          )
          notify()
          schedule()
          return
        }
        if (record && !transient) record.blocked = true
        fail(
          'message' in message && typeof message.message === 'string'
            ? message.message
            : 'A shared edit could not be saved. Your draft remains in this tab. Copy it, then reload the saved file before retrying.',
        )
        if (transient) socket?.close(1013, 'Live editing is busy.')
        if (status === 403 || (status === 404 && !path))
          void Promise.resolve(callbacks.current.onAccessChanged?.()).catch(
            () => {},
          )
        return
      }
      if (!documentMessage(message)) return
      const record = documents.get(message.path)
      const file = store.getSnapshot().buffers.get(message.path)
      if (!record || !file) return
      if (
        record.generation !== file.generation ||
        record.bufferHash !== file.hash ||
        discardVersion !== store.getSnapshot().discardVersion
      ) {
        publishLocal()
        return
      }
      // An old subscription can still have packets in flight after a reload.
      // Only the full reply to this record's own open initializes its baseline.
      if (
        message.openRequestId !== undefined &&
        message.openRequestId !== record.openRequestId
      )
        return
      if (
        !record.opened &&
        (message.openRequestId !== record.openRequestId ||
          message.content === undefined)
      )
        return
      const dirty = file.content !== file.savedContent
      const sameIdentity = record.id === message.documentId
      if (!sameIdentity) {
        record.undo.destroy()
        record.doc.destroy()
        const local = localDocument()
        record.doc = local.doc
        record.undo = local.undo
        record.canonical.destroy()
        record.canonical = new Y.Doc()
        record.pending.clear()
      }
      const incoming = decode(message.update)
      Y.applyUpdate(record.canonical, incoming)
      const savedContent = record.canonical.getText('source').toString()
      if (message.content !== undefined && message.content !== savedContent)
        throw new Error('Invalid canonical document state.')
      // Reconnecting after an evicted document cannot safely replay operations
      // against new identities. Keep the draft and require an explicit reload if
      // both the durable baseline and the local source changed while offline.
      if (
        !sameIdentity &&
        dirty &&
        file.savedContent !== savedContent &&
        file.content !== savedContent
      ) {
        record.id = message.documentId
        record.opened = true
        record.blocked = true
        fail(
          `${message.path} changed while disconnected. Your draft is kept in this tab. Copy your edits, then reload the saved file before continuing.`,
        )
        return
      }
      if (!sameIdentity && dirty && (!canEdit || file.readOnly)) {
        record.id = message.documentId
        record.opened = true
        record.blocked = true
        fail(
          `${message.path} has unsaved edits from before access changed. Your draft is kept in this tab; download it before reloading.`,
        )
        return
      }
      const reconnecting = !record.opened
      if (reconnecting && record.sourceLimitFailure) {
        // The full reopen follows every write queued by the closed connection.
        // Its old ACKs cannot arrive here. Local operations remain in the doc
        // for replay, or for a version-checked fallback if exact diffing fails.
        record.pending.clear()
      }
      let capturedLocal = false
      // Typing can reach the buffer during the send debounce. Capture it before
      // applying a remote update, or the remote baseline could erase that draft.
      if (
        sameIdentity &&
        !record.blocked &&
        canEdit &&
        !file.readOnly &&
        record.doc.getText('source').toString() !== file.content
      ) {
        try {
          capturedLocal = !!captureLocal(
            message.path,
            record,
            file.content,
            !reconnecting && !record.sourceLimitFailure,
          )
        } catch (error) {
          if (diffLimitFallback(message.path, record, error)) return
          record.blocked = true
          record.failedLocalContent = file.content
          fail(
            error instanceof Error
              ? error.message
              : 'This edit could not be merged live. Your draft remains in this tab.',
          )
          return
        }
      }
      Y.applyUpdate(record.doc, incoming)
      record.id = message.documentId
      managedHistory.add(message.path)
      record.opened = true
      if (message.ack !== undefined) record.pending.delete(message.ack)
      if (
        !sameIdentity &&
        dirty &&
        file.savedContent === savedContent &&
        canEdit &&
        !file.readOnly
      ) {
        try {
          captureLocal(message.path, record, file.content)
        } catch (error) {
          if (diffLimitFallback(message.path, record, error)) return
          record.blocked = true
          record.failedLocalContent = file.content
          fail(
            error instanceof Error
              ? error.message
              : 'This edit could not be merged live. Your draft remains in this tab.',
          )
          return
        }
      } else if (
        sameIdentity &&
        reconnecting &&
        canEdit &&
        (!record.sourceLimitFailure ||
          sourceFits(message.path, record.doc.getText('source').toString())) &&
        (record.pending.size || capturedLocal || record.sourceLimitFailure)
      ) {
        // Full updates are idempotent; replay edits whose durable ACK was lost.
        record.pending.clear()
        sendDelta(message.path, record)
      }
      if (record.blocked) {
        if (!dirty || file.content === savedContent) record.blocked = false
        else return
      }
      applying = true
      try {
        record.bufferHash = message.hash
        store.collaborated(
          message.path,
          record.doc.getText('source').toString(),
          savedContent,
          message.hash,
        )
      } finally {
        applying = false
      }
      if (!hasDocumentFailure()) {
        failure = null
        clearIssue()
      }
      notify()
      schedule()
    }

    function connect() {
      if (!current()) return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(
        sessionBoundUrl(
          `${protocol}//${location.host}/websocket/collaboration/${encodeURIComponent(scope.projectId!)}`,
        ),
      )
      const connection = socket
      socket.addEventListener('message', (event: MessageEvent<unknown>) => {
        try {
          if (connection.readyState !== WebSocket.OPEN) return
          if (typeof event.data === 'string') receive(event.data)
        } catch {
          fail(
            'A live update could not be read. Your edits remain in this tab.',
          )
          socket?.close()
        }
      })
      socket.addEventListener('close', (event) => {
        ready = false
        if (!current()) return
        setConnected(false)
        notify()
        if (event.code === 1008) {
          fail(
            'Project access changed. Your unsaved edits are kept in this tab.',
          )
          void Promise.resolve(callbacks.current.onAccessChanged?.())
            .then(() => {
              if (current()) reconnectTimer = setTimeout(connect, 500)
            })
            .catch(() => {})
          return
        }
        setIssue(
          'Live connection interrupted. Your edits are kept in this tab; reconnecting…',
        )
        reconnectTimer = setTimeout(
          connect,
          Math.min(15_000, 500 * 2 ** Math.min(retry++, 5)),
        )
      })
      socket.addEventListener('error', () => socket?.close())
    }

    const history = (path: string, action: 'undo' | 'redo') => {
      const record = documents.get(path)
      const file = store.getSnapshot().buffers.get(path)
      if (!current() || !file) return false
      const local = fallbackHistories.get(path)
      if (local) {
        if (!canEdit || file.readOnly) return true
        local.synchronize(file, store.getSnapshot().discardVersion)
        const content = local.change(action)
        if (content !== undefined) {
          applying = true
          try {
            store.change(path, content)
          } finally {
            applying = false
          }
          notify()
        }
        return true
      }
      if (!record?.id) {
        if (managedHistory.has(path) && fallbackPaths.has(path))
          setIssue(
            `${path} no longer retains its earlier undo history. Your draft is preserved; download it or reload the saved file before continuing.`,
          )
        return (
          managedHistory.has(path) ||
          (liveFile(path) && file.preview !== 'pdf' && !fallbackPaths.has(path))
        )
      }
      if (!canEdit || file.readOnly) return true
      publishLocal()
      if (documents.get(path) !== record || record.blocked) return true
      try {
        captureLocal(
          path,
          record,
          store.getSnapshot().buffers.get(path)?.content ?? file.content,
        )
      } catch (error) {
        record.blocked = true
        record.failedLocalContent = file.content
        fail(
          error instanceof Error
            ? error.message
            : 'This edit could not be merged live. Your draft remains in this tab.',
        )
        return true
      }
      const vector = Y.encodeStateVector(record.doc)
      record.undo.stopCapturing()
      const changed =
        action === 'undo' ? record.undo.undo() : record.undo.redo()
      if (changed) {
        applying = true
        try {
          store.collaborated(
            path,
            record.doc.getText('source').toString(),
            record.canonical.getText('source').toString(),
            file.hash,
          )
        } finally {
          applying = false
        }
        sendDelta(path, record, vector)
        notify()
      }
      return true
    }
    const controller: CollaborationControl = {
      undo: (path) => history(path, 'undo'),
      redo: (path) => history(path, 'redo'),
      flush: async () => {
        if (!current()) return false
        if (!ready) {
          // Initialized live documents must keep using their CRDT identity.
          // A REST save followed by reconnect would import the same local text
          // twice. Keep these drafts local until the live connection returns.
          if (
            [...documents.values()].some((record) => record.pending.size) ||
            store
              .dirty()
              .some(
                (file) =>
                  documents.get(file.path)?.id ||
                  (managedHistory.has(file.path) &&
                    !fallbackPaths.has(file.path)),
              )
          )
            throw new Error(
              'Wait for the live connection to return before saving. Your edits remain in this tab.',
            )
          publishLocal()
          restHandoff()
          return false
        }
        publishLocal()
        if (failure) throw new Error(failure)
        if (
          !managedDirty() &&
          ![...documents.values()].some((record) => record.pending.size)
        ) {
          return restHandoff()
        }
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            waiters.delete(check)
            reject(
              new Error(
                'Live saving is taking too long. Your edits remain in this tab; reconnect before retrying.',
              ),
            )
          }, 15_000)
          const check = () => {
            if (!current() || !ready || failure) {
              clearTimeout(timeout)
              waiters.delete(check)
              reject(
                new Error(
                  failure ||
                    'The live connection was interrupted. Your edits remain in this tab.',
                ),
              )
            } else if (
              !managedDirty() &&
              ![...documents.values()].some((record) => record.pending.size)
            ) {
              clearTimeout(timeout)
              waiters.delete(check)
              resolve()
            }
          }
          waiters.add(check)
          check()
        })
        return restHandoff()
      },
    }
    control.current = controller
    setConnected(false)
    clearIssue()
    connect()
    return () => {
      disposed = true
      ready = false
      clearTimeout(sendTimer)
      clearTimeout(reconnectTimer)
      clearTimeout(listingTimer)
      unsubscribe()
      if (control.current === controller) control.current = null
      socket?.close()
      notify()
      for (const record of documents.values()) {
        destroyRecord(record)
      }
      for (const history of fallbackHistories.values()) history.dispose()
    }
  }, [store, scope, enabled, canEdit])

  return {
    connected: enabled && connected,
    issue: enabled ? issue : null,
    flush,
    undo,
    redo,
  }
}
