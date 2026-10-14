import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { WorkspaceStore } from '../workspaces.mjs'
import { createStudio } from '../studio.mjs'
import { GitPublisher } from '../git-publish.mjs'

const execute = promisify(execFile)
const repository = 'https://git.example.invalid/owner/proofs.git'
const toolchain = 'leanprover/lean4:v4.34.1'

async function fixture(t, { nested = false, api = false } = {}) {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-publish-import-'),
  )
  const dataDir = path.join(temporary, 'data')
  const source = path.join(temporary, 'source')
  const prefix = nested ? 'Lean/' : ''
  const files = new Map([
    [prefix + 'lean-toolchain', toolchain + '\n'],
    [prefix + 'lakefile.toml', 'name = "pinned_fixture"\n'],
    [
      prefix + 'lake-manifest.json',
      JSON.stringify({
        name: 'pinned_fixture',
        packages: [
          {
            name: 'fixturelib',
            type: 'git',
            url: 'https://git.example.invalid/owner/library.git',
            rev: 'c'.repeat(40),
            inherited: false,
          },
        ],
      }) + '\n',
    ],
    [prefix + 'Main.lean', 'theorem unfinished : True := by\n  sorry\n'],
    ['README.md', 'Keep the source repository unchanged.\n'],
  ])
  for (const [name, content] of files) {
    const filename = path.join(source, name)
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, content)
  }
  const env = {
    PATH: process.env.PATH,
    HOME: temporary,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
  const git = async (root, ...args) =>
    (
      await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: root,
        env,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim()
  await git(source, 'init', '--initial-branch=main')
  await git(source, 'add', '.')
  await git(
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Pinned source',
  )
  await git(source, 'tag', 'fixture-pin')
  const pinnedHead = await git(source, 'rev-parse', 'fixture-pin')
  await git(source, 'branch', 'release/pinned', pinnedHead)
  await fs.appendFile(
    path.join(source, prefix + 'Main.lean'),
    '-- Later source revision\n',
  )
  await git(source, 'add', '.')
  await git(
    source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Later source',
  )
  const latestHead = await git(source, 'rev-parse', 'HEAD')
  const calls = []
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [
      { id: 'lean', toolchain },
      { id: 'mathlib', toolchain },
    ],
    templateRoot: () => null,
    async prepareToolchain() {},
    async run(root, args, options = {}) {
      options.signal?.throwIfAborted()
      calls.push({ root, args: [...args] })
      const gitIndex = args[0] === 'git' ? 0 : args.indexOf('git', 3)
      if (gitIndex < 0)
        return { code: 0, stdout: 'Lean version 4.34.1', stderr: '' }
      let workerHome
      if (options.freshHome) {
        workerHome = path.join(
          dataDir,
          'runtime/homes',
          createHash('sha256').update(randomUUID()).digest('hex'),
        )
        await fs.mkdir(workerHome, { recursive: true, mode: 0o700 })
        options.onSpawn?.({ workerHome })
      }
      const mapped = args
        .slice(gitIndex + 1)
        .map((value) =>
          value === repository
            ? pathToFileURL(source).href
            : value
                .replaceAll('/workspace', root)
                .replaceAll('/home/worker', workerHome || temporary),
        )
      const command = mapped.findIndex((value) =>
        ['clone', 'fetch'].includes(value),
      )
      if (command >= 0)
        mapped.splice(command, 0, '-c', 'protocol.file.allow=always')
      try {
        const execution = execute('git', mapped, {
          cwd: root,
          env: { ...env, HOME: workerHome || temporary },
          signal: options.signal,
          maxBuffer: 1024 * 1024,
        })
        execution.child.stdin.end(options.input)
        return {
          code: 0,
          ...(await execution),
        }
      } catch (error) {
        return {
          code: error.code,
          stdout: error.stdout || '',
          stderr: error.stderr || '',
        }
      }
    },
  }
  let studio
  const store = api
    ? (studio = await createStudio({
        dataDir,
        runtime,
        config: {
          defaultModel: 'fixture',
          models: [],
          provider: {},
          lemex: {},
          redact: String,
        },
      })).workspaces
    : await new WorkspaceStore({ dataDir, runtime }).init()
  store.resolveHost = async () => [{ address: '93.184.216.34' }]
  const create = async (input = {}, owner = 'owner') => {
    const project = await store.create(owner, {
      repository,
      autoRepair: false,
      ...input,
    })
    await store.jobs.get(project.id)
    const ready = store.get(project.id, owner)
    assert.equal(ready.status, 'ready', ready.error)
    return ready
  }
  const assertPinnedFiles = async (project, revision = pinnedHead) => {
    const checkout = store.repositoryRoot(project)
    const names = (
      await git(source, 'ls-tree', '-r', '--name-only', revision)
    ).split('\n')
    for (const name of names) {
      const expected = await execute('git', ['show', `${revision}:${name}`], {
        cwd: source,
        env,
      })
      assert.equal(
        await fs.readFile(path.join(checkout, name), 'utf8'),
        expected.stdout,
        name,
      )
    }
    assert.equal(await git(checkout, 'diff', '--name-only', revision), '')
    assert.equal(await git(checkout, 'rev-parse', 'HEAD'), revision)
    assert.equal(project.sourceRevision, revision)
    assert.equal(project.toolchain, toolchain)
  }
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    if (studio) await studio.close()
    else store.close()
    await fs.rm(temporary, { recursive: true, force: true })
  })
  return {
    store,
    runtime,
    calls,
    create,
    git,
    source,
    dataDir,
    studio,
    pinnedHead,
    latestHead,
    assertPinnedFiles,
  }
}

test('publishing-enabled imports create unique working branches at the selected source revision without changing pins or proofs', async (t) => {
  const f = await fixture(t)
  const first = await f.create({
    publishingEnabled: true,
    revision: 'fixture-pin',
  })
  const second = await f.create({
    publishingEnabled: true,
    revision: 'fixture-pin',
  })
  assert.notEqual(f.pinnedHead, f.latestHead)
  assert.notEqual(first.workingBranch, second.workingBranch)
  for (const project of [first, second]) {
    assert.equal(project.publishingEnabled, true)
    assert.equal(project.publishingBranchPrepared, true)
    assert.equal(project.publishingBaseBranch, 'main')
    assert.match(project.workingBranch, /^leanflow\//)
    assert.equal(
      await f.git(
        f.store.repositoryRoot(project),
        'symbolic-ref',
        '--short',
        'HEAD',
      ),
      project.workingBranch,
    )
    await f.assertPinnedFiles(project)
    assert.equal(
      await fs
        .readFile(
          path.join(f.store.repositoryRoot(project), '.git/shallow'),
          'utf8',
        )
        .then((value) => value.includes(f.pinnedHead)),
      true,
    )
  }
  assert.equal(await f.git(f.source, 'symbolic-ref', '--short', 'HEAD'), 'main')
  assert.equal(await f.git(f.source, 'rev-parse', 'HEAD'), f.latestHead)
  assert.equal(
    f.calls.some(({ args }) => args.includes('push')),
    false,
  )
})

test('an explicit working branch belongs to the full checkout of a nested Lean project', async (t) => {
  const f = await fixture(t, { nested: true })
  const project = await f.create({
    publishingEnabled: true,
    workingBranch: 'proof/my-theorem',
    revision: 'fixture-pin',
    subdirectory: 'Lean',
  })
  assert.equal(project.root, path.join(f.store.repositoryRoot(project), 'Lean'))
  assert.equal(project.workingBranch, 'proof/my-theorem')
  assert.equal(
    await f.git(
      f.store.repositoryRoot(project),
      'symbolic-ref',
      '--short',
      'HEAD',
    ),
    'proof/my-theorem',
  )
  assert(
    f.calls
      .filter(({ args }) => args[0] === 'git')
      .every(({ root }) => root === f.store.repositoryRoot(project)),
  )
  assert(
    f.calls
      .filter(({ args }) => args[0] === 'lake')
      .every(({ root }) => root === project.root),
  )
  await f.assertPinnedFiles(project)
  await assert.rejects(fs.stat(path.join(project.root, '.git')), {
    code: 'ENOENT',
  })
})

test('a selected revision branch remains the suggested merge target while a tag uses the repository default', async (t) => {
  const f = await fixture(t)
  const branch = await f.create({
    publishingEnabled: true,
    revision: 'release/pinned',
  })
  const tag = await f.create({
    publishingEnabled: true,
    revision: 'fixture-pin',
  })
  assert.equal(branch.publishingBaseBranch, 'release/pinned')
  assert.equal(tag.publishingBaseBranch, 'main')
  await f.assertPinnedFiles(branch)
  await f.assertPinnedFiles(tag)
})

test('an explicitly requested existing branch at the imported HEAD can be reused without altering its history', async (t) => {
  const f = await fixture(t)
  const project = await f.create({
    publishingEnabled: true,
    workingBranch: 'main',
  })
  assert.equal(project.workingBranch, 'main')
  assert.equal(project.publishingBranchPrepared, true)
  assert.equal(
    await f.git(
      f.store.repositoryRoot(project),
      'symbolic-ref',
      '--short',
      'HEAD',
    ),
    'main',
  )
  assert.equal(
    f.calls.some(({ args }) => args.includes('switch')),
    false,
  )
  await f.assertPinnedFiles(project, f.latestHead)
})

test('a detached revision can reuse an existing requested branch only when it has the same HEAD', async (t) => {
  const f = await fixture(t)
  const project = await f.create({
    publishingEnabled: true,
    revision: 'main',
    workingBranch: 'main',
  })
  assert.equal(project.workingBranch, 'main')
  assert.equal(project.publishingWarning, undefined)
  assert.equal(
    await f.git(
      f.store.repositoryRoot(project),
      'symbolic-ref',
      '--short',
      'HEAD',
    ),
    'main',
  )
  await f.assertPinnedFiles(project, f.latestHead)
})

test('different-HEAD and prefix branch collisions use a unique safe alternative before building while preserving the requested branches', async (t) => {
  const f = await fixture(t)
  for (const input of [
    { revision: 'fixture-pin', workingBranch: 'main' },
    { workingBranch: 'main/proof' },
  ]) {
    const before = f.calls.length
    const project = await f.create({ publishingEnabled: true, ...input })
    const checkout = f.store.repositoryRoot(project)
    assert.notEqual(project.workingBranch, input.workingBranch)
    assert.match(project.workingBranch, /^leanflow-/)
    assert.equal(project.publishingBranchPrepared, true)
    assert(project.publishingWarning.includes(input.workingBranch))
    assert(project.publishingWarning.includes(project.workingBranch))
    assert.equal(
      await f.git(checkout, 'rev-parse', 'refs/heads/main'),
      f.latestHead,
    )
    assert.equal(
      await f.git(checkout, 'symbolic-ref', '--short', 'HEAD'),
      project.workingBranch,
    )
    await f.assertPinnedFiles(
      project,
      input.revision ? f.pinnedHead : f.latestHead,
    )
    const preparation = f.calls.slice(before)
    const lastBranchMutation = preparation.findLastIndex(({ args }) =>
      args.includes('switch'),
    )
    const firstLeanCommand = preparation.findIndex(
      ({ args }) => args[0] === 'lake' || args[0] === 'lean',
    )
    assert(lastBranchMutation >= 0 && firstLeanCommand > lastBranchMutation)
    assert.equal(
      preparation.filter(
        ({ args }) =>
          args.filter((arg) => arg !== '--keep-toolchain').join(' ') ===
          'lake build',
      ).length,
      1,
    )
  }
})

test('disabled publishing keeps the imported branch or detached revision and performs no automatic branch mutation', async (t) => {
  const f = await fixture(t)
  const branch = await f.create({ publishingEnabled: false })
  const pinned = await f.create({
    publishingEnabled: false,
    revision: 'fixture-pin',
  })
  assert.equal(branch.publishingEnabled, false)
  assert.equal(branch.workingBranch, undefined)
  assert.equal(pinned.workingBranch, undefined)
  assert.equal(
    await f.git(
      f.store.repositoryRoot(branch),
      'symbolic-ref',
      '--short',
      'HEAD',
    ),
    'main',
  )
  assert.equal(
    await f.git(
      f.store.repositoryRoot(pinned),
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ),
    'HEAD',
  )
  assert.equal(
    f.calls.some(({ args }) => args.includes('switch')),
    false,
  )
  await f.assertPinnedFiles(branch, f.latestHead)
  await f.assertPinnedFiles(pinned)
})

test('setup refresh and a server reopen preserve the user-selected working branch instead of recreating the import branch', async (t) => {
  const f = await fixture(t)
  let project = await f.create({
    publishingEnabled: true,
    revision: 'fixture-pin',
  })
  const checkout = f.store.repositoryRoot(project)
  await f.git(checkout, 'switch', '-c', 'review/after-import')
  f.store.close()
  await f.store.init()
  assert.equal(f.store.get(project.id, 'owner').publishingBranchPrepared, true)
  const before = f.calls.length
  await f.store.prepare(project.id, 'owner')
  await f.store.jobs.get(project.id)
  project = f.store.get(project.id, 'owner')
  assert.equal(project.status, 'ready', project.error)
  assert.equal(
    await f.git(checkout, 'symbolic-ref', '--short', 'HEAD'),
    'review/after-import',
  )
  assert.equal(
    f.calls
      .slice(before)
      .some(({ args }) => args.includes('switch') || args.includes('checkout')),
    false,
  )
  await f.assertPinnedFiles(project)
})

test('invalid publication settings and working branches are rejected before cloning or creating a workspace', async (t) => {
  const f = await fixture(t)
  const before = f.calls.length
  for (const settings of [
    { publishingEnabled: 'true' },
    { publishingEnabled: 1 },
    { publishingEnabled: true, workingBranch: [] },
    { publishingEnabled: true, workingBranch: null },
    { publishingEnabled: true, workingBranch: '../main' },
    { publishingEnabled: true, workingBranch: 'topic/.hidden' },
    { publishingEnabled: true, workingBranch: 'topic//step' },
    { publishingEnabled: true, workingBranch: 'topic.lock/step' },
    { publishingEnabled: false, workingBranch: 'proof/results' },
  ])
    await assert.rejects(f.store.create('owner', { repository, ...settings }), {
      status: 400,
    })
  await assert.rejects(f.store.create('owner', { publishingEnabled: true }), {
    status: 400,
  })
  assert.equal(f.calls.length, before)
  assert.deepEqual(f.store.list('owner'), [])
  assert.deepEqual(await fs.readdir(f.store.projectsDir), [])
})

test('enabling publishing checks ownership and active work without switching branches or changing project files', async (t) => {
  const f = await fixture(t)
  const project = await f.create({
    publishingEnabled: false,
    revision: 'fixture-pin',
  })
  await assert.rejects(f.store.enablePublishing(project.id, 'another-owner'), {
    status: 404,
  })
  await assert.rejects(
    f.store.enablePublishing(project.id, 'owner', {
      assertIdle() {
        throw Object.assign(new Error('An active check must finish first.'), {
          status: 409,
        })
      },
    }),
    { status: 409 },
  )
  assert.equal(f.store.get(project.id, 'owner').publishingEnabled, false)
  const before = f.calls.length
  const enabled = await f.store.enablePublishing(project.id, 'owner')
  assert.equal(enabled.publishingEnabled, true)
  assert.equal(enabled.workingBranch, undefined)
  assert.equal(f.calls.length, before)
  assert.equal(
    await f.git(
      f.store.repositoryRoot(project),
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ),
    'HEAD',
  )
  await f.assertPinnedFiles(enabled)
})

test('the enable-publishing API rejects unauthenticated, other-owner and active-check requests before persisting the choice', async (t) => {
  const f = await fixture(t, { api: true })
  const project = await f.create({ publishingEnabled: false })
  const token = (
    await fs.readFile(path.join(f.dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const otherToken = 'isolated-publishing-collaborator-token'
  const usersFile = path.join(f.dataDir, 'auth/users.json')
  const users = JSON.parse(await fs.readFile(usersFile, 'utf8'))
  users.push({
    id: 'collaborator',
    name: 'Collaborator',
    tokenHash: createHash('sha256').update(otherToken).digest('hex'),
  })
  await fs.writeFile(usersFile, JSON.stringify(users))
  await new Promise((resolve) =>
    f.studio.server.listen(0, '127.0.0.1', resolve),
  )
  const url = `http://127.0.0.1:${f.studio.server.address().port}/api/projects/${project.id}/git`
  const request = (credential) =>
    fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
        ...(credential ? { Authorization: 'Bearer ' + credential } : {}),
      },
      body: JSON.stringify({ action: 'enable-publishing' }),
    })
  assert.equal((await request()).status, 401)
  assert.equal((await request(otherToken)).status, 404)
  const check = f.studio.events.create('owner', {
    kind: 'check',
    projectId: project.id,
  })
  f.studio.events.updateMetadata(check.id, { status: 'running' })
  const blocked = await request(token)
  assert.equal(blocked.status, 409, await blocked.clone().text())
  assert.equal(f.store.get(project.id, 'owner').publishingEnabled, false)
  f.studio.events.updateMetadata(check.id, { status: 'completed' })
  const response = await request(token)
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json()).publishingEnabled, true)
  const enabled = f.store.get(project.id, 'owner')
  assert.equal(enabled.publishingEnabled, true)
  await f.assertPinnedFiles(enabled, f.latestHead)
  assert.equal(
    f.calls.some(({ args }) => args.includes('push')),
    false,
  )
})

test('shallow tag and branch imports publish local commits through sanitized full-history previews to disposable repositories', async (t) => {
  for (const revision of ['fixture-pin', 'release/pinned']) {
    const f = await fixture(t)
    const project = await f.create({
      publishingEnabled: true,
      revision,
    })
    const checkout = f.store.repositoryRoot(project)
    await fs.appendFile(
      path.join(project.root, 'Main.lean'),
      '-- Published fixture change\n',
    )
    await f.git(checkout, 'add', 'Main.lean')
    await f.git(
      checkout,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Changes from imported project',
    )
    const committedHead = await f.git(checkout, 'rev-parse', 'HEAD')
    await fs.writeFile(
      path.join(project.root, 'Uncommitted.lean'),
      '-- Excluded from publishing\n',
    )
    await fs.writeFile(
      path.join(project.root, '.env'),
      'DUMMY_FIXTURE_ONLY=true\n',
    )
    const destination = path.join(f.dataDir, 'published.git')
    await f.git(f.dataDir, 'init', '--bare', destination)
    const remoteUrl = 'https://github.com/fixture/imported.git'
    const token = 'isolated-publishing-fixture-token'
    let delivered
    const publisher = await new GitPublisher({
      dataDir: f.dataDir,
      runtime: f.runtime,
      workspaces: f.store,
      resolveHost: async () => [{ address: '93.184.216.34' }],
      async publishTransport(input) {
        delivered = input
        assert.equal(input.credentials.token, token)
        assert(!input.args.includes('--force'))
        assert(!JSON.stringify(input.args).includes(token))
        const args = input.args
          .slice(1)
          .map((value) =>
            value === remoteUrl
              ? destination
              : value.replaceAll('/workspace', input.root),
          )
        args.splice(args.indexOf('push'), 0, '-c', 'protocol.file.allow=always')
        return {
          code: 0,
          ...(await execute('git', args, {
            cwd: input.root,
            env: {
              PATH: process.env.PATH,
              HOME: f.dataDir,
              ...input.env,
            },
          })),
        }
      },
    }).init()
    const preview = await publisher.preview('owner', project.id, {
      remoteUrl,
      branch: project.workingBranch,
      baseBranch: project.publishingBaseBranch,
    })
    assert.equal(preview.head, committedHead)
    assert.equal(preview.historyCount, 2)
    assert.equal(preview.uncommittedCount, 1)
    const previewRoot = path.join(f.dataDir, 'git-publish', preview.previewId)
    assert.equal(
      await f.git(
        previewRoot,
        '--git-dir=repository.git',
        'rev-parse',
        '--is-shallow-repository',
      ),
      'false',
    )
    for (const filename of ['.git', 'Main.lean', 'Uncommitted.lean', '.env'])
      await assert.rejects(fs.stat(path.join(previewRoot, filename)), {
        code: 'ENOENT',
      })
    const pushed = await publisher.push('owner', project.id, {
      previewId: preview.previewId,
      token,
    })
    assert.equal(pushed.pushed, true)
    assert.equal(pushed.head, committedHead)
    assert.equal(pushed.review.kind, 'pull-request')
    assert.equal(delivered.credentials.token, '')
    assert.equal(
      await f.git(
        destination,
        'rev-parse',
        `refs/heads/${project.workingBranch}`,
      ),
      committedHead,
    )
    assert.equal(
      await f.git(destination, 'rev-parse', `${committedHead}^`),
      f.pinnedHead,
    )
    const publishedFiles = (
      await f.git(destination, 'ls-tree', '-r', '--name-only', committedHead)
    ).split('\n')
    assert(!publishedFiles.includes('Uncommitted.lean'))
    assert(!publishedFiles.includes('.env'))
    assert.equal(
      await f.git(checkout, 'rev-parse', '--is-shallow-repository'),
      'true',
    )
    assert.equal(await f.git(f.source, 'rev-parse', 'HEAD'), f.latestHead)
    assert(
      !(
        await fs.readFile(
          path.join(f.dataDir, 'git-publish/destinations.json'),
          'utf8',
        )
      ).includes(token),
    )
    await assert.rejects(fs.stat(previewRoot), { code: 'ENOENT' })
  }
})
