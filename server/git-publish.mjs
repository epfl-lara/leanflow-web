import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { validateRepository } from './workspaces.mjs'
import { validateGitBranch } from './git-branches.mjs'
import {
  cleanupGitWorkerHome,
  clearGitCredentials,
  gitCredentialsRunner,
  gitHttpsDestination,
  gitHttpsArgs as gitArgs,
  gitHttpsEnv as gitEnv,
  redactGitCredentials,
  validateGitCredentials,
} from './git-credentials.mjs'
import {
  gitReviewLink,
  gitReviewProvider,
  suggestedPublishBranch,
} from './git-review.mjs'

const HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MAX_BUNDLE = 512 * 1024 * 1024
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const NETWORK_GIT = `import os, sys
env = dict(os.environ)
env.pop('GIT_SSL_NO_VERIFY', None)
os.execvpe(sys.argv[1], sys.argv[1:], env)
`

function destinationHint(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}
function targetBranch(value) {
  return validateGitBranch(value, {
    message: 'Choose a valid destination branch name.',
  })
}
function namedBranch(value) {
  try {
    return validateGitBranch(value)
  } catch {
    return null
  }
}
function requirePublishing(project) {
  if (project.publishingEnabled === false)
    fail(
      'Enable publishing for this project before previewing or pushing changes.',
      409,
    )
}
function rememberedPublication(value) {
  if (
    !value ||
    value.pushed !== true ||
    !HASH.test(value.head) ||
    !namedBranch(value.branch) ||
    typeof value.remoteUrl !== 'string' ||
    destinationHint(value.remoteUrl) !== value.remoteUrl ||
    !['github', 'gitlab', 'other'].includes(value.provider) ||
    (value.baseBranch !== null && !namedBranch(value.baseBranch))
  )
    return null
  try {
    const publication = {
      pushed: true,
      head: value.head,
      branch: value.branch,
      remoteUrl: value.remoteUrl,
      provider: gitReviewProvider(value.remoteUrl, value.provider),
      baseBranch: value.baseBranch,
    }
    const review = gitReviewLink(publication)
    return { ...publication, ...(review ? { review } : {}) }
  } catch {
    return null
  }
}
async function optionalStat(filename) {
  try {
    return await fs.lstat(filename)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}
async function safeCopy(source, destination, maxBytes = MAX_BUNDLE) {
  const input = await fs.open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let output
  try {
    if (
      (await fs.realpath(`/proc/self/fd/${input.fd}`)) !== path.resolve(source)
    )
      fail('Git export path changed or traversed a symbolic link.', 409)
    const before = await input.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes)
      fail('Git export is not a safe bounded regular file.', 409)
    output = await fs.open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      position += bytesRead
      if (position > maxBytes)
        fail('Git export exceeds the 512 MiB publishing limit.', 413)
      let written = 0
      while (written < bytesRead)
        written += (await output.write(buffer, written, bytesRead - written))
          .bytesWritten
    }
    const after = await input.stat(),
      current = await fs.lstat(source)
    if (
      (await fs.realpath(`/proc/self/fd/${input.fd}`)) !==
        path.resolve(source) ||
      position !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.nlink !== 1 ||
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    )
      fail(
        'The Git export changed while being transferred. Preview again.',
        409,
      )
    await output.sync()
  } finally {
    await input.close()
    await output?.close()
  }
}

// Only committed objects cross into a credentialed worker. Original config,
// hooks, worktree files and agent state never accompany this export.
export class GitPublisher {
  constructor({
    dataDir,
    runtime,
    workspaces,
    assertIdle = () => {},
    resolveHost = lookup,
    publishTransport,
    gitCredentials = async () => null,
    redact = String,
    now = Date.now,
    ttlMs = 10 * 60_000,
  }) {
    Object.assign(this, {
      dataDir: path.resolve(dataDir),
      runtime,
      workspaces,
      assertIdle,
      resolveHost,
      publishTransport,
      gitCredentials,
      redact,
      now,
      ttlMs,
    })
    this.dir = path.join(this.dataDir, 'git-publish')
    this.previews = new Map()
    this.busy = new Set()
    this.destinationWrites = Promise.resolve()
    this.defaultBranches = new Map()
  }
  async init() {
    if (!this.initialization)
      this.initialization = (async () => {
        await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
        if ((await fs.realpath(this.dir)) !== this.dir)
          fail('Publishing directory is unsafe.', 409)
        for (const entry of await fs.readdir(this.dir, { withFileTypes: true }))
          if (entry.isDirectory() && UUID.test(entry.name))
            await fs.rm(path.join(this.dir, entry.name), {
              recursive: true,
              force: true,
            })
      })()
    await this.initialization
    return this
  }
  blocked(owner, projectId) {
    if (this.busy.has(projectId))
      return 'A Git operation is already running for this project.'
    try {
      this.assertIdle(projectId, owner)
    } catch (error) {
      return error.message
    }
    return null
  }
  async #locked(projectId, action) {
    const previous = this.workspaces.locks?.get(projectId) || Promise.resolve()
    const task = previous.catch(() => {}).then(action)
    this.workspaces.locks?.set(projectId, task)
    try {
      return await task
    } finally {
      if (this.workspaces.locks?.get(projectId) === task)
        this.workspaces.locks.delete(projectId)
    }
  }
  async withProject(owner, projectId, action, { workspaceLock = true } = {}) {
    this.workspaces.get(projectId, owner)
    if (this.busy.has(projectId))
      fail('A Git operation is already running for this project.', 409)
    this.busy.add(projectId)
    const execute = async () => {
      const project = this.workspaces.get(projectId, owner)
      if (project.status !== 'ready')
        fail('Prepare this project before changing Git history.', 409)
      this.assertIdle(projectId, owner)
      return action(project)
    }
    try {
      return await (workspaceLock
        ? this.#locked(projectId, execute)
        : execute())
    } finally {
      this.busy.delete(projectId)
    }
  }
  async #source(project) {
    const root = this.workspaces.repositoryRoot(project)
    if ((await fs.realpath(root)) !== path.resolve(root))
      fail('The repository root is unsafe.', 409)
    const git = path.join(root, '.git'),
      stat = await optionalStat(git)
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      fail(
        'Publishing requires a regular .git directory. Import a standalone repository first.',
        409,
      )
    for (const relative of [
      'info',
      'objects',
      'objects/info',
      'objects/pack',
    ]) {
      const value = await optionalStat(path.join(git, relative))
      if (value && (!value.isDirectory() || value.isSymbolicLink()))
        fail(
          'Linked Git objects cannot be published. Import a standalone repository first.',
          409,
        )
    }
    for (const relative of [
      'commondir',
      'objects/info/alternates',
      'info/grafts',
    ])
      if (await optionalStat(path.join(git, relative)))
        fail(
          'Linked or rewritten Git history cannot be published. Import a standalone repository first.',
          409,
        )
    return root
  }
  async #run(root, args, options = {}, token = '') {
    const command = [...gitArgs, ...args]
    const { result } = await this.#queued(
      root,
      options.network === 'bridge'
        ? ['python3', '-c', NETWORK_GIT, ...command]
        : command,
      {
        env: gitEnv,
        timeoutMs: 300_000,
        network: 'none',
        freshHome: true,
        cleanHome: true,
        ...options,
      },
    )
    if (result.code !== 0) {
      const detail = this.redact(
        String(result.stderr || result.stdout || 'Git operation failed.'),
      )
        .split(token || '\0')
        .join(token ? '[redacted]' : '\0')
      fail(detail.slice(-4000), 409)
    }
    return result
  }
  async #queued(root, args, options, { keepHome = false } = {}) {
    let child, result
    const deadline = AbortSignal.timeout(options.timeoutMs || 300_000)
    const signal = options.signal
      ? AbortSignal.any([deadline, options.signal])
      : deadline
    try {
      result = await this.runtime.run(root, args, {
        ...options,
        signal,
        maxOutputBytes: 1024 * 1024,
        onSpawn: (worker) => {
          child = worker
        },
      })
    } catch (error) {
      await this.#cleanupHome(child)
      if (signal.aborted)
        fail(
          'The Git operation timed out while waiting for or running a worker. Try again when a worker is available.',
          503,
        )
      throw error
    }
    if (!keepHome) await this.#cleanupHome(child)
    if (signal.aborted) {
      if (keepHome) await this.#cleanupHome(child)
      fail(
        'The Git operation timed out while waiting for or running a worker. Try again when a worker is available.',
        503,
      )
    }
    return { result, child }
  }
  async #cleanupHome(child) {
    await cleanupGitWorkerHome(child, this.dataDir)
  }
  async #head(root) {
    const result = await this.#run(
      root,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      { readOnlyWorkspace: true, readOnlyHome: true },
    )
    const head = result.stdout.trim()
    if (!HASH.test(head)) fail('Create a commit before previewing a push.', 409)
    return head
  }
  async #defaultBranch(root, head) {
    const previous = this.defaultBranches.get(root)
    if (previous?.head === head) return previous.result
    const result = this.#readDefaultBranch(root)
    const entry = { head, result }
    this.defaultBranches.delete(root)
    this.defaultBranches.set(root, entry)
    while (this.defaultBranches.size > 1000)
      this.defaultBranches.delete(this.defaultBranches.keys().next().value)
    try {
      return await result
    } catch (error) {
      if (this.defaultBranches.get(root) === entry)
        this.defaultBranches.delete(root)
      throw error
    }
  }
  async #readDefaultBranch(root) {
    try {
      const result = await this.#run(
        root,
        ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
        { readOnlyWorkspace: true, readOnlyHome: true },
      )
      const reference = result.stdout.trim()
      return reference.startsWith('origin/')
        ? namedBranch(reference.slice('origin/'.length))
        : null
    } catch (error) {
      if (error.status !== 409) throw error
      return null
    }
  }
  async #exportedShallowBoundaries(root, hashes) {
    const result = await this.#run(
      root,
      [
        '--git-dir=/workspace/repository.git',
        'cat-file',
        '--batch-check=%(objectname) %(objecttype)',
      ],
      {
        readOnlyWorkspace: true,
        readOnlyHome: true,
        input: hashes.join('\n') + '\n',
      },
    )
    const lines = result.stdout.trim().split('\n')
    if (lines.length !== hashes.length)
      fail('The exported shallow history could not be verified.', 409)
    return hashes.filter((hash, index) => {
      if (lines[index] === hash + ' commit') return true
      if (lines[index] === hash + ' missing') return false
      fail('The exported shallow history could not be verified.', 409)
    })
  }
  async #history(root, bare = false) {
    const prefix = bare ? ['--git-dir=/workspace/repository.git'] : []
    const commits = await this.#run(
      root,
      [...prefix, 'log', '-20', '--format=%H%x00%s%x00', 'HEAD'],
      { readOnlyWorkspace: true, readOnlyHome: true },
    )
    const fields = commits.stdout.split('\0'),
      rows = []
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const sha = fields[index].trim()
      if (HASH.test(sha))
        rows.push({
          sha,
          message: this.redact(fields[index + 1]).slice(0, 2000),
        })
    }
    const count = await this.#run(
      root,
      [...prefix, 'rev-list', '--count', 'HEAD'],
      { readOnlyWorkspace: true, readOnlyHome: true },
    )
    return {
      commits: rows,
      historyCount: Number.parseInt(count.stdout.trim(), 10) || 0,
    }
  }
  async #remembered(owner, projectId) {
    try {
      const saved = JSON.parse(
        await fs.readFile(path.join(this.dir, 'destinations.json'), 'utf8'),
      )[owner]?.[projectId]
      if (typeof saved === 'string') return { remoteUrl: saved }
      if (!saved || typeof saved.remoteUrl !== 'string') return null
      const lastPublished = rememberedPublication(saved.lastPublished)
      return {
        remoteUrl: saved.remoteUrl,
        ...(['github', 'gitlab', 'other'].includes(saved.provider)
          ? { provider: saved.provider }
          : {}),
        ...(Object.hasOwn(saved, 'baseBranch') &&
        (saved.baseBranch === null || saved.baseBranch === '')
          ? { baseBranch: null }
          : namedBranch(saved.baseBranch)
            ? { baseBranch: saved.baseBranch }
            : {}),
        ...(lastPublished ? { lastPublished } : {}),
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  }
  async #destination(value) {
    return gitHttpsDestination(value, {
      validateRepository,
      resolveHost: this.resolveHost,
    })
  }
  async metadata(owner, projectId, status) {
    const project = this.workspaces.get(projectId, owner)
    status ||= await this.workspaces.gitStatus(projectId, owner)
    const blockedReason = this.blocked(owner, projectId)
    const remembered = await this.#remembered(owner, projectId)
    let remoteUrl =
        remembered?.remoteUrl || destinationHint(project.repository),
      commits = [],
      defaultBranch = null
    if (status.repository) {
      const root = await this.#source(project)
      if (status.revision) commits = (await this.#history(root)).commits
      if (
        !Object.hasOwn(remembered || {}, 'baseBranch') &&
        !namedBranch(project.publishingBaseBranch)
      )
        defaultBranch = await this.#defaultBranch(root, status.revision)
    }
    const review = createHash('sha256').update(
      JSON.stringify({
        revision: status.revision,
        branch: status.branch,
        changes: status.changes,
        diff: status.diff,
      }),
    )
    for (const change of [...status.changes].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      review.update(change.path + '\0')
      try {
        await this.workspaces.gitFilePath(projectId, owner, change.path)
        const handle = await fs.open(
          path.join(project.root, change.path),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          const stat = await handle.stat()
          if (
            (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !==
            path.join(project.root, change.path)
          )
            fail('A Git file path changed while reviewing it.', 409)
          if (!stat.isFile())
            fail('The changed Git path is not a regular file.', 409)
          const buffer = Buffer.alloc(1024 * 1024)
          let position = 0
          while (true) {
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              position,
            )
            if (!bytesRead) break
            review.update(buffer.subarray(0, bytesRead))
            position += bytesRead
          }
          const after = await handle.stat()
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
            fail('Files changed while reviewing Git. Refresh the review.', 409)
        } finally {
          await handle.close()
        }
      } catch (error) {
        if (![403, 404].includes(error.status) && error.code !== 'ENOENT')
          throw error
        review.update('inaccessible-or-deleted')
      }
      review.update('\0')
    }
    return {
      ...status,
      remoteUrl,
      publishingEnabled: project.publishingEnabled !== false,
      provider: gitReviewProvider(remoteUrl, remembered?.provider),
      baseBranch: Object.hasOwn(remembered || {}, 'baseBranch')
        ? remembered.baseBranch
        : namedBranch(project.publishingBaseBranch) || defaultBranch,
      suggestedBranch: suggestedPublishBranch(project.id, this.now()),
      ...(remembered?.lastPublished
        ? { lastPublished: remembered.lastPublished }
        : {}),
      commits,
      reviewToken: review.digest('hex'),
      mutationBlocked: !!blockedReason,
      ...(blockedReason ? { blockedReason } : {}),
    }
  }
  async preview(owner, projectId, input = {}) {
    return this.withProject(
      owner,
      projectId,
      async (project) => {
        requirePublishing(project)
        await this.init()
        for (const [id, item] of this.previews)
          if (
            item.expiresAt <= this.now() ||
            (item.owner === owner && item.projectId === projectId)
          ) {
            this.previews.delete(id)
            await fs.rm(item.root, { recursive: true, force: true })
          }
        if (this.previews.size >= 100)
          fail('Too many pending push previews. Try again later.', 503)
        const status = await this.metadata(owner, projectId),
          source = await this.#source(project)
        const branch = targetBranch(input.branch || status.branch)
        const destination = await this.#destination(
          input.remoteUrl || status.remoteUrl,
        )
        const provider = gitReviewProvider(
          destination.remoteUrl,
          input.provider,
        )
        const baseBranch =
          input.baseBranch === undefined || input.baseBranch === ''
            ? null
            : validateGitBranch(input.baseBranch, {
                message: 'Choose a valid pull or merge request target branch.',
              })
        const head = await this.#head(source),
          previewId = randomUUID()
        const root = path.join(this.dir, previewId)
        await fs.mkdir(root, { mode: 0o700 })
        try {
          let shallowHashes = []
          await this.#locked(projectId, async () => {
            this.assertIdle(projectId, owner)
            let child
            try {
              const exported = await this.#queued(
                source,
                [
                  ...gitArgs,
                  'bundle',
                  'create',
                  '/home/worker/export.bundle',
                  'HEAD',
                ],
                {
                  env: gitEnv,
                  network: 'none',
                  readOnlyWorkspace: true,
                  freshHome: true,
                  cleanHome: true,
                  timeoutMs: 300_000,
                },
                { keepHome: true },
              )
              child = exported.child
              if (exported.result.code !== 0)
                fail(
                  this.redact(exported.result.stderr || 'Git export failed.'),
                  409,
                )
              if (
                !child.workerHome ||
                (await fs.realpath(child.workerHome)) !==
                  path.resolve(child.workerHome) ||
                !child.workerHome.startsWith(
                  path.join(this.dataDir, 'runtime', 'homes') + path.sep,
                )
              )
                fail('The runtime did not supply a safe export home.', 503)
              await safeCopy(
                path.join(child.workerHome, 'export.bundle'),
                path.join(root, 'export.bundle'),
              )
              await fs.unlink(path.join(child.workerHome, 'export.bundle'))
              const shallow = await optionalStat(
                path.join(source, '.git', 'shallow'),
              )
              if (shallow) {
                await safeCopy(
                  path.join(source, '.git', 'shallow'),
                  path.join(root, 'shallow-boundaries'),
                  1024 * 1024,
                )
                shallowHashes = (
                  await fs.readFile(
                    path.join(root, 'shallow-boundaries'),
                    'utf8',
                  )
                )
                  .trim()
                  .split('\n')
                if (
                  !shallowHashes.length ||
                  shallowHashes.some((value) => !HASH.test(value))
                )
                  fail(
                    'Shallow history is invalid. Import a standalone repository first.',
                    409,
                  )
              }
              if ((await this.#head(source)) !== head)
                fail(
                  'The branch changed while exporting its history. Preview again.',
                  409,
                )
            } finally {
              await this.#cleanupHome(child)
            }
          })
          await fs.mkdir(path.join(root, 'empty-template'), { mode: 0o700 })
          await this.#run(root, [
            '-c',
            'protocol.file.allow=always',
            'clone',
            '--bare',
            '--no-hardlinks',
            '--template=/workspace/empty-template',
            '--',
            '/workspace/export.bundle',
            '/workspace/repository.git',
          ])
          await this.#run(root, [
            '--git-dir=/workspace/repository.git',
            'remote',
            'remove',
            'origin',
          ])
          if (!this.pinSupported) {
            const support = await this.#run(root, ['help', '--config'], {
              readOnlyWorkspace: true,
              readOnlyHome: true,
            })
            if (!support.stdout.includes('http.curloptResolve'))
              fail(
                'The Git worker cannot pin HTTPS destinations. Rebuild its image before publishing.',
                503,
              )
            this.pinSupported = true
          }
          if (shallowHashes.length) {
            // An imported revision can leave unrelated shallow branch tips in
            // the source repository. HEAD-only bundles omit those objects;
            // marking them shallow would make --unshallow reject the export.
            shallowHashes = await this.#exportedShallowBoundaries(
              root,
              shallowHashes,
            )
          }
          if (shallowHashes.length) {
            const exportedBoundaries = path.join(
              root,
              'exported-shallow-boundaries',
            )
            await fs.writeFile(
              exportedBoundaries,
              shallowHashes.join('\n') + '\n',
              { mode: 0o600, flag: 'wx' },
            )
            await safeCopy(
              exportedBoundaries,
              path.join(root, 'repository.git', 'shallow'),
              1024 * 1024,
            )
            const upstream = await this.#destination(project.repository)
            try {
              await this.#run(
                root,
                [
                  ...upstream.pin,
                  '--git-dir=/workspace/repository.git',
                  '-c',
                  'fetch.fsckObjects=true',
                  'fetch',
                  '--unshallow',
                  '--no-tags',
                  '--no-recurse-submodules',
                  '--',
                  upstream.remoteUrl,
                  ...shallowHashes,
                ],
                { network: 'bridge', timeoutMs: 600_000 },
              )
            } catch {
              fail(
                'The imported repository has shallow history that could not be fetched anonymously. Import its full history before publishing.',
                409,
              )
            }
          }
          const complete = await this.#run(
            root,
            [
              '--git-dir=/workspace/repository.git',
              'rev-parse',
              '--is-shallow-repository',
            ],
            { readOnlyWorkspace: true, readOnlyHome: true },
          )
          if (complete.stdout.trim() !== 'false')
            fail(
              'The repository still has incomplete shallow history. Import its full history before publishing.',
              409,
            )
          await this.#run(root, [
            '--git-dir=/workspace/repository.git',
            'fsck',
            '--full',
            '--strict',
          ])
          const bareHead = await this.#run(
            root,
            [
              '--git-dir=/workspace/repository.git',
              'rev-parse',
              '--verify',
              'HEAD^{commit}',
            ],
            { readOnlyWorkspace: true, readOnlyHome: true },
          )
          await this.#locked(projectId, async () => {
            this.assertIdle(projectId, owner)
            if (
              bareHead.stdout.trim() !== head ||
              (await this.#head(source)) !== head
            )
              fail(
                'The branch changed while preparing its preview. Preview again.',
                409,
              )
          })
          const history = await this.#history(root, true)
          const preview = {
            previewId,
            head,
            branch,
            remoteUrl: destination.remoteUrl,
            provider,
            baseBranch,
            ...history,
            uncommittedCount: status.changes.length,
          }
          const review = gitReviewLink(preview)
          if (review) preview.review = review
          this.previews.set(previewId, {
            ...preview,
            owner,
            projectId,
            root,
            expiresAt: this.now() + this.ttlMs,
          })
          return preview
        } catch (error) {
          await fs.rm(root, { recursive: true, force: true })
          throw error
        }
      },
      { workspaceLock: false },
    )
  }
  async #recordDestination(owner, projectId, destination) {
    const task = this.destinationWrites
      .catch(() => {})
      .then(async () => {
        const filename = path.join(this.dir, 'destinations.json')
        let stored = {}
        try {
          stored = JSON.parse(await fs.readFile(filename, 'utf8'))
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        stored[owner] = { ...stored[owner], [projectId]: destination }
        const temporary = filename + '.' + randomUUID()
        await fs.writeFile(temporary, JSON.stringify(stored), {
          mode: 0o600,
          flag: 'wx',
        })
        await fs.rename(temporary, filename)
      })
    this.destinationWrites = task
    return task
  }
  async push(owner, projectId, input = {}) {
    return this.withProject(
      owner,
      projectId,
      async (project) => {
        requirePublishing(project)
        if (typeof input.previewId !== 'string' || !UUID.test(input.previewId))
          fail('Preview this push before publishing it.')
        const preview = this.previews.get(input.previewId)
        if (
          !preview ||
          preview.owner !== owner ||
          preview.projectId !== projectId
        )
          fail('Push preview not found. Create a new preview.', 404)
        if (preview.expiresAt <= this.now())
          fail('This push preview expired. Preview it again.', 409)
        const credentials = validateGitCredentials(input)
        if (!credentials.token) {
          const saved = await this.gitCredentials(owner, preview.remoteUrl)
          if (saved) Object.assign(credentials, validateGitCredentials(saved))
        }
        const redactCredentials = (value) =>
          redactGitCredentials(value, credentials, this.redact)
        let attempted = false
        try {
          const source = await this.#source(project)
          await this.#locked(projectId, async () => {
            this.assertIdle(projectId, owner)
            if ((await this.#head(source)) !== preview.head)
              fail(
                'The branch HEAD changed after this preview. Preview the new commits before publishing.',
                409,
              )
          })
          const destination = await this.#destination(preview.remoteUrl)
          this.assertIdle(projectId, owner)
          this.previews.delete(input.previewId)
          attempted = true
          const env = { ...gitEnv }
          const args = [
            ...gitArgs,
            ...destination.pin,
            '--git-dir=/workspace/repository.git',
            '-c',
            'http.extraHeader=',
            '-c',
            'push.followTags=false',
            'push',
            '--porcelain',
            '--no-verify',
            '--',
            preview.remoteUrl,
            `${preview.head}:refs/heads/${preview.branch}`,
          ]
          const result = this.publishTransport
            ? await this.publishTransport({
                root: preview.root,
                args,
                env,
                credentials,
                ...preview,
              })
            : await (async () => {
                const queued = await this.#queued(
                  preview.root,
                  ['python3', '-c', gitCredentialsRunner, ...args],
                  {
                    env,
                    network: 'bridge',
                    freshHome: true,
                    cleanHome: true,
                    readOnlyWorkspace: true,
                    timeoutMs: 300_000,
                    input: JSON.stringify(credentials),
                  },
                )
                return queued.result
              })()
          if (result.code !== 0) {
            const detail = result.truncated
              ? 'Git output exceeded the publishing limit. Check the repository and retry.'
              : redactCredentials(
                  result.stderr || result.stdout || 'Push failed.',
                )
            fail(
              `The repository rejected this push. ${detail.slice(-4000)}`,
              409,
            )
          }
          const published = {
            pushed: true,
            head: preview.head,
            branch: preview.branch,
            remoteUrl: preview.remoteUrl,
            provider: preview.provider,
            baseBranch: preview.baseBranch,
            ...(preview.review ? { review: preview.review } : {}),
          }
          let warning
          try {
            await this.#recordDestination(owner, projectId, {
              remoteUrl: preview.remoteUrl,
              provider: preview.provider,
              baseBranch: preview.baseBranch,
              lastPublished: published,
            })
          } catch {
            warning =
              'The repository was pushed, but its destination could not be saved for the next visit.'
          }
          return {
            ...published,
            ...(warning ? { warning } : {}),
          }
        } catch (error) {
          error.message = redactCredentials(error.message)
          throw error
        } finally {
          clearGitCredentials(credentials)
          if (attempted)
            await fs.rm(preview.root, { recursive: true, force: true })
        }
      },
      { workspaceLock: false },
    )
  }
}
