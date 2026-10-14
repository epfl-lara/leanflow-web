import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceStore } from '../workspaces.mjs'
import { repositoryLocation } from '../project-import.mjs'
import { runAuthenticatedRepositoryGit } from '../repository-git.mjs'

const toolchain = 'leanprover/lean4:v4.34.1'
const token = 'fixture-private-token+/@:42'
const username = 'gitlab+deploy-token-42'
const files = {
  'lean-toolchain': toolchain + '\n',
  'lakefile.toml': 'name = "private_fixture"\n',
  'Main.lean': 'example : True := by trivial\n',
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-private-'))
  const calls = []
  let transport = async (root, args) => {
    if (args.includes('clone')) {
      await fs.mkdir(path.join(root, '.git'), { recursive: true })
      for (const [name, content] of Object.entries(files))
        await fs.writeFile(path.join(root, name), content)
    }
    return {
      code: 0,
      stdout: args.includes('rev-parse') ? 'a'.repeat(40) : 'fixture success',
      stderr: '',
    }
  }
  const runtime = {
    templates: () => [
      { id: 'lean', toolchain },
      { id: 'mathlib', toolchain },
    ],
    templateRoot: () => null,
    prepareToolchain: async () => {},
    run: async (root, args, options) => {
      calls.push({ root, args, options: { ...options } })
      options.signal?.throwIfAborted()
      return transport(root, args, options)
    },
  }
  const store = await new WorkspaceStore({
    dataDir,
    runtime,
    resolveHost: async () => [{ address: '140.82.112.3' }],
  }).init()
  t.after(async () => {
    await Promise.all([...store.jobs.values()])
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return {
    store,
    dataDir,
    calls,
    setTransport: (value) => {
      transport = value
    },
    transport: () => transport,
    create: async (input) => {
      const project = await store.create('alice', {
        autoRepair: false,
        ...input,
      })
      await store.jobs.get(project.id)
      return store.get(project.id, 'alice')
    },
  }
}

function assertNoSecret(value) {
  const text = JSON.stringify(value)
  for (const secret of [
    token,
    encodeURIComponent(token),
    Buffer.from(username + ':' + token).toString('base64'),
  ])
    assert.equal(
      text.includes(secret),
      false,
      'credentials must not appear in observable or persisted project state',
    )
}

test('private GitHub and GitLab imports authenticate clone and selected revision only, retain full history and clear credentials before Lean', async (t) => {
  for (const repository of [
    'https://github.com/example/private.git',
    'https://gitlab.example.org/group/nested/private.git',
  ]) {
    const f = await fixture(t)
    const project = await f.create({
      repository,
      revision: 'feature/proof',
      repositoryToken: token,
      repositoryUsername: username,
      publishingEnabled: true,
    })
    assert.equal(project.status, 'ready', project.error)
    const authenticated = f.calls.filter((call) => call.args[0] === 'python3')
    assert.equal(authenticated.length, 2)
    assert(authenticated[0].args.includes('clone'))
    assert(authenticated[1].args.includes('fetch'))
    for (const { args, options } of authenticated) {
      assert.deepEqual(JSON.parse(options.input), { token, username })
      assertNoSecret(args)
      assertNoSecret(options.env)
      assert.equal(options.onOutput, undefined)
      assert.equal(options.freshHome, true)
      assert.equal(options.cleanHome, true)
      assert.equal(options.readOnlyHome, true)
      assert(args.includes('http.followRedirects=false'))
      assert(
        args.includes(
          'http.curloptResolve=' +
            new URL(repository).hostname +
            ':443:140.82.112.3',
        ),
      )
      assert.equal(args.includes('--depth=1'), false)
    }
    for (const call of f.calls.filter((call) => call.args[0] !== 'python3'))
      assertNoSecret(call)
    assertNoSecret(project)
    assertNoSecret(f.store.list('alice'))
    assertNoSecret(f.store.events(project.id, 'alice'))
    assertNoSecret(f.store.db.prepare('SELECT data FROM projects').all())
    assert.equal(project.repositoryAuthenticationRequired, undefined)
    // Refreshing an imported project must not fetch again or reuse credentials.
    const before = authenticated.length
    await f.store.prepare(project.id, 'alice')
    await f.store.jobs.get(project.id)
    assert.equal(
      f.calls.filter((call) => call.args[0] === 'python3').length,
      before,
    )
  }
})

test('authentication failures redact raw, encoded and Basic credentials and allow retry with a fresh token', async (t) => {
  const f = await fixture(t)
  const success = f.transport()
  f.setTransport(async () => ({
    code: 128,
    stdout: '',
    stderr: `Authentication failed: ${token} ${encodeURIComponent(token)} ${Buffer.from(username + ':' + token).toString('base64')}`,
  }))
  const project = await f.create({
    repository: 'https://gitlab.com/group/private.git',
    repositoryToken: token,
    repositoryUsername: username,
  })
  assert.equal(project.status, 'error')
  assert.equal(project.repositoryAuthenticationRequired, true)
  assert.match(project.error, /read access/)
  assertNoSecret(project)
  assertNoSecret(f.store.events(project.id, 'alice'))
  assertNoSecret(f.store.db.prepare('SELECT data FROM projects').all())
  await assert.rejects(
    f.store.prepare(project.id, 'bob', { repositoryToken: token }),
    /not found/,
  )
  f.store.close()
  await f.store.init()
  assert.equal(
    f.store.get(project.id, 'alice').repositoryAuthenticationRequired,
    true,
  )
  f.setTransport(success)
  await f.store.prepare(project.id, 'alice', {
    repositoryToken: 'fixture-fresh-token',
    repositoryUsername: username,
  })
  await f.store.jobs.get(project.id)
  const ready = f.store.get(project.id, 'alice')
  assert.equal(ready.status, 'ready', ready.error)
  assert.equal(ready.repositoryAuthenticationRequired, undefined)
  assert.equal(
    JSON.parse(
      f.calls.filter((call) => call.args.includes('clone')).at(-1).options
        .input,
    ).token,
    'fixture-fresh-token',
  )
})

test('public access failure offers authentication and invalid credentials never create a project or worker', async (t) => {
  const f = await fixture(t)
  f.setTransport(async () => ({
    code: 128,
    stdout: '',
    stderr: 'fatal: repository not found',
  }))
  const project = await f.create({
    repository: 'https://github.com/example/private.git',
  })
  assert.equal(project.repositoryAuthenticationRequired, true)
  const count = f.store.list('alice').length
  const calls = f.calls.length
  for (const credentials of [
    { repositoryToken: 'has whitespace' },
    { repositoryToken: 42 },
    { repositoryToken: 'x'.repeat(16001) },
    { repositoryUsername: 'user:password' },
    { repositoryUsername: 'bad\nname' },
  ])
    await assert.rejects(
      f.store.create('alice', {
        repository: 'https://github.com/example/private.git',
        ...credentials,
      }),
      /valid.*(?:token|username)/,
    )
  await assert.rejects(
    f.store.create('alice', { repositoryToken: token }),
    /require a Git repository/,
  )
  assert.equal(f.store.list('alice').length, count)
  assert.equal(f.calls.length, calls)
})

test('stopping authenticated import aborts its Git worker without exposing or reusing the token', async (t) => {
  const f = await fixture(t)
  let started
  const began = new Promise((resolve) => {
    started = resolve
  })
  f.setTransport(async (_root, _args, { signal }) => {
    started()
    await new Promise((resolve) =>
      signal.addEventListener('abort', resolve, { once: true }),
    )
    return { code: 130, stdout: '', stderr: token }
  })
  const project = await f.store.create('alice', {
    repository: 'https://gitlab.com/group/private.git',
    repositoryToken: token,
    repositoryUsername: username,
  })
  await began
  const stopped = await f.store.stopPreparation(project.id, 'alice')
  assert.equal(stopped.status, 'error')
  assert.match(stopped.error, /stopped/)
  assertNoSecret(stopped)
  assertNoSecret(f.store.events(project.id, 'alice'))
  assert.equal(f.calls.length, 1)
})

test('GitLab folder links preserve nested namespaces, encoded slash branches, explicit branches and directory overrides', () => {
  const base = 'https://gitlab.example.org/group/subgroup/project'
  assert.deepEqual(
    repositoryLocation(base + '/-/tree/main/Lean?ref_type=heads#readme'),
    { repository: base, revision: 'main', subdirectory: 'Lean' },
  )
  assert.deepEqual(repositoryLocation(base + '/-/tree/main/Lean/'), {
    repository: base,
    revision: 'main',
    subdirectory: 'Lean',
  })
  assert.deepEqual(repositoryLocation(base + '/-/tree/feature%2Fproofs/Lean'), {
    repository: base,
    revision: 'feature/proofs',
    subdirectory: 'Lean',
  })
  assert.deepEqual(
    repositoryLocation(base + '/-/tree/feature/proofs/Lean', {
      revision: 'feature/proofs',
      subdirectory: 'Other',
    }),
    { repository: base, revision: 'feature/proofs', subdirectory: 'Other' },
  )
  for (const suffix of [
    '/-/blob/main/Main.lean',
    '/-/merge_requests/2',
    '/-/tree/',
  ])
    assert.throws(
      () => repositoryLocation(base + suffix),
      /repository or folder link/,
    )
  assert.throws(
    () => repositoryLocation(base + '/-/tree/main/%2E%2E%2FSecret'),
    /relative project subdirectory/,
  )
  assert.throws(
    () => repositoryLocation(base + '/-/tree/main/Lean', { revision: {} }),
    /valid repository revision/,
  )
})

test('truncated Git output cannot reveal an unmatched credential prefix', async () => {
  const result = await runAuthenticatedRepositoryGit({
    dataDir: os.tmpdir(),
    root: os.tmpdir(),
    args: ['clone'],
    credentials: { token, username },
    runtime: {
      run: async () => ({
        code: 128,
        truncated: true,
        stdout: token.slice(0, 9),
        stderr: Buffer.from(username + ':' + token)
          .toString('base64')
          .slice(0, 17),
      }),
    },
  })
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /output exceeded/)
  assert.equal(result.stderr.includes(token.slice(0, 9)), false)
})

test('private clone and revision timeouts explain how to resume without blaming token access', async (t) => {
  for (const phase of ['clone', 'fetch']) {
    const f = await fixture(t)
    const success = f.transport()
    f.setTransport(async (root, args, options) =>
      args.includes(phase)
        ? { code: 124, timedOut: true, stdout: '', stderr: token }
        : success(root, args, options),
    )
    const project = await f.create({
      repository: 'https://github.com/example/private.git',
      revision: 'main',
      repositoryToken: token,
      repositoryUsername: username,
    })
    assert.equal(project.status, 'error')
    assert.match(project.error, /15-minute time limit/)
    assert.match(
      project.error,
      phase === 'clone'
        ? /Create a new import or upload/
        : /resume the completed clone/,
    )
    assert.doesNotMatch(project.error, /access was denied|access failed/)
    assertNoSecret(project)
  }
})
