import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateGitBranch } from './git-branches.mjs'
import { validateWorkspaceFilePath } from './workspaces.mjs'
import {
  clearGitCredentials,
  gitHttpsEnv,
  redactGitCredentials,
  validateGitCredentials,
} from './git-credentials.mjs'
import { runAuthenticatedRepositoryGit } from './repository-git.mjs'

const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status })
}

async function matchesPublishedEdits(source, target, run, options) {
  const name = `leanflow-pull-index-${randomUUID()}`
  const index = path.join(source, '.git', name)
  const alternate = {
    ...options,
    env: { ...gitHttpsEnv, GIT_INDEX_FILE: `/workspace/.git/${name}` },
  }
  try {
    // A separate index compares the remote tree with saved files, including
    // incoming files that are currently untracked. Never stage the user's files.
    await run(source, ['read-tree', target], alternate)
    const different = await run(
      source,
      ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv'],
      alternate,
    )
    if (different.stdout) return false
    const staged = await run(
      source,
      ['diff', '--cached', '--name-only', '-z'],
      options,
    )
    if (!staged.stdout) return true
    const stagedDifference = await run(
      source,
      ['diff', '--cached', '--name-only', '-z', target],
      options,
    )
    return !stagedDifference.stdout
  } finally {
    await fs.rm(index, { force: true })
    await fs.rm(index + '.lock', { force: true })
  }
}

// Fetch into a new bare repository: project config, hooks and filters never run
// with credentials. Only a checked bundle enters the original checkout.
export async function pullProjectGit({
  owner,
  project,
  input,
  source,
  directory,
  runtime,
  dataDir,
  metadata,
  destination,
  credentialsFor,
  run: execute,
  locked,
  assertIdle,
  copy,
}) {
  const run = async (...args) => {
    const result = await execute(...args)
    if (result.truncated)
      fail(
        'Git returned too much output to check this pull safely. Use a separate Git checkout.',
      )
    return result
  }
  if (
    typeof input.reviewToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.reviewToken)
  )
    fail('Refresh Source control before pulling.', 400)
  const initial = await metadata()
  if (initial.reviewToken !== input.reviewToken)
    fail(
      'Project files or Git history changed. Refresh Source control before pulling.',
    )
  validateGitBranch(initial.branch, {
    message: 'Create or switch to a branch before pulling.',
  })
  if (!initial.revision) fail('Create a commit before pulling remote history.')
  const branch = validateGitBranch(
    input.branch === undefined
      ? initial.pullBranch || initial.branch
      : input.branch,
  )
  const remote = await destination(
    input.remoteUrl === undefined ? initial.remoteUrl : input.remoteUrl,
  )
  const credentials = validateGitCredentials(input)
  const root = path.join(directory, randomUUID())
  const bundleName = `leanflow-pull-${randomUUID()}.bundle`
  const bundle = path.join(source, '.git', bundleName)
  const localOptions = { queue: false, readOnlyHome: true }
  let originalStatus
  const clean = async () => {
    assertIdle()
    const status = await run(
      source,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      localOptions,
    )
    if (originalStatus !== undefined && status.stdout !== originalStatus)
      fail(
        'Local changes were saved during the pull. Refresh and try again. No files were overwritten.',
      )
    originalStatus = status.stdout
    const current = await metadata({ queue: false })
    if (current.reviewToken !== initial.reviewToken)
      fail(
        'Project files or Git history changed during the pull. Refresh and try again.',
      )
  }
  let changed = []
  let removed = []
  let updated = false
  try {
    await locked(clean)
    if (!credentials.token) {
      const saved = await credentialsFor(owner, remote.remoteUrl)
      if (saved) Object.assign(credentials, validateGitCredentials(saved))
    }
    await fs.mkdir(root, { mode: 0o700 })
    await run(root, [
      'init',
      '--bare',
      '--template=',
      '/workspace/repository.git',
    ])
    const result = await runAuthenticatedRepositoryGit({
      runtime,
      dataDir,
      root,
      credentials,
      args: [
        ...remote.pin,
        '--git-dir=/workspace/repository.git',
        '-c',
        'fetch.fsckObjects=true',
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--',
        remote.remoteUrl,
        `refs/heads/${branch}:refs/heads/incoming`,
      ],
      timeoutMs: 300_000,
      signal: AbortSignal.timeout(300_000),
    })
    if (result.code !== 0)
      fail(
        `Could not pull ${branch}. Check that the branch exists and your token in Git connections has read access. ${result.stderr.slice(-2000)}`,
      )
    const target = (
      await run(root, [
        '--git-dir=/workspace/repository.git',
        'rev-parse',
        'refs/heads/incoming',
      ])
    ).stdout.trim()
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(target))
      fail('The remote did not return a valid commit.')
    await run(root, [
      '--git-dir=/workspace/repository.git',
      'bundle',
      'create',
      '/workspace/incoming.bundle',
      'refs/heads/incoming',
    ])
    await locked(async () => {
      await clean()
      await copy(path.join(root, 'incoming.bundle'), bundle)
      await run(
        source,
        [
          '-c',
          'protocol.file.allow=always',
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--no-write-fetch-head',
          '--',
          `/workspace/.git/${bundleName}`,
          'refs/heads/incoming',
        ],
        localOptions,
      )
      // Refuse divergence before considering incoming paths. An already-ahead
      // checkout is a successful no-op, not a reset to the remote commit.
      const ancestor = (
        await run(source, ['merge-base', 'HEAD', target], localOptions)
      ).stdout.trim()
      if (ancestor === target) return
      if (ancestor !== initial.revision)
        fail(
          'Local and remote commits have diverged. Reconcile them in a Git checkout, then pull again. No files were overwritten.',
        )
      changed = (
        await run(
          source,
          ['diff', '--name-only', '-z', 'HEAD', target],
          localOptions,
        )
      ).stdout
        .split('\0')
        .filter(Boolean)
      removed = (
        await run(
          source,
          ['diff', '--name-only', '--diff-filter=D', '-z', 'HEAD', target],
          localOptions,
        )
      ).stdout
        .split('\0')
        .filter(Boolean)
      for (const filename of changed) {
        try {
          validateWorkspaceFilePath(filename)
          if (filename.split('/').includes('.lake'))
            throw new Error('Dependency cache')
          if (
            project.subdirectory &&
            !filename.startsWith(project.subdirectory + '/')
          )
            throw new Error('Outside the project folder')
        } catch {
          fail(
            'The incoming history changes a protected project path. Review it in a separate Git checkout before importing it.',
          )
        }
      }
      const tree = changed.length
        ? (
            await run(
              source,
              [
                '--literal-pathspecs',
                'ls-tree',
                '-r',
                '-z',
                target,
                '--',
                ...changed,
              ],
              localOptions,
            )
          ).stdout
        : ''
      for (const entry of tree.split('\0').filter(Boolean)) {
        const [mode, type] = entry.split(' ')
        if (!['100644', '100755'].includes(mode) || type !== 'blob')
          fail(
            'The incoming repository contains links or submodules. Review them in a separate Git checkout before importing it.',
          )
      }
      await clean()
      if (originalStatus.trim()) {
        if (!(await matchesPublishedEdits(source, target, run, localOptions)))
          fail(
            'Commit or move your local changes before pulling. They differ from the incoming commit; no files were overwritten.',
          )
        // Every tracked working file already matches the incoming tree, and
        // no distinct staged edit would be lost. Advance metadata only.
        await run(source, ['reset', '--mixed', target], localOptions)
      } else {
        await run(
          source,
          ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', target],
          localOptions,
        )
      }
      updated = true
    })
    const projectPaths = (paths) =>
      paths.map((filename) =>
        project.subdirectory
          ? filename.slice(project.subdirectory.length + 1)
          : filename,
      )
    return {
      pulled: true,
      updated,
      branch,
      remoteUrl: remote.remoteUrl,
      paths: projectPaths(changed),
      removedPaths: projectPaths(removed),
    }
  } catch (error) {
    error.message = redactGitCredentials(error.message, credentials)
    throw error
  } finally {
    clearGitCredentials(credentials)
    await fs.rm(bundle, { force: true })
    await fs.rm(root, { recursive: true, force: true })
  }
}
