#!/usr/bin/env node
// Exercise Git's credential prompt in a real isolated worker, without network.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Runtime } from '../server/runtime.mjs'
import {
  gitCredentialsRunner,
  gitCredentialHelper,
  gitHttpsEnv,
  cleanupGitWorkerHome,
} from '../server/git-credentials.mjs'

const output = path.resolve('.runtime/git-credentials-check')
const dataDir = path.join(output, randomUUID())
const root = path.join(dataDir, 'workspace')
await fs.mkdir(root, { recursive: true, mode: 0o700 })
const runtime = new Runtime({
  dataDir,
  scope: 'git-credentials-check',
  maxConcurrent: 1,
  maxQueue: 2,
})
let child
try {
  await runtime.init()
  assert(runtime.ready, runtime.error)
  const probe = String.raw`import json, os, subprocess, sys
assert not os.environ.get('GIT_ASKPASS')
filled = subprocess.check_output(['git', '-c', 'credential.helper=', '-c', 'credential.helper=' + sys.argv[1], 'credential', 'fill'], input='protocol=https\nhost=fixture.invalid\n\n', text=True)
values = dict(line.split('=', 1) for line in filled.splitlines() if '=' in line)
assert values['password'] == 'fixture-docker-token'
assert values['username'] == 'gitlab+deploy-token-42'
assert 'fixture-docker-token' not in sys.argv[1]
tmp_options = next(line.split()[3] for line in open('/proc/mounts') if line.split()[1] == '/tmp')
assert 'noexec' in tmp_options.split(',')
print(json.dumps({'gitCredentialPrompt': True, 'noexecTemporaryFiles': True, 'credentialHelper': True}))`
  const result = await runtime.run(
    root,
    [
      'python3',
      '-c',
      gitCredentialsRunner,
      'python3',
      '-c',
      probe,
      gitCredentialHelper,
    ],
    {
      input: JSON.stringify({
        token: 'fixture-docker-token',
        username: 'gitlab+deploy-token-42',
      }),
      env: gitHttpsEnv,
      network: 'none',
      freshHome: true,
      cleanHome: true,
      readOnlyHome: true,
      timeoutMs: 30000,
      onSpawn: (worker) => {
        child = worker
      },
    },
  )
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  await cleanupGitWorkerHome(child, dataDir)
  assert.deepEqual(await fs.readdir(root), [])
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'runtime/homes')), [])
  await fs.writeFile(
    path.join(output, 'report.json'),
    JSON.stringify({ ...report, retainedCredentials: false }, null, 2),
  )
  console.log(
    'PASS: real Git prompts authenticate in an isolated worker with noexec temporary files; no network or retained credentials.',
  )
} finally {
  await cleanupGitWorkerHome(child, dataDir)
  await runtime.shutdown()
}
