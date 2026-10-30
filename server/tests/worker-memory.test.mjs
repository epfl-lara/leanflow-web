import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Runtime } from '../runtime.mjs'
import { loadCapacity } from '../capacity.mjs'
import { memoryBytes, workerMemoryCapacity } from '../worker-memory.mjs'

const gib = 1024 ** 3

test('worker admission preserves the worker allowance and reserves a quarter of host RAM', () => {
  for (const [hostGiB, memory, memoryBudget, expected] of [
    [16, '4g', null, 3],
    [16, '8g', null, 1],
    [64, '8g', null, 6],
    [16, '4096M', '8G', 2],
    [32, '6g', null, 4],
  ]) {
    const capacity = workerMemoryCapacity({
      memory,
      memoryBudget,
      hostMemory: hostGiB * gib,
    })
    assert.equal(capacity.slots, expected)
    assert(
      expected * memoryBytes(memory, 'worker memory') <=
        capacity.memoryBudgetBytes,
    )
    assert(capacity.memoryBudgetBytes <= hostGiB * gib * 0.75)
  }
})

test('invalid or unsafe memory settings never disable admission limits', () => {
  for (const name of ['STUDIO_WORKER_MEMORY', 'STUDIO_WORKER_MEMORY_BUDGET'])
    for (const value of [
      '0',
      '-1',
      'NaN',
      'Infinity',
      '1.5g',
      '1gb',
      '9007199254740992',
      '99999999999999999999g',
    ])
      assert.throws(() => loadCapacity({ [name]: value }), new RegExp(name))
  const input = { memory: '4g', hostMemory: 16 * gib }
  for (const hostMemory of [0, -1, NaN, Infinity, null, '17179869184', 1.5])
    assert.throws(
      () => workerMemoryCapacity({ ...input, hostMemory }),
      /verify Docker host memory/,
    )
  assert.throws(
    () => workerMemoryCapacity({ ...input, memoryBudget: '13g' }),
    /leave at least 25%/,
  )
  assert.throws(
    () => workerMemoryCapacity({ ...input, memoryBudget: '3g' }),
    /does not fit/,
  )
  assert.throws(
    () => workerMemoryCapacity({ ...input, hostMemory: 4 * gib }),
    /does not fit/,
  )
  assert.throws(
    () => workerMemoryCapacity({ ...input, memory: '1m' }),
    /at least 6 MiB/,
  )
  assert.equal(loadCapacity({}).workerMemoryBudget, null)
  assert.equal(
    loadCapacity({ STUDIO_WORKER_MEMORY_BUDGET: ' 8g ' }).workerMemoryBudget,
    '8g',
  )
})

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!(await predicate())) {
    assert(
      Date.now() < deadline,
      'Fixture worker did not reach the expected state',
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function fixture(
  t,
  options = {},
  engineOverrides = {},
  initialize = true,
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-worker-memory-'),
  )
  const dataDir = path.join(directory, 'data')
  const root = path.join(dataDir, 'project')
  const output = path.join(dataDir, 'tex-output')
  const docker = path.join(directory, 'docker-fixture')
  const runs = path.join(directory, 'runs.jsonl')
  const hostToolchainDir = path.join(directory, 'host-toolchains')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(output)
  await fs.writeFile(runs, '')
  await fs.writeFile(
    docker,
    `#!${process.execPath}
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
if (args[0] === 'info') {
  if (args.at(-1) === '{{json .SecurityOptions}}') console.log('[]')
  else console.log(${JSON.stringify(JSON.stringify({ ServerVersion: 'fixture', MemTotal: 16 * gib, MemoryLimit: true, SwapLimit: true, ...engineOverrides }))})
}
if (args[0] === 'image') console.log('sha256:' + 'a'.repeat(64))
if (args[0] === 'run') {
  fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify(args) + String.fromCharCode(10))
  if (args.includes('/opt/lemex/lemex-install.json')) console.log('{}')
  else if (args.includes('/opt/elan/bin/elan')) {
    const mount = args.find(value => value.endsWith(',dst=/elan'))
    const cache = mount.slice('type=bind,src='.length, -',dst=/elan'.length)
    const name = args.at(-1).replaceAll('/', '--').replaceAll(':', '---')
    const binary = path.join(cache, 'toolchains', name, 'bin/lean')
    fs.mkdirSync(path.dirname(binary), { recursive: true })
    fs.writeFileSync(binary, 'fixture toolchain')
  }
  else if (args.includes('/verify/bin/lean')) console.log('Lean (version 4.34.1)')
  else if (args.includes('/opt/tex-compile-worker.py')) {
    const artifacts = { 'result.json': Buffer.from('{"success":true}').toString('base64') }
    console.log('LEANFLOW_TEX_ARTIFACTS:' + args.at(-1) + ':' + JSON.stringify({ artifacts }))
  }
  else {
    console.log(JSON.stringify(args))
    if (args.includes('hold') || args.includes('check')) setInterval(() => {}, 1000)
  }
}
`,
    { mode: 0o700 },
  )
  const runtime = new Runtime({
    dataDir,
    docker,
    hostToolchainDir,
    kernelExportMaxBytes: 1024 * 1024,
    ...options,
  })
  t.after(async () => {
    await runtime.shutdown()
    await fs.rm(directory, { recursive: true, force: true })
  })
  if (initialize) await runtime.init()
  return {
    runtime,
    root,
    output,
    runs: async () =>
      (await fs.readFile(runs, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  }
}

test('memory admission queues weighted checks, allows smaller jobs, and recovers after cancellation', async (t) => {
  const { runtime, root, runs } = await fixture(t)
  assert.equal(runtime.ready, true, runtime.error)
  assert.equal(runtime.info().configuredMaxConcurrent, 6)
  assert.equal(runtime.info().maxConcurrent, 3)
  assert.equal(runtime.info().limits.memoryBudgetBytes, 12 * gib)
  const editor = runtime.spawn(root, ['hold'])
  const pending = runtime.spawnWhenAvailable(root, ['lake', 'check'], {
    kernelCheck: true,
    readOnlyWorkspace: true,
    writeLakeCache: true,
    freshHome: true,
  })
  assert.equal(runtime.info().queued, 1)
  assert.equal((await runtime.run(root, ['quick'])).code, 0)
  assert.equal(runtime.info().queued, 1)
  editor.kill()
  await editor.workerStopped
  const kernel = await pending
  assert.equal(runtime.info().usedSlots, 3)
  await until(async () => (await runs()).some((args) => args.includes('check')))
  const command = (await runs()).find((args) => args.includes('check'))
  assert.equal(command[command.indexOf('--memory') + 1], '12g')
  assert.equal(command[command.indexOf('--memory-swap') + 1], '12g')
  assert.throws(() => runtime.spawn(root, ['quick']), { status: 503 })
  const controller = new AbortController()
  const cancelled = runtime.run(root, ['quick'], { signal: controller.signal })
  assert.equal(runtime.info().queued, 1)
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal(runtime.info().queued, 0)
  kernel.kill()
  await kernel.workerStopped
  assert.equal(runtime.info().usedSlots, 0)
  assert.equal((await runtime.run(root, ['quick'])).code, 0)
})

test('a lower configured worker count remains enforced within the automatic memory budget', async (t) => {
  const { runtime, root } = await fixture(t, { maxConcurrent: 1 })
  assert.equal(runtime.info().maxConcurrent, 1)
  const worker = runtime.spawn(root, ['hold'])
  assert.throws(() => runtime.spawn(root, ['quick']), { status: 503 })
  const pending = runtime.run(root, ['quick'])
  assert.equal(runtime.info().queued, 1)
  worker.kill()
  await worker.workerStopped
  assert.equal((await pending).code, 0)
})

test('a smaller budget scales full checks without shrinking ordinary workers', async (t) => {
  const { runtime, root, runs } = await fixture(t, { memoryBudget: '8g' })
  assert.equal(runtime.info().maxConcurrent, 2)
  assert.equal(runtime.memory, '4g')
  const kernel = runtime.spawn(root, ['lake', 'check'], {
    kernelCheck: true,
    readOnlyWorkspace: true,
    writeLakeCache: true,
    freshHome: true,
  })
  assert.equal(kernel.workerSlots, 2)
  await until(async () => (await runs()).some((args) => args.includes('check')))
  const command = (await runs()).find((args) => args.includes('check'))
  assert.equal(command[command.indexOf('--memory') + 1], '8g')
  kernel.kill()
  await kernel.workerStopped
})

test('memory limits preserve project configuration, pinned files, and custom build commands', async (t) => {
  for (const filename of ['lakefile.toml', 'lakefile.lean'])
    await t.test(filename, async (t) => {
      const { runtime, root } = await fixture(t, { memory: '8g' })
      const files = {
        'lean-toolchain': 'leanprover/lean4:v4.35.0-rc3\n',
        'lake-manifest.json': '{"packages":[],"pinned":"keep"}\n',
        'Main.lean': 'example : True := by trivial\n',
        [filename]: filename.endsWith('.toml')
          ? 'name = "CustomProject"\nmoreLeanArgs = ["-M6144", "-j4"]\n'
          : 'import Lake\nopen Lake DSL\npackage CustomProject where\n  moreLeanArgs := #["-M6144", "-j4"]\n',
      }
      for (const [name, content] of Object.entries(files))
        await fs.writeFile(path.join(root, name), content)
      assert.equal(runtime.info().maxConcurrent, 1)
      for (const command of [
        ['lake', '--keep-toolchain', 'build', 'CustomTarget'],
        ['lake', 'serve', '--'],
        ['python3', '-I', '/workspace/scripts/custom-step.py'],
      ]) {
        const result = await runtime.run(root, command, {
          env: { LEAN_NUM_THREADS: '4' },
        })
        assert.equal(result.code, 0, result.stderr)
        const args = JSON.parse(result.stdout)
        assert.deepEqual(args.slice(args.indexOf(runtime.imageId) + 1), command)
        assert.equal(args[args.indexOf('--memory') + 1], '8g')
      }
      for (const [name, content] of Object.entries(files))
        assert.equal(await fs.readFile(path.join(root, name), 'utf8'), content)
    })
})

test('toolchain installation and verification wait for the same memory slots and retain hard limits', async (t) => {
  const { runtime, root, runs } = await fixture(t, { memoryBudget: '4g' })
  const editor = runtime.spawn(root, ['hold'])
  const preparation = runtime.prepareToolchain('leanprover/lean4:v4.34.1')
  await until(() => runtime.info().queued === 1)
  assert(!(await runs()).some((args) => args.includes('/opt/elan/bin/elan')))
  editor.kill()
  await editor.workerStopped
  assert.deepEqual(await preparation, {
    toolchain: 'leanprover/lean4:v4.34.1',
    ready: true,
  })
  const commands = (await runs()).filter(
    (args) =>
      args.includes('/opt/elan/bin/elan') || args.includes('/verify/bin/lean'),
  )
  assert.equal(commands.length, 2)
  for (const command of commands) {
    assert.equal(command[command.indexOf('--memory') + 1], '4g')
    assert.equal(command[command.indexOf('--memory-swap') + 1], '4g')
    assert.equal(command[command.indexOf('--cpus') + 1], '2')
    assert.equal(command[command.indexOf('--pids-limit') + 1], '512')
    assert(command.includes('--name'))
  }
  assert.equal(runtime.info().usedSlots, 0)
})

test('TeX uses the shared memory budget and resumes after a Lean worker stops', async (t) => {
  const { runtime, root, output, runs } = await fixture(t, {
    memoryBudget: '4g',
  })
  const editor = runtime.spawn(root, ['hold'])
  const pending = runtime.runTex(root, output, { rootFile: 'main.tex' })
  await until(() => runtime.info().queued === 1)
  editor.kill()
  await editor.workerStopped
  assert.equal((await pending).code, 0)
  const command = (await runs()).find((args) =>
    args.includes('/opt/tex-compile-worker.py'),
  )
  assert.equal(command[command.indexOf('--memory') + 1], '4g')
  assert.equal(command[command.indexOf('--memory-swap') + 1], '4g')
  assert.equal(runtime.info().usedSlots, 0)
})

test('TeX cannot start before runtime memory limits have been initialized', async (t) => {
  const { runtime, root, output, runs } = await fixture(t, {}, {}, false)
  await assert.rejects(runtime.runTex(root, output, { rootFile: 'main.tex' }), {
    status: 503,
  })
  assert.deepEqual(await runs(), [])
})

test('unverifiable or unenforceable memory limits disable Lean and TeX workers with an actionable error', async (t) => {
  for (const [options, engine] of [
    [{}, { MemoryLimit: false }],
    [{}, { SwapLimit: false }],
    [{}, { MemTotal: 0 }],
    [{}, { MemTotal: 4 * gib }],
    [{ memoryBudget: '13g' }, {}],
  ])
    await t.test(JSON.stringify({ options, engine }), async (t) => {
      const { runtime, root, output, runs } = await fixture(t, options, engine)
      assert.equal(runtime.ready, false)
      assert.equal(runtime.info().maxConcurrent, 0)
      assert.match(runtime.error, /Docker|STUDIO_WORKER_MEMORY/)
      assert(!runtime.error.includes('build-worker.sh'))
      assert.throws(() => runtime.spawn(root, ['quick']), { status: 503 })
      await assert.rejects(
        runtime.runTex(root, output, { rootFile: 'main.tex' }),
        { status: 503 },
      )
      assert.deepEqual(await runs(), [])
    })
})
