import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createStudio } from '../studio.mjs'
import { GitConnections } from '../git-connections.mjs'
import { validateRepository } from '../workspaces.mjs'

test('Git connection API keeps account tokens private and reuses them only for matching imports', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-git-api-'))
  const toolchain = 'leanprover/lean4:v4.34.1'
  const resolveHost = async () => [{ address: '140.82.112.3' }]
  const connections = await new GitConnections({
    dataDir,
    validateRepository,
    resolveHost,
  }).init()
  const calls = []
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async run(root, args, options) {
      calls.push({ args, options })
      if (args.includes('clone')) {
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
        for (const [name, content] of Object.entries({
          'lean-toolchain': toolchain + '\n',
          'lakefile.toml': 'name = "fixture"\n',
          'Main.lean': 'example : True := by trivial\n',
        }))
          await fs.writeFile(path.join(root, name), content)
      }
      return {
        code: 0,
        stdout: args.includes('rev-parse') ? 'a'.repeat(40) : '',
        stderr: '',
      }
    },
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    gitConnections: connections,
    config: { models: [], provider: {}, lemex: {}, redact: String },
  })
  studio.workspaces.resolveHost = resolveHost
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const access = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const bob = 'fixture-bob-git-connections'
  studio.auth.users.push({
    id: 'bob',
    name: 'Bob',
    tokenHash: createHash('sha256').update(bob).digest('hex'),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth/users.json'),
    JSON.stringify(studio.auth.users),
  )
  const request = (endpoint, method = 'GET', body, auth = access) =>
    fetch(`http://127.0.0.1:${studio.server.address().port}${endpoint}`, {
      method,
      headers: {
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        'Content-Type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    })
  assert.equal(
    (await request('/api/git-connections', 'GET', undefined, null)).status,
    401,
  )
  const token = 'fixture-shared-github-token'
  let response = await request('/api/git-connections', 'PUT', {
    action: 'connect',
    host: 'github.com',
    provider: 'github',
    token,
  })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await response.text()).includes(token), false)
  const bobMetadata = await (
    await request('/api/git-connections', 'GET', undefined, bob)
  ).json()
  assert.deepEqual(bobMetadata.connections, [])
  assert.equal(
    (
      await request(
        '/api/git-connections?host=github.com',
        'DELETE',
        undefined,
        bob,
      )
    ).status,
    200,
  )
  assert.equal(
    (
      await connections.credentials(
        'owner',
        'https://github.com/example/private.git',
      )
    ).token,
    token,
  )
  response = await request('/api/git-connections', 'PUT', {
    action: 'identity',
    name: 'Shared Author',
    email: 'author@example.invalid',
  })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).identity, {
    name: 'Shared Author',
    email: 'author@example.invalid',
  })
  for (const body of [
    [],
    { action: 'unknown' },
    {
      action: 'connect',
      host: 'github.com',
      provider: 'github',
      token: 'has whitespace',
    },
  ])
    assert.equal(
      (await request('/api/git-connections', 'PUT', body)).status,
      400,
    )
  for (const [repository, expected] of [
    ['https://github.com/example/private.git', token],
    ['https://gitlab.com/example/public.git', null],
  ]) {
    response = await request('/api/projects', 'POST', {
      repository,
      autoRepair: false,
    })
    assert.equal(response.status, 201, await response.clone().text())
    const project = await response.json()
    await studio.workspaces.jobs.get(project.id)
    assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
    const clone = calls.filter((call) => call.args.includes('clone')).at(-1)
    assert.equal(clone.args[0], expected ? 'python3' : 'git')
    if (expected) {
      assert.equal(JSON.parse(clone.options.input).token, expected)
      assert.equal(JSON.stringify(clone.args).includes(token), false)
      assert.equal(JSON.stringify(clone.options.env).includes(token), false)
    }
    assert.equal(JSON.stringify(project).includes(token), false)
    assert.equal(
      JSON.stringify(studio.workspaces.events(project.id, 'owner')).includes(
        token,
      ),
      false,
    )
  }
  // Clearing a one-use copy must never disconnect the shared account key.
  assert.equal(
    (
      await connections.credentials(
        'owner',
        'https://github.com/example/private.git',
      )
    ).token,
    token,
  )
  response = await request('/api/git-connections?host=github.com', 'DELETE')
  assert.equal(response.status, 200)
  assert.equal(
    await connections.credentials(
      'owner',
      'https://github.com/example/private.git',
    ),
    null,
  )
})
