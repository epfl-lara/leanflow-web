#!/usr/bin/env node
// Exercise the agent's real Git config and credential socket in a worker.
// All repositories are local fixtures; no provider or Git host is contacted.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Runtime } from '../server/runtime.mjs'
import { configureAgentGit } from '../server/terminal-git.mjs'

const directory = path.resolve('.runtime/agent-git', randomUUID())
const dataDir = path.join(directory, 'data')
const root = path.join(dataDir, 'projects', 'fixture')
const token = 'fixture-agent-git-' + randomUUID()
const digest = createHash('sha256').update(token).digest('hex')
const calls = []
const runtime = new Runtime({
  dataDir,
  scope: 'helper',
  maxConcurrent: 1,
  cpus: 1,
  memory: '1g',
})
const report = { passed: false, providerCalls: 0, remoteWrites: 0, checks: [] }
let broker
try {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, 'lean-toolchain'),
    'leanprover/lean4:v4.34.1\n',
  )
  await fs.writeFile(
    path.join(root, 'lakefile.toml'),
    'name = "agent_git_fixture"\n',
  )
  await runtime.init()
  assert(runtime.ready, runtime.error)
  const home = await runtime.home(root)
  broker = await configureAgentGit({
    home,
    owner: 'alice',
    identity: { name: 'Agent fixture', email: 'agent@example.test' },
    connections: {
      async credentials(owner, repository) {
        calls.push({ owner, repository })
        return owner === 'alice' &&
          repository === 'https://github.com/fixture/project.git'
          ? { username: 'alice', token }
          : null
      },
    },
  })
  const result = await runtime.run(
    root,
    [
      'python3',
      '-c',
      `import hashlib, os, pathlib, subprocess
def git(*args, cwd=None, check=True, data=None):
    return subprocess.run(['git', *args], cwd=cwd, check=check, input=data, capture_output=True, text=True)
query = 'protocol=https\\nhost=github.com\\npath=fixture/project.git\\n\\n'
credential = git('credential', 'fill', data=query).stdout
fields = dict(line.split('=', 1) for line in credential.splitlines() if '=' in line)
assert hashlib.sha256(fields['password'].encode()).hexdigest() == '${digest}'
assert git('credential', 'fill', data=query.replace('project.git', 'other.git'), check=False).returncode != 0
assert not any('fixture-agent-git-' in value for value in os.environ.values())
git('init', '--bare', '/tmp/origin.git')
git('init', '-b', 'main', '/tmp/first')
pathlib.Path('/tmp/first/Notes.md').write_text('initial\\n')
git('add', 'Notes.md', cwd='/tmp/first')
git('commit', '-m', 'Initial', cwd='/tmp/first')
assert git('log', '-1', '--format=%an <%ae>', cwd='/tmp/first').stdout.strip() == 'Agent fixture <agent@example.test>'
git('remote', 'add', 'origin', '/tmp/origin.git', cwd='/tmp/first')
git('push', '-u', 'origin', 'main', cwd='/tmp/first')
git('clone', '--branch', 'main', '/tmp/origin.git', '/tmp/second')
pathlib.Path('/tmp/second/Notes.md').write_text('remote update\\n')
git('add', 'Notes.md', cwd='/tmp/second')
git('commit', '-m', 'Remote update', cwd='/tmp/second')
git('push', cwd='/tmp/second')
git('pull', '--ff-only', cwd='/tmp/first')
assert pathlib.Path('/tmp/first/Notes.md').read_text() == 'remote update\\n'
print('NATIVE_AGENT_GIT_OK')
`,
    ],
    { network: 'none', timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: '0' } },
  )
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /NATIVE_AGENT_GIT_OK/)
  assert(!JSON.stringify(result).includes(token))
  assert(
    !String(await fs.readFile(path.join(home, '.gitconfig'))).includes(token),
  )
  assert(calls.every((call) => call.owner === 'alice'))
  report.checks.push(
    'Native Git uses the agent account identity and saved repository credentials with no token in environment, config, or output.',
  )
  report.checks.push(
    'Native clone, commit, push and fast-forward pull complete against offline fixture repositories; unrelated repositories receive no token.',
  )
  report.passed = true
} finally {
  await broker?.close()
  await runtime.shutdown()
  await fs.rm(directory, { recursive: true, force: true })
  await fs.mkdir(path.dirname(directory), { recursive: true })
  await fs.writeFile(
    path.join(path.dirname(directory), 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
console.log(JSON.stringify(report, null, 2))
