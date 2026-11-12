import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assertTransactionPaths } from './project-transactions.mjs'
import { MAX_PROJECT_FILES } from '../shared/source-limits.mjs'

const MAX_BYTES = 32 * 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const transactionPattern = /^\d{13}-[a-f0-9-]{36}$/
const hashPattern = /^[a-f0-9]{64}$/
const RECORDS_PER_PAGE = 5
const FILES_PER_PAGE = 100
const STARTUP_CLASSIFICATION_MS = 250
const digest = (value) => createHash('sha256').update(value).digest('hex')
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status })
}
export const legacyRecoveryMessage =
  'An older interrupted file update needs review. A project Admin can review the retained originals and either restore them or keep the current files. Your files and history are preserved.'

export function recoveryReviewDeadline(signal) {
  if (signal.aborted)
    fail(
      'The recovery review took too long. Your files are unchanged. Try again, or ask the server administrator to check recovery storage.',
      408,
    )
}

// Pin every directory and reject links, including links in a parent path.
// Preview never creates missing parent folders or follows a stored alias.
async function readBelow(
  root,
  filename,
  { content = false, limit = MAX_BYTES, signal, validateText = false } = {},
) {
  signal?.throwIfAborted()
  const parts = filename.split('/')
  let directory, file
  try {
    directory = await fs.open(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    let expected = root
    if ((await fs.realpath(`/proc/self/fd/${directory.fd}`)) !== expected)
      fail('Recovery storage changed. Refresh the review and try again.')
    for (const part of parts.slice(0, -1)) {
      signal?.throwIfAborted()
      const next = await fs.open(
        `/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      await directory.close()
      directory = next
      expected = path.join(expected, part)
      if ((await fs.realpath(`/proc/self/fd/${directory.fd}`)) !== expected)
        fail('Recovery storage changed. Refresh the review and try again.')
    }
    const target = `/proc/self/fd/${directory.fd}/${parts.at(-1)}`
    file = await fs.open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const before = await file.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > limit)
      fail('A recovery file is unsafe or exceeds the recovery limit.')
    const hash = createHash('sha256')
    const chunks = []
    const decoder = validateText
      ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      : null
    let text = true
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted()
      bytes += chunk.length
      if (bytes > limit) fail('A recovery file exceeds the recovery limit.')
      hash.update(chunk)
      if (decoder && text) {
        try {
          if (chunk.includes(0)) text = false
          else decoder.decode(chunk, { stream: true })
        } catch {
          text = false
        }
      }
      if (content) chunks.push(chunk)
    }
    if (decoder && text) {
      try {
        decoder.decode()
      } catch {
        text = false
      }
    }
    const after = await file.stat()
    const current = await fs.lstat(target)
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink()
    )
      fail('A recovery file changed. Refresh the review and try again.')
    return {
      hash: hash.digest('hex'),
      size: bytes,
      mode: before.mode & 0o777,
      ...(validateText ? { text } : {}),
      ...(content ? { content: Buffer.concat(chunks) } : {}),
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    if (['ELOOP', 'ENOTDIR'].includes(error.code))
      fail(
        'A recovery path contains a link or unsafe folder. Ask the server administrator to inspect it.',
      )
    throw error
  } finally {
    await file?.close()
    await directory?.close()
  }
}

/** Explicit, version-checked recovery of histories made before durable intents. */
export class LegacyProjectRecovery {
  constructor({
    db,
    historyDir,
    validatePath,
    startupClassificationMs = STARTUP_CLASSIFICATION_MS,
  }) {
    Object.assign(this, { db, historyDir, validatePath })
    this.pending = new Map()
    this.deferred = new Set()
    this.startupClassificationMs = startupClassificationMs
    db.exec(
      'CREATE TABLE IF NOT EXISTS legacy_transaction_resolutions (project TEXT NOT NULL, id TEXT NOT NULL, manifestHash TEXT NOT NULL, decision TEXT NOT NULL, actor TEXT NOT NULL, time TEXT NOT NULL, PRIMARY KEY(project,id));',
    )
  }

  assertWritable(projectId) {
    if (this.pending.get(projectId)?.size) fail(legacyRecoveryMessage, 503)
  }

  #resolved(project, id, hash) {
    return (
      this.db
        .prepare(
          'SELECT manifestHash FROM legacy_transaction_resolutions WHERE project=? AND id=?',
        )
        .get(project.id, id)?.manifestHash === hash
    )
  }

  #remember(project, id, manifestHash, decision, actor) {
    this.db
      .prepare(
        'INSERT INTO legacy_transaction_resolutions(project,id,manifestHash,decision,actor,time) VALUES(?,?,?,?,?,?) ON CONFLICT(project,id) DO UPDATE SET manifestHash=excluded.manifestHash,decision=excluded.decision,actor=excluded.actor,time=excluded.time',
      )
      .run(
        project.id,
        id,
        manifestHash,
        decision,
        actor,
        new Date().toISOString(),
      )
    this.pending.get(project.id)?.delete(id)
    if (!this.pending.get(project.id)?.size) this.pending.delete(project.id)
  }

  async #manifest(project, id, signal) {
    if (!transactionPattern.test(id)) fail('Invalid recovery identifier.', 400)
    const relative = `${project.id}/${id}`
    const raw = await readBelow(this.historyDir, `${relative}/manifest.json`, {
      content: true,
      limit: MAX_MANIFEST_BYTES,
      signal,
    })
    if (!raw) return null // Nothing was mutated before the old manifest existed.
    let manifest
    try {
      manifest = JSON.parse(raw.content.toString('utf8'))
    } catch {
      return {
        hash: raw.hash,
        error:
          'The older recovery record is damaged. Restoring automatically is unavailable; current files can be kept after review.',
        changes: [],
      }
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
      return {
        hash: raw.hash,
        changes: [],
        error:
          'The older recovery record has invalid file metadata. Restoring automatically is unavailable; current files can be kept after review.',
      }
    if (manifest.version !== undefined) return null
    if (manifest.projectId !== project.id || manifest.owner !== project.owner)
      fail('The recovery record does not belong to this project.')
    const marker = await readBelow(
      this.historyDir,
      `${relative}/applied.json`,
      { content: true, limit: 4096, signal },
    )
    if (marker) {
      try {
        const applied = JSON.parse(marker.content.toString('utf8'))
        if (
          typeof applied.appliedAt === 'string' &&
          Number.isFinite(Date.parse(applied.appliedAt))
        )
          return null
      } catch {
        /* An incomplete marker needs the same explicit review. */
      }
    }
    try {
      if (
        !Array.isArray(manifest.changes) ||
        !manifest.changes.length ||
        manifest.changes.length > MAX_PROJECT_FILES
      )
        throw new Error()
      const seen = new Set()
      for (const change of manifest.changes) {
        if (
          !change ||
          this.validatePath(change.path) !== change.path ||
          seen.has(change.path) ||
          ![change.beforeHash, change.afterHash].every(
            (value) =>
              value === null ||
              (typeof value === 'string' && hashPattern.test(value)),
          )
        )
          throw new Error()
        seen.add(change.path)
      }
      assertTransactionPaths(seen)
    } catch {
      return {
        hash: raw.hash,
        error:
          'The older recovery record has invalid file metadata. Restoring automatically is unavailable; current files can be kept after review.',
        changes: [],
      }
    }
    return {
      hash: raw.hash,
      changes: manifest.changes,
      createdAt: manifest.createdAt,
    }
  }

  async #scan(project, signal, { classificationMs } = {}) {
    const known = new Set(this.pending.get(project.id) || [])
    known.delete('unavailable')
    const directory = path.join(this.historyDir, project.id)
    let handle
    try {
      recoveryReviewDeadline(signal)
      handle = await fs.open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== directory)
        fail('Project recovery storage is unsafe.')
      // Stream names rather than allocating an unbounded retained-history list.
      const entries = await fs.opendir(`/proc/self/fd/${handle.fd}`)
      for await (const entry of entries) {
        recoveryReviewDeadline(signal)
        if (!transactionPattern.test(entry.name)) continue
        let manifest
        try {
          manifest = await this.#manifest(project, entry.name, signal)
        } catch {
          recoveryReviewDeadline(signal)
          manifest = { error: true }
        }
        recoveryReviewDeadline(signal)
        if (
          manifest?.hash &&
          this.#resolved(project, entry.name, manifest.hash)
        )
          known.delete(entry.name)
        else if (manifest) {
          known.add(entry.name)
          let unchanged = false
          try {
            const classificationSignal =
              classificationMs === undefined
                ? signal
                : AbortSignal.any([
                    signal,
                    AbortSignal.timeout(classificationMs),
                  ])
            unchanged = await this.#allBefore(
              project,
              manifest,
              classificationSignal,
            )
          } catch {
            recoveryReviewDeadline(signal)
            // Only this unmarked update needs further review. A short source
            // classification budget never makes healthy history unavailable.
          }
          if (unchanged) {
            // A never-started or fully rolled-back old update already has
            // every original file. Record that proof without changing source.
            const latest = await this.#manifest(project, entry.name, signal)
            if (latest?.hash === manifest.hash) {
              this.#remember(
                project,
                entry.name,
                manifest.hash,
                'unchanged',
                'system',
              )
              known.delete(entry.name)
            }
          }
        }
        // Never dismiss a known interrupted update just because its manifest
        // disappeared. Only an explicit, hash-bound resolution may dismiss it.
      }
      this.deferred.delete(project.id)
    } catch (error) {
      if (signal.aborted) {
        this.deferred.add(project.id)
        console.warn('[LeanFlow files] Older history scan deferred.', {
          project: project.id,
        })
      } else if (error.code !== 'ENOENT' || handle) known.add('unavailable')
      else this.deferred.delete(project.id)
    } finally {
      await handle?.close().catch(() => known.add('unavailable'))
      if (known.size) this.pending.set(project.id, known)
      else this.pending.delete(project.id)
    }
    recoveryReviewDeadline(signal)
  }

  async init(projects, { signal = AbortSignal.timeout(30000) } = {}) {
    for (const project of projects) {
      if (signal.aborted) {
        this.deferred.add(project.id)
        continue
      }
      try {
        await this.#scan(project, signal, {
          classificationMs: this.startupClassificationMs,
        })
      } catch {
        // One unavailable history never prevents other projects from starting.
      }
    }
  }

  async #allBefore(project, manifest, signal) {
    if (manifest.error) return false
    let bytes = 0
    for (const change of manifest.changes) {
      recoveryReviewDeadline(signal)
      let current
      try {
        current = await readBelow(project.root, change.path, { signal })
      } catch {
        recoveryReviewDeadline(signal)
        return false
      }
      bytes += current?.size || 0
      if (bytes > MAX_BYTES || (current?.hash ?? null) !== change.beforeHash)
        return false
    }
    recoveryReviewDeadline(signal)
    return true
  }

  async refreshUnavailable(project, { signal }) {
    if (
      this.pending.get(project.id)?.has('unavailable') ||
      this.deferred.has(project.id)
    )
      await this.#scan(project, signal)
  }

  async review(
    project,
    id,
    { includeOriginals = false, signal = AbortSignal.timeout(30000) } = {},
  ) {
    if (!this.pending.get(project.id)?.has(id))
      fail('Recovery record not found.', 404)
    const manifest = await this.#manifest(project, id, signal)
    if (!manifest)
      fail('The recovery record changed. Refresh the project.', 409)
    const files = [],
      prepared = []
    let total = 0,
      currentBytes = 0,
      canRestore = !manifest.error,
      unchanged = !manifest.error
    for (const [index, change] of manifest.changes.entries()) {
      signal.throwIfAborted()
      const current = await readBelow(project.root, change.path, {
        content: includeOriginals,
        signal,
        validateText: true,
      })
      const original =
        change.beforeHash === null
          ? null
          : await readBelow(
              this.historyDir,
              `${project.id}/${id}/before/${index}`,
              { content: includeOriginals, signal, validateText: true },
            )
      const alreadyOriginal = (current?.hash ?? null) === change.beforeHash
      unchanged &&= alreadyOriginal
      const expected = [null, change.beforeHash, change.afterHash].includes(
        current?.hash ?? null,
      )
      const available =
        alreadyOriginal ||
        change.beforeHash === null ||
        original?.hash === change.beforeHash
      total += original?.size || 0
      currentBytes += current?.size || 0
      if (total > MAX_BYTES || currentBytes > MAX_BYTES)
        fail(
          'These recovery files exceed the 32 MiB limit. Ask the server administrator to recover them separately.',
          413,
        )
      canRestore &&=
        expected &&
        available &&
        (alreadyOriginal ||
          ((current?.text ?? true) && (original?.text ?? true)))
      files.push({
        path: change.path,
        currentHash: current?.hash ?? null,
        originalHash: change.beforeHash,
        savedHash: change.afterHash,
        originalAvailable: available,
        originalDownloadAvailable: original?.hash === change.beforeHash,
        originalMode: original?.mode ?? null,
        changedAfterUpdate: !expected,
        alreadyOriginal,
        mode: current?.mode ?? null,
      })
      if (includeOriginals && !alreadyOriginal && expected && available) {
        if (change.beforeHash !== null && original?.content.includes(0))
          canRestore = false
        let after = null,
          before = null
        if (current) {
          try {
            before = new TextDecoder('utf-8', {
              fatal: true,
              ignoreBOM: true,
            }).decode(current.content)
          } catch {
            canRestore = false
          }
          if (current.content.includes(0)) canRestore = false
        }
        if (change.beforeHash !== null) {
          try {
            after = new TextDecoder('utf-8', {
              fatal: true,
              ignoreBOM: true,
            }).decode(original.content)
          } catch {
            canRestore = false
          }
        }
        prepared.push({
          path: change.path,
          before,
          beforeHash: current?.hash ?? null,
          beforeMode: current?.mode ?? null,
          after,
          mode: original?.mode ?? current?.mode ?? 0o600,
        })
      }
    }
    const revision = digest(
      JSON.stringify({ id, manifestHash: manifest.hash, files }),
    )
    return {
      id,
      revision,
      manifestHash: manifest.hash,
      createdAt: manifest.createdAt,
      files,
      canRestore,
      unchanged,
      error: manifest.error || null,
      ...(includeOriginals ? { prepared } : {}),
    }
  }

  async list(
    project,
    {
      cursor,
      recordId,
      fileOffset = 0,
      signal = AbortSignal.timeout(30000),
    } = {},
  ) {
    if (
      cursor !== undefined &&
      (typeof cursor !== 'string' ||
        (cursor !== 'unavailable' && !transactionPattern.test(cursor)))
    )
      fail('Choose a valid recovery page.', 400)
    if (
      recordId !== undefined &&
      (typeof recordId !== 'string' ||
        (recordId !== 'unavailable' && !transactionPattern.test(recordId)))
    )
      fail('Choose a valid recovery record.', 400)
    if (
      !Number.isSafeInteger(fileOffset) ||
      fileOffset < 0 ||
      fileOffset > MAX_PROJECT_FILES ||
      (fileOffset && !recordId) ||
      (cursor && recordId)
    )
      fail('Choose a valid recovery file page.', 400)
    recoveryReviewDeadline(signal)
    const all = [...(this.pending.get(project.id) || [])].sort()
    if (recordId && !all.includes(recordId))
      fail('Recovery record not found.', 404)
    const selected = recordId
      ? [recordId]
      : all.filter((id) => !cursor || id > cursor).slice(0, RECORDS_PER_PAGE)
    const results = []
    for (const id of selected) {
      recoveryReviewDeadline(signal)
      try {
        const review = await this.review(project, id, { signal })
        recoveryReviewDeadline(signal)
        if (!this.pending.get(project.id)?.has(id)) continue
        if (fileOffset > review.files.length)
          fail('This file page changed. Refresh the recovery review.', 409)
        const { files, manifestHash: _hash, ...metadata } = review
        results.push({
          ...metadata,
          files: files.slice(fileOffset, fileOffset + FILES_PER_PAGE),
          fileCount: files.length,
          fileOffset,
          nextFileOffset:
            fileOffset + FILES_PER_PAGE < files.length
              ? fileOffset + FILES_PER_PAGE
              : null,
        })
      } catch (error) {
        recoveryReviewDeadline(signal)
        if (!this.pending.get(project.id)?.has(id)) continue
        results.push({
          id,
          revision: null,
          files: [],
          canRestore: false,
          fileCount: 0,
          fileOffset: 0,
          nextFileOffset: null,
          error:
            error.status === 404
              ? 'Recovery record is unavailable.'
              : 'Recovery storage could not be checked. Ask the server administrator to check its files and permissions.',
        })
      }
    }
    recoveryReviewDeadline(signal)
    const last = selected.at(-1)
    const remaining = [...(this.pending.get(project.id) || [])]
    return {
      reviews: results,
      totalRecords: remaining.length,
      scanDeferred: this.deferred.has(project.id),
      nextCursor:
        !recordId && last && remaining.some((id) => id > last) ? last : null,
    }
  }

  async resolve(
    project,
    actor,
    id,
    { revision, decision },
    apply,
    authorize = () => {},
  ) {
    authorize()
    if (
      !['restore', 'keep-current'].includes(decision) ||
      typeof revision !== 'string' ||
      !hashPattern.test(revision)
    )
      fail('Refresh the recovery review and choose a recovery action.', 400)
    const review = await this.review(project, id, {
      includeOriginals: decision === 'restore',
    })
    if (review.revision !== revision)
      fail(
        'Project or recovery files changed after this review. Refresh and review the current files before continuing.',
      )
    if (decision === 'restore') {
      if (!review.canRestore)
        fail(
          'Some files changed or their originals are unavailable. Download the retained files and keep the current project, or restore individual files after reviewing them.',
        )
      authorize()
      await apply(review.prepared)
    } else {
      await apply([], review)
    }
    const manifest = await this.#manifest(project, id)
    if (!manifest || manifest.hash !== review.manifestHash)
      fail(
        'The recovery record changed during recovery. Refresh and review it again.',
      )
    authorize()
    this.#remember(project, id, manifest.hash, decision, actor)
    return review.files.map((file) => file.path)
  }

  async original(project, id, filename) {
    const signal = AbortSignal.timeout(30000)
    const manifest = await this.#manifest(project, id, signal)
    if (!manifest || !this.pending.get(project.id)?.has(id))
      fail('Recovery record not found.', 404)
    const index = manifest.changes.findIndex(
      (change) => change.path === filename,
    )
    if (index < 0 || manifest.changes[index].beforeHash === null)
      fail('Original file not found.', 404)
    const original = await readBelow(
      this.historyDir,
      `${project.id}/${id}/before/${index}`,
      { content: true, signal },
    )
    if (!original || original.hash !== manifest.changes[index].beforeHash)
      fail('This original file is unavailable or failed its integrity check.')
    return original.content
  }
}
