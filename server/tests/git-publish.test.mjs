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
import { gitCredentialsRunner } from '../git-credentials.mjs'
import { gitReviewLink, gitReviewProvider } from '../git-review.mjs'

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
        (mapped.includes('fetch') || mapped.includes('push')) &&
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
  studio.gitConnections.resolveHost = studio.publisher.resolveHost
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
  assert.equal(preview.provider, 'other')
  assert.equal(preview.baseBranch, null)
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
    provider: 'other',
    baseBranch: null,
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

test('the publishing worker receives its one-use token only over stdin and starts with a clean home', async (t) => {
  const f = await fixture(t)
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
  })
  const root = f.publisher.previews.get(preview.previewId).root
  await assert.rejects(fs.stat(path.join(root, 'askpass.py')), {
    code: 'ENOENT',
  })
  const homes = path.join(f.dataDir, 'runtime', 'homes')
  const priorHomes = await fs.readdir(homes)
  f.remotes.set(DEST, 'file://' + f.target)
  f.publisher.publishTransport = undefined
  const token = 'fixture-stdin-only-token'
  const published = await f.publisher.push('owner', f.project.id, {
    previewId: preview.previewId,
    username: 'gitlab+deploy-token-123',
    token,
  })
  assert.equal(published.head, preview.head)
  const call = f.calls.find((entry) =>
    entry.args.includes(gitCredentialsRunner),
  )
  assert(call)
  assert.equal(call.options.cleanHome, true)
  assert.equal(call.options.freshHome, true)
  assert.equal(JSON.parse(call.options.input).token, token)
  assert(!JSON.stringify(call.args).includes(token))
  assert(!JSON.stringify(call.env).includes(token))
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
  assert.deepEqual(await fs.readdir(homes), priorHomes)
  await assert.rejects(fs.stat(root), { code: 'ENOENT' })
  const stored = await fs.readFile(
    path.join(f.dataDir, 'git-publish/destinations.json'),
    'utf8',
  )
  assert(!stored.includes(token))
})

test('review forms preserve the reviewed repository and safely encode branch names for GitHub, nested GitLab, and explicit self-hosted providers', () => {
  const branch = 'leanflow/improve-proof',
    baseBranch = 'release/4.35'
  const github = gitReviewLink({
    remoteUrl: 'https://github.com/alice/proofs.git',
    provider: 'github',
    branch,
    baseBranch,
  })
  assert.equal(github.kind, 'pull-request')
  assert.equal(
    github.url,
    'https://github.com/alice/proofs/compare/release%2F4.35...leanflow%2Fimprove-proof?quick_pull=1',
  )
  for (const remoteUrl of [
    'https://gitlab.com/group/subgroup/proofs.git',
    'https://git.example.invalid/group/subgroup/proofs.git',
  ]) {
    const gitlab = gitReviewLink({
      remoteUrl,
      provider: 'gitlab',
      branch,
      baseBranch,
    })
    const url = new URL(gitlab.url)
    assert.equal(gitlab.kind, 'merge-request')
    assert.equal(url.origin, new URL(remoteUrl).origin)
    assert.equal(url.pathname, '/group/subgroup/proofs/-/merge_requests/new')
    assert.equal(url.searchParams.get('merge_request[source_branch]'), branch)
    assert.equal(
      url.searchParams.get('merge_request[target_branch]'),
      baseBranch,
    )
  }
  assert.equal(
    gitReviewProvider('https://github.com/alice/proofs.git'),
    'github',
  )
  assert.equal(
    gitReviewProvider('https://gitlab.com/group/subgroup/proofs.git'),
    'gitlab',
  )
  assert.equal(
    gitReviewProvider('https://github.com.evil.invalid/alice/proofs.git'),
    'other',
  )
  assert.equal(
    gitReviewProvider('https://git.example.invalid/alice/proofs.git'),
    'other',
  )
  assert.equal(
    gitReviewLink({
      remoteUrl: 'https://github.com/alice/proofs.git',
      provider: 'other',
      branch,
    }),
    undefined,
  )
  for (const remoteUrl of [
    'https://name:token@github.com/alice/proofs.git',
    'https://github.com/alice/proofs.git?token=credential',
    'https://github.com/alice/proofs.git#fragment',
    'https://github.com/alice/proofs.git/extra',
    'https://github.com/alice%2Felsewhere/proofs.git',
    'https://github.com/alice/%252E%252E.git',
    'https://github.com/alice/%00proofs.git',
  ])
    assert.throws(() => gitReviewProvider(remoteUrl, 'github'), { status: 400 })
  assert.throws(() => gitReviewProvider(DEST, 'bitbucket'), { status: 400 })
})

test('pushing a reviewed topic branch returns a provider form bound to that preview and retains no credential', async (t) => {
  const f = await fixture(t)
  const remoteUrl = 'https://gitlab.com/group/subgroup/proofs.git'
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl,
    branch: 'leanflow/topic',
    baseBranch: 'release/stable',
  })
  assert.equal(preview.provider, 'gitlab')
  assert.equal(preview.baseBranch, 'release/stable')
  assert.equal(preview.review.kind, 'merge-request')
  let delivered
  f.publisher.publishTransport = async (input) => {
    delivered = input
    assert(input.args.includes(remoteUrl))
    assert(input.args.includes(`${preview.head}:refs/heads/leanflow/topic`))
    return { code: 0, stdout: '', stderr: '' }
  }
  const oneUse = 'dummy-topic-branch-repository-token'
  const result = await f.publisher.push('owner', f.project.id, {
    previewId: preview.previewId,
    token: oneUse,
    remoteUrl: 'https://unreviewed.example.invalid/elsewhere/repo.git',
    branch: 'main',
    provider: 'github',
    baseBranch: 'main',
  })
  assert.equal(result.remoteUrl, remoteUrl)
  assert.equal(result.branch, 'leanflow/topic')
  assert.equal(result.provider, 'gitlab')
  assert.equal(result.baseBranch, 'release/stable')
  assert.deepEqual(result.review, preview.review)
  assert.equal(
    delivered.credentials.token,
    '',
    'The in-memory credential is consumed after one push',
  )
  assert.equal(f.publisher.previews.has(preview.previewId), false)
  const metadata = await f.publisher.metadata('owner', f.project.id)
  assert.equal(metadata.provider, 'gitlab')
  assert.equal(metadata.baseBranch, 'release/stable')
  assert.equal(metadata.remoteUrl, remoteUrl)
  assert.match(
    metadata.suggestedBranch,
    /^leanflow\/\d{4}-\d{2}-\d{2}-[A-Za-z0-9]{1,8}$/,
  )
  const stored = await fs.readFile(
    path.join(f.dataDir, 'git-publish/destinations.json'),
    'utf8',
  )
  assert(!stored.includes(oneUse))
  assert(!JSON.stringify(result).includes(oneUse))
  await assert.rejects(
    fs.stat(path.join(f.dataDir, 'git-publish', preview.previewId)),
    { code: 'ENOENT' },
  )
  await assert.rejects(
    f.publisher.push('owner', f.project.id, {
      previewId: preview.previewId,
      token: oneUse,
    }),
    { status: 404 },
  )
})

test('publishing can be disabled without preventing local Git review and only the project owner can use a preview', async (t) => {
  const f = await fixture(t)
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
  })
  const project = f.workspaces.get(f.project.id, 'owner')
  project.publishingEnabled = false
  project.publishingBaseBranch = 'release/pinned'
  f.workspaces.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(project), project.id)
  const metadata = await f.publisher.metadata('owner', f.project.id)
  assert.equal(metadata.publishingEnabled, false)
  assert.equal(metadata.baseBranch, 'release/pinned')
  assert.equal(metadata.commits[0].message, 'Initial valid source')
  await assert.rejects(
    f.publisher.preview('owner', f.project.id, { remoteUrl: DEST }),
    /Enable publishing/,
  )
  await assert.rejects(
    f.publisher.push('owner', f.project.id, {
      previewId: preview.previewId,
      token: 'dummy-disabled-token',
    }),
    /Enable publishing/,
  )
  await assert.rejects(
    f.publisher.push('another-owner', f.project.id, {
      previewId: preview.previewId,
    }),
    { status: 404 },
  )
  assert.equal(f.sent.length, 0)
})

test('known and self-hosted provider choices survive reopening while other Git hosts keep ordinary pushing', async (t) => {
  const f = await fixture(t)
  const cases = [
    {
      remoteUrl: 'https://github.com/alice/proofs.git',
      provider: 'github',
      expectedReview: 'pull-request',
    },
    {
      remoteUrl: 'https://git.example.invalid/group/subgroup/proofs.git',
      provider: 'gitlab',
      expectedReview: 'merge-request',
    },
    {
      remoteUrl: 'https://github.com/alice/proofs.git',
      provider: 'other',
    },
    { remoteUrl: DEST, provider: 'other' },
  ]
  f.publisher.publishTransport = async () => ({
    code: 0,
    stdout: '',
    stderr: '',
  })
  for (const item of cases) {
    const preview = await f.publisher.preview('owner', f.project.id, {
      remoteUrl: item.remoteUrl,
      provider: item.provider,
      branch: 'leanflow/export',
      baseBranch: 'main',
    })
    const result = await f.publisher.push('owner', f.project.id, {
      previewId: preview.previewId,
    })
    assert.equal(result.provider, item.provider)
    assert.equal(result.review?.kind, item.expectedReview)
    const metadata = await f.publisher.metadata('owner', f.project.id)
    assert.equal(metadata.provider, item.provider)
    assert.equal(metadata.remoteUrl, item.remoteUrl)
    assert.equal(metadata.baseBranch, 'main')
  }
  await fs.writeFile(
    path.join(f.dataDir, 'git-publish/destinations.json'),
    JSON.stringify({
      owner: { [f.project.id]: 'https://github.com/alice/proofs.git' },
    }),
  )
  const legacy = await f.publisher.metadata('owner', f.project.id)
  assert.equal(legacy.remoteUrl, 'https://github.com/alice/proofs.git')
  assert.equal(legacy.provider, 'github')
})

test('review defaults use the local origin HEAD rather than the working branch, and explicitly clearing a base persists', async (t) => {
  const f = await fixture(t)
  await f.git('switch', '-c', 'leanflow/improved-proofs')
  let metadata = await f.publisher.metadata('owner', f.project.id)
  assert.equal(metadata.branch, 'leanflow/improved-proofs')
  assert.equal(
    metadata.baseBranch,
    null,
    'An unknown repository default is not guessed from the working branch',
  )
  const head = (await f.git('rev-parse', 'HEAD')).stdout.trim()
  await f.git('update-ref', 'refs/remotes/origin/main', head)
  await f.git(
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  )
  await f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'New revision with known origin default',
  )
  metadata = await f.publisher.metadata('owner', f.project.id)
  assert.equal(metadata.baseBranch, 'main')
  assert(
    !f.calls.some((call) => call.options.network === 'bridge'),
    'Finding a default branch never contacts a repository',
  )

  const project = f.workspaces.get(f.project.id, 'owner')
  project.publishingBaseBranch = 'release/pinned'
  f.workspaces.db
    .prepare('UPDATE projects SET data=? WHERE id=?')
    .run(JSON.stringify(project), project.id)
  f.publisher.publishTransport = async () => ({
    code: 0,
    stdout: '',
    stderr: '',
  })
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: 'https://github.com/alice/proofs.git',
    branch: 'leanflow/improved-proofs',
    baseBranch: '',
  })
  assert.equal(preview.baseBranch, null)
  assert.equal(
    new URL(preview.review.url).pathname,
    '/alice/proofs/compare/leanflow%2Fimproved-proofs',
  )
  await f.publisher.push('owner', f.project.id, {
    previewId: preview.previewId,
  })
  metadata = await f.publisher.metadata('owner', f.project.id)
  assert.equal(
    metadata.baseBranch,
    null,
    'Cleared targets stay at the provider default despite known local defaults',
  )
  const remembered = JSON.parse(
    await fs.readFile(
      path.join(f.dataDir, 'git-publish/destinations.json'),
      'utf8',
    ),
  )
  assert.equal(remembered.owner[f.project.id].baseBranch, null)
})

test('pushing directly to the review target stays supported and emits no empty pull or merge request form', async (t) => {
  const f = await fixture(t)
  f.publisher.publishTransport = async () => ({
    code: 0,
    stdout: '',
    stderr: '',
  })
  for (const remoteUrl of [
    'https://github.com/alice/proofs.git',
    'https://gitlab.com/group/proofs.git',
  ]) {
    const preview = await f.publisher.preview('owner', f.project.id, {
      remoteUrl,
      branch: 'main',
      baseBranch: 'main',
    })
    assert.equal(preview.review, undefined)
    const result = await f.publisher.push('owner', f.project.id, {
      previewId: preview.previewId,
    })
    assert.equal(result.pushed, true)
    assert.equal(result.review, undefined)
    assert.equal(result.baseBranch, 'main')
  }
})

test('only a confirmed push is recoverable after reopening, and its saved review remains scoped to its owner without credentials', async (t) => {
  const f = await fixture(t)
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: 'https://github.com/alice/proofs.git',
    branch: 'leanflow/recoverable-publication',
    baseBranch: 'main',
  })
  assert.equal(
    (await f.publisher.metadata('owner', f.project.id)).lastPublished,
    undefined,
  )
  let release, began
  const entered = new Promise((resolve) => {
      began = resolve
    }),
    gate = new Promise((resolve) => {
      release = resolve
    })
  f.publisher.publishTransport = async () => {
    began()
    await gate
    return { code: 0, stdout: '', stderr: '' }
  }
  const token = 'dummy-confirmed-publication-token'
  const publishing = f.publisher.push('owner', f.project.id, {
    previewId: preview.previewId,
    token,
  })
  await entered
  assert.equal(
    (await f.publisher.metadata('owner', f.project.id)).lastPublished,
    undefined,
    'An in-progress push is not reported as confirmed',
  )
  release()
  const confirmed = await publishing
  const reopened = await new GitPublisher({
    dataDir: f.dataDir,
    runtime: f.runtime,
    workspaces: f.workspaces,
  }).init()
  const info = await reopened.metadata('owner', f.project.id)
  assert.deepEqual(info.lastPublished, confirmed)
  assert.equal(info.lastPublished.review.kind, 'pull-request')
  const stored = await fs.readFile(
    path.join(f.dataDir, 'git-publish/destinations.json'),
    'utf8',
  )
  assert(!stored.includes(token))
  assert(!stored.includes('username'))
  assert.deepEqual(
    JSON.parse(stored).owner[f.project.id].lastPublished,
    confirmed,
  )
  await assert.rejects(reopened.metadata('another-owner', f.project.id), {
    status: 404,
  })
  const otherProject = await f.workspaces.create('another-owner', {
    name: 'Separate owner',
    preset: 'lean',
    autoRepair: false,
  })
  await f.workspaces.jobs.get(otherProject.id)
  assert.equal(
    (await reopened.metadata('another-owner', otherProject.id)).lastPublished,
    undefined,
  )

  const rejected = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: 'https://github.com/alice/proofs.git',
    branch: 'leanflow/rejected-publication',
    baseBranch: 'main',
  })
  f.publisher.publishTransport = async () => ({
    code: 1,
    stderr: 'fixture remote rejects this push',
    stdout: '',
  })
  await assert.rejects(
    f.publisher.push('owner', f.project.id, { previewId: rejected.previewId }),
    /rejected this push/,
  )
  assert.deepEqual(
    (await reopened.metadata('owner', f.project.id)).lastPublished,
    confirmed,
    'Failed attempts do not overwrite the last confirmed push',
  )
})

test('successful pushes retain the existing actionable warning when publication metadata cannot be saved', async (t) => {
  const f = await fixture(t)
  f.publisher.publishTransport = async () => ({
    code: 0,
    stdout: '',
    stderr: '',
  })
  const initial = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
    branch: 'initial-publication',
  })
  const confirmed = await f.publisher.push('owner', f.project.id, {
    previewId: initial.previewId,
  })
  const next = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
    branch: 'unsaved-publication',
  })
  const originalDir = f.publisher.dir
  f.publisher.dir = path.join(f.dataDir, 'missing-publication-storage')
  const result = await f.publisher.push('owner', f.project.id, {
    previewId: next.previewId,
  })
  assert.equal(result.pushed, true)
  assert.equal(result.branch, 'unsaved-publication')
  assert.match(result.warning, /pushed.*could not be saved/)
  f.publisher.dir = originalDir
  assert.deepEqual(
    (await f.publisher.metadata('owner', f.project.id)).lastPublished,
    confirmed,
  )
})

test('positive and negative origin-default lookups reuse their worker result until the source HEAD changes', async (t) => {
  const f = await fixture(t)
  const lookups = () =>
    f.calls.filter((call) => call.args.includes('refs/remotes/origin/HEAD'))
      .length
  assert.equal(
    (await f.publisher.metadata('owner', f.project.id)).baseBranch,
    null,
  )
  const first = lookups()
  assert.equal(first, 1)
  await f.publisher.metadata('owner', f.project.id)
  assert.equal(lookups(), first, 'Missing defaults are cached too')
  const head = (await f.git('rev-parse', 'HEAD')).stdout.trim()
  await f.git('update-ref', 'refs/remotes/origin/main', head)
  await f.git(
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
  )
  await f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'Invalidate default branch cache',
  )
  assert.equal(
    (await f.publisher.metadata('owner', f.project.id)).baseBranch,
    'main',
  )
  assert.equal(lookups(), first + 1)
  await f.publisher.metadata('owner', f.project.id)
  assert.equal(lookups(), first + 1, 'Known defaults reuse the same result')
  assert(!f.calls.some((call) => call.options.network === 'bridge'))
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
  for (const input of [
    { provider: 'bitbucket' },
    { provider: null },
    { baseBranch: 'HEAD' },
    { baseBranch: '../main' },
    { baseBranch: 'release/.secret' },
    { baseBranch: 'main.lock' },
    { baseBranch: 123 },
  ])
    await assert.rejects(
      f.publisher.preview('owner', f.project.id, { remoteUrl: DEST, ...input }),
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

test('saved Git connection and author are reused by UI commit and reviewed push without resubmitting credentials', async (t) => {
  const f = await fixture(t)
  const shared = 'fixture-shared-publish-token'
  await f.gitConnections.connect('owner', {
    host: 'git.example.invalid',
    provider: 'other',
    username: 'shared-user',
    token: shared,
  })
  await f.gitConnections.setIdentity('owner', {
    name: 'Shared Author',
    email: 'shared@example.invalid',
  })
  let response = await f.request(undefined, 'GET')
  assert.deepEqual((await response.json()).author, {
    name: 'Shared Author',
    email: 'shared@example.invalid',
  })
  await fs.writeFile(
    path.join(f.root, 'Main.lean'),
    'example : True := by\n  trivial\n',
  )
  response = await f.request({
    action: 'commit',
    message: 'Use shared commit identity',
  })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(
    (await f.git('log', '-1', '--format=%an%n%ae')).stdout.trim(),
    'Shared Author\nshared@example.invalid',
  )
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
    branch: 'proof/shared-connection',
  })
  const result = await f.publisher.push('owner', f.project.id, {
    previewId: preview.previewId,
  })
  assert.equal(result.pushed, true)
  assert.deepEqual(f.sent.at(-1).credentials, {
    username: 'shared-user',
    token: shared,
  })
  assert.equal(
    (await f.gitConnections.credentials('owner', DEST)).token,
    shared,
  )
  const override = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
    branch: 'proof/override',
  })
  await f.publisher.push('owner', f.project.id, {
    previewId: override.previewId,
    token: 'fixture-one-use-override',
  })
  assert.equal(f.sent.at(-1).credentials.token, 'fixture-one-use-override')
  assert.equal(
    (await f.gitConnections.credentials('owner', DEST)).token,
    shared,
  )
  const metadata = JSON.stringify(
    await f.publisher.metadata('owner', f.project.id),
  )
  assert.equal(metadata.includes(shared), false)
  assert(
    !f.calls.some((call) =>
      JSON.stringify({ args: call.args, env: call.env }).includes(shared),
    ),
  )
})

test('truncated rejected pushes cannot expose a saved token prefix', async (t) => {
  const f = await fixture(t)
  const shared = 'fixture-truncated-shared-token'
  await f.gitConnections.connect('owner', {
    host: 'git.example.invalid',
    provider: 'other',
    token: shared,
  })
  const preview = await f.publisher.preview('owner', f.project.id, {
    remoteUrl: DEST,
    branch: 'proof/truncated',
  })
  f.publisher.publishTransport = async () => ({
    code: 128,
    truncated: true,
    stdout: '',
    stderr: shared.slice(0, 17),
  })
  await assert.rejects(
    f.publisher.push('owner', f.project.id, { previewId: preview.previewId }),
    (error) => {
      assert.match(error.message, /output exceeded/)
      assert.equal(error.message.includes(shared.slice(0, 17)), false)
      return true
    },
  )
})
