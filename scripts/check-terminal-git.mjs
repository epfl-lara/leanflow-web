#!/usr/bin/env node
// Verify native Git, shared credential helpers, and nested checkouts in Docker.
// Everything uses private offline fixtures; no repository host is contacted.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { Runtime } from '../server/runtime.mjs'
import { Terminals } from '../server/terminals.mjs'
import { until } from './lib/chat-browser-fixture.mjs'

const execute = promisify(execFile)
const directory = path.resolve('.runtime/terminal-git', randomUUID())
const dataDir = path.join(directory, 'data')
const checkout = path.join(dataDir, 'checkouts', 'fixture')
const root = path.join(checkout, 'Lean')
const dependency = path.join(dataDir, 'dependencies')
const owner = 'git-fixture'
const connectionTokens = new Map([
  [
    'github.com',
    { token: 'fixture-github-' + randomUUID(), username: 'fixture' },
  ],
  [
    'gitlab.com',
    { token: 'fixture-gitlab-' + randomUUID(), username: 'oauth2' },
  ],
])
const secrets = [...connectionTokens.values()].map((value) => value.token)
const calls = []
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  maxConcurrent: 2,
  cpus: 1,
  memory: '1g',
})
const terminals = new Terminals({
  runtime,
  capacity: {},
  workspaces: {
    repositoryRoot: () => checkout,
    configurationFingerprint: () => 'fixture',
    async refreshExternalConfiguration() {},
  },
  gitConnections: {
    async credentials(user, value) {
      const host = new URL(value).hostname
      calls.push({ owner: user, host })
      const credentials = user === owner && connectionTokens.get(host)
      return credentials ? { ...credentials } : null
    },
  },
  gitIdentity: () => ({
    name: 'Fixture Author',
    email: 'fixture@example.test',
  }),
})
const server = http.createServer()
const report = { directory, passed: false, providerCalls: 0, checks: [] }
let socket
let output = ''
const send = (command) =>
  socket.send(JSON.stringify({ type: 'input', data: command + '\r' }))
const python = (code) =>
  'python3 -c ' + "'" + code.replaceAll("'", "'\"'\"'") + "'"
const credentialCheck = (host, token, marker) => {
  const expected = createHash('sha256').update(token).digest('hex')
  return python(
    `import hashlib, subprocess; result = subprocess.run(["git", "credential", "fill"], input="protocol=https\\nhost=${host}\\npath=fixture/project.git\\n\\n", text=True, capture_output=True, check=True); fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line); assert hashlib.sha256(fields["password"].encode()).hexdigest() == "${expected}"; print("${marker}")`,
  )
}
try {
  await runtime.init()
  assert(runtime.ready, runtime.error)
  await runtime.prepareToolchain('leanprover/lean4:v4.34.1')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.join(dependency, '.lake/packages/Fixture'), {
    recursive: true,
  })
  for (const target of [root, dependency]) {
    await fs.writeFile(
      path.join(target, 'lean-toolchain'),
      'leanprover/lean4:v4.34.1\n',
    )
    await fs.writeFile(
      path.join(target, 'lakefile.toml'),
      'name = "terminal_git_fixture"\n',
    )
  }
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await fs.writeFile(
    path.join(dependency, '.lake/packages/Fixture/sentinel'),
    'readonly',
  )
  await execute('git', ['init', '-b', 'main'], { cwd: checkout })
  await execute('git', ['add', 'Lean'], { cwd: checkout })
  await execute(
    'git',
    [
      '-c',
      'user.name=Initial Fixture',
      '-c',
      'user.email=initial@example.test',
      'commit',
      '-m',
      'Initial fixture',
    ],
    { cwd: checkout },
  )
  await runtime.inheritDependencies(dependency, root)
  server.on('upgrade', (req, stream, head) =>
    terminals.upgrade(req, stream, head, { id: 'fixture', owner, root }),
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/`)
  socket.on('message', (data, binary) => {
    if (!binary) {
      const message = JSON.parse(data.toString())
      if (message.type === 'error') report.error = message.message
      return
    }
    output += data.toString()
    if (socket.readyState === 1)
      socket.send(JSON.stringify({ type: 'ack', bytes: data.length }))
  })
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  await until(
    () => output.includes('/repository/Lean'),
    'nested terminal prompt',
  )
  send('stty -echo')
  send(
    'git status --short; git switch -c feature/terminal-check; printf "\\n-- terminal proof change\\n" >> Main.lean; git add Main.lean; git commit -m "Terminal fixture commit"; git log -1 --format="AUTHOR=%an <%ae>"; printf "GIT_COMMIT_DONE\\n"',
  )
  await until(
    () => output.includes('GIT_COMMIT_DONE'),
    'native terminal Git commit',
  )
  assert(
    output.includes('AUTHOR=Fixture Author <fixture@example.test>'),
    output,
  )
  assert.equal(
    (
      await execute('git', ['branch', '--show-current'], { cwd: checkout })
    ).stdout.trim(),
    'feature/terminal-check',
  )
  assert.equal(
    (
      await execute('git', ['log', '-1', '--format=%s'], { cwd: checkout })
    ).stdout.trim(),
    'Terminal fixture commit',
  )
  report.checks.push(
    'Nested checkouts support native Git status, branch creation and commits with the shared default identity.',
  )
  send(
    'git config user.name "Local Override"; git config user.email "override@example.test"; git commit --allow-empty -m "Local identity override"; git log -1 --format="OVERRIDE=%an <%ae>"; lake env lean Main.lean && printf "LEAN_CHECK_OK\\n"; (printf x >> .lake/packages/Fixture/sentinel) 2>/dev/null || printf "DEPENDENCY_READONLY\\n"; printf "PINNED_LEAN_DONE\\n"',
  )
  await until(
    () => output.includes('PINNED_LEAN_DONE'),
    'pinned Lean and dependency mounts',
  )
  assert(
    output.includes('OVERRIDE=Local Override <override@example.test>'),
    output,
  )
  assert(output.includes('DEPENDENCY_READONLY'), output)
  assert(output.includes('LEAN_CHECK_OK'), output)
  assert.equal(
    await fs.readFile(
      path.join(dependency, '.lake/packages/Fixture/sentinel'),
      'utf8',
    ),
    'readonly',
  )
  report.checks.push(
    'Local Git identity overrides still work, pinned Lean checks succeed, and nested dependency mounts stay read only.',
  )
  send(
    python(
      'import subprocess; run = lambda args: subprocess.run(args, check=True, capture_output=True, text=True); run(["git", "init", "--bare", "/tmp/terminal-origin.git"]); run(["git", "push", "/tmp/terminal-origin.git", "HEAD:refs/heads/feature/terminal-check"]); run(["git", "clone", "--branch", "feature/terminal-check", "/tmp/terminal-origin.git", "/tmp/terminal-clone"]); assert run(["git", "rev-parse", "HEAD"]).stdout == run(["git", "-C", "/tmp/terminal-clone", "rev-parse", "HEAD"]).stdout; print("CLONE_PUSH_OK")',
    ),
  )
  await until(
    () => output.includes('CLONE_PUSH_OK'),
    'native offline clone and push',
  )
  report.checks.push(
    'Native Git pushes to an offline bare repository and clones its published branch with matching history.',
  )
  send(
    credentialCheck(
      'github.com',
      connectionTokens.get('github.com').token,
      'GITHUB_AUTH_OK',
    ),
  )
  await until(
    () => output.includes('GITHUB_AUTH_OK'),
    'GitHub native credential helper',
  )
  send(
    credentialCheck(
      'gitlab.com',
      connectionTokens.get('gitlab.com').token,
      'GITLAB_AUTH_OK',
    ),
  )
  await until(
    () => output.includes('GITLAB_AUTH_OK'),
    'GitLab native credential helper',
  )
  connectionTokens.delete('github.com')
  send(
    python(
      'import subprocess; query = "protocol=https\\nhost=github.com\\npath=fixture/project.git\\n\\n"; result = subprocess.run(["git", "credential", "fill"], input=query, text=True, capture_output=True); assert result.returncode != 0 and "password=" not in result.stdout; print("REVOKED_OK")',
    ),
  )
  await until(() => output.includes('REVOKED_OK'), 'revoked Git connection')
  send(
    python(
      'import subprocess; query = "protocol=https\\nhost=github.com.evil.test\\npath=fixture/project.git\\n\\n"; result = subprocess.run(["git", "credential", "fill"], input=query, text=True, capture_output=True); assert result.returncode != 0 and "password=" not in result.stdout; print("HOST_ISOLATION_OK")',
    ),
  )
  await until(
    () => output.includes('HOST_ISOLATION_OK'),
    'exact host credential isolation',
  )
  assert(calls.every((call) => call.owner === owner))
  report.checks.push(
    'Native Git obtains connected GitHub/GitLab credentials; revocation and exact host isolation take effect in the same open terminal.',
  )
  const child = [...runtime.children][0]
  const inspect = JSON.parse(
    (await execute('docker', ['inspect', child.containerName])).stdout,
  )[0]
  const configuration = JSON.stringify({
    env: inspect.Config.Env,
    args: inspect.Config.Cmd,
  })
  for (const secret of secrets) {
    assert(!configuration.includes(secret))
    assert(!output.includes(secret))
  }
  const files = await fs.readdir(child.workerHome, {
    recursive: true,
    withFileTypes: true,
  })
  for (const entry of files) {
    if (!entry.isFile()) continue
    const contents = await fs.readFile(
      path.join(entry.parentPath, entry.name),
      'utf8',
    )
    for (const secret of secrets) assert(!contents.includes(secret))
  }
  report.checks.push(
    'Repository tokens stay out of terminal output, Docker arguments/environment and temporary worker files.',
  )
  await terminals.closeProject('fixture')
  assert.equal(runtime.children.size, 0)
  assert.equal(terminals.sessions.size, 0)
  await assert.rejects(fs.stat(child.workerHome), { code: 'ENOENT' })
  report.checks.push(
    'Closing the terminal removes its worker, credential socket and temporary home.',
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
