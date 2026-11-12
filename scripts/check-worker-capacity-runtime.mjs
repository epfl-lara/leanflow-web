#!/usr/bin/env node
// Bounded native Lean/LSP concurrency fixture. No provider calls or user projects.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Runtime } from '../server/runtime.mjs'
import { LspFrames, frame } from '../server/rpc.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const base = path.resolve('.runtime/worker-capacity-runtime')
const directory = path.join(base, randomUUID())
const report = { passed: false, providerCalls: 0, checks: [], failures: [] }
const source = Array.from(
  { length: 24 },
  (_, index) =>
    `theorem fixture_${index} (a b : Nat) : a + b = b + a := by exact Nat.add_comm a b\n`,
).join('')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, description, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    assert(Date.now() < deadline, `Timed out waiting for ${description}.`)
    await sleep(20)
  }
}
async function record(name, action) {
  const start = Date.now()
  await action()
  report.checks.push({ name, durationMs: Date.now() - start })
  console.log(`PASS ${name}`)
}

const runtime = new Runtime({
  dataDir: directory,
  image: process.env.STUDIO_TEST_WORKER_IMAGE || process.env.LEMEX_WORKER_IMAGE,
  hostToolchainDir: process.env.STUDIO_TEST_TOOLCHAIN_DIR,
  scope: 'helper',
  cpus: 0.5,
  memory: '512m',
  memoryBudget: '1536m',
  maxConcurrent: 3,
  maxQueue: 8,
  interactiveReserved: 1,
  batchReserved: 2,
})
let editor
const tasks = []
try {
  await runtime.init()
  assert(runtime.info().ready, runtime.info().error)
  report.imageId = runtime.imageId
  await runtime.prepareToolchain(toolchain)
  const roots = ['first', 'second', 'editor'].map((name) =>
    path.join(directory, name),
  )
  for (const root of roots) {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'lean-toolchain'), toolchain + '\n')
    await fs.writeFile(
      path.join(root, 'lakefile.toml'),
      'name = "CapacityFixture"\n[[lean_lib]]\nname = "Main"\n',
    )
    await fs.writeFile(path.join(root, 'Main.lean'), source)
  }
  const output = ['', '']
  const program = [
    'import pathlib,subprocess,time',
    'print("BATCH_READY",flush=True)',
    'deadline=time.monotonic()+35',
    'while not pathlib.Path("start").exists():',
    ' if time.monotonic()>deadline: raise TimeoutError("Fixture start did not arrive")',
    ' time.sleep(0.02)',
    'subprocess.run(["lean","Main.lean"],check=True)',
    'print("CHECK_PASSED",flush=True)',
    'while not pathlib.Path("finish").exists():',
    ' if time.monotonic()>deadline: raise TimeoutError("Fixture finish did not arrive")',
    ' time.sleep(0.02)',
  ].join('\n')
  for (let index = 0; index < 2; index++) {
    const task = runtime.run(roots[index], ['python3', '-I', '-c', program], {
      workload: 'batch',
      network: 'none',
      readOnlyWorkspace: true,
      freshHome: true,
      timeoutMs: 40_000,
      onOutput: (text) => {
        output[index] += text
      },
    })
    task.catch(() => {})
    tasks.push(task)
  }
  await until(
    () => output.every((text) => text.includes('BATCH_READY')),
    'both batch workers',
  )
  await record(
    'two native proof workers preserve the reserved interactive slot',
    async () => {
      assert.equal(runtime.info().usedSlots, 2)
      await assert.rejects(runtime.run(roots[0], ['true'], { queue: false }), {
        status: 503,
      })
      editor = runtime.spawn(roots[2], ['lake', 'serve', '--'], {
        workload: 'interactive',
        network: 'none',
        readOnlyWorkspace: true,
        writeLakeCache: true,
        freshHome: true,
        timeoutMs: 40_000,
      })
      assert.equal(runtime.info().usedSlots, 3)
      assert.deepEqual(runtime.info().workloads.active, {
        interactive: 1,
        batch: 2,
      })
    },
  )
  let lspError
  const messages = []
  const frames = new LspFrames((message) => messages.push(message))
  editor.stdout.on('data', (chunk) => {
    try {
      frames.push(chunk)
    } catch (error) {
      lspError = error
    }
  })
  editor.stderr.on('data', () => {})
  editor.stdin.on('error', (error) => {
    lspError = error
  })
  editor.stdin.write(
    frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: null,
        rootUri: 'file:///workspace',
        capabilities: {},
      },
    }),
  )
  await record(
    'real Lean editor initializes while both batch slots are occupied',
    async () => {
      await until(() => {
        if (lspError) throw lspError
        return messages.some((message) => message.id === 1)
      }, 'Lean initialization')
      assert(messages.find((message) => message.id === 1).result)
      editor.stdin.write(
        frame({ jsonrpc: '2.0', method: 'initialized', params: {} }),
      )
    },
  )
  await record(
    'native proof compilation and editor diagnostics finish concurrently',
    async () => {
      editor.stdin.write(
        frame({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri: 'file:///workspace/Main.lean',
              languageId: 'lean4',
              version: 1,
              text: 'example : 2 + 2 = 5 := by rfl\n',
            },
          },
        }),
      )
      await Promise.all(
        roots
          .slice(0, 2)
          .map((root) => fs.writeFile(path.join(root, 'start'), 'start')),
      )
      await until(
        () => output.every((text) => text.includes('CHECK_PASSED')),
        'native Lean proofs',
      )
      await until(() => {
        if (lspError) throw lspError
        return messages.some(
          (message) =>
            message.method === 'textDocument/publishDiagnostics' &&
            message.params?.diagnostics?.some(
              (diagnostic) => diagnostic.severity === 1,
            ),
        )
      }, 'Lean editor error diagnostics')
      assert.equal(runtime.info().usedSlots, 3)
      for (const root of roots)
        assert.equal(
          await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
          source,
        )
    },
  )
  await record(
    'native workers stay within the fixture CPU and memory budget',
    async () => {
      for (const child of runtime.children) {
        const { stdout } = await promisify(execFile)('docker', [
          'inspect',
          '--format',
          '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}',
          child.containerName,
        ])
        assert.equal(stdout.trim(), '536870912 500000000')
      }
      report.limits = {
        maxWorkers: 3,
        combinedCpu: 1.5,
        combinedMemoryBytes: 1536 * 1024 ** 2,
      }
    },
  )
  await record(
    'cancelling queued work leaves the real Lean editor connected',
    async () => {
      const controller = new AbortController()
      const queued = runtime.run(roots[0], ['true'], {
        signal: controller.signal,
      })
      const cancelled = assert.rejects(queued, /Cancel queued fixture/)
      assert.equal(runtime.info().queued, 1)
      controller.abort(new Error('Cancel queued fixture'))
      await cancelled
      assert.equal(runtime.info().queued, 0)
      assert.equal(editor.cancelled, undefined)
      editor.stdin.write(
        frame({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }),
      )
      await until(() => {
        if (lspError) throw lspError
        return messages.some((message) => message.id === 2)
      }, 'Lean shutdown response')
    },
  )
  await Promise.all(
    roots
      .slice(0, 2)
      .map((root) => fs.writeFile(path.join(root, 'finish'), 'finish')),
  )
  const results = await Promise.all(tasks)
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  editor.kill()
  await editor.workerStopped
  assert.equal(runtime.info().usedSlots, 0)
  assert.equal(runtime.info().queued, 0)
  report.passed = true
} catch (error) {
  report.failures.push(error.message)
  console.error(error.message)
  process.exitCode = 1
} finally {
  await runtime.shutdown()
  await Promise.allSettled(tasks)
  await fs.rm(directory, { recursive: true, force: true })
  await fs.mkdir(base, { recursive: true })
  await fs.writeFile(
    path.join(base, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
