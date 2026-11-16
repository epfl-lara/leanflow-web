import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { WorkspaceStore } from '../workspaces.mjs'

const execute = promisify(execFile)

async function fixture(t, { state = 'needs-setup' } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lf-git-status-'))
  const calls = []
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
  }
  const runtime = {
    async runGit(root, args, options) {
      calls.push({ root, args, options })
      try {
        return {
          code: 0,
          ...(await execute(args[0], args.slice(1), {
            cwd: root,
            env: { ...env, ...options.env },
          })),
        }
      } catch (error) {
        return { code: error.code, stdout: error.stdout, stderr: error.stderr }
      }
    },
    run() {
      assert.fail('Git status must not need a Lean worker.')
    },
  }
  const store = await new WorkspaceStore({ dataDir, runtime }).init()
  const project = {
    id: randomUUID(),
    owner: 'alice',
    name: 'Git before Lean',
    status: state,
    ...(state === 'error' ? { needsPreparation: true } : {}),
  }
  project.root = path.join(store.projectsDir, project.id)
  await fs.mkdir(project.root)
  store.db
    .prepare('INSERT INTO projects VALUES(?,?,?)')
    .run(project.id, 'alice', JSON.stringify(project))
  t.after(async () => {
    store.close()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  const git = async (...args) =>
    (await execute('git', args, { cwd: project.root, env })).stdout.trim()
  await git('init', '--template=', '-b', 'main')
  await fs.writeFile(path.join(project.root, '[notes].md'), 'Original notes\n')
  await fs.writeFile(
    path.join(project.root, 'Old.lean'),
    'example : True := by trivial\n',
  )
  await git('add', '.')
  await git('commit', '-m', 'Initial')
  return { store, project, runtime, calls, git }
}

test('Git status and literal-path diffs work before setup and after a setup failure', async (t) => {
  for (const state of ['needs-setup', 'error'])
    await t.test(state, async (t) => {
      const f = await fixture(t, { state })
      await fs.appendFile(
        path.join(f.project.root, '[notes].md'),
        'Saved edit\n',
      )
      const status = await f.store.gitStatus(f.project.id, 'alice')
      assert.equal(status.repository, true)
      assert.equal(status.branch, 'main')
      assert.deepEqual(status.changes, [{ status: ' M', path: '[notes].md' }])
      assert(status.diff.includes('+Saved edit'))
      assert.equal(status.diffTruncated, false)
      assert(f.calls.every(({ options }) => options.network === 'none'))
      await assert.rejects(f.store.gitStatus(f.project.id, 'outsider'), {
        status: 404,
      })
    })
})

test('a staged rename diff includes its source and destination', async (t) => {
  const f = await fixture(t)
  await f.git('mv', 'Old.lean', 'New.lean')
  const status = await f.store.gitStatus(f.project.id, 'alice')
  assert.deepEqual(status.changes, [
    { status: 'R ', path: 'New.lean', from: 'Old.lean' },
  ])
  assert.match(status.diff, /rename from Old\.lean/)
  assert.match(status.diff, /rename to New\.lean/)
})

test('truncated status, HEAD, and diff results cannot become a partial Git review', async (t) => {
  for (const operation of ['status', 'rev-parse', 'diff'])
    await t.test(operation, async (t) => {
      const f = await fixture(t)
      await fs.appendFile(
        path.join(f.project.root, '[notes].md'),
        'Saved edit\n',
      )
      const run = f.runtime.runGit
      f.runtime.runGit = async (root, args, options) => ({
        ...(await run(root, args, options)),
        ...(args.includes(operation) ? { truncated: true } : {}),
      })
      await assert.rejects(
        f.store.gitStatus(f.project.id, 'alice'),
        /too large|completely/,
      )
    })
})

test('linked Git metadata is rejected before a worker reads history', async (t) => {
  const f = await fixture(t)
  await fs.rename(
    path.join(f.project.root, '.git'),
    path.join(f.project.root, 'original-git'),
  )
  await fs.symlink('original-git', path.join(f.project.root, '.git'))
  await assert.rejects(
    f.store.gitStatus(f.project.id, 'alice'),
    /standalone Git repository/,
  )
  assert.equal(f.calls.length, 0)
})
