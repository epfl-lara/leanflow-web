#!/usr/bin/env node
// Real MCP/Lean smoke checks, using isolated copies and the candidate image.
// No provider calls, server restart, live image retag, or user source edits.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Runtime } from '../server/runtime.mjs'

const dataDir = path.resolve(process.env.STUDIO_DATA_DIR || '.data')
const existingProject = process.env.LEAN_PROBE_EXISTING_PROJECT_ROOT
const reportDir = path.resolve(
  process.env.LEAN_PROBE_TEST_REPORT_DIR ||
    (existingProject
      ? '.runtime/lean-probe-jordan'
      : '.runtime/lean-probe-check'),
)
const image =
  process.env.LEAN_PROBE_TEST_IMAGE || 'lemex-web-worker:lean-probe-646cb0ee'
const memory = process.env.LEAN_PROBE_TEST_MEMORY || '6g'
const runtime = new Runtime({ dataDir, image, scope: 'helper', memory })
const directory = path.join(
  dataDir,
  'runtime',
  'lean-probe-check',
  randomUUID(),
)
const results = { image, memory, presets: {}, providerCalls: 0 }
const roots = []

const mcpCheck = String.raw`
import asyncio, json, os, time
from datetime import timedelta
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

def memory_usage():
    result = {}
    for name in ['current', 'peak', 'max']:
        try:
            with open('/sys/fs/cgroup/memory.' + name) as handle:
                result[name] = handle.read().strip()
        except OSError:
            pass
    try:
        with open('/sys/fs/cgroup/memory.events') as handle:
            result['events'] = {name: int(value) for name, value in (line.split() for line in handle)}
    except OSError:
        pass
    return result

async def main():
    params = StdioServerParameters(command='/opt/tools/bin/lean-probe', args=['mcp'], env={**os.environ, 'LEAN_PROBE_AUTO_BUILD':'0'})
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=600)) as client:
            initialization = await client.initialize()
            tools = await client.list_tools()
            result = {'server':initialization.serverInfo.model_dump(), 'tools':[tool.name for tool in tools.tools], 'calls':[]}
            async def call(name, arguments):
                started = time.monotonic()
                response = await client.call_tool(name, arguments)
                data = response.structuredContent
                if data is None:
                    data = json.loads(next(block.text for block in response.content if block.type == 'text'))
                result['calls'].append({'tool':name, 'arguments':arguments, 'seconds':round(time.monotonic()-started,3), 'isError':bool(response.isError), 'memory':memory_usage(), 'result':data})
                return data
            await call('lean_status', {'cwd':'/workspace', 'warm':True})
            existing = os.environ.get('LEAN_PROBE_EXISTING_PROJECT') == '1'
            header = 'import Mathlib\n\n' if existing else open('/workspace/Main.lean').read().split('theorem fixture')[0]
            await call('lean_check', {'cwd':'/workspace', 'code':header + 'example (n : Nat) : n + 0 = n := by rfl', 'timeout_s':90})
            await call('lean_check', {'cwd':'/workspace', 'code':header + 'example : False := by exact (0 : Nat)', 'timeout_s':90})
            await call('lean_check', {'cwd':'/workspace', 'code':header + 'example : False := by sorry', 'timeout_s':90})
            if not existing:
                await call('lean_check_target', {'cwd':'/workspace', 'file':'Main.lean', 'name':'fixture', 'replacement':'theorem fixture (n : Nat) : n + 0 = n := by rfl', 'timeout_s':90})
                await call('lean_check_target', {'cwd':'/workspace', 'file':'Main.lean', 'name':'fixture', 'replacement':'theorem fixture (n : Nat) : n + 0 = n := by simp', 'timeout_s':90})
                for _ in range(4):
                    await call('lean_check', {'cwd':'/workspace', 'code':header + 'example (n : Nat) : n + 0 = n := by rfl', 'timeout_s':90})
                await call('lean_check_target', {'cwd':'/workspace', 'file':'Main.lean', 'name':'fixture', 'replacement':'theorem fixture (n : Nat) : n + 0 = n := by simp', 'timeout_s':90})
            await call('lean_status', {'cwd':'/workspace'})
            print('LEAN_PROBE_RESULT=' + json.dumps(result))

asyncio.run(main())
`

await fs.mkdir(reportDir, { recursive: true })
try {
  const info = await runtime.init()
  assert.equal(info.ready, true, info.error)
  results.imageId = runtime.imageId
  results.nativeCommit = runtime.lemexNativeBuildCommit
  const presets = existingProject ? [] : ['lean', 'mathlib', 'cslib', 'physlib']
  if (!existingProject && runtime.toolchains.has('leanprover/lean4:v4.29.0'))
    presets.push('lean-4.29')
  const requested = process.argv.slice(2)
  assert(
    requested.every((preset) => presets.includes(preset)),
    `Choose prepared presets from: ${presets.join(', ')}`,
  )
  if (existingProject) {
    const root = await fs.realpath(existingProject)
    assert(
      root.startsWith(path.join(dataDir, 'runtime', 'import-check') + path.sep),
      'Existing project must be an isolated import-check fixture',
    )
    const source = path.join(root, 'JordanCurveTheorem.lean')
    const before = await fs.readFile(source)
    const result = await runtime.run(
      root,
      ['/opt/lean-probe/bin/python', '-c', mcpCheck],
      {
        network: 'none',
        readOnlyWorkspace: true,
        timeoutMs: 600000,
        env: { LEAN_PROBE_EXISTING_PROJECT: '1' },
      },
    )
    await fs.writeFile(path.join(reportDir, 'jordan-stdout.log'), result.stdout)
    await fs.writeFile(path.join(reportDir, 'jordan-stderr.log'), result.stderr)
    assert.equal(result.code, 0, result.stderr.slice(-2000))
    const line = result.stdout
      .split('\n')
      .find((line) => line.startsWith('LEAN_PROBE_RESULT='))
    assert(line, 'No structured Jordan MCP result')
    const checked = JSON.parse(line.slice('LEAN_PROBE_RESULT='.length))
    results.presets.jordan = checked
    const [status, valid, invalid, sorry] = checked.calls.map(
      (call) => call.result,
    )
    assert.equal(status.available, true, JSON.stringify(status))
    for (const value of [valid, invalid, sorry])
      assert.equal(value.success, true, JSON.stringify(value))
    assert.equal(valid.ok, true, JSON.stringify(valid))
    assert.equal(invalid.ok, false, JSON.stringify(invalid))
    assert.equal(sorry.ok, false, JSON.stringify(sorry))
    assert.equal(sorry.has_sorry, true, JSON.stringify(sorry))
    assert.deepEqual(await fs.readFile(source), before)
    checked.sourceHash = createHash('sha256').update(before).digest('hex')
    checked.sourceUnchanged = true
    checked.projectRoot = root
    checked.network = 'none'
    checked.workspaceReadonly = true
    checked.toolchain = (
      await fs.readFile(path.join(root, 'lean-toolchain'), 'utf8')
    ).trim()
  }
  for (const preset of presets) {
    if (requested.length && !requested.includes(preset)) continue
    const template = runtime.templateRoot(
      preset === 'lean-4.29' ? 'lean' : preset,
    )
    assert(template, `Required ${preset} preset is not installed`)
    const root = path.join(directory, preset)
    await fs.mkdir(path.join(root, '.lake'), { recursive: true })
    roots.push(root)
    for (const file of [
      'lean-toolchain',
      'lakefile.toml',
      'lakefile.lean',
      'lake-manifest.json',
    ]) {
      try {
        await fs.copyFile(path.join(template, file), path.join(root, file))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    await fs.cp(path.join(template, '.lake'), path.join(root, '.lake'), {
      recursive: true,
      filter: (source) =>
        !source.startsWith(path.join(template, '.lake', 'packages')),
    })
    await runtime.inheritDependencies(template, root)
    if (preset === 'lean-4.29')
      await fs.writeFile(
        path.join(root, 'lean-toolchain'),
        'leanprover/lean4:v4.29.0\n',
      )
    const importName =
      preset === 'lean-4.29' ? 'Lean' : runtime.presetDefinition(preset).import
    const content =
      `import ${importName}\n\n` +
      'theorem fixture (n : Nat) : n + 0 = n := by\n  simp only [Nat.add_zero]\n'
    await fs.writeFile(path.join(root, 'Main.lean'), content)
    const result = await runtime.run(
      root,
      ['/opt/lean-probe/bin/python', '-c', mcpCheck],
      {
        network: 'none',
        readOnlyWorkspace: true,
        timeoutMs: 900000,
      },
    )
    await fs.writeFile(
      path.join(reportDir, `${preset}-stdout.log`),
      result.stdout,
    )
    await fs.writeFile(
      path.join(reportDir, `${preset}-stderr.log`),
      result.stderr,
    )
    assert.equal(
      result.code,
      0,
      `MCP client failed for ${preset}: ${result.stderr.slice(-2000)}`,
    )
    const line = result.stdout
      .split('\n')
      .find((line) => line.startsWith('LEAN_PROBE_RESULT='))
    assert(line, `No structured ${preset} MCP result`)
    const checked = JSON.parse(line.slice('LEAN_PROBE_RESULT='.length))
    results.presets[preset] = checked
    const [status, valid, invalid, sorry, target, warmTarget] =
      checked.calls.map((call) => call.result)
    assert.equal(status.available, true, JSON.stringify(status))
    for (const value of [valid, invalid, sorry, target, warmTarget])
      assert.equal(value.success, true, JSON.stringify(value))
    assert.equal(valid.ok, true, JSON.stringify(valid))
    assert.equal(invalid.ok, false, JSON.stringify(invalid))
    assert.equal(sorry.ok, false, JSON.stringify(sorry))
    assert.equal(sorry.has_sorry, true, JSON.stringify(sorry))
    assert.equal(target.ok, true, JSON.stringify(target))
    assert.equal(warmTarget.ok, true, JSON.stringify(warmTarget))
    for (const call of checked.calls.slice(6, -1)) {
      assert.equal(call.result.success, true, JSON.stringify(call.result))
      assert.equal(call.result.ok, true, JSON.stringify(call.result))
      if (call.tool === 'lean_check')
        assert.equal(call.result.cache.reused_server, false)
    }
    const retainedTarget = checked.calls.at(-2).result
    assert.equal(retainedTarget.cache.cache_hit, true)
    assert.equal(retainedTarget.cache.env_before, warmTarget.cache.env_before)
    assert.equal(
      checked.calls.at(-1).memory.events?.oom_kill || 0,
      0,
      `LeanProbe exceeded the ${memory} memory limit for ${preset}`,
    )
    assert.equal(
      await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
      content,
    )
    checked.sourceHash = createHash('sha256').update(content).digest('hex')
    checked.sourceUnchanged = true
    checked.network = 'none'
    checked.toolchain = (
      await fs.readFile(path.join(root, 'lean-toolchain'), 'utf8')
    ).trim()
    console.log(`${preset}: real MCP checks passed with ${checked.toolchain}`)
  }
  results.passed = true
} catch (error) {
  results.passed = false
  results.error = error.stack || error.message
  process.exitCode = 1
} finally {
  await runtime.shutdown()
  for (const root of roots) {
    await runtime.clearInheritedDependencies(root)
    const key = createHash('sha256').update(root).digest('hex')
    await fs.rm(path.join(dataDir, 'runtime', 'homes', key), {
      recursive: true,
      force: true,
    })
  }
  await fs.rm(directory, { recursive: true, force: true })
  await fs.writeFile(
    path.join(reportDir, 'result.json'),
    JSON.stringify(results, null, 2) + '\n',
  )
  console.log(
    JSON.stringify(
      {
        passed: results.passed,
        imageId: results.imageId,
        error: results.error,
        report: reportDir,
      },
      null,
      2,
    ),
  )
}
