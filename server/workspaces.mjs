import { removeDisposableTree } from './temporary-workspaces.mjs'
import {
  storedDiskBytes,
  storedManifest,
  removeStoredTree,
} from './trash-storage.mjs'
import { DatabaseSync } from 'node:sqlite'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import {
  repositoryLocation,
  projectDirectory,
  uploadedFiles,
  detectProjectDirectory,
} from './project-import.mjs'
import {
  projectLibraries,
  projectEnvironmentImports,
  environmentSmokeProof,
  dependencyBuildTargets,
} from './project-libraries.mjs'
import {
  runPinnedLake,
  dependencyCacheCommands,
  runDependencyCache,
  setupInfrastructureFailure,
  setupFailureMessage,
  dependencyFailureMessage,
  certifyDependencyBuilds,
} from './pinned-lake.mjs'
import { configurationDigest } from './shared-dependencies.mjs'
import { singleFileSource, availablePlaygroundName } from './single-files.mjs'
import { readDependencyConfiguration } from './shared-dependencies.mjs'
import {
  libraryModulePath,
  sourceSelection,
  toolchainSourceModule,
} from './library-sources.mjs'

import { sourceFileByteLimit } from '../shared/source-limits.mjs'
import { MAX_PDF_FILE_BYTES, isPdfFile } from '../shared/file-previews.mjs'
import { validatePdfBytes } from './pdf-preview.mjs'
import { validateSetupBuildTimeout } from './capacity.mjs'
import { validateGitBranch } from './git-branches.mjs'
import { PROJECT_CONFIGURATION_FILES } from '../shared/project-configuration.mjs'
const MAX_FILES = 12000
const PRESETS = new Set(['lean', 'mathlib', 'cslib', 'physlib'])
const CONFIGURATION_FILES = new Set(PROJECT_CONFIGURATION_FILES)
const SECRET_PARTS = new Set([
  '.git',
  '.lemex',
  '.codex',
  '.ssh',
  '.aws',
  '.azure',
  '.config',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'auth.json',
])
const GIT_ARGS = [
  'git',
  '-c',
  'credential.helper=',
  '-c',
  'http.followRedirects=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.file.allow=never',
]
const sha = (value) => createHash('sha256').update(value).digest('hex')
const clone = (value) => JSON.parse(JSON.stringify(value))

export class WorkspaceError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'WorkspaceError'
    this.status = this.statusCode = status
  }
}

function fail(message, status = 400) {
  throw new WorkspaceError(message, status)
}

function validateOwner(owner) {
  if (
    typeof owner !== 'string' ||
    !owner ||
    owner.length > 200 ||
    /[\x00-\x1f]/.test(owner)
  )
    fail('Invalid user identity')
}

function validateId(value, label = 'project') {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)
  )
    fail(`Invalid ${label} identifier`)
  return value
}

function projectName(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 120 ||
    /[\x00-\x1f]/.test(value)
  )
    fail('Names must contain 1–120 printable characters')
  return value.trim()
}

function validateToolchain(value) {
  if (
    typeof value !== 'string' ||
    !/^leanprover\/lean4:v4\.\d+\.\d+(?:-rc\d+)?$/.test(value)
  ) {
    throw Object.assign(
      new WorkspaceError(
        'Use a pinned official Lean 4 release, such as leanprover/lean4:v4.34.1. Nightly toolchains are not supported.',
      ),
      { unsupportedEnvironment: true },
    )
  }
  return value
}

function validateRef(value) {
  if (value == null || value === '') return null
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ||
    value.includes('..') ||
    value.endsWith('/') ||
    value.endsWith('.lock') ||
    value.includes('//')
  )
    fail('Invalid Git branch or revision')
  return value
}

function isSecret(part) {
  const p = part.toLowerCase()
  return (
    SECRET_PARTS.has(p) ||
    p === '.env' ||
    p.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx)$/.test(p) ||
    p === 'settings.local.json'
  )
}

function relativeFile(value, { write = false } = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    value.includes('\\') ||
    /[\x00-\x1f]/.test(value) ||
    path.posix.isAbsolute(value)
  )
    fail('Invalid file path')
  const parts = value.split('/')
  if (
    parts.length > 64 ||
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        Buffer.byteLength(p) > 255 ||
        isSecret(p),
    )
  )
    fail('File path is not permitted')
  if (parts.includes('node_modules'))
    fail('Dependency installation directories are not accessible')
  if (write && parts.length > 1 && CONFIGURATION_FILES.has(parts[0]))
    fail(
      'Project setup files cannot be used as folders. Choose another location.',
    )
  if (
    parts.includes('.lake') &&
    (parts[0] !== '.lake' ||
      parts[1] !== 'packages' ||
      parts.length < 4 ||
      write)
  )
    fail('Dependency files are read only')
  return parts.join('/')
}

export function validateWorkspaceFilePath(value) {
  return relativeFile(value)
}

// Reject all non-public IP ranges, including IPv4 mapped IPv6. HTTP redirects
// and credential helpers are separately disabled for the Git subprocess.
function publicAddress(address) {
  let addr = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (addr.startsWith('::ffff:')) addr = addr.slice(7)
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (isIP(addr) === 6) return addr.startsWith('2') || addr.startsWith('3')
  return false
}

export async function validateRepository(value, resolve = lookup) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    /[\x00-\x20]/.test(value)
  )
    fail('Enter an HTTPS Git repository URL')
  let url
  try {
    url = new URL(value)
  } catch {
    fail('Enter an HTTPS Git repository URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    fail(
      'Use an HTTPS repository URL without credentials, query parameters, or a custom port',
    )
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (!host.includes('.') && !isIP(host))
  )
    fail('Private repository hosts are not permitted')
  let addresses
  try {
    addresses = isIP(host)
      ? [{ address: host }]
      : await resolve(host, { all: true, verbatim: true })
  } catch {
    fail('Repository host could not be resolved')
  }
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    fail('Private repository hosts are not permitted')
  if (
    !url.pathname ||
    url.pathname === '/' ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(url.pathname)
  )
    fail('Repository URL must include a repository path')
  return url.href
}

async function exists(filename) {
  try {
    return await fs.lstat(filename)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function guarded(root, relative, options = {}) {
  const normalized = relativeFile(relative, options)
  const realRoot = await fs.realpath(root)
  if (realRoot !== path.resolve(root))
    fail('Workspace directory is not safe', 409)
  let current = root
  const parts = normalized.split('/')
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i])
    const stat = await exists(current)
    if (!stat) continue
    if (stat.isSymbolicLink()) fail('Symbolic links are not accessible', 403)
    if (i < parts.length - 1 && !stat.isDirectory())
      fail('Parent path is not a directory')
  }
  return current
}

async function workspaceFileBytes(
  filename,
  {
    missing = false,
    byteLimit = sourceFileByteLimit(filename),
    tooLargeMessage = `Files larger than ${byteLimit / (1024 * 1024)} MiB are not editable. Reduce the file or split Lean sources into smaller modules.`,
  } = {},
) {
  let handle
  try {
    handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (missing) return null
      fail('File not found', 404)
    }
    if (error.code === 'ELOOP') fail('Symbolic links are not accessible', 403)
    throw error
  }
  try {
    // Comparing the opened descriptor also detects a parent-directory symlink
    // swapped between the earlier path check and open().
    if (
      (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !==
      path.resolve(filename)
    )
      fail('File path changed during access', 409)
    const stat = await handle.stat()
    if (!stat.isFile()) fail('Path is not a regular file')
    if (stat.size > byteLimit) fail(tooLargeMessage, 413)
    const chunks = []
    let size = 0
    while (true) {
      // Read at most one byte beyond the limit, even when a worker grows the
      // file after stat(). Never allocate an unbounded preview or source read.
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, byteLimit + 1 - size),
      )
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > byteLimit) fail(tooLargeMessage, 413)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return { content: Buffer.concat(chunks, size), mode: stat.mode & 0o777 }
  } finally {
    await handle.close()
  }
}

async function textFile(filename, missing = false) {
  const file = await workspaceFileBytes(filename, { missing })
  if (!file) return null
  if (isPdfFile(filename))
    fail('PDF files are read only. Open the PDF reader to view this file.', 415)
  const { content, mode } = file
  if (content.includes(0)) fail('Binary files are not editable', 415)
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let text
  try {
    text = decoded.decode(content)
  } catch {
    fail('Only UTF-8 files are editable', 415)
  }
  return { content: text, hash: sha(content), mode }
}

async function fileHash(filename) {
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    if (
      (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !==
        path.resolve(filename) ||
      !(await handle.stat()).isFile()
    )
      fail('Source file changed during access', 409)
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk)
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

async function copyWorkspace(
  source,
  target,
  { omitDependencies = false, omitFiles = [] } = {},
) {
  const visit = async (from, to, prefix = '', depth = 0) => {
    if (depth > 64) fail('Project directory nesting exceeds 64 levels', 413)
    const directory = await fs.open(
      from,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      if (
        (await fs.realpath(`/proc/self/fd/${directory.fd}`)) !==
        path.resolve(from)
      )
        fail('Source directory changed during snapshot', 409)
      await fs.mkdir(to, { recursive: true, mode: 0o700 })
      const anchor = `/proc/self/fd/${directory.fd}`
      for (const entry of await fs.readdir(anchor, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (
          entry.name === 'node_modules' ||
          entry.name === '.ready.json' ||
          isSecret(entry.name) ||
          omitFiles.includes(relative) ||
          (omitDependencies && relative === '.lake/packages')
        )
          continue
        const original = path.join(from, entry.name)
        const anchored = path.join(anchor, entry.name)
        const destination = path.join(to, entry.name)
        if (entry.isDirectory())
          await visit(original, destination, relative, depth + 1)
        else if (entry.isSymbolicLink())
          await fs.symlink(await fs.readlink(anchored), destination)
        else if (entry.isFile()) {
          const file = await fs.open(
            anchored,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          )
          try {
            if ((await fs.realpath(`/proc/self/fd/${file.fd}`)) !== original)
              fail('Source file changed during snapshot', 409)
            const stat = await file.stat()
            if (!stat.isFile()) fail('Source file changed during snapshot', 409)
            await fs.copyFile(
              `/proc/self/fd/${file.fd}`,
              destination,
              constants.COPYFILE_FICLONE,
            )
            await fs.chmod(destination, stat.mode & 0o777)
          } finally {
            await file.close()
          }
        }
      }
    } finally {
      await directory.close()
    }
  }
  await visit(source, target)
}

// Node lacks openat(); Linux descriptor paths provide the same stable parent
// anchoring. Repository processes cannot redirect writes through swapped links.
async function writeParent(root, filename) {
  const parts = relativeFile(filename, { write: true }).split('/')
  const name = parts.pop()
  let directory = await fs.open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  let current = root
  try {
    if ((await fs.realpath(`/proc/self/fd/${directory.fd}`)) !== root)
      fail('Workspace directory is not safe', 409)
    for (const part of parts) {
      const child = `/proc/self/fd/${directory.fd}/${part}`
      try {
        await fs.mkdir(child, { mode: 0o700 })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      let next
      try {
        next = await fs.open(
          child,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
      } catch (error) {
        if (error.code === 'ENOTDIR' || error.code === 'ELOOP')
          fail('Parent directory is not safe', 403)
        throw error
      }
      await directory.close()
      directory = next
      current = path.join(current, part)
      if ((await fs.realpath(`/proc/self/fd/${directory.fd}`)) !== current)
        fail('Parent directory changed during save', 409)
    }
    return { handle: directory, name, anchor: `/proc/self/fd/${directory.fd}` }
  } catch (error) {
    await directory.close()
    throw error
  }
}

async function assertTrashTree(directory, depth = 0) {
  if (depth > 64) fail('Folder nesting exceeds 64 levels', 413)
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== directory)
      fail('Folder changed during deletion', 409)
    for (const entry of await fs.readdir(`/proc/self/fd/${handle.fd}`, {
      withFileTypes: true,
    })) {
      if (
        isSecret(entry.name) ||
        ['.lake', 'node_modules'].includes(entry.name)
      )
        fail(
          `The folder contains protected project data (${entry.name}). Archive the project to preserve it instead.`,
          403,
        )
      if (entry.isSymbolicLink())
        fail(
          'Folders containing symbolic links cannot be deleted through the file browser. Archive the project instead.',
          403,
        )
      if (entry.isDirectory())
        await assertTrashTree(path.join(directory, entry.name), depth + 1)
      else if (!entry.isFile())
        fail('Only regular files and folders can be deleted', 403)
    }
  } finally {
    await handle.close()
  }
}

/** Persistent user-scoped workspaces. The runtime owns process isolation. */
export class WorkspaceStore {
  constructor({
    dataDir,
    runtime,
    resolveHost = lookup,
    setupRepair,
    setupBuildTimeoutMs = 1800000,
  }) {
    if (!dataDir || !runtime)
      throw new Error('WorkspaceStore requires dataDir and runtime')
    this.dataDir = path.resolve(dataDir)
    this.runtime = runtime
    this.setupBuildTimeoutMs = validateSetupBuildTimeout(setupBuildTimeoutMs)
    this.resolveHost = resolveHost
    this.setupRepair = setupRepair
    this.projectsDir = path.join(this.dataDir, 'projects')
    this.snapshotsDir = path.join(this.dataDir, 'candidates')
    this.historyDir = path.join(this.dataDir, 'history')
    this.trashDir = path.join(this.dataDir, 'trash')
    this.jobs = new Map()
    this.locks = new Map()
    this.preparationControllers = new Map()
  }

  async init() {
    const previousDataDir = this.dataDir
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 })
    this.dataDir = await fs.realpath(this.dataDir)
    this.projectsDir = path.join(this.dataDir, 'projects')
    this.snapshotsDir = path.join(this.dataDir, 'candidates')
    this.historyDir = path.join(this.dataDir, 'history')
    this.trashDir = path.join(this.dataDir, 'trash')
    await Promise.all(
      [this.projectsDir, this.snapshotsDir, this.historyDir, this.trashDir].map(
        (dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 }),
      ),
    )
    this.db = new DatabaseSync(path.join(this.dataDir, 'workspaces.sqlite'))
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_project ON events(project, id);',
    )
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS trash_owner ON trash(owner);',
    )
    for (const row of this.db.prepare('SELECT data FROM projects').all()) {
      const project = JSON.parse(row.data)
      const checkout = path.join(this.projectsDir, validateId(project.id))
      const selected = path.join(
        checkout,
        projectDirectory(project.subdirectory),
      )
      const previousCheckout = path.join(
        previousDataDir,
        'projects',
        project.id,
      )
      const previousSelected = path.join(
        previousCheckout,
        projectDirectory(project.subdirectory),
      )
      if (
        previousDataDir !== this.dataDir &&
        [previousCheckout, previousSelected].includes(project.root)
      ) {
        const migratedRoot =
          project.root === previousCheckout ? checkout : selected
        const root = await exists(project.root)
        if (root && (await fs.realpath(project.root)) !== migratedRoot)
          throw new Error('Invalid persisted workspace directory')
        if (!root) {
          project.status = 'error'
          project.needsPreparation = false
          project.error =
            'The saved project directory is missing. Restore its files before retrying setup.'
        }
        project.root = migratedRoot
        this.#save(project)
      }
      if (project.root !== checkout && project.root !== selected)
        throw new Error('Invalid persisted workspace directory')
      if (
        project.kind === 'project' &&
        project.protected &&
        project.preset === 'mathlib' &&
        project.autoRepair === false
      ) {
        // Earlier playground copies retained protection when converted.
        delete project.protected
        this.#save(project)
      }
      if (project.kind === 'single-file') {
        let changed = false
        if (
          project.status === 'error' &&
          !project.needsPreparation &&
          (await exists(project.root))
        ) {
          project.needsPreparation = true
          changed = true
        }
        if (project.protected) {
          delete project.protected
          changed = true
        }
        if (project.name === 'Untitled.lean') {
          project.name = availablePlaygroundName(
            'Scratch.lean',
            this.#namedWorkspaces(project.owner),
            project.id,
          )
          changed = true
        }
        if (changed) this.#save(project)
      }
      if (project.status === 'preparing') {
        project.status = 'error'
        if (project.kind === 'single-file') project.needsPreparation = true
        project.error =
          project.kind === 'single-file'
            ? 'Opening was interrupted by a server restart. Retry opening to continue.'
            : 'Preparation was interrupted by a server restart. Retry preparation to continue.'
        if (project.setupRepair?.status === 'running')
          project.setupRepair = {
            ...project.setupRepair,
            status: 'failed',
            message:
              'Lemex setup repair was interrupted by a server restart. Any saved configuration change records were retained; the disposable workspace will be cleaned up.',
          }
        this.#save(project)
        this.#event(project, 'interrupted', project.error)
      }
    }
    for (const row of this.db.prepare('SELECT data FROM trash').all()) {
      const entry = JSON.parse(row.data)
      if (!['moving', 'restoring'].includes(entry.state)) continue
      const content = await exists(
        path.join(this.trashDir, validateId(entry.trashId, 'trash'), 'content'),
      )
      if (entry.state === 'moving') entry.state = content ? 'trashed' : 'failed'
      else if (content) {
        const project = this.#owned(entry.projectId, entry.owner)
        try {
          const destination = await guarded(project.root, entry.path, {
            write: true,
          })
          const restored = await exists(destination)
          if (
            entry.kind === 'folder' &&
            restored?.isDirectory() &&
            restored.dev === entry.reserved?.dev &&
            restored.ino === entry.reserved?.ino
          ) {
            // A crash can leave our empty restore reservation. Its recorded
            // identity and rmdir's empty-only behavior protect user content.
            const parent = await writeParent(project.root, entry.path)
            try {
              const anchored = `${parent.anchor}/${parent.name}`
              const current = await exists(anchored)
              if (
                current?.isDirectory() &&
                current.dev === entry.reserved.dev &&
                current.ino === entry.reserved.ino
              )
                await fs.rmdir(anchored).catch((error) => {
                  if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
                })
            } finally {
              await parent.handle.close()
            }
          }
          entry.state =
            entry.kind === 'file' &&
            restored?.dev === content.dev &&
            restored?.ino === content.ino
              ? 'restored'
              : 'trashed'
        } catch {
          entry.state = 'trashed'
        }
      } else {
        const project = this.#owned(entry.projectId, entry.owner)
        try {
          entry.state = (await exists(
            await guarded(project.root, entry.path, { write: true }),
          ))
            ? 'restored'
            : 'failed'
        } catch {
          entry.state = 'failed'
        }
      }
      this.#saveTrash(entry)
    }
    return this
  }

  close() {
    this.db?.close()
  }

  #save(project) {
    project.updatedAt = new Date().toISOString()
    this.db
      .prepare(
        'INSERT INTO projects(id,owner,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,owner=excluded.owner',
      )
      .run(project.id, project.owner, JSON.stringify(project))
  }

  #event(project, type, message) {
    const sanitized = String(message).replace(
      /(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,
      '$1[redacted]@',
    )
    this.db
      .prepare('INSERT INTO events(project,time,data) VALUES(?,?,?)')
      .run(
        project.id,
        new Date().toISOString(),
        JSON.stringify({ type, message: sanitized }),
      )
  }

  #setupPhase(project, phase) {
    project.setupPhase = phase
    this.#save(project)
  }

  markDependencyPreparation(id, owner, reason) {
    const project = this.get(id, owner)
    project.needsPreparation = true
    project.dependencyWarning = reason
    this.#save(project)
    this.#event(project, 'warning', reason + '\n')
  }

  events(id, owner, after = 0) {
    this.get(id, owner)
    return this.db
      .prepare(
        'SELECT id,time,data FROM events WHERE project=? AND id>? ORDER BY id LIMIT 500',
      )
      .all(id, Math.max(0, Number(after) || 0))
      .map((r) => ({ id: r.id, time: r.time, ...JSON.parse(r.data) }))
  }

  list(owner) {
    validateOwner(owner)
    return this.db
      .prepare('SELECT data FROM projects WHERE owner=? ORDER BY rowid DESC')
      .all(owner)
      .map((r) => JSON.parse(r.data))
      .filter((project) => !project.archivedAt)
      .map((project) => this.#dependencyStatus(project))
  }

  #dependencyStatus(project) {
    if (project.status !== 'ready') return project
    const reason = this.runtime.dependencyPreparationReason?.(project.root)
    if (reason) {
      project.needsPreparation = true
      project.dependencyWarning = reason
    }
    return project
  }

  #namedWorkspaces(owner) {
    return this.db
      .prepare(
        "SELECT id, json_extract(data, '$.name') AS name FROM projects WHERE owner=?",
      )
      .all(owner)
  }

  #owned(id, owner) {
    validateId(id)
    validateOwner(owner)
    const row = this.db
      .prepare('SELECT data FROM projects WHERE id=? AND owner=?')
      .get(id, owner)
    if (!row) fail('Project not found', 404)
    return JSON.parse(row.data)
  }

  get(id, owner) {
    const project = this.#owned(id, owner)
    if (project.archivedAt) fail('Project not found', 404)
    this.#dependencyStatus(project)
    const events = this.db
      .prepare(
        'SELECT data FROM events WHERE project=? ORDER BY id DESC LIMIT 60',
      )
      .all(id)
      .reverse()
    project.log = events
      .map((r) => JSON.parse(r.data).message)
      .join('')
      .slice(-20000)
    return project
  }

  #saveTrash(entry) {
    this.db
      .prepare(
        'INSERT INTO trash(id,owner,project,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(entry.trashId, entry.owner, entry.projectId, JSON.stringify(entry))
  }

  #trashReceipt(entry) {
    const project = this.#owned(entry.projectId, entry.owner)
    return {
      trashId: entry.trashId,
      projectId: entry.projectId,
      projectName: project.name,
      workspaceKind: project.kind === 'single-file' ? 'single-file' : 'project',
      name:
        entry.path === null
          ? project.name
          : entry.name || path.posix.basename(entry.path),
      path: entry.path,
      kind: entry.kind,
      recoverable: entry.state === 'trashed',
      createdAt: entry.createdAt,
      sizeBytes: Number.isSafeInteger(entry.sizeBytes) ? entry.sizeBytes : null,
      ...(entry.state === 'deleting' ? { deleting: true } : {}),
      ...(entry.state === 'restored' ? { restored: true } : {}),
    }
  }

  listTrash(owner) {
    validateOwner(owner)
    return this.db
      .prepare(
        "SELECT data FROM trash WHERE owner=? AND json_extract(data,'$.state') IN ('trashed','deleting') ORDER BY rowid DESC",
      )
      .all(owner)
      .map((row) => this.#trashReceipt(JSON.parse(row.data)))
  }

  async listTrashWithSizes(owner, { projectRunIds = () => [] } = {}) {
    for (const receipt of this.listTrash(owner)) {
      if (receipt.sizeBytes !== null) continue
      await this.#locked(receipt.projectId, async () => {
        const row = this.db
          .prepare('SELECT data FROM trash WHERE id=? AND owner=?')
          .get(receipt.trashId, owner)
        if (!row) return
        const entry = JSON.parse(row.data)
        if (!['trashed', 'deleting'].includes(entry.state)) return
        entry.sizeBytes = await this.#trashSize(
          entry,
          projectRunIds(entry.projectId),
        )
        this.#saveTrash(entry)
      })
    }
    return this.listTrash(owner)
  }

  #projectTrash(id, owner) {
    return this.db
      .prepare('SELECT data FROM trash WHERE project=? AND owner=?')
      .all(id, owner)
      .map((row) => JSON.parse(row.data))
  }

  async #projectSnapshots(project, candidateRunIds = []) {
    candidateRunIds.forEach((id) => validateId(id, 'run'))
    const trusted = new Set(candidateRunIds)
    const snapshots = []
    for (const name of await fs.readdir(this.snapshotsDir)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name)) continue
      const ownership = await storedManifest(
        this.snapshotsDir,
        name,
        'ownership.json',
      )
      const manifest = await storedManifest(this.snapshotsDir, name)
      const records = [ownership, manifest].filter((record) => record !== null)
      const claimed = records.some(
        (record) =>
          record.projectId === project.id && record.owner === project.owner,
      )
      if (!claimed && !trusted.has(name)) continue
      for (const record of records)
        if (
          record.projectId !== project.id ||
          record.owner !== project.owner ||
          record.runId !== name ||
          record.root !== path.join(this.snapshotsDir, name, 'workspace')
        )
          fail(
            'A saved candidate has invalid project metadata. Contact the administrator.',
            409,
          )
      snapshots.push(name)
    }
    return snapshots
  }

  async #projectStorage(project, candidateRunIds = []) {
    return [
      { directory: this.projectsDir, name: validateId(project.id) },
      { directory: this.historyDir, name: project.id },
      ...(await this.#projectSnapshots(project, candidateRunIds)).map(
        (name) => ({
          directory: this.snapshotsDir,
          name,
        }),
      ),
      ...this.#projectTrash(project.id, project.owner).map((entry) => ({
        directory: this.trashDir,
        name: validateId(entry.trashId, 'trash'),
      })),
    ]
  }

  async #trashSize(entry, candidateRunIds = []) {
    return storedDiskBytes(
      entry.kind === 'project'
        ? [
            ...(await this.#projectStorage(
              this.#owned(entry.projectId, entry.owner),
              candidateRunIds,
            )),
            {
              directory: this.trashDir,
              name: validateId(entry.trashId, 'trash'),
            },
          ]
        : [
            {
              directory: this.trashDir,
              name: validateId(entry.trashId, 'trash'),
            },
          ],
    )
  }

  getTrash(trashId, owner) {
    validateId(trashId, 'trash')
    validateOwner(owner)
    const row = this.db
      .prepare('SELECT data FROM trash WHERE id=? AND owner=?')
      .get(trashId, owner)
    if (!row) fail('Recoverable deletion not found', 404)
    return this.#trashReceipt(JSON.parse(row.data))
  }

  async trash(
    id,
    owner,
    filename,
    { assertIdle = () => {}, candidateRunIds = [] } = {},
  ) {
    this.get(id, owner)
    if (filename !== undefined) relativeFile(filename, { write: true })
    return this.#locked(id, async () => {
      const project = this.get(id, owner)
      this.#assertPlaygroundFile(project, filename)
      if (project.protected && filename === undefined)
        fail(
          'This Mathlib workspace is protected and cannot be deleted. You can manage its individual files.',
          403,
        )
      if (project.status === 'preparing' || this.jobs.has(id))
        fail(
          'Wait for project preparation to finish before deleting files or archiving the project.',
          409,
        )
      assertIdle()
      const trashId = randomUUID(),
        createdAt = new Date().toISOString()
      const container = path.join(this.trashDir, trashId)
      if (filename === undefined) {
        const entry = {
          trashId,
          projectId: id,
          projectName: project.name,
          name: project.name,
          owner,
          path: null,
          kind: 'project',
          createdAt,
          state: 'trashed',
        }
        await fs.mkdir(container, { mode: 0o700 })
        await fs.writeFile(
          path.join(container, 'metadata.json'),
          JSON.stringify(entry),
          { mode: 0o600, flag: 'wx' },
        )
        entry.sizeBytes = await this.#trashSize(entry, candidateRunIds)
        if (this.jobs.has(id) || this.get(id, owner).status === 'preparing')
          fail(
            'Wait for project preparation to finish before archiving the project.',
            409,
          )
        assertIdle()
        // Archive the metadata only; cached dependency owners and project history
        // retain their stable paths for completed candidates and later restores.
        project.archivedAt = createdAt
        project.archivedTrashId = trashId
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.#saveTrash(entry)
          this.#save(project)
          this.#event(
            project,
            'archived',
            'Project archived. Restore it from the recoverable deletion receipt.\n',
          )
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        return this.#trashReceipt(entry)
      }
      const destination = await guarded(project.root, filename, { write: true })
      const stat = await exists(destination)
      if (!stat) fail('File or folder not found', 404)
      if (!stat.isFile() && !stat.isDirectory())
        fail('Only regular files and folders can be deleted', 403)
      if (stat.isDirectory()) await assertTrashTree(destination)
      const entry = {
        trashId,
        projectId: id,
        projectName: project.name,
        name: path.posix.basename(filename),
        owner,
        path: filename,
        kind: stat.isDirectory() ? 'folder' : 'file',
        createdAt,
        state: 'moving',
      }
      const parent = await writeParent(project.root, filename)
      try {
        const anchored = `${parent.anchor}/${parent.name}`
        const current = await fs.lstat(anchored)
        if (
          current.isSymbolicLink() ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino
        )
          fail(
            'File or folder changed during deletion. Refresh the file tree and try again.',
            409,
          )
        await fs.mkdir(container, { mode: 0o700 })
        await fs.writeFile(
          path.join(container, 'metadata.json'),
          JSON.stringify({ ...entry, state: 'trashed' }),
          { mode: 0o600, flag: 'wx' },
        )
        this.#saveTrash(entry)
        if (this.jobs.has(id) || this.get(id, owner).status === 'preparing')
          fail(
            'Wait for project preparation to finish before deleting files.',
            409,
          )
        assertIdle()
        await fs.rename(anchored, path.join(container, 'content'))
        entry.state = 'trashed'
        entry.sizeBytes = await this.#trashSize(entry)
        this.#saveTrash(entry)
        this.#invalidateConfiguration(project, filename)
        this.#event(
          project,
          'trashed',
          `Moved ${filename} to recoverable trash (${trashId}).\n`,
        )
        return this.#trashReceipt(entry)
      } catch (error) {
        const moved = await exists(path.join(container, 'content'))
        if (moved) entry.state = 'trashed'
        else {
          entry.state = 'failed'
          entry.error = 'Deletion did not move any project files.'
        }
        this.#saveTrash(entry)
        throw error
      } finally {
        await parent.handle.close()
      }
    })
  }

  async restore(trashId, owner, { assertIdle = () => {} } = {}) {
    validateId(trashId, 'trash')
    validateOwner(owner)
    const row = this.db
      .prepare('SELECT data FROM trash WHERE id=? AND owner=?')
      .get(trashId, owner)
    if (!row) fail('Recoverable deletion not found', 404)
    const initial = JSON.parse(row.data)
    return this.#locked(initial.projectId, async () => {
      const current = this.db
        .prepare('SELECT data FROM trash WHERE id=? AND owner=?')
        .get(trashId, owner)
      if (!current) fail('Recoverable deletion not found', 404)
      const entry = JSON.parse(current.data)
      if (entry.state === 'restored') return this.#trashReceipt(entry)
      if (entry.state !== 'trashed')
        fail('This deletion is not ready to restore', 409)
      const project = this.#owned(entry.projectId, owner)
      if (project.status === 'preparing' || this.jobs.has(project.id))
        fail(
          'Wait for project preparation to finish before restoring deleted files.',
          409,
        )
      assertIdle()
      if (entry.kind === 'project') {
        if (!project.archivedAt || project.archivedTrashId !== trashId)
          fail(
            'This project archive no longer matches the deletion receipt',
            409,
          )
        const root = await exists(project.root)
        if (!root?.isDirectory() || root.isSymbolicLink())
          fail('The archived project directory is unavailable', 409)
        assertIdle()
        delete project.archivedAt
        delete project.archivedTrashId
        entry.state = 'restored'
        entry.restoredAt = new Date().toISOString()
        this.db.exec('BEGIN IMMEDIATE')
        try {
          this.#saveTrash(entry)
          this.#save(project)
          this.#event(project, 'restored', 'Project restored.\n')
          this.db.exec('COMMIT')
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
        return this.#trashReceipt(entry)
      }
      if (project.archivedAt)
        fail('Restore the archived project before restoring its files', 409)
      this.#assertPlaygroundFile(project, entry.path)
      const destination = await guarded(project.root, entry.path, {
        write: true,
      })
      if (await exists(destination))
        fail(
          'A file or folder already exists at the restore path. Move it before restoring.',
          409,
        )
      const content = path.join(this.trashDir, trashId, 'content')
      const source = await exists(content)
      if (
        !source ||
        source.isSymbolicLink() ||
        (entry.kind === 'file' ? !source.isFile() : !source.isDirectory())
      )
        fail('The recoverable file data is unavailable', 409)
      const parent = await writeParent(project.root, entry.path)
      try {
        const anchored = `${parent.anchor}/${parent.name}`
        if (await exists(anchored))
          fail(
            'A file or folder already exists at the restore path. Move it before restoring.',
            409,
          )
        if (
          this.jobs.has(project.id) ||
          this.get(project.id, owner).status === 'preparing'
        )
          fail(
            'Wait for project preparation to finish before restoring deleted files.',
            409,
          )
        assertIdle()
        entry.state = 'restoring'
        this.#saveTrash(entry)
        if (entry.kind === 'file') {
          // link() publishes a regular file atomically with EEXIST protection.
          // Keep the trash link rather than discarding stored data on restore.
          await fs.link(content, anchored)
        } else {
          // Reserve an absent directory atomically. Renaming the saved tree can
          // replace only our own empty reservation, never user files or a tree.
          await fs.mkdir(anchored, { mode: 0o700 })
          const reserved = await fs.lstat(anchored)
          entry.reserved = { dev: reserved.dev, ino: reserved.ino }
          this.#saveTrash(entry)
          try {
            const current = await fs.lstat(anchored)
            if (
              !current.isDirectory() ||
              current.dev !== reserved.dev ||
              current.ino !== reserved.ino
            )
              fail(
                'The restore path changed. Move the existing path before restoring.',
                409,
              )
            await fs.rename(content, anchored)
          } catch (error) {
            const current = await exists(anchored)
            if (
              current?.isDirectory() &&
              current.dev === reserved.dev &&
              current.ino === reserved.ino
            )
              await fs.rmdir(anchored).catch(() => {})
            throw error
          }
        }
        entry.state = 'restored'
        entry.restoredAt = new Date().toISOString()
        this.#saveTrash(entry)
        this.#invalidateConfiguration(project, entry.path)
        this.#event(
          project,
          'restored',
          `Restored ${entry.path} from recoverable trash.\n`,
        )
        return this.#trashReceipt(entry)
      } catch (error) {
        if (await exists(content)) {
          entry.state = 'trashed'
          this.#saveTrash(entry)
        }
        if (['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code))
          fail(
            'A file or folder already exists at the restore path. Move it before restoring.',
            409,
          )
        throw error
      } finally {
        await parent.handle.close()
      }
    })
  }

  async deleteForever(
    trashId,
    owner,
    { assertIdle = () => {}, candidateRunIds = [] } = {},
  ) {
    validateId(trashId, 'trash')
    validateOwner(owner)
    const initial = this.db
      .prepare('SELECT project FROM trash WHERE id=? AND owner=?')
      .get(trashId, owner)
    if (!initial) fail('Recoverable deletion not found', 404)
    return this.#locked(initial.project, async () => {
      const row = this.db
        .prepare('SELECT data FROM trash WHERE id=? AND owner=?')
        .get(trashId, owner)
      if (!row) fail('Recoverable deletion not found', 404)
      const entry = JSON.parse(row.data)
      if (!['trashed', 'deleting'].includes(entry.state))
        fail(
          'This item was restored and cannot be permanently deleted from Trash.',
          409,
        )
      const project = this.#owned(entry.projectId, owner)
      if (project.status === 'preparing' || this.jobs.has(project.id))
        fail(
          'Wait for project preparation to stop before permanently deleting its data.',
          409,
        )
      assertIdle()
      let locations = [{ directory: this.trashDir, name: trashId }]
      if (entry.kind === 'project') {
        if (!project.archivedAt || project.archivedTrashId !== trashId)
          fail(
            'This project archive no longer matches the deletion receipt.',
            409,
          )
        const checkout = this.repositoryRoot(project)
        const snapshots =
          entry.deletion?.snapshots ||
          (await this.#projectSnapshots(project, candidateRunIds))
        const trash =
          entry.deletion?.trash ||
          this.#projectTrash(project.id, owner).map((item) => item.trashId)
        snapshots.forEach((id) => validateId(id, 'run'))
        trash.forEach((id) => validateId(id, 'trash'))
        const roots = [
          project.root,
          ...snapshots.map((id) =>
            path.join(this.snapshotsDir, id, 'workspace'),
          ),
        ]
        for (const root of new Set([checkout, ...roots])) {
          const stat = await exists(root)
          if (
            stat &&
            (!stat.isDirectory() ||
              stat.isSymbolicLink() ||
              (await fs.realpath(root)) !== root)
          )
            fail(
              'A stored workspace directory is unsafe. Contact the administrator before permanently deleting it.',
              403,
            )
        }
        // Refresh the runtime's dependency registry before checking references.
        // Cached packages outside these trees remain owned by the runtime.
        if (await exists(project.root))
          this.runtime.dependencyRoot?.(project.root)
        const inside = (filename, root) =>
          filename === root || filename.startsWith(root + path.sep)
        for (const [target, source] of this.runtime.dependencies || [])
          if (
            inside(source, checkout) &&
            !inside(target, checkout) &&
            !snapshots.some((id) =>
              inside(target, path.join(this.snapshotsDir, id)),
            )
          )
            fail(
              'Another saved workspace still uses this project’s dependency cache. Remove that workspace before deleting this project forever.',
              409,
            )
        locations = [
          ...snapshots.map((name) => ({ directory: this.snapshotsDir, name })),
          { directory: this.historyDir, name: project.id },
          { directory: this.projectsDir, name: project.id },
          ...trash.map((name) => ({ directory: this.trashDir, name })),
        ]
        // Archiving closes editor sockets asynchronously. Wait for their workers
        // and candidate workers before removing any mounted project content.
        for (const root of new Set([checkout, ...roots]))
          await this.runtime.stopProject?.(root)
        assertIdle()
        for (const root of roots)
          if (await exists(root))
            await this.runtime.clearInheritedDependencies?.(root, {
              force: true,
            })
        entry.deletion = { snapshots, trash }
      }
      assertIdle()
      const receipt = this.#trashReceipt(entry)
      entry.state = 'deleting'
      this.#saveTrash(entry)
      // Leave a retryable deleting receipt after a filesystem failure; partly
      // removed content must never become available for restoration again.
      for (const { directory, name } of locations)
        await removeStoredTree(directory, name)
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (entry.kind === 'project') {
          this.db.prepare('DELETE FROM events WHERE project=?').run(project.id)
          this.db
            .prepare('DELETE FROM trash WHERE project=? AND owner=?')
            .run(project.id, owner)
          this.db
            .prepare('DELETE FROM projects WHERE id=? AND owner=?')
            .run(project.id, owner)
        } else
          this.db
            .prepare('DELETE FROM trash WHERE id=? AND owner=?')
            .run(trashId, owner)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      return { ...receipt, recoverable: false, deleted: true }
    })
  }

  async #locked(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    this.locks.set(id, next)
    try {
      return await next
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }
  }

  async create(owner, input = {}) {
    validateOwner(owner)
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('Invalid project configuration')
    const singleFile = singleFileSource(input, (value) =>
      relativeFile(value, { write: true }),
    )
    const files =
      input.files === undefined
        ? null
        : uploadedFiles(input.files, (value) =>
            relativeFile(value, { write: true }),
          )
    if (files && input.repository)
      fail('Choose a repository or local files, not both.')
    if (input.autoRepair !== undefined && typeof input.autoRepair !== 'boolean')
      fail('Choose whether Lemex may repair project setup.')
    if (
      input.publishingEnabled !== undefined &&
      typeof input.publishingEnabled !== 'boolean'
    )
      fail('Choose whether to enable repository publishing.')
    const definitions = await this.runtime.templates()
    if (input.libraries !== undefined && (files || input.repository))
      fail(
        'Imported projects keep their own dependency configuration. Select libraries when creating a new project.',
      )
    const selection = projectLibraries(
      singleFile ? ['mathlib'] : input.libraries,
      definitions,
    )
    const preset =
      selection?.preset || input.preset || (files ? 'lean' : 'mathlib')
    if (!PRESETS.has(preset)) fail('Unknown project preset')
    const location = input.repository
      ? repositoryLocation(input.repository, input)
      : { subdirectory: projectDirectory(input.subdirectory) }
    const revision = validateRef(location.revision || input.revision)
    const repository = location.repository
      ? await validateRepository(location.repository, this.resolveHost)
      : null
    if (revision && !repository) fail('A revision requires a Git repository')
    if (
      !repository &&
      (input.publishingEnabled !== undefined ||
        input.workingBranch !== undefined)
    )
      fail('Publishing settings require a Git repository import.')
    if (input.workingBranch !== undefined && input.publishingEnabled !== true)
      fail('Enable publishing before choosing a working branch.')
    if (
      input.workingBranch !== undefined &&
      typeof input.workingBranch !== 'string'
    )
      fail('Enter a valid working branch name.')
    const definition = Array.isArray(definitions)
      ? definitions.find((p) => (p.id || p.preset) === preset)
      : definitions[preset]
    if (
      singleFile &&
      (!definition?.ready ||
        definition.playgroundReady === false ||
        !(await this.runtime.templateRoot('mathlib')))
    )
      fail(
        definition?.playgroundState === 'verifying'
          ? 'Mathlib Playground is being checked. Try again shortly.'
          : definition?.playgroundState === 'failed'
            ? 'Mathlib Playground needs a new check. Use Retry Mathlib preparation, then try again.'
            : 'Mathlib Playground is not prepared on this server. Ask the administrator to prepare Mathlib, then try again.',
        503,
      )
    const toolchain = input.toolchain
      ? validateToolchain(input.toolchain)
      : definition?.toolchain || null
    if (
      !repository &&
      preset !== 'lean' &&
      input.toolchain &&
      definition?.toolchain &&
      toolchain !== definition.toolchain
    )
      fail(
        `The ${preset} preset requires ${definition.toolchain}. Choose Lean basics to use another pinned version.`,
      )
    if (!repository && !toolchain)
      fail('The selected preset is not configured', 503)
    const name =
      input.name ||
      singleFile?.path ||
      (location.subdirectory
        ? path.posix.basename(location.subdirectory)
        : repository
          ? new URL(repository).pathname
              .split('/')
              .filter(Boolean)
              .at(-1)
              .replace(/\.git$/, '')
          : files
            ? 'Uploaded project'
            : `${preset} project`)
    projectName(name)
    const id = randomUUID()
    const workingBranch =
      input.publishingEnabled === true
        ? validateGitBranch(
            input.workingBranch?.trim() || `leanflow/${id.slice(0, 8)}`,
            { message: 'Enter a valid working branch name.' },
          )
        : undefined
    const root = path.join(this.projectsDir, id)
    await fs.mkdir(root, { recursive: false, mode: 0o700 })
    const project = {
      id,
      name: name.trim(),
      owner,
      status: 'preparing',
      toolchain,
      preset,
      ...(singleFile ? { kind: 'single-file', presetInitialized: false } : {}),
      ...(selection ? { libraries: selection.libraries } : {}),
      repository,
      revision,
      ...(input.publishingEnabled !== undefined
        ? { publishingEnabled: input.publishingEnabled }
        : {}),
      ...(workingBranch ? { workingBranch } : {}),
      root,
      subdirectory: location.subdirectory || '',
      uploaded: !!files,
      autoRepair: singleFile ? false : input.autoRepair !== false,
      createdAt: new Date().toISOString(),
    }
    if (singleFile)
      await fs.writeFile(path.join(root, 'Main.lean'), singleFile.content, {
        mode: 0o600,
        flag: 'wx',
      })
    if (files)
      for (const file of files) {
        const destination = await guarded(root, file.path, { write: true })
        await fs.mkdir(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        })
        await fs.writeFile(destination, file.content, {
          mode: 0o600,
          flag: 'wx',
        })
      }
    if (singleFile && input.name === undefined)
      project.name = availablePlaygroundName(
        singleFile.path,
        this.#namedWorkspaces(owner),
      )
    this.#save(project)
    this.#event(project, 'created', `Creating ${project.name}.\n`)
    this.#beginPrepare(project)
    if (singleFile) await this.jobs.get(project.id)
    return clone(this.#owned(project.id, owner))
  }

  async rename(id, owner, input) {
    this.get(id, owner)
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('Enter a name for this workspace.')
    const name = projectName(input.name)
    return this.#locked(id, async () => {
      const project = this.get(id, owner)
      if (
        this.#namedWorkspaces(owner).some(
          (item) => item.id !== id && item.name === name,
        )
      )
        fail(
          'A workspace, including an item in Trash, already uses that name. Choose a different name.',
          409,
        )
      project.name = name
      this.#save(project)
      this.#event(project, 'renamed', `Renamed workspace to ${name}.\n`)
      return clone(project)
    })
  }

  async convertSingleFile(id, owner) {
    this.get(id, owner)
    return this.#locked(id, async () => {
      const project = this.get(id, owner)
      if (project.status === 'preparing' || this.jobs.has(id))
        fail(
          'Wait for playground preparation to finish before converting.',
          409,
        )
      if (project.kind === 'single-file') {
        project.kind = 'project'
        if (project.status === 'error') project.needsPreparation = true
        delete project.presetInitialized
        this.#save(project)
        this.#event(
          project,
          'converted',
          'Playground converted to a project. Files and chats are preserved.\n',
        )
      }
      return clone(project)
    })
  }

  #beginPrepare(project) {
    if (this.jobs.has(project.id)) return
    project.setupStartedAt = new Date().toISOString()
    project.setupPhase = 'reading-project'
    this.#save(project)
    const controller = new AbortController()
    this.preparationControllers.set(project.id, controller)
    const job = Promise.resolve()
      .then(() =>
        this.#locked(project.id, async () => {
          try {
            await this.#prepareProject(project)
          } catch (error) {
            if (
              !project.autoRepair ||
              !this.setupRepair ||
              error.unsupportedEnvironment ||
              controller.signal.aborted ||
              (!project.imported &&
                !project.uploaded &&
                !error.setupEnvironment) ||
              [403, 404, 409, 413, 429, 503].includes(error.status) ||
              error.infrastructure
            ) {
              if (!controller.signal.aborted)
                this.#event(
                  project,
                  'warning',
                  !this.setupRepair
                    ? 'Lemex setup repair is unavailable on this server. You can edit setup files and retry.\n'
                    : !project.autoRepair
                      ? 'Automatic setup repair is disabled for this project. You can edit setup files and retry.\n'
                      : 'Automatic repair was skipped because this failure needs a supported Lean version, network access or available worker capacity. Inspect the setup error and retry.\n',
                )
              throw error
            }
            try {
              await this.#repairPreparation(project, error, controller.signal)
            } catch (repairError) {
              throw new Error(
                `${error.message}\nAutomatic setup repair also failed: ${repairError.message}`,
                { cause: repairError },
              )
            }
            await this.#prepareProject(project)
          }
        }),
      )
      .catch(async (error) => {
        project.status = 'error'
        project.needsPreparation = Boolean(
          project.kind === 'single-file' ||
          project.uploaded ||
          project.imported ||
          (!project.repository &&
            (await exists(path.join(project.root, 'lean-toolchain')))),
        )
        project.error = controller.signal.aborted
          ? 'Project setup stopped. You can retry when ready.'
          : error.message || 'Project preparation failed'
        if (project.setupRepair?.status === 'running')
          project.setupRepair = {
            ...project.setupRepair,
            status: 'failed',
            message: project.error,
          }
        this.#save(project)
        this.#event(project, 'error', `${project.error}\n`)
      })
      .finally(() => {
        this.jobs.delete(project.id)
        this.preparationControllers.delete(project.id)
      })
    this.jobs.set(project.id, job)
  }

  async prepare(id, owner, { assertIdle = () => {} } = {}) {
    this.get(id, owner)
    return this.#locked(id, async () => {
      const project = this.#owned(id, owner)
      if (project.archivedAt) fail('Project not found', 404)
      assertIdle()
      if (this.jobs.has(id)) return project
      project.status = 'preparing'
      delete project.needsPreparation
      delete project.error
      delete project.dependencyWarning
      delete project.log
      if (project.setupRepair) {
        project.setupRepairHistory = [
          ...(project.setupRepairHistory || []),
          project.setupRepair,
        ]
        delete project.setupRepair
      }
      this.#save(project)
      this.#beginPrepare(project)
      return clone(project)
    })
  }

  async stopPreparation(id, owner) {
    this.get(id, owner)
    this.preparationControllers
      .get(id)
      ?.abort(new Error('Project setup stopped.'))
    await this.jobs.get(id)
    return this.get(id, owner)
  }

  repositoryRoot(project) {
    return path.join(this.projectsDir, validateId(project.id))
  }

  async enablePublishing(id, owner, { assertIdle = () => {} } = {}) {
    return this.#locked(id, async () => {
      const project = this.#owned(id, owner)
      if (project.archivedAt) fail('Project not found', 404)
      this.#ready(project)
      assertIdle()
      project.publishingEnabled = true
      this.#save(project)
      return clone(project)
    })
  }

  async #preparePublishingBranch(project) {
    if (!project.workingBranch || project.publishingBranchPrepared) return
    const root = this.repositoryRoot(project)
    const run = (args) =>
      this.runtime.run(root, [...GIT_ARGS, ...args], {
        network: 'none',
        timeoutMs: 30000,
        signal: this.preparationControllers.get(project.id)?.signal,
      })
    const current = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const currentBranch = current.code === 0 ? current.stdout.trim() : null
    if (!project.publishingBaseBranch)
      project.publishingBaseBranch = await this.#publishingBaseBranch(
        project,
        currentBranch,
        run,
      )
    if (currentBranch !== project.workingBranch) {
      const head = await run(['rev-parse', '--verify', 'HEAD'])
      const refs = await run([
        'for-each-ref',
        '--format=%(refname:strip=2)%00%(objectname)',
        'refs/heads',
      ])
      if (head.code !== 0 || refs.code !== 0)
        fail(
          'The imported Git revision is unavailable. Retry project setup.',
          409,
        )
      const branches = new Map(
        refs.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('\0')),
      )
      const existing = branches.get(project.workingBranch)
      const reused = existing === head.stdout.trim()
      const collision =
        existing ||
        [...branches.keys()].some(
          (name) =>
            name.startsWith(project.workingBranch + '/') ||
            project.workingBranch.startsWith(name + '/'),
        )
      if (collision && !reused) {
        const requested = project.workingBranch
        let replacement = `leanflow-${project.id.slice(0, 8)}`
        while (
          [...branches.keys()].some(
            (name) =>
              name === replacement || name.startsWith(replacement + '/'),
          )
        )
          replacement = `leanflow-${randomUUID()}`
        project.workingBranch = replacement
        project.publishingWarning = `The working branch ${requested} conflicts with an existing branch. Using ${replacement} at the imported revision; existing branches are preserved.`
        this.#save(project)
        this.#event(project, 'warning', project.publishingWarning + '\n')
      }
      try {
        await this.#command(
          project,
          [
            ...GIT_ARGS,
            'switch',
            ...(reused ? [] : ['-c']),
            project.workingBranch,
          ],
          30000,
        )
      } catch (error) {
        error.status = 409
        throw error
      }
    }
    project.publishingBranchPrepared = true
    this.#save(project)
    this.#event(
      project,
      'output',
      `Working branch ${project.workingBranch} is ready. No changes have been pushed.\n`,
    )
  }

  async #publishingBaseBranch(project, currentBranch, run) {
    if (project.revision) {
      const fetched = await textFile(
        path.join(this.repositoryRoot(project), '.git', 'FETCH_HEAD'),
        true,
      )
      const requested = project.revision.replace(/^refs\/heads\//, '')
      for (const line of fetched?.content.split('\n') || []) {
        const branch = line.match(
          /^[a-f0-9]{40,64}\t[^\t]*\tbranch '([^']+)' of /,
        )?.[1]
        if (branch === requested) {
          try {
            return validateGitBranch(branch)
          } catch {
            break
          }
        }
      }
    }
    const origin = await run([
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ])
    const candidate =
      (currentBranch !== project.workingBranch ? currentBranch : null) ||
      (origin.code === 0 ? origin.stdout.trim().replace(/^origin\//, '') : null)
    try {
      return validateGitBranch(candidate)
    } catch {
      return undefined
    }
  }

  async upload(id, owner, input) {
    const project = this.get(id, owner)
    this.#ready(project)
    const files = uploadedFiles(input, (value) =>
      relativeFile(value, { write: true }),
    )
    return this.#locked(id, async () => {
      for (const file of files)
        if (
          await exists(await guarded(project.root, file.path, { write: true }))
        )
          fail(
            `A file named ${file.path} already exists. Rename it before uploading; existing files are preserved.`,
            409,
          )
      return this.#applyLocked(
        project,
        files.map((file) => ({
          path: file.path,
          beforeHash: null,
          before: null,
          after: file.content,
        })),
        'uploaded',
      )
    })
  }

  async gitFilePath(id, owner, filename) {
    const project = this.get(id, owner)
    const relative = relativeFile(filename, { write: true })
    const stat = await exists(
      await guarded(project.root, relative, { write: true }),
    )
    if (stat && !stat.isFile())
      fail('Only regular project files can be committed.', 403)
    return relative
  }

  async #repairPreparation(project, cause, signal) {
    const attempt = randomUUID()
    const container = path.join(this.dataDir, 'setup-repairs', attempt)
    const candidate = path.join(container, 'workspace')
    await fs.mkdir(container, { recursive: true, mode: 0o700 })
    project.setupRepair = {
      id: attempt,
      status: 'running',
      startedAt: new Date().toISOString(),
      message:
        'Automatic setup failed. Lemex is repairing the project configuration.',
    }
    this.#setupPhase(project, 'repairing-setup')
    this.#save(project)
    this.#event(
      project,
      'setup-repair',
      `${project.setupRepair.message}\nOriginal error: ${cause.message}\n`,
    )
    await fs.mkdir(candidate, { mode: 0o700 })
    try {
      await this.runtime.claimTemporaryWorkspace?.(candidate)
      await this.#repairCandidate(project, {
        cause,
        signal,
        container,
        candidate,
      })
    } finally {
      try {
        if (this.runtime.releaseTemporaryWorkspace)
          await this.runtime.releaseTemporaryWorkspace(candidate)
        else await removeDisposableTree(candidate)
      } catch (error) {
        console.warn('Deferred setup workspace cleanup:', error.message)
      }
    }
  }

  async #repairCandidate(project, { cause, signal, container, candidate }) {
    await copyWorkspace(project.root, candidate, { omitDependencies: true })
    const allowed = new Set([
      'lean-toolchain',
      'lakefile.lean',
      'lakefile.toml',
      'lake-manifest.json',
    ])
    const before = new Map()
    for (const entry of await this.#walk(candidate, {
      includeLinks: true,
      limit: Infinity,
    }))
      before.set(
        entry.path,
        entry.link === undefined
          ? { hash: await fileHash(await guarded(candidate, entry.path)) }
          : { link: entry.link },
      )
    await this.setupRepair({
      root: candidate,
      project: { name: project.name, toolchain: project.toolchain },
      error: cause.message,
      signal,
      onOutput: (message) => this.#event(project, 'setup-repair', message),
      onProgress: (phase) => this.#setupPhase(project, phase),
      onActivity: (activity) => {
        project.setupRepair.activity = activity
        this.#save(project)
      },
    })
    signal.throwIfAborted()
    // Evaluate repaired configuration in the disposable copy before admitting
    // it. Lake files are executable; include any evaluation-time source edits
    // in the integrity comparison below, and create the lockfile here.
    this.#setupPhase(project, 'validating-repair')
    const repairedToolchain = validateToolchain(
      (
        await textFile(await guarded(candidate, 'lean-toolchain'))
      ).content.trim(),
    )
    const originalToolchain = await textFile(
      await guarded(project.root, 'lean-toolchain'),
      true,
    )
    if (
      originalToolchain &&
      /^leanprover\/lean4:v4\.\d+\.\d+(?:-rc\d+)?$/.test(
        originalToolchain.content.trim(),
      ) &&
      originalToolchain.content.trim() !== repairedToolchain
    )
      fail(
        'Setup repair changed the pinned Lean release. The original environment was preserved.',
        409,
      )
    let abortDownload
    try {
      await Promise.race([
        this.runtime.prepareToolchain(repairedToolchain),
        new Promise((_, reject) => {
          abortDownload = () => reject(signal.reason)
          signal.addEventListener('abort', abortDownload, { once: true })
          if (signal.aborted) abortDownload()
        }),
      ])
    } finally {
      signal.removeEventListener('abort', abortDownload)
    }
    const commands = []
    if (!(await exists(path.join(candidate, 'lake-manifest.json'))))
      commands.push(['lake', 'update'])
    commands.push(['lake', 'env', 'lean', '--version'])
    for (const args of commands) {
      const checked = await runPinnedLake(this.runtime, candidate, args, {
        signal,
        network: 'bridge',
        timeoutMs: 900000,
        onOutput: (message) => this.#event(project, 'setup-repair', message),
      })
      signal.throwIfAborted()
      if (checked.code !== 0)
        throw new Error(
          `Repaired setup did not pass its isolated environment check: ${(checked.stderr || checked.stdout || '').slice(-2000)}`,
        )
    }
    const repairedConfiguration = await this.#dependencyConfiguration({
      root: candidate,
    })
    let repairedManifest = null,
      originalManifest = null
    try {
      repairedManifest = JSON.parse(repairedConfiguration['lake-manifest.json'])
    } catch {
      /* Checked by Lake. */
    }
    try {
      originalManifest = JSON.parse(
        (
          await textFile(
            await guarded(project.root, 'lake-manifest.json'),
            true,
          )
        )?.content,
      )
    } catch {
      /* Missing or invalid lockfiles can be repaired. */
    }
    this.#assertRepairDependencyPins(originalManifest, repairedManifest)
    for (const command of dependencyCacheCommands(repairedManifest, {
      toolchain: repairedToolchain,
    })) {
      await runDependencyCache(this.runtime, candidate, command, {
        signal,
        network: 'bridge',
        timeoutMs: 5400000,
        onOutput: (message) => this.#event(project, 'setup-repair', message),
      })
    }
    for (const target of dependencyBuildTargets(repairedManifest)) {
      const built = await runPinnedLake(
        this.runtime,
        candidate,
        ['lake', 'build', target],
        {
          signal,
          network: 'bridge',
          timeoutMs: 1800000,
          onOutput: (message) => this.#event(project, 'setup-repair', message),
        },
      )
      signal.throwIfAborted()
      if (built.code !== 0)
        throw new Error(
          `Repaired setup could not build dependency ${target}: ${(built.stderr || built.stdout || '').slice(-2000)}`,
        )
    }
    await this.runtime.inheritDependencies?.(candidate, candidate)
    await this.#checkProjectEnvironment({ ...project, root: candidate }, signal)
    const finalConfiguration = await this.#dependencyConfiguration({
      root: candidate,
    })
    if (
      originalToolchain &&
      /^leanprover\/lean4:v4\.\d+\.\d+(?:-rc\d+)?$/.test(
        originalToolchain.content.trim(),
      ) &&
      finalConfiguration['lean-toolchain']?.trim() !==
        originalToolchain.content.trim()
    )
      fail(
        'Setup repair changed the pinned Lean release. The original environment was preserved.',
        409,
      )
    let finalManifest = null
    try {
      finalManifest = JSON.parse(finalConfiguration['lake-manifest.json'])
    } catch {
      /* Validated by the environment check. */
    }
    this.#assertRepairDependencyPins(originalManifest, finalManifest)
    const after = new Map(
      (
        await this.#walk(candidate, { includeLinks: true, limit: Infinity })
      ).map((entry) => [entry.path, entry]),
    )
    const changes = []
    for (const filename of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(filename),
        entry = after.get(filename)
      const changed =
        previous?.link !== entry?.link ||
        (entry?.link === undefined &&
          previous?.hash !==
            (entry
              ? await fileHash(await guarded(candidate, filename))
              : undefined))
      if (!changed) continue
      if (!allowed.has(filename) || entry?.link !== undefined)
        fail(
          `Setup repair tried to change ${filename}. Source files were preserved; only Lake configuration and lean-toolchain changes are accepted.`,
          409,
        )
      const original = await textFile(
        await guarded(project.root, filename, { write: true }),
        true,
      )
      changes.push({
        path: filename,
        before: original?.content ?? null,
        after: entry
          ? (await textFile(await guarded(candidate, filename))).content
          : null,
      })
    }
    const pinned = await textFile(await guarded(candidate, 'lean-toolchain'))
    validateToolchain(pinned.content.trim())
    if (
      !(await exists(path.join(candidate, 'lakefile.lean'))) &&
      !(await exists(path.join(candidate, 'lakefile.toml')))
    )
      fail('Setup repair did not produce a Lake project configuration.')
    // Keep the original configuration outside every writable worker mount.
    await fs.writeFile(
      path.join(container, 'changes.json'),
      JSON.stringify({
        projectId: project.id,
        createdAt: new Date().toISOString(),
        changes,
      }),
      { mode: 0o600 },
    )
    for (const change of changes) {
      const parent = await writeParent(project.root, change.path)
      try {
        const destination = `${parent.anchor}/${parent.name}`
        if (change.after === null) await fs.unlink(destination)
        else {
          const temporary = `${parent.anchor}/.setup-${randomUUID()}`
          try {
            await fs.writeFile(temporary, change.after, {
              mode: 0o600,
              flag: 'wx',
            })
            await fs.rename(temporary, destination)
          } finally {
            await fs.rm(temporary, { force: true })
          }
        }
      } finally {
        await parent.handle.close()
      }
    }
    project.setupRepair.changes = changes.map((change) => change.path)
    project.repairedConfiguration = true
    project.setupRepair.message = changes.length
      ? 'Lemex updated setup files. Checking the Lean environment again.'
      : 'Lemex checked setup without changing configuration. Checking the original project again.'
    this.#save(project)
    this.#event(
      project,
      'setup-repair',
      `${project.setupRepair.message}\nChanged: ${project.setupRepair.changes.join(', ')}\n`,
    )
  }

  async #initializeRepository(project) {
    if (
      !project.repository &&
      !(await exists(path.join(this.repositoryRoot(project), '.git')))
    ) {
      if (!(await exists(path.join(project.root, '.gitignore'))))
        await fs.writeFile(path.join(project.root, '.gitignore'), '.lake/\n', {
          mode: 0o600,
        })
      await this.#command(project, [...GIT_ARGS, 'init', '-b', 'main'], 30000)
    }
  }

  async #command(
    project,
    args,
    timeoutMs = 900000,
    network = 'none',
    env = {},
  ) {
    const result = await runPinnedLake(
      this.runtime,
      args[0] === 'git' ? this.repositoryRoot(project) : project.root,
      args,
      {
        timeoutMs,
        network,
        signal: this.preparationControllers.get(project.id)?.signal,
        ...(args[0] !== 'git' && project.repairedConfiguration
          ? { readOnlyWorkspace: true, writeLakeCache: true }
          : {}),
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_LFS_SKIP_SMUDGE: '1',
          ...env,
        },
        onOutput: (output) =>
          this.#event(
            project,
            'output',
            typeof output === 'string'
              ? output
              : output?.text || output?.data || '',
          ),
      },
    )
    if (result.code !== 0)
      throw Object.assign(
        new Error(
          [
            setupFailureMessage(result),
            `${args[0]} failed (exit ${result.code}): ${(result.stderr || result.stdout || '').slice(-2000)}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        { infrastructure: setupInfrastructureFailure(result) },
      )
    return result
  }

  #assertRepairDependencyPins(original, repaired) {
    for (const dependency of Array.isArray(original?.packages)
      ? original.packages
      : []) {
      if (dependency?.type !== 'git' || !/^[a-f0-9]{40}$/.test(dependency.rev))
        continue
      const replacement = Array.isArray(repaired?.packages)
        ? repaired.packages.find((pkg) => pkg?.name === dependency.name)
        : null
      if (
        !replacement ||
        replacement.rev !== dependency.rev ||
        replacement.url !== dependency.url
      )
        fail(
          'Setup repair changed a pinned dependency revision. The original lockfile was preserved.',
          409,
        )
    }
  }

  async #dependencyConfiguration(project) {
    const configuration = {}
    for (const name of [
      'lean-toolchain',
      'lake-manifest.json',
      'lakefile.lean',
      'lakefile.toml',
    ]) {
      const file = await textFile(await guarded(project.root, name), true)
      if (file) configuration[name] = file.content
    }
    return configuration
  }

  async #sharedDependencies(project, signal) {
    if (!this.runtime.prepareSharedDependencies) return null
    const configuration = await this.#dependencyConfiguration(project)
    let shared
    try {
      shared = await this.runtime.prepareSharedDependencies(project.root, {
        owner: project.owner,
        toolchain: project.toolchain,
        configuration,
        signal,
        validateRepository: (url) => validateRepository(url, this.resolveHost),
        onOutput: (message) => {
          if (!signal?.aborted)
            this.#event(
              project,
              'output',
              typeof message === 'string' ? message : message?.text || '',
            )
        },
      })
    } catch (error) {
      signal?.throwIfAborted()
      // A private retry has the same resource and repository requirements.
      // Keep the actionable failure and avoid repeating that expensive work.
      if (error.infrastructure) throw error
      this.#event(
        project,
        'warning',
        `Shared dependency preparation failed: ${error.message}\nContinuing with a private environment.\n`,
      )
      return null
    }
    signal?.throwIfAborted()
    if (!shared) return null
    const current = await this.#dependencyConfiguration(project)
    if (configurationDigest(current) !== configurationDigest(configuration))
      fail(
        'The project configuration changed during dependency preparation. Retry preparation with the current files.',
        409,
      )
    await this.runtime.inheritDependencies(shared.root, project.root)
    this.#event(
      project,
      'output',
      shared.reused
        ? 'Using the shared, verified Mathlib dependency cache.\n'
        : 'Prepared a shared, verified Mathlib dependency cache.\n',
    )
    return shared
  }

  async #checkProjectEnvironment(project, signal) {
    const configuration = await this.#dependencyConfiguration(project)
    let manifest = null
    try {
      manifest = JSON.parse(configuration['lake-manifest.json'])
    } catch {
      /* Lean-only projects can have no dependencies. */
    }
    const imports = projectEnvironmentImports(project, manifest)
    this.#event(
      project,
      'output',
      `Checking that ${imports.join(', ')} are ready for proofs.\n`,
    )
    const result = await runPinnedLake(
      this.runtime,
      project.root,
      ['lake', 'env', 'lean', '--stdin'],
      {
        input: environmentSmokeProof(imports),
        signal,
        network: 'none',
        timeoutMs: 180000,
        readOnlyWorkspace: true,
        writeLakeCache: true,
        onOutput: (message) =>
          this.#event(
            project,
            'output',
            typeof message === 'string' ? message : message?.text || '',
          ),
      },
    )
    signal?.throwIfAborted()
    if (result.code !== 0)
      throw Object.assign(
        new Error(
          `The project environment is not ready (${imports.join(', ')}). ${(result.stderr || result.stdout || 'The import check failed.').slice(-2000)}`,
        ),
        {
          setupEnvironment: true,
          infrastructure: setupInfrastructureFailure(result),
        },
      )
  }

  async #prepareProject(project) {
    this.preparationControllers.get(project.id)?.signal.throwIfAborted()
    this.#setupPhase(project, 'reading-project')
    this.#event(project, 'preparing', 'Preparing the project environment.\n')
    if (project.customEnvironment && !project.repository && !project.uploaded) {
      const template = await this.runtime.templateRoot(project.preset)
      if (
        template &&
        configurationDigest(readDependencyConfiguration(template)) ===
          configurationDigest(readDependencyConfiguration(project.root))
      ) {
        delete project.customEnvironment
        await this.runtime.inheritDependencies?.(template, project.root)
      }
    }
    if (project.repository || project.uploaded || project.customEnvironment)
      await this.runtime.clearInheritedDependencies?.(project.root, {
        force: project.customEnvironment === true,
      })
    const checkout = this.repositoryRoot(project)
    const prepared =
      project.kind === 'single-file' && !project.customEnvironment
        ? this.runtime.preparedPresetEnvironment?.(project.preset)
        : null
    if (
      project.kind === 'single-file' &&
      !project.customEnvironment &&
      this.runtime.preparedPresetEnvironment &&
      !prepared
    )
      fail(
        'Mathlib Playground is being prepared or needs a new check. Retry Mathlib preparation, then open this playground again.',
        503,
      )
    const entries = await fs.readdir(checkout)
    if (project.repository && !project.imported && entries.length)
      fail(
        'An interrupted import left project files. Create a new import to preserve these files safely.',
        409,
      )
    if (project.repository && !entries.length) {
      // Revalidate before each clone, rather than trusting a previously resolved URL.
      await validateRepository(project.repository, this.resolveHost)
      await this.#command(
        project,
        [
          ...GIT_ARGS,
          'clone',
          '--depth=1',
          '--no-recurse-submodules',
          '--',
          project.repository,
          '.',
        ],
        900000,
        'bridge',
      )
      if (project.revision) {
        await this.#command(
          project,
          [...GIT_ARGS, 'fetch', '--depth=1', 'origin', project.revision],
          900000,
          'bridge',
        )
        await this.#command(project, [
          ...GIT_ARGS,
          'checkout',
          '--detach',
          'FETCH_HEAD',
        ])
      }
      project.imported = true
      this.#save(project)
    } else if (
      !project.repository &&
      (!entries.length ||
        (project.kind === 'single-file' && !project.presetInitialized))
    ) {
      let template = await this.runtime.templateRoot(project.preset)
      if (template && project.preset === 'lean') {
        const cachedToolchain = (
          await textFile(await guarded(template, 'lean-toolchain'))
        ).content.trim()
        if (cachedToolchain !== project.toolchain) template = null
      }
      if (template) {
        const inherit = typeof this.runtime.inheritDependencies === 'function'
        await copyWorkspace(template, project.root, {
          omitDependencies: inherit,
          omitFiles: project.kind === 'single-file' ? ['Main.lean'] : [],
        })
        if (inherit)
          await this.runtime.inheritDependencies(template, project.root)
        if (project.libraries?.length && project.kind !== 'single-file') {
          const selection = projectLibraries(
            project.libraries,
            await this.runtime.templates(),
          )
          await fs.writeFile(
            path.join(project.root, 'Main.lean'),
            `${selection.imports.map((name) => `import ${name}`).join('\n')}\n\ntheorem addition_commutes (a b : Nat) : a + b = b + a := by\n  exact Nat.add_comm a b\n`,
            { mode: 0o600 },
          )
        }
      } else {
        if (project.preset !== 'lean')
          fail(
            `The ${project.preset} preset is still being installed. Retry after the preset becomes ready.`,
            503,
          )
        await fs.writeFile(
          path.join(project.root, 'lean-toolchain'),
          `${project.toolchain}\n`,
          { mode: 0o600 },
        )
        await fs.writeFile(
          path.join(project.root, 'lakefile.toml'),
          'name = "lean_workspace"\nversion = "0.1.0"\ndefaultTargets = ["Main"]\n\n[[lean_lib]]\nname = "Main"\n',
          { mode: 0o600 },
        )
        await fs.writeFile(
          path.join(project.root, 'Main.lean'),
          '-- Welcome to your Lean workspace.\n\ntheorem hello_lean (n : Nat) : n + 0 = n := by\n  simp\n',
          { mode: 0o600 },
        )
      }
      if (project.kind === 'single-file') {
        project.presetInitialized = true
        this.#save(project)
      }
    }
    if (project.repository || project.uploaded) {
      if (!project.subdirectory)
        project.subdirectory = await detectProjectDirectory(checkout)
      const selected = project.subdirectory
        ? await guarded(checkout, projectDirectory(project.subdirectory))
        : checkout
      if (!(await exists(selected))?.isDirectory())
        fail('The selected project subdirectory was not found.', 404)
      if (selected !== project.root)
        this.#event(
          project,
          'output',
          `Using Lean project in ${project.subdirectory}.\n`,
        )
      project.root = selected
      this.#save(project)
    }
    await this.#preparePublishingBranch(project)
    if (
      prepared &&
      configurationDigest(readDependencyConfiguration(project.root)) ===
        prepared.configuration
    ) {
      await this.#initializeRepository(project)
      this.preparationControllers.get(project.id)?.signal.throwIfAborted()
      project.status = 'ready'
      delete project.needsPreparation
      delete project.error
      this.#save(project)
      this.#event(
        project,
        'ready',
        'Mathlib Playground ready. Reused the verified, prepared Mathlib environment.\n',
      )
      return
    }
    if (prepared)
      fail(
        'The prepared Mathlib environment changed. Retry Mathlib preparation, then retry this playground.',
        503,
      )
    const toolchainFile = await guarded(project.root, 'lean-toolchain')
    const pinned = await textFile(toolchainFile, true)
    if (!pinned)
      fail(
        'This repository has no lean-toolchain file. Add a pinned Lean 4 toolchain before retrying.',
      )
    const toolchain = validateToolchain(pinned.content.trim())
    if (
      !project.repository &&
      !project.uploaded &&
      project.preset !== 'lean' &&
      project.toolchain &&
      project.toolchain !== toolchain
    )
      fail(
        'The selected toolchain does not match the cached preset. Use a custom Lean project for another version.',
      )
    project.toolchain = toolchain
    this.#setupPhase(project, 'preparing-lean')
    const signal = this.preparationControllers.get(project.id)?.signal
    // A shared toolchain download may serve another project. Stop this wait
    // immediately without killing that shared download or changing its cache.
    let abortWait
    try {
      await Promise.race([
        this.runtime.prepareToolchain(toolchain, {
          onOutput: (message) => {
            if (!signal?.aborted) this.#event(project, 'output', message)
          },
        }),
        new Promise((_, reject) => {
          abortWait = () => reject(signal.reason)
          signal?.addEventListener('abort', abortWait, { once: true })
          if (signal?.aborted) abortWait()
        }),
      ])
    } finally {
      signal?.removeEventListener('abort', abortWait)
    }
    this.preparationControllers.get(project.id)?.signal.throwIfAborted()
    // Existing lockfiles are authoritative. Lake fetches missing packages using
    // the pinned manifest when evaluating its environment.
    this.#setupPhase(project, 'preparing-dependencies')
    if (
      !(await exists(path.join(project.root, 'lake-manifest.json'))) &&
      !(await exists(path.join(project.root, '.lake')))
    )
      await this.#command(project, ['lake', 'update'], 900000, 'bridge')
    const shared =
      project.repository ||
      project.uploaded ||
      project.customEnvironment ||
      project.setupRepair?.status === 'running'
        ? await this.#sharedDependencies(project, signal)
        : null
    // Building a imported project's user proofs may fail legitimately. Preparation
    // requires usable dependencies and a Lake environment; proof errors belong in LSP.
    await this.#command(
      project,
      ['lake', 'env', 'lean', '--version'],
      900000,
      'bridge',
    )
    if (project.repository || project.uploaded || project.customEnvironment) {
      let manifest = null
      try {
        manifest = JSON.parse(
          (await textFile(await guarded(project.root, 'lake-manifest.json')))
            .content,
        )
      } catch (error) {
        if (
          !(error instanceof WorkspaceError) &&
          !(error instanceof SyntaxError)
        )
          throw error
      }
      for (const command of dependencyCacheCommands(manifest, {
        toolchain: project.toolchain,
      }))
        if (!shared || command.args.includes(`--package=${manifest?.name}`))
          await runDependencyCache(this.runtime, project.root, command, {
            signal,
            network: 'bridge',
            timeoutMs: 5400000,
            onOutput: (message) => this.#event(project, 'output', message),
          })
      // Imported projects need their own compiled modules for cross-file imports.
      if (!shared)
        for (const target of dependencyBuildTargets(manifest, {
          includeInherited: true,
        }))
          await this.#command(
            project,
            ['lake', 'build', target],
            1800000,
            'bridge',
          )
      // Failed user proofs remain repairable, so they do not make an otherwise
      // usable environment unavailable in the editor.
      this.#setupPhase(project, 'building-project')
      const build = await this.runtime.run(project.root, ['lake', 'build'], {
        timeoutMs: this.setupBuildTimeoutMs,
        network: 'none',
        signal: this.preparationControllers.get(project.id)?.signal,
        ...(project.repairedConfiguration
          ? { readOnlyWorkspace: true, writeLakeCache: true }
          : {}),
        onOutput: (output) =>
          this.#event(
            project,
            'output',
            typeof output === 'string'
              ? output
              : output?.text || output?.data || '',
          ),
      })
      signal?.throwIfAborted()
      if (build.code !== 0) {
        const dependency = dependencyFailureMessage(build)
        if (dependency)
          throw Object.assign(new Error(dependency), {
            setupEnvironment: true,
            infrastructure: setupInfrastructureFailure(build),
          })
        project.buildWarning =
          setupFailureMessage(build) ||
          'Some project targets did not compile. Open their files to inspect and repair the Lean errors.'
        this.#event(project, 'warning', `${project.buildWarning}\n`)
      } else delete project.buildWarning
      if (!shared) {
        await this.runtime.inheritDependencies?.(project.root, project.root)
        await certifyDependencyBuilds(this.runtime, project.root, manifest, {
          signal,
          onOutput: (message) => this.#event(project, 'output', message),
        })
      }
    }
    this.#setupPhase(project, 'checking-environment')
    await this.#checkProjectEnvironment(project, signal)
    await this.#initializeRepository(project)
    if (await exists(path.join(checkout, '.git'))) {
      try {
        const result = await this.#command(
          project,
          [...GIT_ARGS, 'rev-parse', 'HEAD'],
          30000,
        )
        project.sourceRevision = result.stdout.trim()
      } catch {
        /* Fresh projects can have no commit yet. */
      }
    }
    signal?.throwIfAborted()
    project.status = 'ready'
    delete project.needsPreparation
    if (project.setupRepair?.status === 'running')
      project.setupRepair = {
        ...project.setupRepair,
        status: 'completed',
        message: 'Lemex repaired setup; the Lean environment check passed.',
      }
    delete project.error
    this.#save(project)
    this.#event(project, 'ready', 'Project ready.\n')
  }

  #ready(project, allowConfigurationChange = false) {
    if (
      project.status !== 'ready' &&
      !(
        allowConfigurationChange &&
        project.status === 'error' &&
        project.needsPreparation
      )
    )
      fail(
        project.status === 'error'
          ? project.error || 'Project needs preparation'
          : 'Project is still being prepared',
        409,
      )
  }

  async #walk(
    root,
    {
      dependencies = false,
      dependencyRoot = root,
      includeLinks = false,
      foldersOnly = false,
      limit = MAX_FILES,
    } = {},
  ) {
    const result = []
    const visit = async (directory, prefix = '') => {
      let entries
      if (foldersOnly) {
        let handle
        try {
          handle = await fs.open(
            directory,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          )
          if (
            (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !==
            path.resolve(directory)
          )
            fail(
              'Folder changed during access. Refresh the file tree and try again.',
              409,
            )
          entries = await fs.readdir(`/proc/self/fd/${handle.fd}`, {
            withFileTypes: true,
          })
        } catch (error) {
          if (error.code === 'ENOTDIR' || error.code === 'ELOOP')
            fail(
              'Folder changed during access. Refresh the file tree and try again.',
              409,
            )
          throw error
        } finally {
          await handle?.close()
        }
      } else entries = await fs.readdir(directory, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (result.length >= limit) break
        if (
          isSecret(entry.name) ||
          entry.name === '.ready.json' ||
          entry.name === 'node_modules' ||
          entry.name === '.lake'
        )
          continue
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const full = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) {
          if (includeLinks)
            result.push({
              path: relative,
              size: 0,
              link: await fs.readlink(full),
            })
        } else if (entry.isDirectory()) {
          if (foldersOnly) {
            try {
              relativeFile(relative, { write: true })
            } catch (error) {
              if (error instanceof WorkspaceError) continue
              throw error
            }
            result.push({ path: relative })
          }
          await visit(full, relative)
        } else if (!foldersOnly && entry.isFile()) {
          const stat = await fs.stat(full)
          result.push({ path: relative, size: stat.size })
        }
      }
    }
    await visit(root)
    if (dependencies) {
      const deps = path.join(dependencyRoot, '.lake', 'packages')
      const stat = await exists(deps)
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        await guarded(dependencyRoot, '.lake/packages/check/placeholder.lean')
        const projects = await fs.readdir(deps, { withFileTypes: true })
        for (const project of projects) {
          if (
            !project.isDirectory() ||
            isSecret(project.name) ||
            result.length >= limit
          )
            continue
          const start = result.length
          await visit(
            path.join(deps, project.name),
            `.lake/packages/${project.name}`,
          )
          // Dependency navigation intentionally includes Lean source and documentation.
          for (let i = result.length - 1; i >= start; i--) {
            if (!/\.(lean|md|toml)$/.test(result[i].path)) result.splice(i, 1)
            else result[i].readOnly = true
          }
        }
      }
    }
    return result
  }

  async files(id, owner) {
    const project = this.get(id, owner)
    const dependencyRoot =
      (await this.runtime.dependencyRoot?.(project.root)) || project.root
    return this.#walk(project.root, { dependencies: true, dependencyRoot })
  }

  async folders(id, owner) {
    const project = this.get(id, owner)
    return (await this.#walk(project.root, { foldersOnly: true })).map(
      (folder) => folder.path,
    )
  }

  async createFolder(id, owner, input) {
    this.get(id, owner)
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('Enter a folder name.')
    const filename = relativeFile(input.path, { write: true })
    if (CONFIGURATION_FILES.has(filename.split('/')[0]))
      fail(
        'This name is reserved for a project setup file. Choose another folder name.',
      )
    return this.#locked(id, async () => {
      const project = this.get(id, owner)
      this.#ready(project, true)
      if (project.kind === 'single-file')
        fail(
          'Convert the playground to a project before creating folders.',
          409,
        )
      if (this.jobs.has(id))
        fail(
          'Wait for project preparation to finish before creating folders.',
          409,
        )
      await guarded(project.root, filename, { write: true })
      const parent = await writeParent(project.root, filename)
      try {
        await fs.mkdir(`${parent.anchor}/${parent.name}`, { mode: 0o700 })
      } catch (error) {
        if (error.code === 'EEXIST')
          fail(
            'A file or folder with this name already exists. Choose another name.',
            409,
          )
        throw error
      } finally {
        await parent.handle.close()
      }
      this.#event(project, 'saved', `Created folder ${filename}.\n`)
      return { path: filename }
    })
  }

  async readFile(id, owner, filename) {
    const project = this.get(id, owner)
    relativeFile(filename)
    const root = filename.startsWith('.lake/packages/')
      ? (await this.runtime.dependencyRoot?.(project.root)) || project.root
      : project.root
    const { content, hash } = await textFile(await guarded(root, filename))
    return { content, hash }
  }

  async readPdfPreview(id, owner, filename) {
    const project = this.get(id, owner)
    const relative = relativeFile(filename)
    if (!isPdfFile(relative)) fail('Choose a .pdf file to preview.', 415)
    const root = relative.startsWith('.lake/packages/')
      ? (await this.runtime.dependencyRoot?.(project.root)) || project.root
      : project.root
    const { content } = await workspaceFileBytes(
      await guarded(root, relative),
      {
        byteLimit: MAX_PDF_FILE_BYTES,
        tooLargeMessage:
          'PDF files must be at most 16 MiB. Reduce the PDF and upload it again.',
      },
    )
    return { content: validatePdfBytes(relative, content), path: relative }
  }

  async readLibrarySource(id, owner, input) {
    const project = this.get(id, owner)
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      (input.uri !== undefined && input.module !== undefined)
    )
      fail('Choose a module or a Lean definition location.')
    const module =
      input.uri !== undefined
        ? toolchainSourceModule(project.toolchain, input.uri)
        : input.module
    const signature = input.signature === undefined ? '' : input.signature
    const filename = libraryModulePath(module)
    if (typeof signature !== 'string' || signature.length > 16_000)
      fail('The declaration signature must be at most 16,000 characters.')
    let source
    let displayPath
    if (/^(?:Init|Lean|Std)(?:\.|$)/.test(module)) {
      const root = this.runtime.toolchainSourceRoot?.(project.toolchain)
      if (!root)
        fail(
          'The project’s Lean sources are unavailable. Prepare the project and try again.',
          404,
        )
      try {
        source = await textFile(await guarded(root, filename))
      } catch (error) {
        if (error.code === 'ENOENT' || error.status === 404)
          fail(
            'This module is unavailable in the project’s Lean installation. Use Open source to view the indexed version.',
            404,
          )
        throw error
      }
      displayPath = `Lean library/${filename}`
    } else {
      // Use the module, never the declaration's namespace. Existing workspace
      // reads also handle packages mounted from a shared dependency cache.
      const candidates = (await this.files(id, owner)).filter(
        (file) =>
          file.path.startsWith('.lake/packages/') &&
          file.path.endsWith(`/${filename}`),
      )
      if (candidates.length !== 1)
        fail(
          candidates.length
            ? 'More than one installed library contains this module. Open it from the library file tree.'
            : 'This module is not installed in the project. Use Open source to view the indexed version.',
          404,
        )
      displayPath = candidates[0].path
      source = await this.readFile(id, owner, displayPath)
    }
    let selection = sourceSelection(source.content, signature)
    if (input.uri !== undefined) {
      const endLine = input.endLine ?? input.line
      if (
        !Number.isSafeInteger(input.line) ||
        input.line < 1 ||
        !Number.isSafeInteger(endLine) ||
        endLine < input.line ||
        endLine > source.content.split('\n').length
      )
        fail(
          'The definition position is outside the local source file. Request its definition again.',
        )
      selection = { line: input.line, endLine }
    }
    return {
      module,
      path: displayPath,
      toolchain: project.toolchain || null,
      content: source.content,
      readOnly: true,
      ...selection,
    }
  }

  #assertPlaygroundFile(project, filename) {
    if (project.kind === 'single-file' && CONFIGURATION_FILES.has(filename))
      fail('Convert it to a project before editing setup files.', 409)
  }

  #invalidateConfiguration(project, filename, changed = true) {
    if (!changed || !CONFIGURATION_FILES.has(filename)) return false
    return this.#requirePreparation(project)
  }

  #requirePreparation(project) {
    delete project.log
    project.status = 'error'
    project.needsPreparation = true
    project.customEnvironment = true
    project.error =
      'Project configuration changed. Retry setup to prepare and test the updated environment.'
    this.#save(project)
    return true
  }

  configurationFingerprint(id, owner) {
    const project = this.get(id, owner)
    return configurationDigest(readDependencyConfiguration(project.root))
  }

  async refreshExternalConfiguration(id, owner, previous) {
    this.get(id, owner)
    return this.#locked(id, () => {
      const project = this.get(id, owner)
      if (project.status === 'preparing') return false
      let current
      try {
        current = configurationDigest(readDependencyConfiguration(project.root))
      } catch {
        // Missing, oversized, or non-regular configuration needs the same
        // recovery path as a changed file. Never follow terminal-made links.
      }
      return current === previous ? false : this.#requirePreparation(project)
    })
  }

  async writeFile(id, owner, filename, content, expectedHash) {
    const project = this.get(id, owner)
    this.#ready(project, true)
    if (isPdfFile(filename))
      fail(
        'PDF files are read only. Upload a new PDF with a different name.',
        415,
      )
    if (
      typeof content !== 'string' ||
      Buffer.byteLength(content) >
        sourceFileByteLimit(typeof filename === 'string' ? filename : '') ||
      content.includes('\0')
    )
      fail(
        `File content must be UTF-8 text at most ${sourceFileByteLimit(typeof filename === 'string' ? filename : '') / (1024 * 1024)} MiB. Reduce the file or split Lean sources into smaller modules.`,
        413,
      )
    return this.#locked(id, async () => {
      const project = this.#owned(id, owner)
      if (project.archivedAt) fail('Project not found', 404)
      this.#ready(project, true)
      if (this.jobs.has(id))
        fail('Wait for project preparation to finish before saving.', 409)
      this.#assertPlaygroundFile(project, filename)
      const destination = await guarded(project.root, filename, { write: true })
      const before = await textFile(destination, true)
      if (expectedHash !== undefined && expectedHash !== (before?.hash ?? null))
        fail(
          'The file changed since it was opened. Reload it before saving.',
          409,
        )
      const parent = await writeParent(project.root, filename)
      const temporary = `${parent.anchor}/.lemex-write-${randomUUID()}`
      try {
        await fs.writeFile(temporary, content, {
          mode: before?.mode ?? 0o600,
          flag: 'wx',
        })
        await fs.rename(temporary, `${parent.anchor}/${parent.name}`)
      } finally {
        await fs.rm(temporary, { force: true })
        await parent.handle.close()
      }
      this.#event(project, 'saved', `Saved ${filename}.\n`)
      const requiresPreparation = this.#invalidateConfiguration(
        project,
        filename,
        before?.content !== content,
      )
      return { content, hash: sha(content), requiresPreparation }
    })
  }

  async gitStatus(id, owner) {
    const project = this.get(id, owner)
    this.#ready(project)
    if (!(await exists(path.join(this.repositoryRoot(project), '.git'))))
      return {
        repository: false,
        branch: null,
        revision: null,
        changes: [],
        diff: '',
      }
    const status = await this.#command(
      project,
      [
        ...GIT_ARGS,
        'status',
        '--porcelain=v1',
        '--branch',
        '--untracked-files=all',
        '-z',
      ],
      30000,
    )
    const records = status.stdout.split('\0').filter(Boolean)
    const branchLine = records[0]?.startsWith('## ')
      ? records.shift().slice(3).split('...')[0]
      : null
    const branch =
      branchLine?.replace(/^(?:No commits yet on |Initial commit on )/, '') ||
      null
    const changes = []
    for (let i = 0; i < records.length; i++) {
      const record = records[i]
      const item = { status: record.slice(0, 2), path: record.slice(3) }
      if (/[RC]/.test(item.status)) item.from = records[++i]
      if (project.subdirectory) {
        const prefix = project.subdirectory + '/'
        if (
          !item.path.startsWith(prefix) ||
          (item.from && !item.from.startsWith(prefix))
        )
          continue
        item.path = item.path.slice(prefix.length)
        if (item.from) item.from = item.from.slice(prefix.length)
      }
      try {
        relativeFile(item.path)
        if (item.from) relativeFile(item.from)
        changes.push(item)
      } catch {
        /* Secret paths never appear in API results. */
      }
    }
    // Restrict diff pathspecs to visible files so accidental secrets cannot leak.
    const visible = changes
      .map((c) => c.path)
      .filter((p) => !p.startsWith('.lake/'))
      .map((p) => (project.subdirectory ? `${project.subdirectory}/${p}` : p))
    const head = await this.runtime.run(
      this.repositoryRoot(project),
      [...GIT_ARGS, 'rev-parse', '--verify', 'HEAD'],
      { network: 'none', timeoutMs: 30000 },
    )
    const revision =
      head.code === 0 && /^[a-f0-9]{40,64}$/.test(head.stdout.trim())
        ? head.stdout.trim()
        : null
    const diff = visible.length
      ? (
          await this.#command(
            project,
            [
              ...GIT_ARGS,
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              ...(revision ? ['HEAD'] : []),
              '--',
              ...visible,
            ],
            30000,
          )
        ).stdout
      : ''
    return {
      repository: true,
      branch,
      revision,
      changes,
      diff: diff.slice(0, 500000),
    }
  }

  async snapshot(id, owner, runId) {
    const project = this.get(id, owner)
    this.#ready(project)
    validateId(runId, 'run')
    return this.#locked(id, () => this.#capture(this.get(id, owner), runId))
  }

  async #capture(project, runId) {
    const { id, owner } = project
    const container = path.join(this.snapshotsDir, runId)
    await fs
      .mkdir(container, { recursive: false, mode: 0o700 })
      .catch((error) => {
        if (error.code === 'EEXIST')
          fail('A candidate workspace already exists for this run', 409)
        throw error
      })
    const root = path.join(container, 'workspace')
    // This server-owned marker precedes every source copy and dependency bind.
    // An interrupted capture remains attributable even without its manifest.
    await fs.writeFile(
      path.join(container, 'ownership.json'),
      JSON.stringify({ projectId: id, owner, runId, root }),
      { mode: 0o600, flag: 'wx' },
    )
    const inherit = typeof this.runtime.inheritDependencies === 'function'
    await copyWorkspace(project.root, root, { omitDependencies: inherit })
    if (inherit) await this.runtime.inheritDependencies(project.root, root)
    const files = []
    const links = []
    for (const entry of await this.#walk(root, {
      includeLinks: true,
      limit: Infinity,
    })) {
      if (entry.link !== undefined)
        links.push({ path: entry.path, target: entry.link })
      else
        files.push({
          path: entry.path,
          hash: await fileHash(await guarded(root, entry.path)),
        })
    }
    let sourceRevision = project.sourceRevision || null
    if (await exists(path.join(this.repositoryRoot(project), '.git'))) {
      try {
        sourceRevision = (
          await this.#command(
            project,
            [...GIT_ARGS, 'rev-parse', 'HEAD'],
            30000,
          )
        ).stdout.trim()
      } catch {
        /* No commit yet. */
      }
    }
    const snapshot = {
      root,
      files,
      links,
      sourceRevision,
      projectId: id,
      owner,
      runId,
      createdAt: new Date().toISOString(),
    }
    // Record original content outside the writable candidate. It is needed for
    // review and allows recovery after the server restarts.
    const baseline = path.join(container, 'baseline')
    await fs.mkdir(baseline, { mode: 0o700 })
    for (const file of files) {
      const destination = path.join(baseline, file.path)
      await fs.mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      })
      await fs.copyFile(
        path.join(root, file.path),
        destination,
        constants.COPYFILE_FICLONE,
      )
    }
    await fs.writeFile(
      path.join(container, 'manifest.json'),
      JSON.stringify(snapshot),
      { mode: 0o600, flag: 'wx' },
    )
    this.#event(
      project,
      'snapshot',
      `Created candidate workspace for run ${runId}.\n`,
    )
    return snapshot
  }

  async #manifest(snapshot) {
    if (!snapshot || typeof snapshot !== 'object')
      fail('Invalid candidate workspace')
    const runId = validateId(
      snapshot.runId || path.basename(path.dirname(snapshot.root || '')),
      'run',
    )
    const container = path.join(this.snapshotsDir, runId)
    const root = path.join(container, 'workspace')
    if (
      snapshot.root !== root ||
      (await fs.realpath(container)) !== container ||
      (await fs.realpath(root)) !== root
    )
      fail('Invalid candidate workspace', 403)
    const manifest = JSON.parse(
      await fs.readFile(path.join(container, 'manifest.json'), 'utf8'),
    )
    if (manifest.root !== root || manifest.runId !== runId)
      fail('Invalid candidate manifest', 403)
    return { manifest, container }
  }

  async changes(snapshot) {
    const { manifest, container } = await this.#manifest(snapshot)
    const base = new Map(manifest.files.map((file) => [file.path, file]))
    const entries = await this.#walk(manifest.root, {
      includeLinks: true,
      limit: Infinity,
    })
    this.#checkLinks(manifest, entries, 'Candidate symbolic links changed')
    const current = new Map(
      entries
        .filter((file) => file.link === undefined)
        .map((file) => [file.path, file]),
    )
    const changes = []
    for (const filename of [
      ...new Set([...base.keys(), ...current.keys()]),
    ].sort()) {
      const original = base.get(filename)
      if (
        original &&
        current.has(filename) &&
        (await fileHash(await guarded(manifest.root, filename))) ===
          original.hash
      )
        continue
      let before = null
      let after = null
      if (original) {
        try {
          before = (
            await textFile(
              await guarded(path.join(container, 'baseline'), filename),
            )
          ).content
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error
          fail(`Candidate changed a noneditable file: ${filename}`, 409)
        }
      }
      if (current.has(filename)) {
        try {
          after = (await textFile(await guarded(manifest.root, filename)))
            .content
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error
          fail(`Candidate changed a noneditable file: ${filename}`, 409)
        }
      } else {
        // A symlink replacing a source file is an error, not an implicit deletion.
        const target = await exists(path.join(manifest.root, filename))
        if (target)
          fail(`Candidate file ${filename} is not a regular editable file`, 409)
      }
      if (before !== after)
        changes.push({
          path: filename,
          before,
          after,
          beforeHash: original?.hash || null,
        })
    }
    return changes
  }

  async readSnapshotFile(snapshot, filename) {
    const { manifest } = await this.#manifest(snapshot)
    return textFile(await guarded(manifest.root, filename, { write: true }))
  }

  #checkLinks(manifest, entries, message) {
    const expected = new Map(
      (manifest.links || []).map((link) => [link.path, link.target]),
    )
    const current = entries.filter((entry) => entry.link !== undefined)
    if (
      current.length !== expected.size ||
      current.some((link) => expected.get(link.path) !== link.link)
    )
      fail(message, 409)
  }

  async #assertCurrent(manifest, project, liveChanges = []) {
    if (manifest.projectId !== project.id || manifest.owner !== project.owner)
      fail('Candidate belongs to another project', 403)
    const entries = await this.#walk(project.root, {
      includeLinks: true,
      limit: Infinity,
    })
    this.#checkLinks(
      manifest,
      entries,
      'Project symbolic links changed during the assistant run. Start a new run from the current project.',
    )
    const current = entries.filter((entry) => entry.link === undefined)
    const base = new Map(manifest.files.map((file) => [file.path, file.hash]))
    for (const change of liveChanges) {
      if (change.after === null) base.delete(change.path)
      else base.set(change.path, sha(change.after))
    }
    if (current.length !== base.size)
      fail(
        'Project files changed during the assistant run. Start a new run from the current project.',
        409,
      )
    for (const entry of current) {
      if (
        base.get(entry.path) !==
        (await fileHash(await guarded(project.root, entry.path)))
      )
        fail(
          `Project changed during the assistant run: ${entry.path}. Start a new run from the current project.`,
          409,
        )
    }
    return true
  }

  async #assertLiveCurrent(manifest, project, previous, next = []) {
    if (manifest.projectId !== project.id || manifest.owner !== project.owner)
      fail('Candidate belongs to another project', 403)
    const entries = await this.#walk(project.root, {
      includeLinks: true,
      limit: Infinity,
    })
    this.#checkLinks(
      manifest,
      entries,
      'Project symbolic links changed during the assistant run. Start a new run from the current project.',
    )
    const base = new Map(manifest.files.map((file) => [file.path, file.hash]))
    for (const change of previous) base.set(change.path, sha(change.after))
    const current = new Map(
      entries
        .filter((entry) => entry.link === undefined)
        .map((entry) => [entry.path, entry]),
    )
    const touched = new Set([...previous, ...next].map((change) => change.path))
    const configuration = new Set([
      'lean-toolchain',
      'lakefile.lean',
      'lakefile.toml',
      'lake-manifest.json',
    ])
    const protectedPath = (filename) =>
      configuration.has(path.posix.basename(filename)) || touched.has(filename)
    for (const filename of new Set([...base.keys(), ...current.keys()])) {
      if (!protectedPath(filename)) continue
      const expected = base.get(filename) ?? null
      const actual = current.has(filename)
        ? await fileHash(await guarded(project.root, filename))
        : null
      if (expected !== actual)
        fail(
          `Project changed during the assistant run: ${filename}. Start a new run from the current project.`,
          409,
        )
    }
    return true
  }

  async #assertTouched(manifest, project, live) {
    if (manifest.projectId !== project.id || manifest.owner !== project.owner)
      fail('Candidate belongs to another project', 403)
    for (const change of live) {
      const actual = await textFile(
        await guarded(project.root, change.path, { write: true }),
        true,
      )
      if (actual?.hash !== sha(change.after))
        fail(
          `Project changed during the assistant run: ${change.path}. Undo cannot overwrite your saved changes.`,
          409,
        )
    }
    return true
  }

  async assertSnapshotCurrent(snapshot) {
    const { manifest } = await this.#manifest(snapshot)
    const project = this.get(manifest.projectId, manifest.owner)
    return this.#locked(project.id, () =>
      this.#assertCurrent(manifest, project),
    )
  }

  async #leanChanges(manifest, container, changes) {
    if (!Array.isArray(changes) || changes.length > 1000)
      fail('Invalid live Lean change set')
    const original = new Map(
      manifest.files.map((file) => [file.path, file.hash]),
    )
    const seen = new Set(),
      result = []
    for (const change of changes) {
      if (!change || typeof change !== 'object')
        fail('Invalid live Lean change')
      const filename = relativeFile(change.path, { write: true })
      if (
        !filename.endsWith('.lean') ||
        path.posix.basename(filename) === 'lakefile.lean'
      )
        fail('Live assistant edits may change Lean source files only', 409)
      if (seen.has(filename)) fail('A live change set contains duplicate paths')
      seen.add(filename)
      if (
        typeof change.after !== 'string' ||
        Buffer.byteLength(change.after) > sourceFileByteLimit(filename) ||
        change.after.includes('\0')
      )
        fail(
          'Live assistant edits require editable Lean text and cannot delete files',
          409,
        )
      const beforeHash = original.get(filename) ?? null
      if (beforeHash !== change.beforeHash)
        fail(`Original baseline does not match ${filename}`, 409)
      let before = null
      if (beforeHash !== null) {
        const baseline = await textFile(
          await guarded(path.join(container, 'baseline'), filename),
        )
        if (baseline.hash !== beforeHash)
          fail('The protected assistant baseline changed', 409)
        before = baseline.content
      }
      if (change.before !== undefined && change.before !== before)
        fail(`Original baseline content does not match ${filename}`, 409)
      if (change.after !== before)
        result.push({ path: filename, before, after: change.after, beforeHash })
    }
    return result
  }

  #liveTransition(previous, next) {
    const old = new Map(previous.map((change) => [change.path, change]))
    const desired = new Map(next.map((change) => [change.path, change]))
    const transition = []
    for (const filename of [
      ...new Set([...old.keys(), ...desired.keys()]),
    ].sort()) {
      const original = old.get(filename) || desired.get(filename)
      const before = old.has(filename)
        ? old.get(filename).after
        : original.before
      const after = desired.has(filename)
        ? desired.get(filename).after
        : original.before
      if (before !== after)
        transition.push({
          path: filename,
          before,
          after,
          beforeHash: before === null ? null : sha(before),
        })
    }
    return transition
  }

  async syncLive(snapshot, changes, previousChanges = []) {
    const { manifest, container } = await this.#manifest(snapshot)
    const initial = this.get(manifest.projectId, manifest.owner)
    return this.#locked(initial.id, async () => {
      const project = this.get(initial.id, initial.owner)
      this.#ready(project)
      const previous = await this.#leanChanges(
        manifest,
        container,
        previousChanges,
      )
      const next = await this.#leanChanges(manifest, container, changes)
      await this.#assertLiveCurrent(manifest, project, previous, next)
      await this.#applyLocked(
        project,
        this.#liveTransition(previous, next),
        'live',
      )
      return next
    })
  }

  async assertLive(snapshot, liveChanges = []) {
    const { manifest, container } = await this.#manifest(snapshot)
    const initial = this.get(manifest.projectId, manifest.owner)
    return this.#locked(initial.id, async () => {
      const project = this.get(initial.id, initial.owner)
      this.#ready(project)
      const live = await this.#leanChanges(manifest, container, liveChanges)
      return this.#assertLiveCurrent(manifest, project, live)
    })
  }

  async undoLive(snapshot, liveChanges) {
    const { manifest, container } = await this.#manifest(snapshot)
    const initial = this.get(manifest.projectId, manifest.owner)
    return this.#locked(initial.id, async () => {
      const project = this.get(initial.id, initial.owner)
      this.#ready(project, true)
      const live = await this.#leanChanges(manifest, container, liveChanges)
      await this.#assertTouched(manifest, project, live)
      return this.#applyLocked(project, this.#liveTransition(live, []), 'undo')
    })
  }

  async verificationCopy(snapshot, changes, options = {}) {
    const { liveChanges = [] } = options
    const { manifest, container } = await this.#manifest(snapshot)
    const initial = this.get(manifest.projectId, manifest.owner)
    const project = initial
    this.#ready(project)
    if (!Array.isArray(changes) || changes.length > 1000)
      fail('Invalid verification change set')
    return this.#locked(project.id, async () => {
      const currentProject = this.get(project.id, project.owner)
      this.#ready(currentProject)
      const previous = await this.#leanChanges(manifest, container, liveChanges)
      const proposed = await this.#leanChanges(manifest, container, changes)
      if (Object.hasOwn(options, 'liveChanges'))
        await this.#assertLiveCurrent(
          manifest,
          currentProject,
          previous,
          proposed,
        )
      else await this.#assertCurrent(manifest, currentProject)
      // Build from the saved project rather than copying anything controlled by
      // the model. The new root also gets a separate runtime HOME and artifacts.
      const verified = await this.#capture(currentProject, randomUUID())
      const transitions = this.#liveTransition(previous, proposed)
      for (const change of transitions) {
        const destination = await guarded(verified.root, change.path, {
          write: true,
        })
        const before = await textFile(destination, true)
        if ((before?.hash ?? null) !== change.beforeHash)
          fail(`Verification baseline changed for ${change.path}`, 409)
        const parent = await writeParent(verified.root, change.path)
        const temporary = `${parent.anchor}/.lemex-write-${randomUUID()}`
        try {
          if (change.after === null) {
            const reverted = path.join(path.dirname(verified.root), 'reverted')
            await fs.mkdir(reverted, { recursive: true, mode: 0o700 })
            await fs.rename(
              `${parent.anchor}/${parent.name}`,
              path.join(reverted, randomUUID()),
            )
          } else {
            await fs.writeFile(temporary, change.after, {
              flag: 'wx',
              mode: before?.mode ?? 0o600,
            })
            await fs.rename(temporary, `${parent.anchor}/${parent.name}`)
          }
        } finally {
          await fs.rm(temporary, { force: true })
          await parent.handle.close()
        }
      }
      return {
        ...verified,
        sourceRevision: manifest.sourceRevision,
        purpose: 'verification',
        sourceRunId: manifest.runId,
      }
    })
  }

  async applyChanges(id, owner, changes, { snapshot } = {}) {
    const project = this.get(id, owner)
    this.#ready(project)
    if (!Array.isArray(changes) || changes.length > 1000)
      fail('Invalid change set')
    return this.#locked(id, async () => {
      if (snapshot) {
        const { manifest } = await this.#manifest(snapshot)
        await this.#assertCurrent(manifest, project)
      }
      return this.#applyLocked(project, changes)
    })
  }

  async #applyLocked(project, changes, reason = 'applied') {
    project = this.get(project.id, project.owner)
    this.#ready(project, reason === 'undo')
    const { id, owner } = project
    const seen = new Set()
    const prepared = []
    for (const change of changes) {
      if (!change || typeof change !== 'object') fail('Invalid file change')
      const filename = relativeFile(change.path, { write: true })
      this.#assertPlaygroundFile(project, filename)
      if (seen.has(filename)) fail('A change set contains duplicate paths')
      seen.add(filename)
      const pdfUpload =
        reason === 'uploaded' &&
        isPdfFile(filename) &&
        Buffer.isBuffer(change.after) &&
        change.beforeHash === null
      if (pdfUpload) validatePdfBytes(filename, change.after)
      else if (isPdfFile(filename))
        fail(
          'PDF files are read only. Upload a new PDF with a different name.',
          415,
        )
      else if (
        change.after !== null &&
        (typeof change.after !== 'string' ||
          Buffer.byteLength(change.after) > sourceFileByteLimit(filename) ||
          change.after.includes('\0'))
      )
        fail('Invalid changed file content')
      if (
        change.beforeHash !== null &&
        (typeof change.beforeHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(change.beforeHash))
      )
        fail('Every change requires its original file hash')
      const destination = await guarded(project.root, filename, { write: true })
      if (pdfUpload && (await exists(destination)))
        fail(
          `A file named ${filename} already exists. Rename the PDF before uploading.`,
          409,
        )
      const before = pdfUpload ? null : await textFile(destination, true)
      if ((before?.hash ?? null) !== change.beforeHash)
        fail(
          `Cannot apply: ${filename} changed since the assistant run started.`,
          409,
        )
      prepared.push({
        ...change,
        path: filename,
        destination,
        existed: !!before,
        mode: before?.mode ?? 0o600,
        before: before?.content ?? null,
      })
    }
    if (!prepared.length) return { applied: 0, files: [] }
    const transaction = path.join(
      this.historyDir,
      id,
      `${Date.now()}-${randomUUID()}`,
    )
    await fs.mkdir(path.join(transaction, 'staged'), {
      recursive: true,
      mode: 0o700,
    })
    await fs.mkdir(path.join(transaction, 'before'), { mode: 0o700 })
    await fs.writeFile(
      path.join(transaction, 'manifest.json'),
      JSON.stringify({
        projectId: id,
        owner,
        createdAt: new Date().toISOString(),
        changes: prepared.map(({ path: filename, beforeHash, after }) => ({
          path: filename,
          beforeHash,
          afterHash: after === null ? null : sha(after),
        })),
      }),
      { mode: 0o600 },
    )
    for (let i = 0; i < prepared.length; i++) {
      if (prepared[i].after !== null)
        await fs.writeFile(
          path.join(transaction, 'staged', String(i)),
          prepared[i].after,
          { mode: prepared[i].mode },
        )
    }
    const applied = []
    try {
      for (let i = 0; i < prepared.length; i++) {
        const change = prepared[i]
        const parent = await writeParent(project.root, change.path)
        const anchored = `${parent.anchor}/${parent.name}`
        try {
          if (change.existed)
            await fs.rename(
              anchored,
              path.join(transaction, 'before', String(i)),
            )
          applied.push({ ...change, index: i, parent, anchored })
          if (change.after !== null)
            await fs.rename(
              path.join(transaction, 'staged', String(i)),
              anchored,
            )
        } catch (error) {
          if (!applied.some((item) => item.parent === parent))
            await parent.handle.close()
          throw error
        }
      }
    } catch (error) {
      for (const change of applied.reverse()) {
        await fs.rm(change.anchored, { force: true })
        if (change.existed)
          await fs.rename(
            path.join(transaction, 'before', String(change.index)),
            change.anchored,
          )
      }
      throw error
    } finally {
      await Promise.all(applied.map((change) => change.parent.handle.close()))
    }
    await fs.writeFile(
      path.join(transaction, 'applied.json'),
      JSON.stringify({ appliedAt: new Date().toISOString() }),
      { mode: 0o600 },
    )
    const requiresPreparation = prepared.some((change) =>
      this.#invalidateConfiguration(
        project,
        change.path,
        change.before !== change.after,
      ),
    )
    const action =
      reason === 'live'
        ? `Saved ${prepared.length} live assistant edits`
        : reason === 'undo'
          ? `Undid ${prepared.length} live assistant edits`
          : `Applied ${prepared.length} reviewed changes`
    this.#event(
      project,
      reason,
      `${action}. Backup: ${path.relative(this.dataDir, transaction)}\n`,
    )
    return {
      applied: prepared.length,
      requiresPreparation,
      files: prepared.map((change) => ({
        path: change.path,
        hash: change.after === null ? null : sha(change.after),
      })),
    }
  }
}
