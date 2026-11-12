import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createStudio } from '../studio.mjs'

test('environment API authenticates, enforces ownership and blocks active work before adding Lean', async (t) => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lean-environment-http-'),
  )
  const toolchain = 'leanprover/lean4:v4.35.0'
  const runtime = {
    async init() {},
    async shutdown() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain, ready: true }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async run(root, args) {
      if (args.includes('init'))
        await fs.mkdir(path.join(root, '.git'), { recursive: true })
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
    config: { models: [], provider: {}, lemex: {}, redact: String },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const token = (
    await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
  ).trim()
  const other = 'fixture-other-user'
  studio.auth.users.push({
    id: 'other',
    name: 'Other',
    tokenHash: createHash('sha256').update(other).digest('hex'),
  })
  await fs.writeFile(
    path.join(dataDir, 'auth/users.json'),
    JSON.stringify(studio.auth.users),
  )
  const request = (id, body, auth = token) =>
    fetch(
      `http://127.0.0.1:${studio.server.address().port}/api/projects/${id}/environment`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        },
        body: JSON.stringify(body),
      },
    )
  const project = await studio.workspaces.create('owner', {
    files: [{ path: 'paper.md', content: 'Original specification' }],
  })
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'needs-setup')
  assert.equal((await request(project.id, { libraries: [] }, null)).status, 401)
  assert.equal(
    (await request(project.id, { libraries: [] }, other)).status,
    404,
  )
  assert.equal(
    (await request(project.id, { libraries: ['unknown'] })).status,
    400,
  )
  const job = studio.events.create('owner', {
    projectId: project.id,
    kind: 'proof',
  })
  assert.equal((await request(project.id, { libraries: [] })).status, 409)
  assert.equal(
    await fs.stat(path.join(project.root, 'lean-toolchain')).catch(() => null),
    null,
  )
  studio.events.updateMetadata(job.id, { status: 'completed' })
  const response = await request(project.id, { libraries: [], toolchain })
  assert.equal(response.status, 200, await response.clone().text())
  const result = await response.json()
  assert.equal(result.status, 'preparing')
  assert.equal(result.root, undefined)
  await studio.workspaces.jobs.get(project.id)
  assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
  assert.equal(
    await fs.readFile(path.join(project.root, 'paper.md'), 'utf8'),
    'Original specification',
  )
  assert.equal((await request(project.id, { libraries: [] })).status, 409)
  await t.test(
    'an agent can publish its checked configuration without ignoring other active work',
    async () => {
      const configuration = await studio.workspaces.readFile(
        project.id,
        'owner',
        'lakefile.toml',
      )
      const change = {
        path: 'lakefile.toml',
        beforeHash: configuration.hash,
        after: configuration.content + '\n# requested agent setup repair\n',
      }
      const agent = studio.events.create('owner', {
        kind: 'agent',
        projectId: project.id,
      })
      studio.events.updateMetadata(agent.id, { status: 'verifying' })
      const check = studio.events.create('owner', {
        kind: 'proof',
        projectId: project.id,
      })
      studio.events.updateMetadata(check.id, { status: 'running' })
      await assert.rejects(
        studio.workspaces.applyChanges(project.id, 'owner', [change], {
          agentRunId: agent.id,
        }),
        { status: 409 },
      )
      assert.equal(studio.events.get(check.id).status, 'running')
      assert.equal(
        (await studio.workspaces.readFile(project.id, 'owner', 'lakefile.toml'))
          .hash,
        configuration.hash,
      )
      studio.events.updateMetadata(check.id, { status: 'completed' })
      const result = await studio.workspaces.applyChanges(
        project.id,
        'owner',
        [change],
        { agentRunId: agent.id },
      )
      assert.equal(result.requiresPreparation, true)
      assert.equal(studio.events.get(agent.id).status, 'verifying')
      assert.equal(
        (await studio.workspaces.readFile(project.id, 'owner', 'lakefile.toml'))
          .content,
        change.after,
      )
      studio.events.updateMetadata(agent.id, { status: 'completed' })
    },
  )
})
