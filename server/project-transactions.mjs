import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { removeDisposableTree } from './temporary-workspaces.mjs'
import { MAX_PROJECT_FILES } from '../shared/source-limits.mjs'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_CHANGES = MAX_PROJECT_FILES
const MAX_INTENT_BYTES = Math.ceil(MAX_BYTES / 3) * 4 + MAX_CHANGES * 2048
const digest = (value) => createHash('sha256').update(value).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const transactionPattern = /^\d{13}-[a-f0-9-]{36}$/
export const projectRecoveryMessage =
  'An interrupted file update needs administrator recovery. Download the available project files, then ask a project Admin to retry file recovery. If it still fails, ask the server administrator to check the retained transaction. Editing and project jobs are paused to preserve your files.'

function unappliedError(cause) {
  if ([401, 403, 404, 409].includes(cause.status || cause.statusCode))
    return cause
  return Object.assign(
    new Error(
      'The save was not applied; your files are unchanged. Free storage if needed, then try again.',
      { cause },
    ),
    { status: 503 },
  )
}

function logFailure(row, error, phase, filename) {
  console.error(
    '[LeanFlow files] Transaction failure:',
    JSON.stringify({
      project: row.project,
      transaction: row.id,
      phase,
      path: filename || error.transactionPath || null,
      code: error.code || error.name,
      reason:
        error.name === 'SyntaxError'
          ? 'Invalid recovery metadata.'
          : String(error.message).slice(0, 2000),
    }),
  )
}

function recoveryError(cause) {
  return Object.assign(new Error(projectRecoveryMessage, { cause }), {
    status: 503,
    projectRecovery: true,
  })
}

export function assertTransactionPaths(paths) {
  const seen = new Set(paths)
  for (const filename of seen) {
    const parts = filename.split('/')
    parts.pop()
    while (parts.length) {
      if (seen.has(parts.join('/')))
        throw Object.assign(
          new Error('A file update cannot also use that file as a folder.'),
          { status: 400 },
        )
      parts.pop()
    }
  }
}

async function openDirectory(filename) {
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== filename)
      throw new Error('Transaction directory changed.')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function syncDirectory(filename) {
  const handle = await openDirectory(filename)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function durableFile(filename, content, mode = 0o600) {
  const handle = await fs.open(
    filename,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  )
  try {
    await handle.writeFile(content)
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// All reads and replacements stay anchored to the same checked parent handle.
async function targetState(
  project,
  change,
  parent,
  { sync = false, singleLink = false } = {},
) {
  if (
    (await fs.realpath(parent.anchor)) !==
    path.dirname(path.join(project.root, change.path))
  )
    throw new Error('Transaction parent changed.')
  const filename = `${parent.anchor}/${parent.name}`
  let handle
  try {
    handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const before = await handle.stat()
    if (
      !before.isFile() ||
      before.size > MAX_BYTES ||
      (singleLink && before.nlink !== 1)
    )
      throw new Error('Transaction target is not a bounded regular file.')
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      if (bytes > MAX_BYTES)
        throw new Error('Transaction target grew too large.')
      hash.update(chunk)
    }
    const after = await handle.stat()
    const current = await fs.lstat(filename)
    if (
      before.size !== bytes ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink()
    )
      throw new Error('Transaction target changed during checking.')
    if (sync) await handle.sync()
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

export class ProjectTransactions {
  constructor({ db, historyDir, validatePath, openParent }) {
    Object.assign(this, { db, historyDir, validatePath, openParent })
    this.errors = new Map()
    db.exec(
      'CREATE TABLE IF NOT EXISTS pending_project_transactions (id TEXT PRIMARY KEY, project TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, payload TEXT NOT NULL);',
    )
  }

  assertWritable(projectId) {
    if (this.errors.has(projectId)) throw recoveryError()
  }

  #validate(row, project) {
    if (
      typeof row.payload !== 'string' ||
      Buffer.byteLength(row.payload) > MAX_INTENT_BYTES
    )
      throw new Error('Invalid transaction size.')
    const intent = JSON.parse(row.payload)
    if (
      intent.version !== 1 ||
      intent.id !== row.id ||
      !transactionPattern.test(intent.id) ||
      intent.projectId !== row.project ||
      intent.owner !== row.owner ||
      project.id !== row.project ||
      project.owner !== row.owner ||
      !Array.isArray(intent.changes) ||
      !intent.changes.length ||
      intent.changes.length > MAX_CHANGES
    )
      throw new Error('Invalid transaction identity or version.')
    let bytes = 0
    const seen = new Set()
    for (const change of intent.changes) {
      if (
        !change ||
        this.validatePath(change.path) !== change.path ||
        seen.has(change.path) ||
        !Number.isInteger(change.mode) ||
        change.mode < 0 ||
        change.mode > 0o777 ||
        (change.beforeHash !== null &&
          (typeof change.beforeHash !== 'string' ||
            !hashPattern.test(change.beforeHash))) ||
        (change.afterHash !== null &&
          (typeof change.afterHash !== 'string' ||
            !hashPattern.test(change.afterHash)))
      )
        throw new Error('Invalid transaction change.')
      seen.add(change.path)
      if (change.before === null) {
        if (change.beforeHash !== null)
          throw new Error('Missing original transaction bytes.')
      } else {
        if (typeof change.before !== 'string')
          throw new Error('Invalid original transaction bytes.')
        const content = Buffer.from(change.before, 'base64')
        bytes += content.length
        if (
          bytes > MAX_BYTES ||
          content.toString('base64') !== change.before ||
          digest(content) !== change.beforeHash
        )
          throw new Error('Original transaction bytes failed verification.')
      }
    }
    assertTransactionPaths(seen)
    return intent
  }

  #directory(intent) {
    return path.join(this.historyDir, intent.projectId, intent.id)
  }

  async #committed(intent, payload) {
    const directory = this.#directory(intent)
    // Opening the directory first rejects replaced or linked history paths.
    const parent = await openDirectory(directory)
    let handle
    try {
      try {
        handle = await fs.open(
          `/proc/self/fd/${parent.fd}/applied.json`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 4096)
        throw new Error('Invalid transaction commit marker.')
      const marker = JSON.parse(await handle.readFile('utf8'))
      if (
        marker.version !== 1 ||
        marker.id !== intent.id ||
        marker.projectId !== intent.projectId ||
        marker.owner !== intent.owner ||
        marker.intentHash !== digest(payload)
      )
        throw new Error('Transaction commit marker failed verification.')
      return true
    } finally {
      await handle?.close()
      await parent.close()
    }
  }

  async #syncParents(project, intent) {
    const directories = new Set([project.root])
    for (const change of intent.changes) {
      let directory = path.dirname(path.join(project.root, change.path))
      while (directory !== project.root) {
        directories.add(directory)
        directory = path.dirname(directory)
      }
    }
    for (const directory of [...directories].sort(
      (a, b) => b.length - a.length,
    ))
      await syncDirectory(directory)
  }

  async #recover(row, project, onCommitted) {
    const intent = this.#validate(row, project)
    const committed = await this.#committed(intent, row.payload)
    if (committed) {
      await onCommitted?.(project, intent.changes)
    } else {
      let staging, originals, currentPath
      const directory = this.#directory(intent)
      const beforeDirectory = path.join(directory, 'before')
      try {
        for (const change of intent.changes) {
          currentPath = change.path
          const parent = await this.openParent(project.root, change.path)
          try {
            const current = await targetState(project, change, parent)
            if (![null, change.beforeHash, change.afterHash].includes(current))
              throw new Error('Transaction target contains an unexpected edit.')
          } finally {
            await parent.handle.close()
          }
        }
        for (const [index, change] of intent.changes.entries()) {
          currentPath = change.path
          const parent = await this.openParent(project.root, change.path)
          try {
            const current = await targetState(project, change, parent)
            if (![null, change.beforeHash, change.afterHash].includes(current))
              throw new Error('Transaction target changed before recovery.')
            if (current !== change.beforeHash) {
              const destination = `${parent.anchor}/${parent.name}`
              if (change.before === null) {
                // Preflight proved this is exactly the newly-created file.
                if (current !== null) await fs.unlink(destination)
              } else {
                if (!originals)
                  originals = await openDirectory(beforeDirectory).catch(
                    (error) => {
                      if (error.code === 'ENOENT') return null
                      throw error
                    },
                  )
                const original = originals
                  ? await targetState(
                      { root: beforeDirectory },
                      { path: String(index) },
                      {
                        anchor: `/proc/self/fd/${originals.fd}`,
                        name: String(index),
                      },
                      { singleLink: true },
                    )
                  : null
                if (original !== null) {
                  if (original !== change.beforeHash)
                    throw new Error(
                      'Original transaction backup failed verification.',
                    )
                  await fs.rename(
                    `/proc/self/fd/${originals.fd}/${index}`,
                    destination,
                  )
                } else {
                  if (!staging) {
                    const rollback = path.join(directory, 'rollback')
                    await fs.mkdir(rollback, { recursive: true, mode: 0o700 })
                    staging = await openDirectory(rollback)
                  }
                  const temporary = `/proc/self/fd/${staging.fd}/${index}`
                  try {
                    const previous = await fs
                      .lstat(temporary)
                      .catch((error) => {
                        if (error.code === 'ENOENT') return null
                        throw error
                      })
                    if (previous) {
                      if (
                        !previous.isFile() ||
                        previous.isSymbolicLink() ||
                        previous.nlink !== 1
                      )
                        throw new Error('Rollback staging file is not safe.')
                      await fs.unlink(temporary)
                    }
                    await durableFile(
                      temporary,
                      Buffer.from(change.before, 'base64'),
                      change.mode,
                    )
                    await fs.rename(temporary, destination)
                  } finally {
                    await fs.rm(temporary, { force: true })
                  }
                }
              }
            }
            if (
              (await targetState(project, change, parent, {
                sync: current === change.beforeHash,
              })) !== change.beforeHash
            )
              throw new Error('Transaction target changed during recovery.')
          } finally {
            await parent.handle.close()
          }
        }
        await originals?.sync()
        await staging?.sync()
        await this.#syncParents(project, intent)
      } catch (error) {
        error.transactionPath ||= currentPath
        throw error
      } finally {
        await originals?.close()
        await staging?.close()
      }
    }
    this.db
      .prepare('DELETE FROM pending_project_transactions WHERE id=?')
      .run(row.id)
    this.errors.delete(row.project)
    return committed
  }

  async recoverPending({ projectFor, onCommitted }) {
    // Load only small identities together; original bytes are read one intent at a time.
    const rows = this.db
      .prepare(
        'SELECT id,project FROM pending_project_transactions ORDER BY rowid',
      )
      .all()
    for (const identity of rows) {
      try {
        await this.retry(projectFor(identity.project), { onCommitted })
      } catch (error) {
        if (this.errors.has(identity.project)) continue
        this.errors.set(identity.project, projectRecoveryMessage)
        logFailure(
          { project: identity.project, id: identity.id },
          error,
          'startup',
        )
      }
    }
  }

  async retry(project, { onCommitted } = {}) {
    const row = this.db
      .prepare('SELECT * FROM pending_project_transactions WHERE project=?')
      .get(project.id)
    if (!row) {
      if (this.errors.has(project.id))
        throw recoveryError(new Error('Pending transaction is unavailable.'))
      return
    }
    try {
      await this.#recover(row, project, onCommitted)
    } catch (error) {
      this.errors.set(project.id, projectRecoveryMessage)
      logFailure(row, error, 'recovery')
      throw recoveryError(error)
    }
  }

  async apply(project, prepared, { authorize, onCommitted } = {}) {
    this.assertWritable(project.id)
    const id = `${Date.now()}-${randomUUID()}`
    const intent = {
      version: 1,
      id,
      projectId: project.id,
      owner: project.owner,
      changes: prepared.map((change) => ({
        path: change.path,
        mode: change.mode,
        before:
          change.before === null
            ? null
            : Buffer.from(change.before).toString('base64'),
        beforeHash: change.beforeHash,
        afterHash: change.after === null ? null : digest(change.after),
      })),
    }
    const row = {
      id,
      project: project.id,
      owner: project.owner,
      payload: JSON.stringify(intent),
    }
    try {
      this.#validate(row, project)
    } catch (cause) {
      throw Object.assign(
        new Error(
          'This file update exceeds the recovery limit. Save fewer files at once.',
          { cause },
        ),
        { status: 413 },
      )
    }
    const directory = this.#directory(intent)
    const projectHistory = path.dirname(directory)
    await fs.mkdir(projectHistory, { recursive: true, mode: 0o700 })
    const history = await openDirectory(projectHistory)
    await history.close()
    await fs.mkdir(directory, { mode: 0o700 })
    try {
      await fs.mkdir(path.join(directory, 'staged'), { mode: 0o700 })
      await fs.mkdir(path.join(directory, 'before'), { mode: 0o700 })
      await durableFile(
        path.join(directory, 'manifest.json'),
        JSON.stringify({
          version: 1,
          projectId: project.id,
          owner: project.owner,
          createdAt: new Date().toISOString(),
          changes: intent.changes.map(({ path, beforeHash, afterHash }) => ({
            path,
            beforeHash,
            afterHash,
          })),
        }),
      )
      for (const [index, change] of prepared.entries())
        if (change.after !== null)
          await durableFile(
            path.join(directory, 'staged', String(index)),
            change.after,
            change.mode,
          )
      for (const target of ['staged', 'before'])
        await syncDirectory(path.join(directory, target))
      await syncDirectory(directory)
      await syncDirectory(projectHistory)
      await syncDirectory(this.historyDir)
      this.db
        .prepare(
          'INSERT INTO pending_project_transactions (id,project,owner,payload) VALUES (?,?,?,?)',
        )
        .run(id, project.id, project.owner, row.payload)
    } catch (error) {
      await removeDisposableTree(directory).catch(() => {
        console.error(
          '[LeanFlow files] Could not remove abandoned update staging.',
        )
      })
      logFailure(row, error, 'staging')
      throw unappliedError(error)
    }
    let mutationStarted = false
    let currentPath
    try {
      for (const change of intent.changes) {
        currentPath = change.path
        const parent = await this.openParent(project.root, change.path)
        try {
          if (
            (await targetState(project, change, parent, { sync: true })) !==
            change.beforeHash
          )
            throw Object.assign(
              new Error(`Cannot apply: ${change.path} changed before saving.`),
              { status: 409 },
            )
        } finally {
          await parent.handle.close()
        }
      }
      for (const [index, change] of intent.changes.entries()) {
        currentPath = change.path
        const parent = await this.openParent(project.root, change.path)
        try {
          authorize?.()
          if (
            (await targetState(project, change, parent)) !== change.beforeHash
          )
            throw Object.assign(
              new Error(`Cannot apply: ${change.path} changed before saving.`),
              { status: 409 },
            )
          const destination = `${parent.anchor}/${parent.name}`
          if (change.before !== null) {
            mutationStarted = true
            await fs.rename(
              destination,
              path.join(directory, 'before', String(index)),
            )
          }
          authorize?.()
          if (change.afterHash !== null) {
            mutationStarted = true
            await fs.rename(
              path.join(directory, 'staged', String(index)),
              destination,
            )
          }
          if ((await targetState(project, change, parent)) !== change.afterHash)
            throw new Error('Transaction target changed during saving.')
        } finally {
          await parent.handle.close()
        }
      }
      await syncDirectory(path.join(directory, 'before'))
      await syncDirectory(path.join(directory, 'staged'))
      await this.#syncParents(project, intent)
      const marker = path.join(directory, `.applied-${randomUUID()}`)
      await durableFile(
        marker,
        JSON.stringify({
          version: 1,
          id,
          projectId: project.id,
          owner: project.owner,
          intentHash: digest(row.payload),
          appliedAt: new Date().toISOString(),
        }),
      )
      await fs.rename(marker, path.join(directory, 'applied.json'))
      await syncDirectory(directory)
      await onCommitted?.(project, intent.changes)
      this.db
        .prepare('DELETE FROM pending_project_transactions WHERE id=?')
        .run(id)
      return directory
    } catch (error) {
      try {
        if (!mutationStarted) {
          this.db
            .prepare('DELETE FROM pending_project_transactions WHERE id=?')
            .run(id)
          await removeDisposableTree(directory).catch((cleanupError) => {
            logFailure(row, cleanupError, 'unused staging cleanup')
          })
        } else if (await this.#recover(row, project, onCommitted))
          return directory
      } catch (cause) {
        this.errors.set(project.id, projectRecoveryMessage)
        logFailure(row, cause, 'rollback', currentPath)
        throw recoveryError(cause)
      }
      logFailure(row, error, 'save rolled back', currentPath)
      throw unappliedError(error)
    }
  }
}
