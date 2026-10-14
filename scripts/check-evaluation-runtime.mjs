#!/usr/bin/env node
// Real Lean checks and editor messages in a private fixture; zero provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { Runtime } from '../server/runtime.mjs'
import { createStudio } from '../server/studio.mjs'
import { until } from './lib/chat-browser-fixture.mjs'

const directory = path.resolve('.runtime/evaluation-runtime', randomUUID())
const dataDir = path.join(directory, 'data')
await fs.mkdir(directory, { recursive: true })
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  cpus: 1,
  memory: '2g',
  maxConcurrent: 2,
  image:
    process.env.LEAN_PROBE_TEST_IMAGE || 'lemex-web-worker:lean-probe-646cb0ee',
})
const source =
  'import Lean\n#eval show IO Unit from do\n  IO.println "evaluation-fixture-visible"\n'
const blocked =
  'import Lean\npartial def waitForever : IO Unit := do\n  IO.sleep 20\n  waitForever\n#eval waitForever\nexample : True := by trivial\n'
const report = { providerCalls: 0, directory, checks: [], passed: false }
let studio, socket
try {
  studio = await createStudio({
    dataDir,
    runtime,
    config: {
      defaultModel: 'offline-fixture',
      models: [],
      provider: {},
      redact: String,
      lemex: {},
    },
  })
  assert.equal(runtime.ready, true, runtime.error)
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const api = async (endpoint, body) => {
    const response = await fetch(base + endpoint, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value = await response.json()
    assert(response.ok, `${response.status} ${value.error}`)
    return value
  }
  const project = await studio.workspaces.create('owner', {
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: 'leanprover/lean4:v4.34.1\n' },
      {
        path: 'lakefile.toml',
        content:
          'name = "evaluation_fixture"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n',
      },
      { path: 'Main.lean', content: source },
    ],
  })
  await studio.workspaces.jobs.get(project.id)
  const saved = studio.workspaces.get(project.id, 'owner')
  assert.equal(saved.status, 'ready', saved.error)
  socket = new WebSocket(
    base.replace('http:', 'ws:') + `/websocket/${project.id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const messages = []
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw))
    messages.push(message)
    if (message.method && 'id' in message)
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }),
      )
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const send = (message) =>
    socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
  send({
    id: 1,
    method: 'initialize',
    params: {
      processId: null,
      rootUri: 'file:///workspace',
      capabilities: {},
      workspaceFolders: [{ uri: 'file:///workspace', name: 'fixture' }],
    },
  })
  await until(
    () => messages.some((message) => message.id === 1 && !message.method),
    'real Lean initialize',
    30000,
  )
  send({ method: 'initialized', params: {} })
  const document = {
    uri: 'file:///workspace/Main.lean',
    languageId: 'lean4',
    version: 1,
    text: source,
  }
  send({ method: 'textDocument/didOpen', params: { textDocument: document } })
  await until(
    () =>
      messages.some(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          message.params.diagnostics.some((diagnostic) =>
            diagnostic.message.includes('evaluation-fixture-visible'),
          ),
      ),
    'visible finite monadic evaluation result',
    30000,
  )
  report.checks.push(
    'Finite IO #eval prints its result through the actual editor diagnostics connection.',
  )
  await studio.workspaces.writeFile(
    project.id,
    'owner',
    'Main.lean',
    blocked,
    (await studio.workspaces.readFile(project.id, 'owner', 'Main.lean')).hash,
  )
  const check = await api(`/api/projects/${project.id}/check`, {
    path: 'Main.lean',
  })
  await until(
    () => studio.events.get(check.id).status === 'running',
    'real blocked build started',
  )
  await until(() => runtime.children.size === 2, 'build worker started')
  const stopped = await api(`/api/jobs/${check.id}/stop`, {})
  assert.equal(stopped.status, 'cancelled')
  await until(
    () => runtime.children.size === 1,
    'cancelled build worker removed',
  )
  report.checks.push(
    'Stop check cancels an actual worker evaluating an endless IO loop and releases its slot.',
  )
  send({
    method: 'textDocument/didChange',
    params: {
      textDocument: { uri: document.uri, version: 2 },
      contentChanges: [{ text: blocked }],
    },
  })
  send({
    id: 2,
    method: '$/lean/plainGoal',
    params: {
      textDocument: { uri: document.uri },
      position: { line: 5, character: 25 },
    },
  })
  await until(
    () =>
      messages.some(
        (message) =>
          message.method === '$/leanflow/processing' && message.params.message,
      ),
    'stationary processing notice',
    75000,
  )
  assert(
    !messages.some(
      (message) => message.id === 2 && message.error?.code === -32001,
    ),
  )
  send({
    method: 'textDocument/didClose',
    params: { textDocument: { uri: document.uri } },
  })
  const recovered = source.replace(
    'evaluation-fixture-visible',
    'evaluation-fixture-recovered',
  )
  send({
    method: 'textDocument/didOpen',
    params: { textDocument: { ...document, version: 3, text: recovered } },
  })
  await until(
    () =>
      messages.some(
        (message) =>
          message.method === 'textDocument/publishDiagnostics' &&
          message.params.diagnostics.some((diagnostic) =>
            diagnostic.message.includes('evaluation-fixture-recovered'),
          ),
      ),
    'editor recovery after removing the blocking evaluation',
    30000,
  )
  report.checks.push(
    'Stationary processing shows a neutral notice without cancelling requests; restarting its document with corrected unsaved text restores diagnostics.',
  )
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
} finally {
  socket?.terminate()
  await studio?.close()
  await fs.writeFile(
    path.join(directory, 'result.json'),
    JSON.stringify(report, null, 2),
  )
}
console.log(JSON.stringify(report, null, 2))
