import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { WebSocket } from 'ws'
import { createStudio } from '../studio.mjs'
import { LspFrames, frame } from '../rpc.mjs'

test('authenticated editor blocks executable widgets while goals, hover and diagnostics still relay', async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-widget-policy-'),
  )
  const source =
    'globalThis.untrustedWidgetExecuted = true; export default () => null'
  const child = new EventEmitter()
  for (const stream of ['stdin', 'stdout', 'stderr'])
    child[stream] = new PassThrough()
  let killed = false,
    spawned = 0
  child.kill = () => {
    if (killed) return
    killed = true
    queueMicrotask(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 0)
    })
  }
  const workerRequests = []
  const frames = new LspFrames((message) => {
    workerRequests.push(message)
    if (!message.method || !('id' in message)) return
    child.stdout.write(
      frame({
        jsonrpc: '2.0',
        id: message.id,
        result:
          message.params?.method === 'Lean.Widget.getWidgetSource'
            ? { sourcetext: source }
            : message.method === 'textDocument/hover'
              ? { contents: 'Nat' }
              : { goals: [{ hyps: [], type: 'True' }] },
      }),
    )
  })
  child.stdin.on('data', (chunk) => frames.push(chunk))
  const studio = await createStudio({
    dataDir,
    runtime: {
      async init() {},
      async shutdown() {
        child.kill()
      },
      info: () => ({ ready: true }),
      templates: () => [],
      spawn: (_root, args) => {
        assert.deepEqual(args, ['lake', 'serve', '--'])
        spawned++
        return child
      },
    },
    config: {
      defaultModel: 'fixture',
      models: [],
      provider: {},
      lemex: {},
      redact: String,
    },
  })
  let socket
  t.after(async () => {
    socket?.terminate()
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const project = {
    id: 'widget-policy-project',
    owner: 'owner',
    name: 'Widget boundary fixture',
    status: 'ready',
    root: path.join(dataDir, 'projects/widget-policy-project'),
  }
  await fs.mkdir(project.root, { recursive: true })
  await fs.writeFile(
    path.join(project.root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  studio.workspaces.db
    .prepare('INSERT INTO projects(id,owner,data) VALUES(?,?,?)')
    .run(project.id, project.owner, JSON.stringify(project))
  studio.server.listen(0, '127.0.0.1')
  await once(studio.server, 'listening')
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ token }),
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  for (const [expected, endpoint, headers] of [
    [401, project.id, { Origin: base }],
    [403, project.id, { Cookie: cookie, Origin: 'https://attacker.invalid' }],
    [404, 'missing-widget-project', { Cookie: cookie, Origin: base }],
  ]) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        base + '/websocket/' + endpoint,
        {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'MTIzNDU2Nzg5MDEyMzQ1Ng==',
            ...headers,
          },
          timeout: 2000,
        },
        (response) => {
          let bytes = 0
          response.on('data', (chunk) => (bytes += chunk.length))
          response.once('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              bytes,
            }),
          )
        },
      )
      request.on('upgrade', (_response, socket) => {
        socket.destroy()
        reject(new Error('A refused editor connection was upgraded'))
      })
      request.once('error', reject)
      request.once('timeout', () =>
        request.destroy(new Error('Upgrade refusal timed out')),
      )
      request.end()
    })
    assert.equal(response.status, expected)
    assert.equal(response.headers['content-length'], '0')
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.bytes, 0)
  }
  assert.equal(spawned, 0, 'Refused upgrades cannot start a worker')
  const messages = []
  socket = new WebSocket(
    base.replace('http:', 'ws:') + '/websocket/' + project.id,
    {
      headers: {
        Cookie: cookie,
        Origin: base,
      },
    },
  )
  socket.on('message', (data) => messages.push(JSON.parse(data)))
  await once(socket, 'open')
  const wait = async (predicate) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const found = messages.find(predicate)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.fail('Expected editor response was not received')
  }
  const rpc = (id, method) => ({
    jsonrpc: '2.0',
    id,
    method: '$/lean/rpc/call',
    params: {
      textDocument: { uri: 'file:///workspace/Main.lean' },
      position: { line: 0, character: 0 },
      sessionId: '1',
      method,
      params: {},
    },
  })
  socket.send(JSON.stringify(rpc(1, 'Lean.Widget.getWidgetSource')))
  assert.equal((await wait((m) => m.id === 1)).error.code, -32803)
  socket.send(JSON.stringify(rpc(2, 'Lean.Widget.getWidgets')))
  assert.deepEqual((await wait((m) => m.id === 2)).result, { widgets: [] })
  assert.deepEqual(workerRequests, [])
  socket.send(JSON.stringify(rpc(3, 'Lean.Widget.getInteractiveGoals')))
  assert.deepEqual((await wait((m) => m.id === 3)).result, {
    goals: [{ hyps: [], type: 'True' }],
  })
  child.stdout.write(frame({ id: 1, result: { sourcetext: source } }))
  child.stdout.write(
    frame({ id: 'forged-source', result: { sourcetext: source } }),
  )
  child.stdout.write(
    frame({
      method: 'Lean.Widget.getWidgetSource',
      params: { sourcetext: source },
    }),
  )
  assert.equal((await wait((m) => m.id === 'forged-source')).error.code, -32803)
  child.stdout.write(
    frame({
      method: 'textDocument/publishDiagnostics',
      params: { uri: 'file:///workspace/Main.lean', diagnostics: [] },
    }),
  )
  await wait((m) => m.method === 'textDocument/publishDiagnostics')
  socket.send(
    JSON.stringify({
      id: 4,
      method: 'textDocument/hover',
      params: {
        textDocument: { uri: 'file:///workspace/Main.lean' },
        position: { line: 0, character: 8 },
      },
    }),
  )
  assert.deepEqual((await wait((m) => m.id === 4)).result, { contents: 'Nat' })
  assert(!JSON.stringify(messages).includes(source))
  assert(!JSON.stringify(workerRequests).includes('getWidgetSource'))
  assert(!JSON.stringify(workerRequests).includes('getWidgets'))
  assert.equal(workerRequests.length, 2)
})
