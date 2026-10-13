#!/usr/bin/env node
// Real isolated Git export/push checks; all destinations and credentials are disposable.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { cpSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Runtime } from '../server/runtime.mjs'
import { GitPublisher } from '../server/git-publish.mjs'

const exec = promisify(execFile)
const output = path.resolve('.runtime/git-publish-check')
const dataDir = path.resolve('.data/runtime/git-publish-check', randomUUID())
const source = path.join(dataDir, 'source')
const destination = path.join(dataDir, 'destination.git')
const certificate = path.join(dataDir, 'tls')
const remoteUrl = 'https://git.example.org/owner/proofs.git'
const token = 'disposable-' + randomUUID()
const report = { providerCalls: 0, externalPushes: 0, checks: [], pushes: 0 }
const runtime = new Runtime({
  dataDir,
  image:
    process.env.STUDIO_TEST_IMAGE || 'lemex-web-worker:lean-probe-646cb0ee',
  scope: 'helper',
})
const gitOptions = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
]
const hostEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
}
const git = async (root, args) =>
  (
    await exec('git', [...gitOptions, '-C', root, ...args], {
      env: hostEnv,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim()
const collect = (child) =>
  new Promise((resolve, reject) => {
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (bytes) => {
      stdout += bytes
    })
    child.stderr.on('data', (bytes) => {
      stderr += bytes
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
const fail409 = async (action, pattern) =>
  assert.rejects(
    action,
    (error) => error.status === 409 && pattern.test(error.message),
  )
let busy = false,
  tlsChecked = false,
  publisher
const project = {
  id: randomUUID(),
  owner: 'owner',
  root: path.join(source, 'Lean'),
  subdirectory: 'Lean',
  status: 'ready',
  repository: remoteUrl,
}
const workspaces = {
  locks: new Map(),
  get(id, owner) {
    if (id !== project.id || owner !== project.owner)
      throw Object.assign(new Error('Project not found'), { status: 404 })
    return project
  },
  repositoryRoot: () => source,
  gitFilePath: async (_id, _owner, filename) => {
    assert.equal(filename, 'Main.lean')
    return path.join(project.root, filename)
  },
  gitStatus: async () => ({
    repository: true,
    branch: 'main',
    revision: await git(source, ['rev-parse', 'HEAD']),
    changes: [{ path: 'Main.lean', status: ' M' }],
    diff: await git(source, ['diff', '--', 'Lean/Main.lean']),
  }),
}

// The only test substitution is the network destination: a private /tmp bare
// repository receives the real Git push. Credentials follow production's stdin
// JSON -> trusted Python -> Git-only environment flow, never Docker env/argv.
const transportScript = String.raw`
import http.server, json, os, pathlib, shutil, ssl, subprocess, sys, threading
credentials = json.loads(sys.stdin.buffer.read(32769))
assert 'GIT_PUBLISH_TOKEN' not in os.environ
assert 'GIT_SSL_NO_VERIFY' not in os.environ
argv = sys.argv[1:]
assert 'http.sslVerify=true' in argv
assert 'core.hooksPath=/dev/null' in argv
assert 'credential.helper=' in argv
assert credentials['token'] not in '\0'.join(argv)
assert not os.path.exists('/workspace/.git')
assert not os.path.exists('/workspace/Lean/Main.lean')
assert not os.path.exists('/workspace/private.env')
assert not os.path.exists(SOURCE_PATH)
assert not os.path.exists('/localhome/milikic/.ssh')
config = pathlib.Path('/workspace/repository.git/config').read_text()
assert 'poison' not in config and 'hooksPath' not in config and 'helper' not in config
assert not os.path.exists('/workspace/repository.git/hooks/pre-push')
try:
    pathlib.Path('/workspace/write-attempt').write_text('bad')
    raise AssertionError('Publishing workspace was writable')
except OSError:
    pass
env = dict(os.environ)
env.pop('GIT_SSL_NO_VERIFY', None)
env['GIT_PUBLISH_TOKEN'] = credentials['token']
env['GIT_PUBLISH_USERNAME'] = credentials['username']
if os.path.exists('/workspace/test-tls/cert.pem'):
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(dict(self.headers)); self.send_response(401); self.end_headers()
        def log_message(self, *args): pass
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain('/workspace/test-tls/cert.pem', '/workspace/test-tls/key.pem')
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    prefix = argv[:argv.index('--git-dir=/workspace/repository.git')]
    tls = subprocess.run(prefix + ['ls-remote', 'https://127.0.0.1:%d/repo.git' % server.server_port], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True)
    server.shutdown(); server.server_close()
    assert tls.returncode != 0 and ('certificate' in tls.stderr.lower() or 'ssl' in tls.stderr.lower()), tls.stderr
    assert requests == [], 'Git sent an HTTP request despite the untrusted certificate'
    print('TLS_REJECTED_BEFORE_HTTP', flush=True)
shutil.copytree('/workspace/test-remote.git', '/tmp/remote.git')
remote_index = argv.index('--', argv.index('push')) + 1
argv[remote_index] = '/tmp/remote.git'
argv[1:1] = ['-c', 'protocol.file.allow=always']
result = subprocess.run(argv, env=env, stdin=subprocess.DEVNULL)
if result.returncode == 0:
    subprocess.run(['git', '--git-dir=/tmp/remote.git', 'bundle', 'create', '/home/worker/remote.bundle', '--all'], check=True, stdin=subprocess.DEVNULL)
sys.exit(result.returncode)
`.replace('SOURCE_PATH', JSON.stringify(source))

async function publishTransport({ root, args, env, credentials }) {
  assert.equal(credentials.token, token)
  assert.equal(Object.hasOwn(env, 'GIT_SSL_NO_VERIFY'), false)
  assert.equal(JSON.stringify({ args, env }).includes(token), false)
  assert(args.includes('http.sslVerify=true'))
  assert(
    args.some((value) =>
      value.startsWith('http.curloptResolve=git.example.org:443:'),
    ),
  )
  assert.equal(args.includes('--force'), false)
  await fs.cp(destination, path.join(root, 'test-remote.git'), {
    recursive: true,
  })
  if (!tlsChecked)
    await fs.cp(certificate, path.join(root, 'test-tls'), { recursive: true })
  let child
  const promise = runtime.run(
    root,
    ['python3', '-c', transportScript, ...args],
    {
      env,
      freshHome: true,
      readOnlyWorkspace: true,
      network: 'none',
      timeoutMs: 60000,
      input: JSON.stringify(credentials),
      onSpawn(worker) {
        child = worker
        assert.equal(child.spawnargs.join('\0').includes(token), false)
      },
    },
  )
  let result
  try {
    result = await promise
    assert.equal((result.stdout + result.stderr).includes(token), false)
    if (!tlsChecked && result.code === 0) {
      assert(result.stdout.includes('TLS_REJECTED_BEFORE_HTTP'))
      tlsChecked = true
    }
    if (result.code === 0)
      await git(destination, [
        'fetch',
        path.join(child.workerHome, 'remote.bundle'),
        '+refs/heads/*:refs/heads/*',
      ])
  } finally {
    await fs.rm(child.workerHome, { recursive: true, force: true })
  }
  report.pushes++
  return result
}

async function commit(message, value) {
  if (value) await fs.writeFile(path.join(project.root, 'Main.lean'), value)
  await git(source, ['add', '--', 'Lean/Main.lean', 'README.md'])
  await git(source, [
    '-c',
    'user.name=Disposable QA',
    '-c',
    'user.email=qa@example.invalid',
    'commit',
    '-m',
    message,
  ])
  return git(source, ['rev-parse', 'HEAD'])
}
async function scanSecrets(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) await scanSecrets(filename)
    else if (entry.isFile())
      assert.equal(
        (await fs.readFile(filename)).includes(Buffer.from(token)),
        false,
        `One-use token persisted in ${path.relative(dataDir, filename)}`,
      )
  }
}

try {
  await fs.mkdir(project.root, { recursive: true })
  await fs.mkdir(certificate)
  await exec(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(certificate, 'key.pem'),
      '-out',
      path.join(certificate, 'cert.pem'),
      '-subj',
      '/CN=localhost',
      '-days',
      '1',
    ],
    { maxBuffer: 1024 * 1024 },
  )
  await git(source, ['init', '-b', 'main'])
  await fs.writeFile(
    path.join(source, 'README.md'),
    'Disposable repository root sibling\n',
  )
  await commit('Initial proof', 'theorem first : True := by trivial\n')
  const published = await commit(
    'Second proof',
    'theorem second : True := by trivial\n',
  )
  await fs.writeFile(
    path.join(project.root, 'Main.lean'),
    'UNCOMMITTED SOURCE MUST NOT PUBLISH\n',
  )
  await fs.writeFile(
    path.join(source, 'private.env'),
    'PRIVATE UNTRACKED FILE\n',
  )
  await git(source, [
    'config',
    'remote.origin.url',
    'https://poison.example.org/stolen.git',
  ])
  await git(source, ['config', 'core.hooksPath', '/workspace/poison-hooks'])
  await git(source, ['config', 'core.fsmonitor', '/workspace/poison-monitor'])
  await git(source, [
    'config',
    'credential.helper',
    '!echo poison-helper >&2; exit 93',
  ])
  await git(source, ['config', 'http.sslVerify', 'false'])
  await git(source, [
    'config',
    'http.https://git.example.org/.sslVerify',
    'false',
  ])
  await fs.mkdir(path.join(source, 'poison-hooks'))
  await fs.writeFile(
    path.join(source, 'poison-hooks/pre-push'),
    '#!/bin/sh\necho poison-hook >&2\nexit 93\n',
    { mode: 0o700 },
  )
  await fs.writeFile(
    path.join(source, 'poison-monitor'),
    '#!/bin/sh\necho poison-monitor >&2\nexit 94\n',
    { mode: 0o700 },
  )
  await git(dataDir, ['init', '--bare', destination])
  await runtime.init()
  assert(runtime.ready, runtime.error)
  publisher = await new GitPublisher({
    dataDir,
    runtime,
    workspaces,
    publishTransport,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    assertIdle: () => {
      if (busy) throw Object.assign(new Error('Agent active'), { status: 409 })
    },
  }).init()
  runtime.maxConcurrent = 1
  const occupied = runtime.spawn(
    source,
    ['python3', '-c', 'import sys; sys.stdin.readline()'],
    {
      freshHome: true,
      readOnlyWorkspace: true,
      network: 'none',
      timeoutMs: 10000,
    },
  )
  const occupiedResult = collect(occupied)
  let metadataSettled = false
  const metadataWaiting = publisher
    .metadata('owner', project.id)
    .finally(() => {
      metadataSettled = true
    })
  const queueDeadline = Date.now() + 5000
  while (
    !runtime.queue.length &&
    !metadataSettled &&
    Date.now() < queueDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(metadataSettled, false)
  assert.equal(runtime.queue.length, 1)
  assert.equal(runtime.children.size, 1)
  occupied.stdin.end('release\n')
  assert.equal((await occupiedResult).code, 0)
  await fs.rm(occupied.workerHome, { recursive: true, force: true })
  const metadata = await metadataWaiting
  assert.equal(runtime.queue.length, 0)
  assert.equal(runtime.children.size, 0)
  assert.equal(
    (await fs.readdir(path.join(dataDir, 'runtime/homes'))).length,
    0,
  )
  runtime.maxConcurrent = 6
  report.checks.push(
    'With the only worker slot occupied, Git metadata queued until release and succeeded with no 503 or retained worker homes.',
  )
  assert.equal(metadata.remoteUrl, remoteUrl)
  assert.equal(metadata.commits.length, 2)
  report.checks.push(
    'Default destination is server-managed repository metadata, unaffected by poisoned origin configuration.',
  )
  const preview = await publisher.preview('owner', project.id, {
    branch: 'main',
  })
  assert.equal(preview.head, published)
  assert.equal(preview.historyCount, 2)
  assert.equal(preview.uncommittedCount, 1)
  assert.equal(preview.remoteUrl, remoteUrl)
  const result = await publisher.push('owner', project.id, {
    previewId: preview.previewId,
    token,
  })
  assert(result.pushed)
  assert.equal(await git(destination, ['rev-parse', 'main']), published)
  assert.equal(
    await git(destination, ['show', 'main:Lean/Main.lean']),
    'theorem second : True := by trivial',
  )
  assert.equal(
    await git(destination, ['show', 'main:README.md']),
    'Disposable repository root sibling',
  )
  assert.equal(
    (await git(destination, ['ls-tree', '-r', '--name-only', 'main'])).includes(
      'private.env',
    ),
    false,
  )
  report.checks.push(
    'Real isolated export and push transferred exactly the reviewed two-commit history, including root siblings, excluding unsaved and untracked files.',
  )
  report.checks.push(
    'Credential worker could not access original worktree, hooks/config, personal home, or write the exported workspace; token traveled only via stdin and Git subprocess environment.',
  )
  report.checks.push(
    'Git rejected an actual local HTTPS server with an untrusted certificate before any HTTP request or credential exchange.',
  )
  await assert.rejects(
    () =>
      publisher.push('owner', project.id, {
        previewId: preview.previewId,
        token,
      }),
    (error) => error.status === 404,
  )

  const next = await commit(
    'Third proof',
    'theorem third : True := by trivial\n',
  )
  const fast = await publisher.preview('owner', project.id, { branch: 'main' })
  await publisher.push('owner', project.id, {
    previewId: fast.previewId,
    token,
  })
  assert.equal(await git(destination, ['rev-parse', 'main']), next)
  assert.equal(await git(destination, ['rev-list', '--count', 'main']), '3')
  report.checks.push(
    'A second reviewed publish fast-forwarded the local bare branch; consumed previews cannot be replayed.',
  )

  const stale = await publisher.preview('owner', project.id, { branch: 'main' })
  const current = await commit(
    'Fourth proof',
    'theorem fourth : True := by trivial\n',
  )
  const beforeStale = report.pushes
  await fail409(
    () =>
      publisher.push('owner', project.id, {
        previewId: stale.previewId,
        token,
      }),
    /HEAD changed/,
  )
  assert.equal(report.pushes, beforeStale)
  busy = true
  await fail409(
    () => publisher.preview('owner', project.id, { branch: 'main' }),
    /Agent active/,
  )
  busy = false
  report.checks.push(
    'Changed HEAD and active-project guards reject publishing before any credentialed transport.',
  )

  const divergent = path.join(dataDir, 'divergent')
  await git(dataDir, ['clone', '--no-hardlinks', destination, divergent])
  await git(divergent, ['checkout', 'main'])
  await fs.writeFile(
    path.join(divergent, 'remote-only.txt'),
    'Concurrent remote change\n',
  )
  await git(divergent, ['add', 'remote-only.txt'])
  await git(divergent, [
    '-c',
    'user.name=Other QA',
    '-c',
    'user.email=other@example.invalid',
    'commit',
    '-m',
    'Remote-only commit',
  ])
  await git(divergent, ['push', destination, 'HEAD:refs/heads/main'])
  const remoteHead = await git(destination, ['rev-parse', 'main'])
  const conflict = await publisher.preview('owner', project.id, {
    branch: 'main',
  })
  assert.equal(conflict.head, current)
  await fail409(
    () =>
      publisher.push('owner', project.id, {
        previewId: conflict.previewId,
        token,
      }),
    /rejected.*(?:fetch first|non-fast-forward|remote contains work)/s,
  )
  assert.equal(await git(destination, ['rev-parse', 'main']), remoteHead)
  report.checks.push(
    'A real non-fast-forward push was rejected and preserved the remote branch; no force option is used.',
  )

  await fs.writeFile(
    path.join(source, '.git/objects/info/alternates'),
    '/outside/objects\n',
  )
  await fail409(
    () => publisher.preview('owner', project.id, { branch: 'main' }),
    /Linked or rewritten/,
  )
  await fs.rm(path.join(source, '.git/objects/info/alternates'))

  // Reproduce a depth-one import followed by a locally committed change.
  // Anonymous upstream fetch is redirected only by this injected test runtime;
  // production keeps its public HTTPS/DNS validation unchanged.
  const completeSource = path.join(dataDir, 'complete-source')
  const upstream = path.join(dataDir, 'upstream.git')
  await fs.rename(source, completeSource)
  await git(dataDir, [
    'clone',
    '--bare',
    '--no-hardlinks',
    completeSource,
    upstream,
  ])
  await git(dataDir, ['clone', '--depth=1', 'file://' + upstream, source])
  assert.equal(
    await git(source, ['rev-parse', '--is-shallow-repository']),
    'true',
  )
  const shallowHead = await commit(
    'Local change after shallow import',
    'theorem fifth : True := by trivial\n',
  )
  let anonymousFetches = 0
  publisher.runtime = {
    run(root, args, options) {
      if (args.includes('--unshallow')) {
        anonymousFetches++
        assert.equal(options.network, 'bridge')
        assert.equal(JSON.stringify(options.env).includes(token), false)
        assert.equal(args.includes(token), false)
        cpSync(upstream, path.join(root, 'test-upstream.git'), {
          recursive: true,
        })
        args = [...args]
        args[args.indexOf(remoteUrl)] = '/workspace/test-upstream.git'
        args.splice(
          args.indexOf('git') + 1,
          0,
          '-c',
          'protocol.file.allow=always',
        )
        options = { ...options, network: 'none' }
      }
      return runtime.run(root, args, options)
    },
  }
  const shallow = await publisher.preview('owner', project.id, {
    branch: 'shallow-proof',
  })
  assert.equal(anonymousFetches, 1)
  assert.equal(shallow.head, shallowHead)
  assert.equal(shallow.historyCount, 5)
  await publisher.push('owner', project.id, {
    previewId: shallow.previewId,
    token,
  })
  assert.equal(
    await git(destination, ['rev-parse', 'shallow-proof']),
    shallowHead,
  )
  assert.equal(
    await git(destination, ['rev-list', '--count', 'shallow-proof']),
    '5',
  )
  assert.equal(
    await git(source, ['rev-parse', '--is-shallow-repository']),
    'true',
  )
  report.checks.push(
    'A real depth-one import plus local commit was anonymously unshallowed in the sanitized export, pushed with all five ancestors, and left original shallow history unchanged.',
  )

  await scanSecrets(dataDir)
  assert.equal(
    (await fs.readdir(path.join(dataDir, 'runtime/homes'))).length,
    0,
  )
  report.checks.push(
    'Linked-object sources are rejected; one-use tokens are absent from retained files, and all worker homes are removed.',
  )
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = String(error.stack || error)
    .split(token)
    .join('[redacted]')
  process.exitCode = 1
} finally {
  await runtime.shutdown().catch(() => {})
  await fs.mkdir(output, { recursive: true })
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await fs.rm(dataDir, { recursive: true, force: true })
  console.log(JSON.stringify(report, null, 2))
}
