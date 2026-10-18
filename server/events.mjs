import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { proofTargetReference } from './proof-target.mjs'
import {
  setupFailureMessage,
  dependencyFailureMessage,
} from './pinned-lake.mjs'
import {
  recordReasoningBlock,
  reasoningBlocksFromEvents,
} from '../shared/reasoning-timeline.mjs'

export const TERMINAL = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'applied',
])
const changeFields = ['changes', 'liveChanges']

export class EventStore extends EventEmitter {
  constructor(dataDir) {
    super()
    this.reasoningCache = new Map()
    this.setMaxListeners(100)
    this.db = new DatabaseSync(path.join(dataDir, 'activity.sqlite'))
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (job TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(job,seq)); CREATE TABLE IF NOT EXISTS job_changes (job TEXT NOT NULL, field TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(job,field));',
    )
    for (const row of this.db
      .prepare('SELECT id,payload FROM jobs')
      .iterate()) {
      const job = JSON.parse(row.payload)
      // Migrate older inline rows once, without retaining all jobs in memory.
      if (changeFields.some((field) => Object.hasOwn(job, field)))
        this.#transaction(() => this.#storeJob(row.id, job))
      if (!TERMINAL.has(job.status))
        this.updateMetadata(job.id, {
          status: 'interrupted',
          error:
            'The server restarted during this job. Start a new run to continue.',
        })
    }
  }
  create(owner, fields) {
    const job = {
      ...fields,
      id: randomUUID(),
      owner,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      log: '',
      message: '',
      changes: [],
    }
    this.#transaction(() => this.#storeJob(job.id, job, true))
    this.event(job.id, 'status', { status: job.status })
    return job
  }
  #readMetadata(id, owner) {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id)
    if (!row) throw Object.assign(new Error('Job not found.'), { status: 404 })
    const job = JSON.parse(row.payload)
    if (owner !== undefined && job.owner !== owner)
      throw Object.assign(new Error('Job not found.'), { status: 404 })
    return job
  }
  #metadata(job) {
    const { changePaths, ...metadata } = job
    for (const field of changeFields)
      if (Object.hasOwn(changePaths || {}, field))
        metadata[field] = changePaths[field]
    return metadata
  }
  getMetadata(id, owner) {
    return this.#metadata(this.#readMetadata(id, owner))
  }
  #hydrate(job) {
    const rows = this.db
      .prepare('SELECT field,payload FROM job_changes WHERE job=?')
      .all(job.id)
    for (const row of rows) job[row.field] = JSON.parse(row.payload)
    return job
  }
  get(id, owner) {
    // Check ownership before reading the larger change history.
    return this.#hydrate(this.getMetadata(id, owner))
  }
  #transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  #storeJob(id, job, insert = false) {
    const metadata = { ...job }
    const changePaths = { ...metadata.changePaths }
    const changes = []
    for (const field of changeFields) {
      if (!Object.hasOwn(metadata, field)) continue
      const value = metadata[field]
      changes.push([field, JSON.stringify(metadata[field])])
      delete metadata[field]
      if (value === undefined) delete changePaths[field]
      else
        changePaths[field] = Array.isArray(value)
          ? value.map((change) => ({ path: change.path }))
          : null
    }
    if (Object.keys(changePaths).length) metadata.changePaths = changePaths
    else delete metadata.changePaths
    if (insert)
      this.db
        .prepare('INSERT INTO jobs VALUES(?,?,?)')
        .run(id, job.owner, JSON.stringify(metadata))
    else
      this.db
        .prepare('UPDATE jobs SET payload=? WHERE id=?')
        .run(JSON.stringify(metadata), id)
    // Change text and metadata commit together. Ordinary progress updates never
    // read or rewrite these rows; full reads retain the existing API contract.
    for (const [field, payload] of changes) {
      if (payload === undefined)
        this.db
          .prepare('DELETE FROM job_changes WHERE job=? AND field=?')
          .run(id, field)
      else
        this.db
          .prepare(
            'INSERT INTO job_changes VALUES(?,?,?) ON CONFLICT(job,field) DO UPDATE SET payload=excluded.payload',
          )
          .run(id, field, payload)
    }
    return this.#metadata(metadata)
  }
  snapshot(id, owner) {
    return this.#snapshot(this.get(id, owner))
  }
  snapshotMetadata(id, owner) {
    return this.#snapshot(this.getMetadata(id, owner))
  }
  #snapshot(job) {
    // Both reads are synchronous: no event producer can run between reading the
    // accumulated fields and the replay cursor in this server process.
    const eventCursor = this.cursor(job.id)
    return {
      ...job,
      reasoningBlocks: this.reasoningBlocks(job),
      reasoningHistoryAvailable: true,
      eventCursor,
    }
  }
  reasoningBlocks(job) {
    if (
      Array.isArray(job.reasoningBlocks) &&
      (job.reasoningHistoryAvailable ||
        (!job.reasoningBaseOffset && !job.reasoningSummaryBaseOffset))
    )
      return job.reasoningBlocks
    if (!job.reasoning && !job.reasoningSummary) return []
    const cursor = this.cursor(job.id)
    const cached = this.reasoningCache.get(job.id)
    if (cached?.cursor === cursor) return cached.blocks
    const rows = this.db
      .prepare(
        "SELECT payload FROM events WHERE job=? AND json_extract(payload,'$.type') IN ('message','reasoning','reasoning-summary','followup') ORDER BY seq",
      )
      .iterate(job.id)
    const blocks = reasoningBlocksFromEvents(
      (function* () {
        for (const row of rows) yield JSON.parse(row.payload)
      })(),
    )
    if (this.reasoningCache.size >= 128)
      this.reasoningCache.delete(this.reasoningCache.keys().next().value)
    this.reasoningCache.set(job.id, { cursor, blocks })
    return blocks
  }
  reasoningPage(id, owner, blockId, offset = 0) {
    const job = this.getMetadata(id, owner)
    const blocks = this.reasoningBlocks(job)
    const index = blocks.findIndex((block) => block.id === blockId)
    if (index < 0)
      throw Object.assign(new Error('Reasoning step not found.'), {
        status: 404,
      })
    const block = blocks[index]
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > Math.max(block.reasoningLength, block.summaryLength)
    )
      throw Object.assign(new Error('Invalid reasoning position.'), {
        status: 400,
      })
    const limit = 250_000
    const result = { reasoning: '', reasoningSummary: '', nextOffset: null }
    const lengths = { reasoning: 0, reasoningSummary: 0 }
    const start = Number(block.id.slice('reasoning-'.length))
    const end = blocks[index + 1]
      ? Number(blocks[index + 1].id.slice('reasoning-'.length))
      : this.cursor(id) + 1
    for (const row of this.db
      .prepare(
        "SELECT payload FROM events WHERE job=? AND seq>=? AND seq<? AND json_extract(payload,'$.type') IN ('reasoning','reasoning-summary') ORDER BY seq",
      )
      .iterate(id, start, end)) {
      const event = JSON.parse(row.payload)
      const field =
        event.type === 'reasoning' ? 'reasoning' : 'reasoningSummary'
      const text = typeof event.data?.text === 'string' ? event.data.text : ''
      const position = lengths[field]
      lengths[field] += text.length
      result[field] += text.slice(
        Math.max(0, offset - position),
        Math.max(0, offset + limit - position),
      )
      if (
        lengths.reasoning >= Math.min(block.reasoningLength, offset + limit) &&
        lengths.reasoningSummary >=
          Math.min(block.summaryLength, offset + limit)
      )
        break
    }
    if (Math.max(block.reasoningLength, block.summaryLength) > offset + limit)
      result.nextOffset = offset + limit
    return result
  }
  cursor(id) {
    return Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0) AS cursor FROM events WHERE job=?',
        )
        .get(id).cursor,
    )
  }
  listMetadata(owner, projectId, kind = 'agent') {
    return this.db
      .prepare(
        "SELECT payload FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND json_extract(payload,'$.kind')=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(owner, projectId, kind)
      .map((row) => this.#metadata(JSON.parse(row.payload)))
  }
  list(owner, projectId, kind = 'agent') {
    return this.listMetadata(owner, projectId, kind).map((job) =>
      this.#hydrate(job),
    )
  }
  projectMetadata(owner, projectId) {
    return this.db
      .prepare(
        "SELECT payload FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? ORDER BY rowid ASC",
      )
      .all(owner, projectId)
      .map((row) => this.#metadata(JSON.parse(row.payload)))
  }
  activeMetadata(owner, projectId, kind) {
    const terminal = [...TERMINAL]
    return this.db
      .prepare(
        `SELECT payload FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND json_extract(payload,'$.status') NOT IN (${terminal.map(() => '?').join(',')}) ${kind ? "AND json_extract(payload,'$.kind')=?" : ''}`,
      )
      .all(owner, projectId, ...terminal, ...(kind ? [kind] : []))
      .map((row) => this.#metadata(JSON.parse(row.payload)))
  }
  deleteRuns(owner, ids) {
    const jobs = [...new Set(ids)].map((id) => this.getMetadata(id, owner))
    if (jobs.some((job) => !TERMINAL.has(job.status)))
      throw Object.assign(
        new Error('Stop active runs before permanently deleting this content.'),
        { status: 409 },
      )
    this.#transaction(() => {
      for (const job of jobs) {
        this.db.prepare('DELETE FROM events WHERE job=?').run(job.id)
        this.db.prepare('DELETE FROM job_changes WHERE job=?').run(job.id)
        this.db
          .prepare('DELETE FROM jobs WHERE id=? AND owner=?')
          .run(job.id, owner)
      }
    })
    for (const job of jobs) this.reasoningCache.delete(job.id)
  }
  deleteProject(owner, projectId) {
    const ids = this.db
      .prepare(
        "SELECT id FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=?",
      )
      .all(owner, projectId)
      .map((row) => row.id)
    this.deleteRuns(owner, ids)
  }
  summaries(owner, projectId, kind = 'agent') {
    const fields = [
      'projectId',
      'chatId',
      'status',
      'mode',
      'model',
      'effort',
      'createdAt',
      'updatedAt',
      'liveRevision',
      'liveEdits',
      'liveUndone',
    ]
    const columns = fields
      .map((field) => `json_extract(payload,'$.${field}') AS ${field}`)
      .join(',')
    return this.db
      .prepare(
        `SELECT id,${columns},json_extract(payload,'$.progress') AS progress,
          CASE WHEN json_type(payload,'$.proofTarget')='object' THEN json_object(
            'path',json_extract(payload,'$.proofTarget.path'),
            'startLine',json_extract(payload,'$.proofTarget.startLine'),
            'endLine',json_extract(payload,'$.proofTarget.endLine'),
            'name',json_extract(payload,'$.proofTarget.name')) END AS proofTarget,
          COALESCE((SELECT MAX(seq) FROM events WHERE events.job=jobs.id),0) AS eventCursor FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND json_extract(payload,'$.kind')=? ORDER BY rowid DESC LIMIT 100`,
      )
      .all(owner, projectId, kind)
      .map((row) => ({
        ...row,
        eventCursor: Number(row.eventCursor),
        progress: row.progress ? JSON.parse(row.progress) : null,
        proofTarget: row.proofTarget
          ? proofTargetReference(JSON.parse(row.proofTarget))
          : undefined,
        liveRevision: row.liveRevision === null ? undefined : row.liveRevision,
        liveEdits: row.liveEdits === null ? undefined : !!row.liveEdits,
        liveUndone: row.liveUndone === null ? undefined : !!row.liveUndone,
      }))
  }
  updateMetadata(id, fields) {
    const job = this.#transaction(() =>
      this.#storeJob(id, {
        ...this.#readMetadata(id),
        ...fields,
        updatedAt: new Date().toISOString(),
      }),
    )
    if (fields.status) this.event(id, 'status', { status: fields.status })
    return job
  }
  update(id, fields) {
    this.updateMetadata(id, fields)
    return this.get(id)
  }
  event(id, type, data) {
    const seq = Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(seq),0)+1 AS next FROM events WHERE job=?',
        )
        .get(id).next,
    )
    const event = { seq, type, data, at: new Date().toISOString() }
    this.db
      .prepare('INSERT INTO events VALUES(?,?,?)')
      .run(id, seq, JSON.stringify(event))
    this.emit(id, event)
    return event
  }
  events(id, after = 0) {
    return this.db
      .prepare('SELECT payload FROM events WHERE job=? AND seq>? ORDER BY seq')
      .all(id, after)
      .map((row) => JSON.parse(row.payload))
  }
  eventPage(id, after = 0) {
    return this.db
      .prepare(
        'SELECT payload FROM events WHERE job=? AND seq>? ORDER BY seq LIMIT 100',
      )
      .all(id, after)
      .map((row) => JSON.parse(row.payload))
  }
  append(id, field, text, type) {
    const job = this.getMetadata(id)
    const combined = (job[field] || '') + text,
      trimmed = Math.max(0, combined.length - 250_000)
    const baseOffset = (job[field + 'BaseOffset'] || 0) + trimmed
    const truncated = !!job[field + 'Truncated'] || trimmed > 0
    const tracksOutput = ['message', 'reasoning', 'reasoningSummary'].includes(
      field,
    )
    const blocks = tracksOutput
      ? recordReasoningBlock(
          this.reasoningBlocks(job),
          field,
          text.length,
          {
            message: (job.messageBaseOffset || 0) + (job.message?.length || 0),
            followups: job.followups?.length || 0,
            reasoning:
              (job.reasoningBaseOffset || 0) + (job.reasoning?.length || 0),
            reasoningSummary:
              (job.reasoningSummaryBaseOffset || 0) +
              (job.reasoningSummary?.length || 0),
          },
          `reasoning-${this.cursor(id) + 1}`,
        )
      : []
    this.updateMetadata(id, {
      [field]: combined.slice(-250_000),
      [field + 'BaseOffset']: baseOffset,
      ...(truncated ? { [field + 'Truncated']: true } : {}),
      ...(tracksOutput
        ? {
            reasoningBlocks: blocks,
            reasoningHistoryAvailable: true,
          }
        : {}),
    })
    this.event(id, type, {
      text,
      ...(truncated ? { baseOffset, truncated: true } : {}),
    })
  }
  close() {
    this.db.close()
  }
}

export class JobManager {
  constructor({ events, runtime, workspaces, checkTimeoutMs = 1800000 }) {
    Object.assign(this, { events, runtime, workspaces })
    this.checkTimeoutMs = checkTimeoutMs
    this.active = new Map()
    this.controllers = new Map()
    this.stopping = false
  }
  check(owner, projectId, file) {
    if (this.stopping)
      throw Object.assign(
        new Error(
          'The server is shutting down. Reopen the project after it restarts.',
        ),
        { status: 503 },
      )
    const project = this.workspaces.get(projectId, owner)
    if (project.status !== 'ready' || project.needsPreparation)
      throw Object.assign(
        new Error('Prepare this project before checking it.'),
        { status: 409 },
      )
    const job = this.events.create(owner, { kind: 'check', projectId, file })
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    const task = Promise.resolve()
      .then(async () => {
        try {
          controller.signal.throwIfAborted()
          if (file) await this.workspaces.readFile(projectId, owner, file)
          controller.signal.throwIfAborted()
          this.events.updateMetadata(job.id, { status: 'running' })
          const fingerprint = await this.workspaces.checkFingerprint?.(
            projectId,
            owner,
            { signal: controller.signal },
          )
          const kernelCheck =
            project.kind !== 'single-file' &&
            !!(await this.runtime.leanCheckSupported?.(project.root, {
              signal: controller.signal,
            }))
          controller.signal.throwIfAborted()
          const checkMethod = kernelCheck ? 'lake-check' : 'lake-build'
          this.events.updateMetadata(job.id, { checkMethod })
          this.events.append(
            job.id,
            'log',
            kernelCheck
              ? 'Building the default targets and independently checking every project declaration and its full dependency chain with the pinned Lean kernel. Unused declarations from imported libraries are outside this check.\n'
              : project.kind === 'single-file'
                ? 'Checking this file with the pinned Lean compiler.\n'
                : 'This pinned Lean release does not provide lake check. Using the existing project build check.\n',
            'activity',
          )
          const options = {
            network: 'none',
            timeoutMs: this.checkTimeoutMs,
            signal: controller.signal,
            readOnlyWorkspace: true,
            writeLakeCache: true,
            onOutput: (text) =>
              this.events.append(job.id, 'log', text, 'activity'),
          }
          let result = kernelCheck
            ? await this.runtime.checkProject(project.root, {
                ...options,
                kernelCheck: true,
                freshHome: true,
                cleanHome: true,
              })
            : await this.runtime.run(project.root, ['lake', 'build'], options)
          controller.signal.throwIfAborted()
          if (file && file.endsWith('.lean') && result.code === 0) {
            const checked = await this.runtime.run(
              project.root,
              ['lake', 'env', 'lean', '--json', '-Dwarn.sorry=true', file],
              options,
            )
            controller.signal.throwIfAborted()
            result = {
              ...checked,
              stdout: result.stdout + checked.stdout,
              stderr: result.stderr + checked.stderr,
            }
          }
          if (
            fingerprint !== undefined &&
            fingerprint !==
              (await this.workspaces.checkFingerprint(projectId, owner, {
                signal: controller.signal,
              }))
          ) {
            result = { ...result, code: 1, sourceChanged: true }
          }
          this.events.updateMetadata(job.id, {
            status: result.code === 0 ? 'completed' : 'failed',
            result,
            error:
              result.code === 0
                ? undefined
                : result.sourceChanged
                  ? 'Project files changed during this check. Run the check again to check the current files.'
                  : result.timedOut
                    ? 'Lean checking reached its time limit. Inspect the last module in the build output, then retry or ask the administrator to review the check limits.'
                    : kernelCheck && result.code === 153
                      ? 'The full Lean export exceeded its file size limit. Use more focused imports or ask the administrator to review the kernel export limit.'
                      : kernelCheck && result.code === 137
                        ? 'The full Lean checker was stopped, possibly by its memory limit. Use more focused imports or ask the administrator to review the worker limits.'
                        : setupFailureMessage(result) ||
                          (kernelCheck
                            ? 'The independent Lean project check did not pass. Inspect the check output; a kernel or sandbox failure is not replaced by a build-only result.'
                            : 'Lean build failed. See the build output.'),
          })
          const dependency = dependencyFailureMessage(result)
          if (dependency)
            this.workspaces.markDependencyPreparation?.(
              projectId,
              owner,
              dependency,
            )
        } catch (error) {
          const cancelled = controller.signal.aborted && !error.workerCleanup
          this.events.updateMetadata(job.id, {
            status: cancelled ? 'cancelled' : 'failed',
            error: cancelled ? undefined : error.message,
          })
          if (error.workerCleanup) throw error
        }
      })
      .finally(() => {
        this.active.delete(job.id)
        this.controllers.delete(job.id)
      })
    this.active.set(job.id, task)
    task.catch(() => {}) // shutdown() retains and observes the original promise.
    return job
  }
  async stop(owner, id) {
    const job = this.events.getMetadata(id, owner)
    if (job.kind !== 'check')
      throw Object.assign(new Error('This job is not a Lean check.'), {
        status: 400,
      })
    if (TERMINAL.has(job.status)) {
      await this.active.get(id)
      return
    }
    const controller = this.controllers.get(id)
    if (!controller)
      throw Object.assign(new Error('This Lean check is no longer running.'), {
        status: 409,
      })
    this.events.updateMetadata(id, { status: 'stopping' })
    controller.abort(new Error('Lean check stopped.'))
    await this.active.get(id)
  }
  async stopProject(owner, projectId) {
    this.workspaces.get(projectId, owner)
    const ids = new Set(
      this.events
        .activeMetadata(owner, projectId, 'check')
        .map((job) => job.id),
    )
    for (const id of this.active.keys()) {
      const job = this.events.getMetadata(id)
      if (job.owner === owner && job.projectId === projectId) ids.add(id)
    }
    const results = await Promise.allSettled(
      [...ids].map((id) => this.stop(owner, id)),
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }
  shutdown() {
    this.stopping = true
    this.shutdownPromise ||= Promise.allSettled([...this.active.values()]).then(
      () => {},
    )
    return this.shutdownPromise
  }
}
