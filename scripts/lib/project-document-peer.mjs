// Real collaboration protocol for isolated shared-project tests and load fixtures.
import { WebSocket } from 'ws'
import * as Y from 'yjs'

export async function waitForDocument(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out: ${label}`)
}

export function encodeDocument(update) {
  return Buffer.from(update).toString('base64')
}

export async function connectProjectDocumentPeer(
  { origin, projectId, token, sockets, timeoutMs = 5000 },
  { id = projectId, name = 'Main.lean', open = true, doc = new Y.Doc() } = {},
) {
  const until = (check, label) => waitForDocument(check, label, timeoutMs)
  const documents = new Map([[name, { doc, id: null }]])
  const peer = { packets: [], doc, documents, requestId: 0, id: null }
  const url = new URL(
    '/websocket/collaboration/' + encodeURIComponent(id),
    origin,
  )
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: new URL(origin).origin,
    },
    handshakeTimeout: timeoutMs,
  })
  sockets.add(ws)
  peer.ws = ws
  ws.on('error', () => {})
  ws.on('message', (bytes) => {
    const packet = JSON.parse(bytes.toString())
    if (peer.ignorePackets) return
    peer.packets.push(packet)
    if (packet.type === 'document') {
      if (packet.path === name) peer.id = packet.documentId
      const state = documents.get(packet.path)
      if (state) {
        state.id = packet.documentId
        Y.applyUpdate(
          state.doc,
          new Uint8Array(Buffer.from(packet.update, 'base64')),
        )
      }
    }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => {
      res.resume()
      reject(
        Object.assign(new Error('Handshake denied'), {
          status: res.statusCode,
        }),
      )
    })
  })
  await until(
    () => peer.packets.some((item) => item.type === 'ready'),
    'collaboration ready',
  )
  peer.open = async (path) => {
    if (!documents.has(path))
      documents.set(path, { doc: new Y.Doc(), id: null })
    ws.send(JSON.stringify({ type: 'open', path }))
    await until(
      () =>
        peer.packets.some(
          (item) => item.type === 'document' && item.path === path,
        ),
      'document opened',
    )
  }
  if (open) await peer.open(name)
  peer.send = (body) => ws.send(JSON.stringify(body))
  peer.edit = (change, path = name) => {
    const { doc, id } = documents.get(path)
    const vector = Y.encodeStateVector(doc)
    change(doc.getText('source'))
    const requestId = ++peer.requestId
    peer.send({
      type: 'update',
      path,
      documentId: id,
      update: encodeDocument(Y.encodeStateAsUpdate(doc, vector)),
      requestId,
    })
    return requestId
  }
  peer.ack = (requestId) =>
    until(
      () =>
        peer.packets.find(
          (item) =>
            item.ack === requestId ||
            (item.requestId === requestId && item.type === 'error'),
        ),
      `ack ${requestId}`,
    )
  return peer
}
