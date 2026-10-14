#!/usr/bin/env node
// Exercise a real PTY and worker sandbox in private fixtures; no provider calls.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { Runtime } from '../server/runtime.mjs'
import { Terminals } from '../server/terminals.mjs'

const directory = path.resolve('.runtime/terminal-runtime', randomUUID())
const dataDir = path.join(directory, 'data')
const root = path.join(dataDir, 'project')
const scratchRoot = path.join(dataDir, 'scratch')
const previousSource = '-- previous full project\n'
const scratchSource = '-- private Scratch proof\nexample : 2 = 2 := rfl\n'
const projects = new Map([
  ['/', { id: 'fixture', root }],
  ['/scratch', { id: 'scratch', kind: 'single-file', root: scratchRoot }],
])
const dependencies = path.join(dataDir, 'dependencies')
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  cpus: 1,
  memory: '1g',
  maxConcurrent: 2,
})
const terminals = new Terminals({
  runtime,
  capacity: { terminals: 1, terminalsPerProject: 1 },
})
const server = http.createServer()
const report = { directory, checks: [], providerCalls: 0, passed: false }
let socket
const until = async (check, label, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
try {
  await runtime.init()
  assert(runtime.ready, runtime.error)
  await runtime.prepareToolchain('leanprover/lean4:v4.34.1')
  for (const target of [
    root,
    path.join(dependencies, '.lake/packages/Fixture'),
  ])
    await fs.mkdir(target, { recursive: true })
  for (const target of [root, dependencies]) {
    await fs.writeFile(
      path.join(target, 'lean-toolchain'),
      'leanprover/lean4:v4.34.1\n',
    )
    await fs.writeFile(
      path.join(target, 'lakefile.toml'),
      'name = "terminal_fixture"\n',
    )
  }
  await fs.writeFile(
    path.join(dependencies, '.lake/packages/Fixture/sentinel'),
    'readonly-dependency',
  )
  await runtime.inheritDependencies(dependencies, root)
  const previousHome = await runtime.home(root)
  await fs.writeFile(
    path.join(previousHome, '.lemex/auth.json'),
    'PRIVATE_FIXTURE',
  )
  await fs.writeFile(path.join(dataDir, 'sibling-secret'), 'PRIVATE_FIXTURE')
  await fs.symlink(
    path.join(dataDir, 'sibling-secret'),
    path.join(root, 'escape'),
  )
  await fs.writeFile(path.join(root, 'Main.lean'), previousSource)
  server.on('upgrade', (req, stream, head) =>
    terminals.upgrade(req, stream, head, projects.get(req.url)),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/`)
  let output = ''
  socket.on('message', (data, binary) => {
    if (binary) {
      output = (output + data.toString()).slice(-1024 * 1024)
      socket.send(JSON.stringify({ type: 'ack', bytes: data.length }))
    }
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const input = (data) => socket.send(JSON.stringify({ type: 'input', data }))
  await until(() => output.includes('/workspace'), 'interactive prompt')
  input('stty -echo\r')
  socket.send(JSON.stringify({ type: 'resize', rows: 31, cols: 93 }))
  input(
    "test -t 0 && test -t 1 && printf 'PTY_OK\\n'; stty size; lake env lean --version\r",
  )
  await until(
    () =>
      output.includes('PTY_OK') &&
      output.includes('31 93') &&
      output.includes('Lean (version 4.34.1'),
    'PTY, resize and pinned Lean',
  )
  report.checks.push(
    'Interactive PTY, resize, and the pinned Lean environment work.',
  )
  input(
    "lemex --version; lemex --help >/dev/null && printf 'LEMEX_CLI_OK\\n'\r",
  )
  await until(
    () => output.includes('LEMEX_CLI_OK'),
    'Lemex CLI in the terminal',
  )
  report.checks.push(
    'The packaged Lemex CLI is available inside the terminal sandbox.',
  )
  input(
    'printf \'saved from terminal\\n\' > terminal.txt; python3 -c \'import os; assert not any(k in os.environ for k in ["LEMEX_API_KEY", "OPENAI_API_KEY"]); assert not os.path.exists(os.path.expanduser("~/.lemex/auth.json")); assert not os.path.exists("escape"); print("PRIVATE_OK")\'\r',
  )
  await until(
    () => output.includes('PRIVATE_OK'),
    'credential and host isolation',
  )
  assert.equal(
    await fs.readFile(path.join(root, 'terminal.txt'), 'utf8'),
    'saved from terminal\n',
  )
  report.checks.push(
    'Saved project writes work; provider credentials, prior worker auth, and sibling files are inaccessible.',
  )
  input(
    "(printf x >> .lake/packages/Fixture/sentinel) 2>/dev/null || printf 'DEPENDENCY_READONLY\\n'; (printf x >> /opt/lean-toolchains/leanprover--lean4---v4.34.1/bin/lean) 2>/dev/null || printf 'TOOLCHAIN_READONLY\\n'; (touch /etc/terminal-fixture) 2>/dev/null || printf 'SYSTEM_READONLY\\n'\r",
  )
  await until(
    () =>
      ['DEPENDENCY_READONLY', 'TOOLCHAIN_READONLY', 'SYSTEM_READONLY'].every(
        (marker) => output.includes(marker),
      ),
    'read-only mounts',
  )
  assert.equal(
    await fs.readFile(
      path.join(dependencies, '.lake/packages/Fixture/sentinel'),
      'utf8',
    ),
    'readonly-dependency',
  )
  report.checks.push(
    'Shared dependencies, pinned toolchains and the worker system remain read only.',
  )
  input('sleep 120\r')
  await new Promise((resolve) => setTimeout(resolve, 250))
  input('\x03')
  input("printf 'INTERRUPTED_OK\\n'\r")
  await until(() => output.includes('INTERRUPTED_OK'), 'Ctrl+C interruption')
  input('sleep 120 &\r')
  await until(() => runtime.children.size === 1, 'worker running')
  const containerName = [...runtime.children][0].containerName
  const closed = new Promise((resolve) => socket.once('close', resolve))
  socket.close()
  await closed
  await until(() => runtime.children.size === 0, 'complete worker cleanup')
  const { execFileSync } = await import('node:child_process')
  assert.equal(
    execFileSync(
      'docker',
      ['ps', '-aq', '--filter', `name=^/${containerName}$`],
      { encoding: 'utf8' },
    ).trim(),
    '',
  )
  report.checks.push(
    'Ctrl+C interrupts commands; disconnect removes the shell, background processes, and container.',
  )
  await until(
    () => terminals.sessions.size === 0,
    'previous terminal fully released',
  )
  await fs.mkdir(scratchRoot)
  for (const filename of ['lean-toolchain', 'lakefile.toml'])
    await fs.copyFile(
      path.join(root, filename),
      path.join(scratchRoot, filename),
    )
  await fs.writeFile(path.join(scratchRoot, 'Main.lean'), scratchSource)
  await runtime.inheritDependencies(dependencies, scratchRoot)
  output = ''
  socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/scratch`)
  socket.on('message', (data, binary) => {
    if (!binary) return
    output += data.toString()
    if (socket.readyState === 1)
      socket.send(JSON.stringify({ type: 'ack', bytes: data.length }))
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  await until(() => output.includes('/workspace'), 'Scratch terminal prompt')
  input('stty -echo\r')
  input(
    "cat Main.lean; printf '\n-- saved in Scratch terminal\n' >> Main.lean; printf 'SCRATCH_EDIT_DONE\n'\r",
  )
  await until(
    () =>
      output.includes('private Scratch proof') &&
      output.includes('SCRATCH_EDIT_DONE'),
    'Scratch source and terminal edit',
  )
  assert.equal(
    await fs.readFile(path.join(scratchRoot, 'Main.lean'), 'utf8'),
    scratchSource + '\n-- saved in Scratch terminal\n',
  )
  assert.equal(
    await fs.readFile(path.join(root, 'Main.lean'), 'utf8'),
    previousSource,
  )
  assert(!output.includes('previous full project'))
  await terminals.closeProject('scratch')
  await until(() => runtime.children.size === 0, 'Scratch worker cleanup')
  report.checks.push(
    'A Scratch terminal reads and edits its own Main.lean after a full-project terminal closes; the other project source stays unchanged.',
  )
  report.passed = true
} finally {
  socket?.terminate()
  terminals.close()
  await runtime.shutdown()
  await new Promise((resolve) => server.close(resolve))
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(
    path.join(directory, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report, null, 2))
