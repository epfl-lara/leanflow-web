#!/usr/bin/env node
// Check real Lean definition paths in a disposable worker project, with no provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../server/runtime.mjs'
import { LspFrames } from '../server/rpc.mjs'
import { toolchainSourceModule } from '../server/library-sources.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.runtime/source-navigation-lean')
await fs.mkdir(output, { recursive: true })
const dataDir = await fs.mkdtemp(path.join(output, 'fixture-'))
const presets = JSON.parse(
  await fs.readFile(path.join(root, 'server/presets.json'), 'utf8'),
)
const toolchain = presets.find((preset) => preset.id === 'lean').toolchain
const runtime = new Runtime({ dataDir, scope: 'helper', cpus: 1, memory: '2g' })
const pending = new Map()
let child,
  nextId = 0,
  stderr = ''
const report = { toolchain, providerCalls: 0, definitions: [] }
try {
  const info = await runtime.init()
  assert.equal(info.ready, true, info.error)
  await runtime.prepareToolchain(toolchain)
  const workspace = path.join(dataDir, 'project')
  await fs.mkdir(workspace)
  await fs.writeFile(path.join(workspace, 'lean-toolchain'), toolchain + '\n')
  await fs.writeFile(
    path.join(workspace, 'lakefile.toml'),
    'name = "source_fixture"\n',
  )
  const content = 'import Lean\n#check Nat.pos_of_neZero\n#check Lean.Level\n'
  await fs.writeFile(path.join(workspace, 'Main.lean'), content)
  const setup = await runtime.run(workspace, ['lake', 'update'], {
    network: 'none',
  })
  assert.equal(setup.code, 0, setup.stderr)
  child = runtime.spawn(workspace, ['lake', 'serve', '--'], {
    network: 'none',
    readOnlyWorkspace: true,
    writeLakeCache: true,
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8000)
  })
  const send = (message) => {
    const value = JSON.stringify({ jsonrpc: '2.0', ...message })
    child.stdin.write(
      `Content-Length: ${Buffer.byteLength(value)}\r\n\r\n${value}`,
    )
  }
  const frames = new LspFrames((message) => {
    if (message.method) {
      if ('id' in message) send({ id: message.id, result: null })
      return
    }
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timer)
    if (message.error) item.reject(new Error(JSON.stringify(message.error)))
    else item.resolve(message.result)
  })
  child.stdout.on('data', (chunk) => frames.push(chunk))
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Lean timed out on ${method}: ${stderr}`))
      }, 30000)
      pending.set(id, { resolve, reject, timer })
      send({ id, method, params })
    })
  await request('initialize', {
    processId: null,
    rootUri: 'file:///workspace',
    capabilities: { textDocument: { definition: { linkSupport: true } } },
  })
  send({ method: 'initialized', params: {} })
  send({
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri: 'file:///workspace/Main.lean',
        languageId: 'lean4',
        version: 1,
        text: content,
      },
    },
  })
  for (const [line, name] of [
    [1, 'Nat.pos_of_neZero'],
    [2, 'Lean.Level'],
  ]) {
    let definitions
    for (let attempt = 0; attempt < 8; attempt++) {
      definitions = await request('textDocument/definition', {
        textDocument: { uri: 'file:///workspace/Main.lean' },
        position: { line, character: 12 },
      })
      if (definitions?.length) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    assert(
      definitions?.length,
      `Lean must return a definition for ${name}: ${stderr}`,
    )
    const location = definitions[0]
    const uri = location.uri || location.targetUri
    const module = toolchainSourceModule(toolchain, uri)
    const range = location.range || location.targetSelectionRange
    const source = await fs.readFile(
      path.join(
        runtime.toolchainSourceRoot(toolchain),
        module.replaceAll('.', '/') + '.lean',
      ),
      'utf8',
    )
    report.definitions.push({
      name,
      uri,
      module,
      line: range.start.line + 1,
      text: source.split('\n')[range.start.line],
    })
  }
  report.ok = true
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const item of pending.values()) clearTimeout(item.timer)
  child?.kill('SIGTERM')
  await runtime.shutdown()
  await fs.rm(dataDir, { recursive: true, force: true })
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
