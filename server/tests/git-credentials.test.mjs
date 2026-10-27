import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  cleanupGitWorkerHome,
  clearGitCredentials,
  gitCredentialHelper,
  gitCredentialsRunner,
  gitHttpsEnv,
  redactGitCredentials,
  validateGitCredentials,
} from '../git-credentials.mjs'

function runCredentialCommand(command, credentials, options = {}) {
  const args = ['-c', gitCredentialsRunner, ...command]
  const env = { PATH: process.env.PATH, ...gitHttpsEnv, ...options.env }
  const child = spawn('python3', args, {
    cwd: options.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (value) => {
      stdout += value
    })
    child.stderr.on('data', (value) => {
      stderr += value
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr, args, env }))
    child.stdin.end(JSON.stringify(credentials))
  })
}

test('one-use credentials validate before use and support GitLab deploy-token usernames', () => {
  assert.deepEqual(validateGitCredentials(), {
    token: '',
    username: 'x-access-token',
  })
  for (const username of [
    'x-access-token',
    'oauth2',
    'gitlab+deploy-token-123',
    'fixture.user@example.invalid',
  ]) {
    const credentials = validateGitCredentials({
      token: 'fixture-token!+/%@',
      username,
    })
    assert.equal(credentials.username, username)
    assert.equal(credentials.token, 'fixture-token!+/%@')
    clearGitCredentials(credentials)
    assert.equal(credentials.token, '')
  }
  for (const token of [
    null,
    12,
    'with space',
    'newline\n',
    'é',
    'a'.repeat(16001),
  ])
    assert.throws(() => validateGitCredentials({ token }), { status: 400 })
  for (const username of [
    null,
    12,
    '',
    'with space',
    'a:b',
    'a/b',
    'a'.repeat(201),
  ])
    assert.throws(() => validateGitCredentials({ username }), { status: 400 })
})

test('credential redaction covers raw, URL and HTTP Basic forms alongside existing redaction', () => {
  const credentials = validateGitCredentials({
    username: 'gitlab+deploy-token-123',
    token: 'fixture!+/%@secret',
  })
  const forms = [
    credentials.token,
    encodeURI(credentials.token),
    encodeURIComponent(credentials.token),
    Buffer.from(credentials.username + ':' + credentials.token).toString(
      'base64',
    ),
  ]
  const output = redactGitCredentials(
    'existing-secret ' + forms.join(' '),
    credentials,
    (value) => value.replaceAll('existing-secret', '[existing redaction]'),
  )
  assert(output.startsWith('[existing redaction] '))
  assert.equal(output.split('[redacted]').length - 1, forms.length)
  for (const form of forms) assert(!output.includes(form))
  assert.equal(
    redactGitCredentials('plain output', { token: '' }),
    'plain output',
  )
})

test('the credential helper satisfies Git get, store and erase operations without writing credentials or executable files', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow credential test '),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const credentials = validateGitCredentials({
    token: '\\"'.repeat(8000),
    username: 'u'.repeat(200),
  })
  const script = `import json, os, subprocess, sys
command = ['git', '-c', 'credential.helper=', '-c', 'credential.helper=' + sys.argv[1], 'credential']
request = 'protocol=https\\nhost=git.example.invalid\\n\\n'
filled = subprocess.check_output(command + ['fill'], input=request, text=True)
values = dict(line.split('=', 1) for line in filled.splitlines() if '=' in line)
for operation in ['approve', 'reject']:
    result = subprocess.run(command + [operation], input=filled + '\\n', text=True, capture_output=True, check=True)
    assert result.stdout == ''
print(json.dumps({
    'username': values['username'],
    'password': values['password'],
    'askpass': os.environ.get('GIT_ASKPASS'),
    'stdin': sys.stdin.read(),
    'sslBypass': os.environ.get('GIT_SSL_NO_VERIFY'),
}))
`
  const result = await runCredentialCommand(
    ['python3', '-c', script, gitCredentialHelper],
    credentials,
    {
      cwd: root,
      env: { GIT_SSL_NO_VERIFY: 'true', TMPDIR: root },
    },
  )
  assert.equal(result.code, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.username, credentials.username)
  assert.equal(output.password, credentials.token)
  assert.equal(output.stdin, '')
  assert.equal(output.sslBypass, null)
  assert.equal(output.askpass, null)
  for (const value of [
    gitCredentialHelper,
    JSON.stringify(result.args),
    JSON.stringify(result.env),
  ])
    assert(!value.includes(credentials.token))
  assert(!gitCredentialHelper.includes(credentials.username))
  assert.deepEqual(await fs.readdir(root), [])
})

test('credentialed subprocess failures return without creating helper files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-git-failure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const result = await runCredentialCommand(
    [
      'python3',
      '-c',
      "import os, sys; assert 'GIT_ASKPASS' not in os.environ; sys.exit(27)",
    ],
    validateGitCredentials({ token: 'fixture-failure-token' }),
    { cwd: root, env: { TMPDIR: root } },
  )
  assert.equal(result.code, 27, result.stderr)
  assert.deepEqual(await fs.readdir(root), [])
})

test('pinned credentialed Git refuses workers without pinning support before exposing credentials', async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-git-pin-test-'),
  )
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const git = path.join(root, 'git')
  await fs.writeFile(
    git,
    `#!/usr/bin/python3
import json, os, sys
if sys.argv[1:] == ['help', '--config']:
    with open(os.path.join(os.environ['FIXTURE_ROOT'], 'support.json'), 'w') as target:
        json.dump({'token': os.environ.get('GIT_REPOSITORY_TOKEN'), 'username': os.environ.get('GIT_REPOSITORY_USERNAME')}, target)
    if os.environ['FIXTURE_PIN_SUPPORT'] == 'yes':
        print('http.curloptResolve')
else:
    with open(os.path.join(os.environ['FIXTURE_ROOT'], 'launched'), 'w') as target:
        target.write('git launched')
`,
    { mode: 0o700 },
  )
  const credentials = validateGitCredentials({ token: 'fixture-pin-secret' })
  for (const support of ['no', 'yes']) {
    const result = await runCredentialCommand(
      [
        'git',
        '-c',
        'http.curloptResolve=git.example.invalid:443:93.184.216.34',
        'fetch',
      ],
      credentials,
      {
        cwd: root,
        env: {
          PATH: root + ':' + process.env.PATH,
          FIXTURE_ROOT: root,
          FIXTURE_PIN_SUPPORT: support,
        },
      },
    )
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(root, 'support.json'), 'utf8')),
      { token: null, username: null },
    )
    assert(!result.stdout.includes(credentials.token))
    assert(!result.stderr.includes(credentials.token))
    if (support === 'no') {
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /Rebuild its image/)
      await assert.rejects(fs.stat(path.join(root, 'launched')), {
        code: 'ENOENT',
      })
    } else {
      assert.equal(result.code, 0, result.stderr)
      assert.equal(
        await fs.readFile(path.join(root, 'launched'), 'utf8'),
        'git launched',
      )
    }
  }
})

test('worker-home cleanup deletes only canonical worker directories inside the data directory', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-git-home-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const homes = path.join(dataDir, 'runtime', 'homes')
  const home = path.join(homes, 'a'.repeat(64))
  const unrelated = path.join(dataDir, 'b'.repeat(64))
  const linked = path.join(homes, 'c'.repeat(64))
  const named = path.join(homes, 'preserved')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(unrelated)
  await fs.mkdir(named)
  await fs.symlink(unrelated, linked)
  for (const workerHome of [unrelated, linked, named]) {
    await cleanupGitWorkerHome({ workerHome }, dataDir)
    assert((await fs.lstat(workerHome)).isDirectory() || workerHome === linked)
  }
  await cleanupGitWorkerHome({ workerHome: home }, dataDir)
  await assert.rejects(fs.stat(home), { code: 'ENOENT' })
  await cleanupGitWorkerHome({ workerHome: home }, dataDir)
  await cleanupGitWorkerHome(undefined, dataDir)
})

test('worker-home cleanup waits for container removal and preserves homes when stopping fails', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-git-stop-'))
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }))
  const home = path.join(dataDir, 'runtime/homes', 'a'.repeat(64))
  await fs.mkdir(home, { recursive: true })
  let stopped
  const workerStopped = new Promise((resolve) => {
    stopped = resolve
  })
  const cleanup = cleanupGitWorkerHome(
    { workerHome: home, workerStopped },
    dataDir,
  )
  assert((await fs.stat(home)).isDirectory())
  stopped()
  await cleanup
  await assert.rejects(fs.stat(home), { code: 'ENOENT' })

  await fs.mkdir(home)
  await assert.rejects(
    cleanupGitWorkerHome(
      {
        workerHome: home,
        workerStopped: Promise.reject(new Error('Container removal failed')),
      },
      dataDir,
    ),
    /Container removal failed/,
  )
  assert((await fs.stat(home)).isDirectory())
})
