import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import syncFs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createStudio } from '../studio.mjs'
import { GitPublisher } from '../git-publish.mjs'

const execute = promisify(execFile)
const DEST = 'https://git.example.invalid/alice/proofs.git'
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-publish-'))
  const calls = [],
    remotes = new Map()
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async shutdown() {},
    spawn(root, args, options = {}) {
      const home = path.join(
        dataDir,
        'runtime/homes',
        createHash('sha256').update(randomUUID()).digest('hex'),
      )
      syncFs.mkdirSync(home, { recursive: true, mode: 0o700 })
      const mapped = args
        .map((value) =>
          value.replaceAll('/workspace', root).replaceAll('/home/worker', home),
        )
        .map((value) => remotes.get(value) || value)
      if (
        mapped.includes('fetch') &&
        mapped.some((value) => value.startsWith('file://'))
      )
        mapped.splice(
          mapped.indexOf('git') + 1,
          0,
          '-c',
          'protocol.file.allow=always',
        )
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        ...Object.fromEntries(
          Object.entries(options.env || {}).map(([key, value]) => [
            key,
            String(value).replaceAll('/workspace', root),
          ]),
        ),
      }
      calls.push({ root, args, options, env })
      const child = spawn(mapped[0], mapped.slice(1), {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      child.workerHome = home
      return child
    },
    async run(root, args, options = {}) {
      if (['lake', 'lean'].includes(args[0])) {
        if (args[0] === 'lake' && args[1] === 'update') {
          await fs.mkdir(path.join(root, '.lake'), { recursive: true })
          await fs.writeFile(
            path.join(root, 'lake-manifest.json'),
            '{"packages":[]}',
          )
        }
        return { code: 0, stdout: '', stderr: '' }
      }
      const child = this.spawn(root, args, options)
      options.onSpawn?.(child)
      return new Promise((resolve, reject) => {
        let stdout = '',
          stderr = ''
        child.stdout.on('data', (data) => {
          stdout += data
        })
        child.stderr.on('data', (data) => {
          stderr += data
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, stdout, stderr }))
        child.stdin.end(options.input)
      })
    },
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    config: {
      defaultModel: 'fixture',
      models: [],
      provider: {},
      lemex: {},
      redact: String,
    },
  })
  studio.publisher.resolveHost = async () => [{ address: '93.184.216.34' }]
  const project = await studio.workspaces.create('owner', {
    name: 'Publishing fixture',
    preset: 'lean',
    autoRepair: false,
  })
  await studio.workspaces.jobs.get(project.id)
  const root = studio.workspaces.repositoryRoot(project)
  const git = async (...args) =>
    execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: dataDir,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
  await git('add', 'Main.lean', 'lakefile.toml', 'lean-toolchain')
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Initial valid source',
  )
  const target = path.join(dataDir, 'target.git')
  await execute('git', ['init', '--bare', target])
  const sent = []
  studio.publisher.publishTransport = async (input) => {
    sent.push({ ...input, credentials: { ...input.credentials } })
    assert.equal('GIT_SSL_NO_VERIFY' in input.env, false)
    assert(!input.args.includes('--force'))
    assert(input.args.includes('http.sslVerify=true'))
    assert(
      input.args.some((value) =>
        value.startsWith('http.curloptResolve=git.example.invalid:443:'),
      ),
    )
    const args = input.args
      .map((value) => value.replaceAll('/workspace', input.root))
      .map((value) => (value === DEST ? target : value))
    args.splice(1, 0, '-c', 'protocol.file.allow=always')
    try {
      return {
        code: 0,
        ...(await execute(args[0], args.slice(1), {
          cwd: input.root,
          env: { PATH: process.env.PATH, HOME: dataDir, ...input.env },
          maxBuffer: 1024 * 1024,
        })),
      }
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr }
    }
  }
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const request = (body, method = 'POST') =>
    fetch(
      `http://127.0.0.1:${studio.server.address().port}/api/projects/${project.id}/git`,
      {
        method,
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: 'Bearer ' + token,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      },
    )
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return {
    ...studio,
    dataDir,
    root,
    git,
    project,
    runtime,
    calls,
    request,
    target,
    sent,
    remotes,
  }
}

test('preview exports committed objects only and publishes the exact reviewed HEAD without retaining a token', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(
    path.join(f.root, 'Uncommitted.lean'),
    '-- Not published\n',
  )
  await f.git(
    'remote',
    'add',
    'origin',
    'https://worker:credential@untrusted.example.invalid/project.git',
  )
  const info = await (await f.request(undefined, 'GET')).json()
  assert.equal(
    info.remoteUrl,
    null,
    'Worker-controlled origin is never an automatic publish destination',
  )
  assert.equal(info.commits[0].message, 'Initial valid source')
  assert.equal(info.mutationBlocked, false)
  assert(!JSON.stringify(info).includes('credential'))
  const previewResponse = await f.request({
    action: 'preview-push',
    remoteUrl: DEST,
  })
  assert.equal(
    previewResponse.status,
    200,
    await previewResponse.clone().text(),
  )
  const preview = await previewResponse.json()
  assert.equal(preview.branch, 'main')
  assert.equal(preview.historyCount, 1)
  assert.equal(preview.uncommittedCount, info.changes.length)
  const oneUse = 'dummy-repository-token-not-a-real-credential'
  const pushed = await f.request({
    action: 'push',
    previewId: preview.previewId,
    token: oneUse,
  })
  assert.equal(pushed.status, 200, await pushed.clone().text())
  assert.deepEqual(await pushed.json(), {
    pushed: true,
    head: preview.head,
    branch: 'main',
    remoteUrl: DEST,
  })
  assert.equal(
    (
      await execute('git', [
        '--git-dir=' + f.target,
        'rev-parse',
        'refs/heads/main',
      ])
    ).stdout.trim(),
    preview.head,
  )
  const tree = (
    await execute('git', [
      '--git-dir=' + f.target,
      'ls-tree',
      '-r',
      '--name-only',
      'refs/heads/main',
    ])
  ).stdout
  assert(!tree.includes('Uncommitted.lean'))
  assert(
    !f.calls.some(
      (call) =>
        JSON.stringify(call.args).includes(oneUse) ||
        JSON.stringify(call.env).includes(oneUse),
    ),
  )
  assert(
    !f.calls.some(
      (call) => call.root === f.root && call.options.network === 'bridge',
    ),
  )
  assert.equal(f.sent[0].credentials.token, oneUse)
  assert.equal(
    (await f.publisher.metadata('owner', f.project.id)).remoteUrl,
    DEST,
  )
  const stored = await fs.readFile(
    path.join(f.dataDir, 'git-publish/destinations.json'),
    'utf8',
  )
  assert(!stored.includes(oneUse))
  assert.equal(
    (await fs.stat(path.join(f.dataDir, 'git-publish/destinations.json')))
      .mode & 0o777,
    0o600,
  )
  assert.equal(
    (await f.request({ action: 'push', previewId: preview.previewId })).status,
    404,
  )
})

test('publish previews reject private destinations, wrong owners, stale HEADs, expiry, and invalid branch/token input', async (t) => {
  const f = await fixture(t)
  for (const remoteUrl of [
    'file:///tmp/repo.git',
    'http://example.com/repo.git',
    'https://127.0.0.1/repo.git',
    'https://name:secret@example.com/repo.git',
  ])
    await assert.rejects(
      f.publisher.preview('owner', f.project.id, { remoteUrl }),
      { status: 400 },
    )
  for (const branch of ['HEAD', 'topic/.hidden', '../bad', 'main.lock'])
    await assert.rejects(
      f.publisher.preview('owner', f.project.id, { remoteUrl: DEST, branch }),
      { status: 400 },
    )
  let preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
  })
  await assert.rejects(
    f.publisher.push('someone-else', f.project.id, {
      previewId: preview.previewId,
    }),
    { status: 404 },
  )
  await assert.rejects(
    f.publisher.push('owner', f.project.id, {
      previewId: preview.previewId,
      token: 'unicode-é',
    }),
    { status: 400 },
  )
  await fs.writeFile(
    path.join(f.root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await f.git('add', 'Main.lean')
  await f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'New HEAD',
  )
  await assert.rejects(
    f.publisher.push('owner', f.project.id, { previewId: preview.previewId }),
    /HEAD changed/,
  )
  preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
  })
  const item = f.publisher.previews.get(preview.previewId)
  f.publisher.now = () => item.expiresAt + 1
  await assert.rejects(
    f.publisher.push('owner', f.project.id, { previewId: preview.previewId }),
    /expired/,
  )
  assert.equal(f.sent.length, 0)
})

test('commit review sees new nested files and detects changed untracked bytes before staging', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.root, 'NewFolder'))
  await fs.writeFile(
    path.join(f.root, 'NewFolder/Helper.lean'),
    'example : True := by trivial\n',
  )
  const first = await (await f.request(undefined, 'GET')).json()
  assert(
    first.changes.some((change) => change.path === 'NewFolder/Helper.lean'),
  )
  await fs.writeFile(
    path.join(f.root, 'NewFolder/Helper.lean'),
    'example : True := by constructor\n',
  )
  const second = await (await f.request(undefined, 'GET')).json()
  assert.notEqual(first.reviewToken, second.reviewToken)
  const stale = await f.request({
    action: 'commit',
    message: 'Reviewed content',
    reviewToken: first.reviewToken,
  })
  assert.equal(stale.status, 409)
  assert.equal((await f.git('diff', '--cached', '--name-only')).stdout, '')
  const fresh = await f.request({
    action: 'commit',
    message: 'Reviewed content',
    reviewToken: second.reviewToken,
    authorName: 'Proof Author',
    authorEmail: 'proof@example.invalid',
  })
  assert.equal(fresh.status, 200, await fresh.clone().text())
  assert.equal(
    (await f.git('log', '-1', '--format=%an <%ae>')).stdout.trim(),
    'Proof Author <proof@example.invalid>',
  )
})

test('busy publishing blocks competing Git mutations and new checks, runs, preparation, and deletion without blocking reads', async (t) => {
  const f = await fixture(t)
  let release, started
  const gate = new Promise((resolve) => {
      release = resolve
    }),
    entered = new Promise((resolve) => {
      started = resolve
    })
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
  })
  f.publisher.publishTransport = async () => {
    started()
    await gate
    return { code: 0, stdout: '', stderr: '' }
  }
  const push = f.publisher.push('owner', f.project.id, {
    previewId: preview.previewId,
  })
  await entered
  assert(
    !f.workspaces.locks.has(f.project.id),
    'Network publishing must not hold the editor workspace lock',
  )
  const info = await (await f.request(undefined, 'GET')).json()
  assert.equal(info.mutationBlocked, true)
  assert.equal(
    (await f.request({ action: 'branch', name: 'concurrent' })).status,
    409,
  )
  const token = (
    await fs.readFile(path.join(f.dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  for (const [suffix, body] of [
    ['check', { path: 'Main.lean' }],
    ['runs', { mode: 'proofs', prompt: 'Do not run.' }],
    ['prepare', {}],
    ['trash', { path: 'Main.lean' }],
  ]) {
    const response = await fetch(
      `http://127.0.0.1:${f.server.address().port}/api/projects/${f.project.id}/${suffix}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    assert.equal(response.status, 409, suffix)
  }
  release()
  await push
})

test('push errors redact raw, URL-encoded, and Basic credentials and consume attempted previews', async (t) => {
  const f = await fixture(t),
    token = 'dummy!+repository-token',
    username = 'fixture-user'
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
  })
  const basic = Buffer.from(username + ':' + token).toString('base64')
  f.publisher.publishTransport = async () => ({
    code: 1,
    stdout: '',
    stderr: token + ' ' + encodeURIComponent(token) + ' ' + basic,
  })
  const response = await f.request({
    action: 'push',
    previewId: preview.previewId,
    token,
    username,
  })
  assert.equal(response.status, 409)
  const error = await response.text()
  for (const secret of [token, encodeURIComponent(token), basic])
    assert(!error.includes(secret))
  assert.equal(f.publisher.previews.has(preview.previewId), false)
})

test('linked repositories, object alternates, and source grafts fail before credentialed workers start', async (t) => {
  const f = await fixture(t)
  for (const relative of ['objects/info/alternates', 'info/grafts']) {
    const filename = path.join(f.root, '.git', relative)
    await fs.writeFile(filename, 'unsupported\n')
    await assert.rejects(
      f.publisher.preview('owner', f.project.id, { remoteUrl: DEST }),
      { status: 409 },
    )
    await fs.unlink(filename)
  }
  await fs.rename(path.join(f.root, '.git'), path.join(f.root, 'saved.git'))
  await fs.symlink('saved.git', path.join(f.root, '.git'))
  await assert.rejects(
    f.publisher.preview('owner', f.project.id, { remoteUrl: DEST }),
    { status: 409 },
  )
  assert.equal(f.sent.length, 0)
})

test('startup reclaims only orphan UUID preview directories and repeated init preserves active previews', async (t) => {
  const f = await fixture(t)
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
  })
  const root = f.publisher.previews.get(preview.previewId).root
  await f.publisher.init()
  assert((await fs.stat(root)).isDirectory())
  const orphan = path.join(f.dataDir, 'git-publish', randomUUID()),
    preserved = path.join(f.dataDir, 'git-publish', 'recovery-notes')
  await fs.mkdir(orphan)
  await fs.mkdir(preserved)
  await fs.writeFile(
    path.join(f.dataDir, 'git-publish/destinations.json'),
    '{}',
  )
  const restarted = new GitPublisher({
    dataDir: f.dataDir,
    runtime: f.runtime,
    workspaces: f.workspaces,
  })
  await restarted.init()
  await assert.rejects(fs.stat(root), { code: 'ENOENT' })
  await assert.rejects(fs.stat(orphan), { code: 'ENOENT' })
  assert((await fs.stat(preserved)).isDirectory())
  assert.equal(
    await fs.readFile(
      path.join(f.dataDir, 'git-publish/destinations.json'),
      'utf8',
    ),
    '{}',
  )
})
