#!/usr/bin/env node
// Exercise configuration recovery with real workers in a private, offline project.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { Runtime } from '../server/runtime.mjs'
import { createStudio } from '../server/studio.mjs'
import { until } from './lib/chat-browser-fixture.mjs'

const directory = path.resolve('.runtime/terminal-configuration', randomUUID())
const dataDir = path.join(directory, 'data')
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  cpus: 1,
  memory: '1g',
  maxConcurrent: 2,
})
const report = { passed: false, providerCalls: 0, checks: [], directory }
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
  assert(runtime.ready, runtime.error)
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${studio.server.address().port}`
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const api = async (endpoint, body) => {
    const response = await fetch(base + endpoint, {
      headers,
      ...(body === undefined
        ? {}
        : { method: 'POST', body: JSON.stringify(body) }),
    })
    const value = await response.json()
    assert(response.ok, `${response.status}: ${value.error}`)
    return value
  }
  const source = 'example : True := by trivial\n'
  const project = await api('/api/projects', {
    name: 'Terminal configuration fixture',
    autoRepair: false,
    files: [
      { path: 'lean-toolchain', content: 'leanprover/lean4:v4.34.1\n' },
      {
        path: 'lakefile.toml',
        content:
          'name = "terminal_configuration"\ndefaultTargets = ["Main"]\n[[lean_lib]]\nname = "Main"\n',
      },
      { path: 'Main.lean', content: source },
    ],
  })
  await studio.workspaces.jobs.get(project.id)
  const prefix = `/api/projects/${project.id}`
  assert.equal((await api(prefix)).status, 'ready')
  let output = ''
  socket = new WebSocket(
    base.replace('http:', 'ws:') + `/websocket/terminal/${project.id}`,
    { headers },
  )
  socket.on('message', (chunk, binary) => {
    if (binary) {
      output += chunk.toString()
      if (socket.readyState === 1)
        socket.send(JSON.stringify({ type: 'ack', bytes: chunk.length }))
    }
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  await until(() => output.includes('/workspace'), 'terminal prompt')
  const send = (data) => socket.send(JSON.stringify({ type: 'input', data }))
  send('stty -echo\r')
  send(
    "printf '\\n# Terminal configuration edit\\n' >> lakefile.toml; printf 'CONFIGURATION_WRITTEN\\n'\r",
  )
  await until(
    () => output.includes('CONFIGURATION_WRITTEN'),
    'configuration write',
  )
  assert.equal((await api(prefix + '/terminal/stop', {})).stopped, true)
  const changed = await api(prefix)
  assert.equal(changed.status, 'error')
  assert.equal(changed.needsPreparation, true)
  assert.match(changed.error, /Retry setup/)
  assert.equal(runtime.children.size, 0)
  report.checks.push(
    'A real terminal configuration edit marks the environment for preparation after worker cleanup.',
  )
  await api(prefix + '/prepare', {})
  await studio.workspaces.jobs.get(project.id)
  const prepared = await api(prefix)
  assert.equal(prepared.status, 'ready', prepared.error)
  const file = await api(prefix + '/file?path=Main.lean')
  assert.equal(file.content, source)
  const check = await api(prefix + '/check', { file: 'Main.lean' })
  await until(
    async () =>
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        (await api(`/api/jobs/${check.id}`)).status,
      ),
    'Lean check',
  )
  const checked = await api(`/api/jobs/${check.id}`)
  assert.equal(checked.status, 'completed', checked.error)
  report.checks.push(
    'Retry setup succeeds with the pinned Lean version; saved proofs remain intact and pass a fresh Lean check.',
  )
  report.passed = true
} finally {
  socket?.terminate()
  if (studio) await studio.close()
  else await runtime.shutdown()
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report, null, 2))
