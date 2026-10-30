import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { AgentRpc, LspFrames } from '../../server/rpc.mjs'
import { runPinnedLake } from '../../server/pinned-lake.mjs'
import { providerRequestConfig } from '../../server/provider-requests.mjs'

// Exercise the editor with read-only sources and a writable Lake cache.
// A successful initialize alone does not prove that imports or goals work.
export async function checkSetupEditor(
  runtime,
  root,
  file,
  { line, character },
) {
  const text = await fs.readFile(path.join(root, file), 'utf8')
  const child = runtime.spawn(root, ['lake', 'serve', '--'], {
    network: 'none',
    cleanHome: true,
    readOnlyWorkspace: true,
    writeLakeCache: true,
  })
  const closed = once(child, 'close')
  const pending = new Map()
  let nextId = 0
  let stderr = ''
  const send = (message) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message })
    child.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
  }
  const fail = (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000)
  })
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.on('close', () => fail(new Error(`Lean editor closed: ${stderr}`)))
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
  child.stdout.on('data', (chunk) => {
    try {
      frames.push(chunk)
    } catch (error) {
      fail(error)
    }
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Lean timed out on ${method}: ${stderr}`))
      }, 60000)
      pending.set(id, { resolve, reject, timer })
      send({ id, method, params })
    })
  try {
    const initialized = await request('initialize', {
      processId: null,
      rootUri: 'file:///workspace',
      capabilities: {},
      workspaceFolders: [{ uri: 'file:///workspace', name: 'setup-fixture' }],
    })
    assert(initialized.capabilities)
    send({ method: 'initialized', params: {} })
    const uri = `file:///workspace/${file}`
    send({
      method: 'textDocument/didOpen',
      params: {
        textDocument: { uri, languageId: 'lean4', version: 1, text },
      },
    })
    const params = { textDocument: { uri }, position: { line, character } }
    let goals
    for (let attempt = 0; attempt < 20; attempt++) {
      goals = await request('$/lean/plainGoal', params)
      if (goals?.goals?.length) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert(
      goals?.goals?.length,
      `No editor goal in ${file}: ${JSON.stringify(goals)} ${stderr}`,
    )
    const hover = await request('textDocument/hover', {
      ...params,
      position: { line, character: text.split('\n')[line].length - 1 },
    })
    assert(hover?.contents, `No editor hover in ${file}`)
    const session = await request('$/lean/rpc/connect', { uri })
    const interactive = await request('$/lean/rpc/call', {
      ...params,
      sessionId: session.sessionId,
      method: 'Lean.Widget.getInteractiveGoals',
      params,
    })
    assert(
      interactive?.goals?.length,
      `No interactive infoview goals in ${file}`,
    )
    await request('shutdown', null)
    send({ method: 'exit' })
    return { goals: goals.goals, hover: true, interactiveGoals: true }
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer)
    child.kill('SIGTERM')
    await closed
  }
}

// Start the real native helper in a snapshot without sending a model turn.
// Write only an offline fixture configuration; never load host credentials.
export async function checkSetupLemex(runtime, root) {
  const config = [
    ...providerRequestConfig({ LEMEX_API_KEY: 'offline-fixture' }),
    'model_provider = "fixture"',
    'model = "offline-fixture"',
    '[model_providers.fixture]',
    'name = "Offline fixture"',
    'base_url = "http://127.0.0.1:9/v1"',
    'wire_api = "responses"',
    '',
  ].join('\n')
  const written = await runtime.run(
    root,
    [
      'python3',
      '-I',
      '-c',
      'import pathlib, sys; pathlib.Path("/home/worker/.lemex/config.toml").write_text(sys.stdin.read())',
    ],
    { input: config, network: 'none', cleanHome: true, timeoutMs: 30000 },
  )
  assert.equal(written.code, 0, written.stderr)
  const child = runtime.spawn(
    root,
    ['lemex', 'app-server', '--stdio', '--strict-config'],
    {
      network: 'none',
      cleanHome: true,
    },
  )
  const closed = once(child, 'close')
  const rpc = new AgentRpc(child)
  child.stderr.resume()
  try {
    await rpc.call(
      'initialize',
      { clientInfo: { name: 'setup_readiness', version: '0.1.0' } },
      30000,
    )
    rpc.notify('initialized')
    const started = await rpc.call(
      'thread/start',
      {
        model: 'offline-fixture',
        cwd: '/workspace',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ephemeral: true,
      },
      30000,
    )
    assert(started.thread?.id)
    return { initialized: true, threadStarted: true, modelTurns: 0 }
  } finally {
    rpc.close()
    await closed
  }
}

export async function checkSetupCompiler(runtime, root, file) {
  const checked = await runPinnedLake(
    runtime,
    root,
    ['lake', 'env', 'lean', file],
    {
      network: 'none',
      cleanHome: true,
      readOnlyWorkspace: true,
      writeLakeCache: true,
      timeoutMs: 120000,
    },
  )
  assert.equal(checked.code, 0, checked.stderr + checked.stdout)
}

export async function checkSetupProbe(runtime, root, file) {
  const script = String.raw`
import asyncio, json, os, pathlib, sys
from datetime import timedelta
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    source = pathlib.Path(sys.argv[1]).read_text()
    header = '\n'.join(line for line in source.splitlines() if line.startswith('import ')) + '\n'
    params = StdioServerParameters(command='/opt/tools/bin/lean-probe', args=['mcp'], env={**os.environ, 'LEAN_PROBE_AUTO_BUILD': '0'})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=180)) as client:
            await client.initialize()
            results = []
            for tool, args in [
                ('lean_status', {'cwd': '/workspace', 'warm': True}),
                ('lean_check', {'cwd': '/workspace', 'code': source, 'timeout_s': 90}),
                ('lean_check', {'cwd': '/workspace', 'code': header + 'example : False := by exact (0 : Nat)', 'timeout_s': 90}),
                ('lean_check', {'cwd': '/workspace', 'code': header + 'example : False := by sorry', 'timeout_s': 90}),
            ]:
                response = await client.call_tool(tool, args)
                data = response.structuredContent
                if data is None:
                    data = json.loads(next(block.text for block in response.content if block.type == 'text'))
                results.append(data)
            print('SETUP_PROBE_RESULT=' + json.dumps(results))

asyncio.run(main())
`
  const result = await runtime.run(
    root,
    ['/opt/lean-probe/bin/python', '-c', script, file],
    {
      network: 'none',
      cleanHome: true,
      readOnlyWorkspace: true,
      timeoutMs: 600000,
    },
  )
  assert.equal(result.code, 0, result.stderr + result.stdout)
  const prefix = 'SETUP_PROBE_RESULT='
  const line = result.stdout
    .split('\n')
    .find((value) => value.startsWith(prefix))
  assert(line, result.stderr + result.stdout)
  const [status, valid, invalid, sorry] = JSON.parse(line.slice(prefix.length))
  assert.equal(status.available, true, JSON.stringify(status))
  for (const value of [valid, invalid, sorry])
    assert.equal(value.success, true, JSON.stringify(value))
  assert.equal(valid.ok, true, JSON.stringify(valid))
  assert.equal(invalid.ok, false, JSON.stringify(invalid))
  assert.equal(sorry.ok, false, JSON.stringify(sorry))
  assert.equal(sorry.has_sorry, true, JSON.stringify(sorry))
  return {
    available: true,
    validAccepted: true,
    invalidRejected: true,
    sorryRejected: true,
  }
}
