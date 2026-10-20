#!/usr/bin/env node
// Real compiler/LSP/native-start checks, with no model turn or provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { Runtime } from '../server/runtime.mjs'
import { createStudio } from '../server/studio.mjs'
import { AgentRpc } from '../server/rpc.mjs'
import { providerRequestConfig } from '../server/provider-requests.mjs'

const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || '.data')
const fixture = path.join(dataDir, 'runtime/repaired-editor', randomUUID())
const output = path.resolve('.runtime/repaired-editor')
const runtime = new Runtime({
  dataDir,
  image:
    process.env.LEAN_PROBE_TEST_IMAGE || 'lemex-web-worker:lean-probe-646cb0ee',
  scope: 'helper',
  memory: process.env.STUDIO_WORKER_MEMORY || '6g',
})
const source = 'theorem preserved (n : Nat) : n + 0 = n := by rfl\n'
const roots = new Set()
const report = { providerCalls: 0, modelTurns: 0, checks: [] }
let studio, socket, rpc
const until = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
const lakefile = (label) => `import Lake
open Lake DSL
#eval show IO Unit from do
  let denied ← try
    IO.FS.writeFile "Main.lean" "axiom injected : False\\n"
    pure false
  catch _ => pure true
  unless denied do throw <| IO.userError "Source write was allowed"
  IO.FS.writeFile ".lake/source-write-denied" "${label}"
package RepairedBoundary
@[default_target] lean_lib Main
`
try {
  studio = await createStudio({
    dataDir: fixture,
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
  const project = await studio.workspaces.create('owner', {
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: 'leanprover/lean4:v4.34.1\n' },
      {
        path: 'lakefile.toml',
        content:
          'name = "RepairedBoundary"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n',
      },
      { path: 'Main.lean', content: source },
    ],
  })
  await studio.workspaces.jobs.get(project.id)
  const saved = studio.workspaces.get(project.id, 'owner')
  assert.equal(saved.status, 'ready', saved.error)
  roots.add(saved.root)
  saved.repairedConfiguration = true
  studio.workspaces.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(saved), project.id)
  await fs.rm(path.join(saved.root, 'lakefile.toml'))
  await fs.writeFile(path.join(saved.root, 'lakefile.lean'), lakefile('check'))
  const token = (
    await fs.readFile(path.join(fixture, 'auth/owner.token'), 'utf8')
  ).trim()
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const response = await fetch(`${base}/api/projects/${project.id}/check`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: 'Main.lean' }),
  })
  assert.equal(response.status, 202)
  const check = await response.json()
  await until(
    () => ['completed', 'failed'].includes(studio.events.get(check.id).status),
    'real Check Lean',
    60000,
  )
  const checked = studio.events.get(check.id)
  assert.equal(checked.status, 'completed', checked.error || checked.log)
  assert.equal(
    await fs.readFile(path.join(saved.root, 'Main.lean'), 'utf8'),
    source,
  )
  assert.equal(
    await fs.readFile(
      path.join(saved.root, '.lake/source-write-denied'),
      'utf8',
    ),
    'check',
  )
  report.checks.push(
    'Check Lean builds and validates the selected file while executable Lake configuration cannot write source.',
  )

  await fs.writeFile(path.join(saved.root, 'lakefile.lean'), lakefile('lsp'))
  socket = new WebSocket(
    base.replace('http:', 'ws:') + `/websocket/${project.id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const initialized = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('LSP initialize timed out')),
      30000,
    )
    socket.on('message', (raw) => {
      const value = JSON.parse(String(raw))
      if (value.id === 1) {
        clearTimeout(timer)
        if (value.error) reject(new Error(JSON.stringify(value.error)))
        else resolve(value.result)
      }
    })
    socket.once('close', () => {
      clearTimeout(timer)
      reject(new Error('LSP closed before initialize'))
    })
  })
  socket.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: null,
        rootUri: 'file:///workspace',
        capabilities: {},
        workspaceFolders: [{ uri: 'file:///workspace', name: 'fixture' }],
      },
    }),
  )
  assert((await initialized).capabilities)
  assert.equal(
    await fs.readFile(
      path.join(saved.root, '.lake/source-write-denied'),
      'utf8',
    ),
    'lsp',
  )
  assert.equal(
    await fs.readFile(path.join(saved.root, 'Main.lean'), 'utf8'),
    source,
  )
  socket.close()
  report.checks.push(
    'The real editor LSP initializes with writable Lake cache while a reevaluated Lake configuration cannot write source.',
  )

  await fs.mkdir(path.join(saved.root, '.git/hooks'), { recursive: true })
  await fs.writeFile(
    path.join(saved.root, '.git/hooks/pre-commit'),
    '#!/bin/sh\necho PRIVATE_HOOK\n',
  )
  const snapshot = await studio.workspaces.snapshot(
    project.id,
    'owner',
    randomUUID(),
  )
  roots.add(snapshot.root)
  await assert.rejects(fs.lstat(path.join(snapshot.root, '.git')), {
    code: 'ENOENT',
  })
  const home = await runtime.home(snapshot.root)
  await fs.writeFile(
    path.join(home, '.lemex/config.toml'),
    [
      ...providerRequestConfig({ LEMEX_API_KEY: 'offline-fixture' }),
      'model_provider = "fixture"',
      'model = "offline-fixture"',
      '[model_providers.fixture]',
      'name = "Offline fixture"',
      'base_url = "http://127.0.0.1:9/v1"',
      'wire_api = "responses"',
      '',
    ].join('\n'),
  )
  const child = runtime.spawn(
    snapshot.root,
    ['lemex', 'app-server', '--stdio', '--strict-config'],
    { network: 'none', timeoutMs: 30000 },
  )
  rpc = new AgentRpc(child)
  await rpc.call(
    'initialize',
    { clientInfo: { name: 'gitless_fixture', version: '0.1.0' } },
    20000,
  )
  rpc.notify('initialized')
  const resolved = await rpc.call('config/read', { includeLayers: false })
  const features = await rpc.call('experimentalFeature/list', { limit: 200 })
  const disabled = [
    'multi_agent',
    'multi_agent_v2',
    'concurrent_reasoning_summaries',
  ]
  report.nativeFeatures = {}
  for (const name of disabled) {
    assert.equal(resolved.config.features[name], false)
    const feature = features.data.find((entry) => entry.name === name)
    assert(feature, `The native binary does not recognize ${name}`)
    assert.equal(
      feature.enabled,
      false,
      `${name} is enabled in the native runtime`,
    )
    report.nativeFeatures[name] = feature.enabled
  }
  report.checks.push(
    'Strict native config accepts the production RCP flags; native feature introspection confirms subagents and concurrent reasoning summaries are disabled.',
  )
  const started = await rpc.call(
    'thread/start',
    {
      model: 'offline-fixture',
      cwd: '/workspace',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: true,
    },
    20000,
  )
  assert(started.thread?.id)
  rpc.close()
  report.checks.push(
    'The real native Lemex app-server opens a thread in a proof snapshot without .git; no model turn is sent.',
  )
  report.imageId = runtime.imageId
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = error.stack || error.message
  process.exitCode = 1
} finally {
  socket?.terminate()
  rpc?.close()
  if (studio) await studio.close()
  else await runtime.shutdown()
  for (const root of roots)
    await fs.rm(
      path.join(
        dataDir,
        'runtime/homes',
        createHash('sha256').update(root).digest('hex'),
      ),
      { recursive: true, force: true },
    )
  await fs.rm(fixture, { recursive: true, force: true })
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report, null, 2))
}
