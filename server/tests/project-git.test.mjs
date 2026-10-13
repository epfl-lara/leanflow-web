import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createStudio } from '../studio.mjs'

const execute = promisify(execFile)
test('nested project commits preserve pre-staged sibling and private files outside the commit', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-git-scope-'))
  const runtime = {
    async init() {},
    info: () => ({ ready: true }),
    templates: () => [{ id: 'lean', toolchain: 'leanprover/lean4:v4.34.1' }],
    templateRoot: () => null,
    async prepareToolchain() {},
    async shutdown() {},
    async run(root, args) {
      if (args[0] !== 'git') return { code: 0, stdout: '', stderr: '' }
      try {
        return {
          code: 0,
          ...(await execute(args[0], args.slice(1), { cwd: root })),
        }
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      }
    },
    spawn: (root, args) =>
      spawn(args[0], args.slice(1), {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  }
  const studio = await createStudio({
    dataDir,
    runtime,
    config: {
      defaultModel: 'fixture',
      models: [],
      provider: {},
      redact: String,
      lemex: {},
    },
  })
  await new Promise((resolve) => studio.server.listen(0, '127.0.0.1', resolve))
  try {
    const project = await studio.workspaces.create('owner', {
      autoRepair: false,
      subdirectory: 'Lean',
      files: [
        { path: 'Lean/lean-toolchain', content: 'leanprover/lean4:v4.34.1\n' },
        { path: 'Lean/lakefile.toml', content: 'name = "fixture"\n' },
        { path: 'Lean/Main.lean', content: 'example : True := by trivial\n' },
        {
          path: 'sibling.txt',
          content: 'Keep this staged, outside the selected Lean project.\n',
        },
      ],
    })
    await studio.workspaces.jobs.get(project.id)
    assert.equal(studio.workspaces.get(project.id, 'owner').status, 'ready')
    const checkout = studio.workspaces.repositoryRoot(project)
    await fs.writeFile(
      path.join(checkout, 'Lean/image.bin'),
      Buffer.from([0, 1, 2, 255]),
    )
    await fs.writeFile(
      path.join(checkout, 'Lean/large.txt'),
      'x'.repeat(2 * 1024 * 1024 + 1),
    )
    await fs.writeFile(path.join(checkout, 'Lean/.env'), 'DUMMY=not-a-secret\n')
    await execute('git', ['add', 'sibling.txt', 'Lean/.env'], { cwd: checkout })
    const token = (
      await fs.readFile(path.join(dataDir, 'auth/owner.token'), 'utf8')
    ).trim()
    const response = await fetch(
      `http://127.0.0.1:${studio.server.address().port}/api/projects/${project.id}/git`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'commit',
          message: 'Selected Lean files only',
        }),
      },
    )
    assert.equal(response.status, 200, await response.text())
    const committed = (
      await execute('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
        cwd: checkout,
      })
    ).stdout
      .trim()
      .split('\n')
    assert(committed.includes('Lean/Main.lean'))
    assert(committed.includes('Lean/image.bin'))
    assert(committed.includes('Lean/large.txt'))
    assert(
      committed.every(
        (file) => file.startsWith('Lean/') && file !== 'Lean/.env',
      ),
    )
    const staged = (
      await execute('git', ['diff', '--cached', '--name-only'], {
        cwd: checkout,
      })
    ).stdout
      .trim()
      .split('\n')
    assert.deepEqual(staged.sort(), ['Lean/.env', 'sibling.txt'])
  } finally {
    await studio.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  }
})
