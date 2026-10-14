import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { runAuthenticatedRepositoryGit } from '../repository-git.mjs'
import { validateGitCredentials } from '../git-credentials.mjs'

const execute = promisify(execFile)
const TOKEN = 'fixture-only-read-token!+/%@'
const USERNAMES = new Set(['x-access-token', 'gitlab+deploy-token-123'])
const FIRST = 'example : True := by trivial\n'
const SECOND = 'example : 2 + 2 = 4 := by decide\n'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow https git '),
  )
  let server
  const children = new Set()
  const sockets = new Set()
  const stop = (child) => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  t.after(async () => {
    for (const child of children) stop(child)
    if (server?.listening) {
      const closed = new Promise((resolve) => server.close(resolve))
      for (const socket of sockets) socket.destroy()
      await closed
    }
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const env = {
    PATH: process.env.PATH,
    HOME: dataDir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  const command = (binary, args, options = {}) =>
    execute(binary, args, { env, timeout: 15000, ...options })
  const tls = path.join(dataDir, 'tls')
  await fs.mkdir(tls)
  await command('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '1',
    '-subj',
    '/CN=LeanFlow isolated Git test CA',
    '-keyout',
    path.join(tls, 'ca.key'),
    '-out',
    path.join(tls, 'ca.pem'),
  ])
  await command('openssl', [
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-subj',
    '/CN=localhost',
    '-keyout',
    path.join(tls, 'server.key'),
    '-out',
    path.join(tls, 'server.csr'),
  ])
  await fs.writeFile(
    path.join(tls, 'extensions'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
  )
  await command('openssl', [
    'x509',
    '-req',
    '-sha256',
    '-days',
    '1',
    '-in',
    path.join(tls, 'server.csr'),
    '-CA',
    path.join(tls, 'ca.pem'),
    '-CAkey',
    path.join(tls, 'ca.key'),
    '-CAcreateserial',
    '-extfile',
    path.join(tls, 'extensions'),
    '-out',
    path.join(tls, 'server.pem'),
  ])
  const source = path.join(dataDir, 'source')
  const repositories = path.join(dataDir, 'repositories')
  const bare = path.join(repositories, 'proofs.git')
  await fs.mkdir(repositories)
  await command('git', ['init', '--initial-branch=main', source])
  const git = (...args) => command('git', args, { cwd: source })
  await fs.writeFile(path.join(source, 'Main.lean'), FIRST)
  await git('add', 'Main.lean')
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Initial source',
  )
  await command('git', ['clone', '--bare', source, bare])
  const requests = []
  server = https.createServer(
    {
      key: await fs.readFile(path.join(tls, 'server.key')),
      cert: await fs.readFile(path.join(tls, 'server.pem')),
    },
    (request, response) => {
      const header = request.headers.authorization || ''
      const credential = header.startsWith('Basic ')
        ? Buffer.from(header.slice(6), 'base64').toString('utf8')
        : ''
      const colon = credential.indexOf(':')
      const username = colon < 0 ? '' : credential.slice(0, colon)
      const authenticated =
        USERNAMES.has(username) && credential.slice(colon + 1) === TOKEN
      requests.push({ username, authenticated, path: request.url })
      if (!authenticated) {
        response.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="LeanFlow Git fixture"',
          'Content-Type': 'text/plain',
        })
        const token = credential.slice(colon + 1)
        response.end(
          username
            ? `Access denied: ${token} ${encodeURIComponent(token)} ${header.slice(6)}\n`
            : 'Repository authentication required.\n',
        )
        return
      }
      const url = new URL(request.url, 'https://localhost')
      const child = spawn('git', ['http-backend'], {
        cwd: repositories,
        env: {
          ...env,
          GIT_PROJECT_ROOT: repositories,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method,
          CONTENT_TYPE: request.headers['content-type'] || '',
          CONTENT_LENGTH: request.headers['content-length'] || '',
          HTTP_GIT_PROTOCOL: request.headers['git-protocol'] || '',
          REMOTE_USER: username,
          REMOTE_ADDR: '127.0.0.1',
          SERVER_PROTOCOL: 'HTTP/1.1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
      children.add(child)
      const output = []
      let bytes = 0
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 1024 * 1024) stop(child)
        else output.push(chunk)
      })
      child.stderr.resume()
      child.on('error', () => {
        if (response.writableEnded || response.destroyed) return
        response.writeHead(500)
        response.end('Git fixture could not start.\n')
      })
      child.on('close', (code) => {
        children.delete(child)
        if (response.writableEnded || response.destroyed) return
        const value = Buffer.concat(output)
        const boundary = value.indexOf('\r\n\r\n')
        if (code !== 0 || boundary < 0) {
          response.writeHead(500)
          response.end('Git fixture failed.\n')
          return
        }
        let status = 200
        const headers = {}
        for (const line of value
          .subarray(0, boundary)
          .toString('utf8')
          .split('\r\n')) {
          const separator = line.indexOf(':')
          const key = line.slice(0, separator)
          const content = line.slice(separator + 1).trim()
          if (key.toLowerCase() === 'status')
            status = Number(content.split(' ')[0])
          else headers[key] = content
        }
        response.writeHead(status, headers)
        response.end(value.subarray(boundary + 4))
      })
      child.stdin.on('error', () => {})
      request.pipe(child.stdin)
    },
  )
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const remote = `https://localhost:${port}/proofs.git`
  const pin = `http.curloptResolve=localhost:${port}:127.0.0.1`
  const calls = []
  const runtime = {
    async run(root, args, options) {
      const workerHome = path.join(
        dataDir,
        'runtime',
        'homes',
        randomBytes(32).toString('hex'),
      )
      await fs.mkdir(workerHome, { recursive: true, mode: 0o700 })
      const childEnv = {
        ...env,
        ...options.env,
        HOME: workerHome,
        TMPDIR: workerHome,
        GIT_SSL_CAINFO: path.join(tls, 'ca.pem'),
      }
      calls.push({
        args,
        env: childEnv,
        freshHome: options.freshHome,
        cleanHome: options.cleanHome,
        readOnlyHome: options.readOnlyHome,
      })
      const child = spawn(args[0], args.slice(1), {
        cwd: root,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
      children.add(child)
      child.workerHome = workerHome
      options.onSpawn(child)
      return await new Promise((resolve, reject) => {
        let stdout = '',
          stderr = ''
        const timer = setTimeout(
          () => stop(child),
          Math.min(options.timeoutMs, 20000),
        )
        child.stdout.on('data', (value) => {
          stdout += value
        })
        child.stderr.on('data', (value) => {
          stderr += value
        })
        child.on('error', (error) => {
          children.delete(child)
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          children.delete(child)
          clearTimeout(timer)
          resolve({ code, stdout, stderr })
        })
        child.stdin.on('error', () => {})
        child.stdin.end(options.input)
      })
    },
  }
  const authenticatedGit = (root, args, credentials) =>
    runAuthenticatedRepositoryGit({
      runtime,
      dataDir,
      root,
      args: ['-c', pin, ...args],
      credentials,
      timeoutMs: 20000,
    })
  return {
    dataDir,
    git,
    command,
    bare,
    remote,
    requests,
    calls,
    authenticatedGit,
  }
}

async function assertNoSecretFiles(root, secrets) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name)
    if (entry.isDirectory()) await assertNoSecretFiles(filename, secrets)
    else if (entry.isFile()) {
      const contents = await fs.readFile(filename)
      for (const secret of secrets)
        assert(
          !contents.includes(Buffer.from(secret)),
          `Credentials persisted in ${filename}`,
        )
    }
  }
}

test(
  'private HTTPS imports authenticate real clone and fetch operations without retaining credentials',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t)
    const root = path.join(f.dataDir, 'token-only-clone')
    await fs.mkdir(root)
    const tokenOnly = validateGitCredentials({ token: TOKEN })
    const cloned = await f.authenticatedGit(
      root,
      ['clone', '--no-recurse-submodules', '--', f.remote, '.'],
      tokenOnly,
    )
    assert.equal(cloned.code, 0, cloned.stderr)
    assert.equal(await fs.readFile(path.join(root, 'Main.lean'), 'utf8'), FIRST)
    assert(
      f.requests.some((request) => !request.authenticated && !request.username),
      'Git should first receive a Basic challenge',
    )
    assert(
      f.requests.some(
        (request) =>
          request.authenticated && request.username === 'x-access-token',
      ),
    )
    await f.git('checkout', '-b', 'topic/private')
    await fs.writeFile(path.join(f.dataDir, 'source', 'Main.lean'), SECOND)
    await f.git('add', 'Main.lean')
    await f.git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Private branch',
    )
    await f.git('tag', 'release-one')
    await f.git('push', f.bare, 'topic/private', '--tags')
    const fetched = await f.authenticatedGit(
      root,
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--',
        f.remote,
        'refs/heads/topic/private:refs/remotes/origin/topic/private',
        'refs/tags/release-one:refs/tags/release-one',
      ],
      tokenOnly,
    )
    assert.equal(fetched.code, 0, fetched.stderr)
    for (const revision of [
      'refs/remotes/origin/topic/private',
      'refs/tags/release-one',
    ]) {
      const actual = await f.command('git', ['show', revision + ':Main.lean'], {
        cwd: root,
      })
      assert.equal(actual.stdout, SECOND)
    }
    const deployRoot = path.join(f.dataDir, 'gitlab-deploy-clone')
    await fs.mkdir(deployRoot)
    const deploy = validateGitCredentials({
      username: 'gitlab+deploy-token-123',
      token: TOKEN,
    })
    const deployed = await f.authenticatedGit(
      deployRoot,
      ['clone', '--no-recurse-submodules', '--', f.remote, '.'],
      deploy,
    )
    assert.equal(deployed.code, 0, deployed.stderr)
    assert(
      f.requests.some(
        (request) =>
          request.authenticated && request.username === deploy.username,
      ),
    )
    const invalid = validateGitCredentials({
      token: 'invalid-fixture-token!+/%@',
    })
    const invalidRoot = path.join(f.dataDir, 'invalid-token-clone')
    await fs.mkdir(invalidRoot)
    const rejected = await f.authenticatedGit(
      invalidRoot,
      ['clone', '--no-recurse-submodules', '--', f.remote, '.'],
      invalid,
    )
    assert.notEqual(rejected.code, 0)
    assert.match(rejected.stderr, /Authentication failed/i)
    assert.match(rejected.stderr, /\[redacted\]/)
    const secrets = [TOKEN, invalid.token].flatMap((token) => [
      token,
      encodeURIComponent(token),
      encodeURI(token),
      ...[...USERNAMES].map((username) =>
        Buffer.from(username + ':' + token).toString('base64'),
      ),
    ])
    for (const call of f.calls) {
      assert.equal(call.freshHome, true)
      assert.equal(call.cleanHome, true)
      assert.equal(call.readOnlyHome, true)
      assert.equal(call.env.GIT_SSL_NO_VERIFY, undefined)
      for (const secret of secrets)
        assert(!JSON.stringify([call.args, call.env]).includes(secret))
    }
    for (const result of [cloned, fetched, deployed, rejected])
      for (const secret of secrets)
        assert(!JSON.stringify(result).includes(secret))
    assert.deepEqual(
      await fs.readdir(path.join(f.dataDir, 'runtime', 'homes')),
      [],
    )
    await assertNoSecretFiles(f.dataDir, secrets)
  },
)
