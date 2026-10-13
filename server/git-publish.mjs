import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { validateRepository } from './workspaces.mjs'

const HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const MAX_BUNDLE = 512 * 1024 * 1024
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const gitEnv = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '0',
  GIT_TRACE: '0',
  GIT_TRACE_PACKET: '0',
  GIT_TRACE_CURL: '0',
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
  NO_PROXY: '*',
}
const gitArgs = [
  'git',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'credential.helper=',
  '-c',
  'http.followRedirects=false',
  '-c',
  'http.proxy=',
  '-c',
  'http.sslVerify=true',
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.https.allow=always',
]
const ASKPASS = `#!/usr/bin/python3
import os, sys
print(os.environ.get('GIT_PUBLISH_USERNAME', 'x-access-token') if len(sys.argv) > 1 and sys.argv[1].lower().startswith('username') else os.environ.get('GIT_PUBLISH_TOKEN', ''))
`
const PUSH = `import json, os, subprocess, sys
data = json.loads(sys.stdin.buffer.read(32769))
env = dict(os.environ)
env.pop('GIT_SSL_NO_VERIFY', None)
env['GIT_PUBLISH_USERNAME'] = data.get('username') or 'x-access-token'
env['GIT_PUBLISH_TOKEN'] = data.get('token') or ''
sys.exit(subprocess.run(sys.argv[1:], env=env, stdin=subprocess.DEVNULL).returncode)
`
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
  if (
    typeof value !== 'string' ||
    value === 'HEAD' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part.startsWith('.') ||
          part.endsWith('.') ||
          part.endsWith('.lock'),
      )
  )
    fail('Choose a valid destination branch name.')
  return value
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
      redact,
      now,
      ttlMs,
    })
    this.dir = path.join(this.dataDir, 'git-publish')
    this.previews = new Map()
    this.busy = new Set()
    this.destinationWrites = Promise.resolve()
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
    const home = child?.workerHome
    if (
      home &&
      path.dirname(home) === path.join(this.dataDir, 'runtime', 'homes') &&
      /^[a-f0-9]{64}$/.test(path.basename(home)) &&
      (await fs.realpath(home)) === path.resolve(home)
    )
      await fs.rm(home, { recursive: true, force: true })
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
      return (
        JSON.parse(
          await fs.readFile(path.join(this.dir, 'destinations.json'), 'utf8'),
        )[owner]?.[projectId] || null
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    }
  }
  async #destination(value) {
    let addresses = []
    const remoteUrl = await validateRepository(value, async (...args) => {
      const resolved = await this.resolveHost(...args)
      addresses = resolved.map((item) => item.address)
      return resolved
    })
    const hostname = new URL(remoteUrl).hostname
    if (!addresses.length) addresses = [hostname.replace(/^\[|\]$/g, '')]
    const selected =
      addresses.find((address) => isIP(address) === 4) || addresses[0]
    const pin = isIP(hostname.replace(/^\[|\]$/g, ''))
      ? []
      : [
          '-c',
          `http.curloptResolve=${hostname}:443:${isIP(selected) === 6 ? '[' + selected + ']' : selected}`,
        ]
    return { remoteUrl, pin }
  }
  async metadata(owner, projectId, status) {
    const project = this.workspaces.get(projectId, owner)
    status ||= await this.workspaces.gitStatus(projectId, owner)
    const blockedReason = this.blocked(owner, projectId)
    let remoteUrl =
        (await this.#remembered(owner, projectId)) ||
        destinationHint(project.repository),
      commits = []
    if (status.repository) {
      const root = await this.#source(project)
      if (status.revision) commits = (await this.#history(root)).commits
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
            await safeCopy(
              path.join(root, 'shallow-boundaries'),
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
          await fs.writeFile(path.join(root, 'askpass.py'), ASKPASS, {
            mode: 0o700,
            flag: 'wx',
          })
          const preview = {
            previewId,
            head,
            branch,
            remoteUrl: destination.remoteUrl,
            ...history,
            uncommittedCount: status.changes.length,
          }
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
  async #recordDestination(owner, projectId, remoteUrl) {
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
        stored[owner] = { ...stored[owner], [projectId]: remoteUrl }
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
        if (
          input.token !== undefined &&
          (typeof input.token !== 'string' ||
            input.token.length > 16_000 ||
            /[^\x21-\x7e]/.test(input.token))
        )
          fail('Enter a valid one-use repository token.')
        if (
          input.username !== undefined &&
          (typeof input.username !== 'string' ||
            !/^[A-Za-z0-9._@-]{1,200}$/.test(input.username))
        )
          fail('Enter a valid repository username.')
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
        const credentials = {
          token: input.token || '',
          username: input.username || 'x-access-token',
        }
        const redactCredentials = (value) => {
          let text = this.redact(String(value))
          if (credentials.token)
            for (const secret of [
              credentials.token,
              encodeURIComponent(credentials.token),
              Buffer.from(
                credentials.username + ':' + credentials.token,
              ).toString('base64'),
            ])
              text = text.split(secret).join('[redacted]')
          return text
        }
        const env = { ...gitEnv, GIT_ASKPASS: '/workspace/askpass.py' }
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
        try {
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
                  ['python3', '-c', PUSH, ...args],
                  {
                    env,
                    network: 'bridge',
                    freshHome: true,
                    readOnlyWorkspace: true,
                    timeoutMs: 300_000,
                    input: JSON.stringify(credentials),
                  },
                )
                return queued.result
              })()
          if (result.code !== 0) {
            const detail = redactCredentials(
              result.stderr || result.stdout || 'Push failed.',
            )
            fail(
              `The repository rejected this push. ${detail.slice(-4000)}`,
              409,
            )
          }
          let warning
          try {
            await this.#recordDestination(owner, projectId, preview.remoteUrl)
          } catch {
            warning =
              'The repository was pushed, but its destination could not be saved for the next visit.'
          }
          return {
            pushed: true,
            head: preview.head,
            branch: preview.branch,
            remoteUrl: preview.remoteUrl,
            ...(warning ? { warning } : {}),
          }
        } catch (error) {
          error.message = redactCredentials(error.message)
          throw error
        } finally {
          credentials.token = ''
          await fs.rm(preview.root, { recursive: true, force: true })
        }
      },
      { workspaceLock: false },
    )
  }
}
