import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createStudio } from '../studio.mjs'

const execute = promisify(execFile)

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-git-init-'))
  const commands = []
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.35.0' }],
    templateRoot: () => null,
    async prepareToolchain() {
      assert.fail('Git initialization must not prepare Lean')
    },
    async shutdown() {},
    async run(root, args, options = {}) {
      commands.push(args)
      assert.equal(
        args[0],
        'git',
        'Only Git may run for an unprepared notes project',
      )
      assert.notEqual(options.network, 'bridge')
      try {
        const command = execute(args[0], args.slice(1), {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: dataDir,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            ...options.env,
          },
          timeout: 5000,
          signal: options.signal,
          maxBuffer: options.maxOutputBytes || 1024 * 1024,
        })
        command.child.stdin.on('error', (error) => {
          if (error.code !== 'EPIPE') command.child.kill()
        })
        command.child.stdin.end(options.input)
        return { code: 0, ...(await command) }
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      }
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
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  const owner = {
    id: 'owner',
    token: (
      await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
    ).trim(),
  }
  const project = await studio.workspaces.create(owner.id, {
    name: 'Notes before Lean',
    autoRepair: false,
    files: [
      {
        path: 'Notes.md',
        content: 'Original notes without a Lean environment.\n',
      },
      { path: '.gitignore', content: 'generated/\n' },
    ],
  })
  await studio.workspaces.jobs.get(project.id)
  const root = studio.workspaces.repositoryRoot(project)
  assert.equal(
    studio.workspaces.get(project.id, owner.id).status,
    'needs-setup',
  )
  const request = (actor = owner, method = 'POST') =>
    fetch(
      `http://127.0.0.1:${studio.server.address().port}/api/projects/${project.id}/git`,
      {
        method,
        signal: AbortSignal.timeout(10000),
        headers: {
          ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}),
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(method === 'POST'
          ? { body: JSON.stringify({ action: 'initialize' }) }
          : {}),
      },
    )
  const git = (...args) =>
    execute(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        ...args,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: dataDir,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    )
  const update = (values) => {
    const current = studio.workspaces.get(project.id, owner.id)
    studio.workspaces.db
      .prepare('UPDATE projects SET data=? WHERE id=?')
      .run(JSON.stringify({ ...current, ...values }), project.id)
  }
  return { ...studio, commands, owner, project, root, request, git, update }
}

test('HTTP initialization creates local Git before Lean setup and preserves an existing custom history', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.publisher.agentContext(f.owner.id, f.project.id), {
    kind: 'git',
    repository: false,
  })
  let response = await f.request(f.owner, 'GET')
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.json()).repository, false)
  response = await f.request()
  assert.equal(response.status, 200, await response.clone().text())
  const info = await response.json()
  assert.equal(info.repository, true)
  assert.equal(info.branch, 'main')
  assert.equal(info.revision, null)
  assert.equal(f.workspaces.get(f.project.id, f.owner.id).status, 'needs-setup')
  assert.equal(
    await fs.readFile(path.join(f.root, '.gitignore'), 'utf8'),
    'generated/\n',
  )
  assert.equal(
    await fs.readFile(path.join(f.root, 'Notes.md'), 'utf8'),
    'Original notes without a Lean environment.\n',
  )
  await f.git('switch', '-c', 'my/existing-branch')
  await f.git('add', '--', 'Notes.md', '.gitignore')
  await f.git('commit', '-m', 'Existing notes history')
  const revision = (await f.git('rev-parse', 'HEAD')).stdout.trim()
  await fs.appendFile(
    path.join(f.root, 'Notes.md'),
    'Keep this uncommitted edit.\n',
  )
  const status = (await f.git('status', '--porcelain=v1')).stdout
  response = await f.request()
  assert.equal(response.status, 200, await response.clone().text())
  const existing = await response.json()
  assert.equal(existing.branch, 'my/existing-branch')
  assert.equal(existing.revision, revision)
  assert.equal((await f.git('status', '--porcelain=v1')).stdout, status)
  assert.equal(f.commands.filter((args) => args.includes('init')).length, 1)
  assert(f.commands.every((args) => args[0] === 'git'))
})

test('HTTP initialization denies unauthenticated, unrelated, and viewer accounts without creating Git metadata', async (t) => {
  const f = await fixture(t)
  const viewer = await f.auth.createUser(f.owner, { name: 'Viewer' })
  const outsider = await f.auth.createUser(f.owner, { name: 'Outsider' })
  f.workspaces.memberships.set(f.project, viewer.user.id, 'viewer')
  for (const [actor, expected] of [
    [null, 401],
    [{ id: viewer.user.id, token: viewer.token }, 403],
    [{ id: outsider.user.id, token: outsider.token }, 404],
  ]) {
    const response = await f.request(actor)
    assert.equal(response.status, expected, await response.clone().text())
  }
  await assert.rejects(fs.stat(path.join(f.root, '.git')), { code: 'ENOENT' })
  assert.equal(f.commands.length, 0)
})

test('HTTP initialization preserves setup, recovery, and concurrent Git guards', async (t) => {
  const f = await fixture(t)
  f.update({ status: 'preparing' })
  let response = await f.request()
  assert.equal(response.status, 409, await response.clone().text())
  f.update({ status: 'needs-setup' })
  f.workspaces.transactions.errors.set(
    f.project.id,
    new Error('Fixture interrupted transaction'),
  )
  response = await f.request()
  assert.equal(response.status, 503, await response.clone().text())
  assert.match((await response.json()).error, /recovery/)
  f.workspaces.transactions.errors.delete(f.project.id)
  f.publisher.busy.add(f.project.id)
  response = await f.request()
  assert.equal(response.status, 409, await response.clone().text())
  assert.match((await response.json()).error, /Git operation/)
  f.publisher.busy.delete(f.project.id)
  await assert.rejects(fs.stat(path.join(f.root, '.git')), { code: 'ENOENT' })
  assert.equal(f.commands.length, 0)
})

test('HTTP initialization refuses to replace missing imported Git history', async (t) => {
  const f = await fixture(t)
  f.update({ repository: 'https://git.example.invalid/alice/proofs.git' })
  const response = await f.request()
  assert.equal(response.status, 409, await response.clone().text())
  assert.match(
    (await response.json()).error,
    /imported repository is incomplete/,
  )
  await assert.rejects(fs.stat(path.join(f.root, '.git')), { code: 'ENOENT' })
  assert.equal(f.commands.length, 0)
})
