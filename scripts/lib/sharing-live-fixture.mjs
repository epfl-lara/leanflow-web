import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStudio } from '../../server/studio.mjs'
import { Runtime } from '../../server/runtime.mjs'
import { loadCapacity } from '../../server/capacity.mjs'
import { fixtureModelDiscovery } from '../../server/tests/fixtures/model-discovery.mjs'

const TOOLCHAIN = 'leanprover/lean4:v4.34.1'
export const liveSource = '-- shared baseline\nexample : True := by trivial\n'

export async function createSharingLiveFixture({
  directory,
  realRuntime = true,
} = {}) {
  directory = path.resolve(
    directory ||
      path.join('.runtime/sharing-validation', `browser-${randomUUID()}`),
  )
  const dataDir = path.join(directory, 'data')
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const capacity = loadCapacity({
    STUDIO_MAX_WORKERS: '6',
    STUDIO_MAX_WORKER_QUEUE: '12',
    STUDIO_MAX_EDITORS: '8',
    STUDIO_MAX_EDITORS_PER_PROJECT: '6',
    STUDIO_MAX_TERMINALS: '2',
    STUDIO_MAX_TERMINALS_PER_PROJECT: '2',
    STUDIO_WORKER_CPUS: '1',
    STUDIO_WORKER_MEMORY: '1g',
    STUDIO_WORKER_MEMORY_BUDGET: '8g',
  })
  const makeRuntime = () => {
    assert(realRuntime, 'Live fixture requires real isolated workers.')
    return new Runtime({
      dataDir,
      image:
        process.env.STUDIO_TEST_WORKER_IMAGE || process.env.LEMEX_WORKER_IMAGE,
      hostToolchainDir: process.env.STUDIO_TEST_TOOLCHAIN_DIR,
      scope: 'helper',
      cpus: 1,
      memory: '1g',
      memoryBudget: '8g',
      maxConcurrent: 6,
      maxQueue: 12,
    })
  }
  let runtime, studio, origin, port
  const start = async () => {
    runtime = makeRuntime()
    studio = await createStudio({
      dataDir,
      runtime,
      capacity,
      modelDiscoverer: fixtureModelDiscovery,
      titleGenerator: async () => null,
      config: {
        models: [
          {
            id: 'offline-test-model',
            name: 'Offline test model',
            reasoningEfforts: [{ id: 'high', description: 'High' }],
            defaultReasoningEffort: 'high',
          },
        ],
        defaultModel: 'offline-test-model',
        provider: { LEMEX_BASE_URL: 'https://provider.example/v1' },
        lemex: {},
        redact: String,
      },
    })
    assert(runtime.info().ready, runtime.info().error)
    await runtime.prepareToolchain(TOOLCHAIN)
    await new Promise((resolve) =>
      studio.server.listen(port || 0, '127.0.0.1', resolve),
    )
    port = studio.server.address().port
    origin = `http://127.0.0.1:${port}`
  }
  try {
    await start()
  } catch (error) {
    await studio?.close().catch(() => {})
    await runtime?.shutdown().catch(() => {})
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
  try {
    const admin = {
      id: 'owner',
      name: 'Sharing Admin',
      token: (
        await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
      ).trim(),
    }
    const accounts = { admin }
    await studio.auth.updateProfile(admin, { name: admin.name })
    for (const [key, name] of Object.entries({
      editorA: 'Sharing Editor A',
      editorB: 'Sharing Editor B',
      viewer: 'Sharing Viewer',
      outsider: 'Sharing Outsider',
    })) {
      const result = await studio.auth.createUser(admin, { name })
      accounts[key] = { id: result.user.id, name, token: result.token }
      await studio.auth.updateProfile(accounts[key], { name })
    }
    for (const account of Object.values(accounts)) {
      await studio.providers.save(
        account.id,
        `offline-fixture-${account.id}`,
        'https://provider.example/v1',
      )
    }
    const request = (
      actor,
      endpoint,
      { body, method = 'GET', ...options } = {},
    ) =>
      fetch(origin + endpoint, {
        ...options,
        method,
        headers: {
          Authorization: `Bearer ${accounts[actor]?.token || actor.token}`,
          Origin: origin,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const project = await studio.workspaces.create(admin.id, {
      preset: 'lean',
      toolchain: TOOLCHAIN,
      name: 'Live sharing validation',
      autoRepair: false,
    })
    await studio.workspaces.jobs.get(project.id)
    assert.equal(
      studio.workspaces.get(project.id, admin.id).status,
      'ready',
      studio.workspaces.get(project.id, admin.id).error,
    )
    const initial = await studio.workspaces.readFile(
      project.id,
      admin.id,
      'Main.lean',
    )
    await studio.workspaces.writeFile(
      project.id,
      admin.id,
      'Main.lean',
      liveSource,
      initial.hash,
    )
    await studio.workspaces.writeFile(
      project.id,
      admin.id,
      'Other.lean',
      '-- second file\nexample : 2 = 2 := rfl\n',
      null,
    )
    for (const key of ['editorA', 'editorB', 'viewer']) {
      const response = await request(
        'admin',
        `/api/projects/${project.id}/sharing/members/${accounts[key].id}`,
        {
          method: 'PUT',
          body: { role: key === 'viewer' ? 'viewer' : 'editor' },
        },
      )
      assert.equal(response.status, 200)
      await response.json()
    }
    const privateProject = await studio.workspaces.create(accounts.editorB.id, {
      preset: 'lean',
      toolchain: TOOLCHAIN,
      name: 'Private project sentinel',
      autoRepair: false,
    })
    await studio.workspaces.jobs.get(privateProject.id)
    assert.equal(
      studio.workspaces.get(privateProject.id, accounts.editorB.id).status,
      'ready',
    )
    await studio.workspaces.writeFile(
      privateProject.id,
      accounts.editorB.id,
      'PRIVATE.txt',
      'PRIVATE_PROJECT_SENTINEL\n',
      null,
    )
    let closed = false
    return {
      directory,
      dataDir,
      accounts,
      project,
      privateProject,
      capacity,
      request,
      get studio() {
        return studio
      },
      get runtime() {
        return runtime
      },
      get origin() {
        return origin
      },
      async restart() {
        await studio.close()
        await start()
      },
      async close({ keepData = false } = {}) {
        if (closed) return
        closed = true
        await studio.close()
        if (!keepData) await fs.rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await studio?.close().catch(() => {})
    await runtime?.shutdown().catch(() => {})
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}
