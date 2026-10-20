import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { TERMINAL } from './events.mjs'
import { validatePdfBytes } from './pdf-preview.mjs'
import { MAX_PDF_FILE_BYTES } from '../shared/file-previews.mjs'
import { isTexFile, safeTexPath, TEX_ENGINES } from '../shared/tex.mjs'

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const unavailable =
  'LaTeX compilation is unavailable. Ask the administrator to build and configure the TeX worker image.'

async function artifact(directory, filename, byteLimit, missing = false) {
  const absolute = path.join(directory, filename)
  let handle
  try {
    if ((await fs.realpath(directory)) !== directory)
      fail('TeX artifacts are not accessible.', 403)
    handle = await fs.open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== absolute)
      fail('TeX artifact changed during access.', 409)
    const stat = await handle.stat()
    if (!stat.isFile()) fail('TeX output is not a regular file.', 409)
    if (stat.size > byteLimit)
      fail(
        'TeX output exceeds its size limit. Reduce the document and compile again.',
        413,
      )
    const chunks = []
    let size = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, byteLimit + 1 - size))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > byteLimit) fail('TeX output exceeds its size limit.', 413)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (missing) return null
      fail('This build has no PDF output. Compile the document again.', 404)
    }
    if (error.code === 'ELOOP')
      fail('TeX artifacts cannot be symbolic links.', 403)
    throw error
  } finally {
    await handle?.close()
  }
}

function diagnosticsFrom(result, files) {
  if (!Array.isArray(result?.diagnostics)) return []
  const known = new Set(files.map((file) => file.path))
  return result.diagnostics.slice(0, 200).flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.message !== 'string'
    )
      return []
    const candidate = (
      typeof entry.path === 'string'
        ? entry.path
        : typeof entry.file === 'string'
          ? entry.file
          : ''
    )
      .replace(/^\/(?:project|workspace|source)\//, '')
      .replace(/^\.\//, '')
    return [
      {
        severity: entry.severity === 'warning' ? 'warning' : 'error',
        message: entry.message.slice(0, 4000),
        ...(known.has(candidate) ? { path: candidate } : {}),
        ...(Number.isSafeInteger(entry.line) && entry.line > 0
          ? { line: entry.line }
          : {}),
      },
    ]
  })
}

export class TexBuildManager {
  constructor({
    dataDir,
    events,
    runtime,
    workspaces,
    timeoutMs = 120000,
    retainedBuilds = 10,
    assertCanStart = () => {},
  }) {
    Object.assign(this, {
      events,
      runtime,
      workspaces,
      timeoutMs,
      retainedBuilds,
      assertCanStart,
    })
    this.directory = path.join(path.resolve(dataDir), 'tex-builds')
    this.active = new Map()
    this.controllers = new Map()
    this.projectBuilds = new Map()
    this.stopping = false
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    if ((await fs.realpath(this.directory)) !== this.directory)
      fail('TeX storage is not safe.', 403)
    const projects = new Map()
    const jobs = this.events.db
      .prepare(
        "SELECT payload FROM jobs WHERE json_extract(payload,'$.kind')='tex'",
      )
      .all()
      .map((row) => JSON.parse(row.payload))
    for (const job of jobs) {
      const directory = this.#directory(job.id)
      let stat
      try {
        stat = await fs.lstat(directory)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (
        stat &&
        (!stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (await fs.realpath(directory)) !== directory)
      )
        fail('TeX build storage is not safe.', 403)
      if (job.cleanupFailed) {
        if (!this.runtime.stopProject)
          fail('A TeX worker still needs cleanup before startup.', 503)
        await this.runtime.stopProject(path.join(directory, 'source'))
        this.events.updateMetadata(job.id, { cleanupFailed: false })
      }
      await fs.rm(path.join(directory, 'source'), {
        recursive: true,
        force: true,
      })
      if (job.status !== 'completed')
        await fs.rm(path.join(directory, 'output'), {
          recursive: true,
          force: true,
        })
      projects.set(this.#key(job.owner, job.projectId), [
        job.owner,
        job.projectId,
      ])
    }
    for (const [owner, projectId] of projects.values())
      await this.#prune(owner, projectId)
    return this
  }

  async availability() {
    if (!this.runtime.runTex || !this.runtime.texInfo)
      return { available: false, error: unavailable, engines: [...TEX_ENGINES] }
    const info = await this.runtime.texInfo()
    return {
      available: info.available === true,
      engines: [...TEX_ENGINES],
      ...(info.error || !info.available
        ? { error: info.error || unavailable }
        : {}),
    }
  }

  #key(owner, projectId) {
    return JSON.stringify([owner, projectId])
  }
  #directory(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
      fail('TeX build not found.', 404)
    return path.join(this.directory, id)
  }
  #job(owner, id, { requireProject = true } = {}) {
    let job
    try {
      job = this.events.getMetadata(id, owner)
    } catch (error) {
      if (error.status === 404)
        fail(
          'This TeX build is unavailable or its history expired. Compile the document again.',
          404,
        )
      throw error
    }
    if (job.kind !== 'tex') fail('TeX build not found.', 404)
    if (requireProject) this.workspaces.get(job.projectId, owner)
    return job
  }
  #public(job) {
    return {
      id: job.id,
      projectId: job.projectId,
      rootFile: job.rootFile,
      engine: job.engine,
      status: job.status,
      sourceRevision: job.sourceRevision || null,
      workspaceRevision: job.workspaceRevision || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      diagnostics: job.diagnostics || [],
      textAvailable:
        !!job.textRevision &&
        job.textAvailable !== false &&
        !job.artifactsRemoved,
      textTruncated: job.textTruncated === true,
      ...(Number.isSafeInteger(job.pageCount) && job.pageCount >= 0
        ? { pageCount: job.pageCount }
        : {}),
      log: (job.log || '').slice(-64000),
      origin: job.originRunId ? 'agent' : 'user',
      cleanupFailed: job.cleanupFailed === true,
      ...(job.error ? { error: job.error } : {}),
      ...(job.pdfRevision && !job.artifactsRemoved
        ? {
            pdf: {
              url: `/api/projects/${encodeURIComponent(job.projectId)}/tex/builds/${job.id}/pdf`,
              revision: job.pdfRevision,
              filename:
                path.posix.basename(
                  job.rootFile,
                  path.posix.extname(job.rootFile),
                ) + '.pdf',
            },
          }
        : {}),
    }
  }
  get(owner, id) {
    return this.#public(this.#job(owner, id))
  }
  async state(owner, projectId, { rootFile } = {}) {
    this.workspaces.get(projectId, owner)
    if (rootFile !== undefined && !isTexFile(safeTexPath(rootFile)))
      fail('Choose a .tex root document.')
    const info = await this.availability()
    const latest = (successful = false, selectedRoot) => {
      const row = this.events.db
        .prepare(
          `SELECT id FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND json_extract(payload,'$.kind')='tex' AND json_extract(payload,'$.originRunId') IS NULL ${selectedRoot ? "AND json_extract(payload,'$.rootFile')=?" : ''} ${successful ? "AND json_extract(payload,'$.status')='completed' AND json_extract(payload,'$.pdfRevision') IS NOT NULL" : ''} ORDER BY rowid DESC LIMIT 1`,
        )
        .get(owner, projectId, ...(selectedRoot ? [selectedRoot] : []))
      return row ? this.#public(this.events.getMetadata(row.id, owner)) : null
    }
    const selectedRoot = rootFile ?? latest()?.rootFile ?? 'main.tex'
    const activeRow = this.#rows(owner, projectId).find(
      (job) => !TERMINAL.has(job.status) || job.cleanupFailed,
    )
    const activeBuild = activeRow
      ? this.#public(this.events.getMetadata(activeRow.id, owner))
      : null
    const build = latest(false, selectedRoot)
    const lastSuccessful = latest(true, selectedRoot)
    if (build && activeBuild) build.log = ''
    if (lastSuccessful) lastSuccessful.log = ''
    let workspaceRevision = null
    if (info.available) {
      try {
        workspaceRevision = await this.workspaces.texSourceVersion(
          projectId,
          owner,
          selectedRoot,
        )
      } catch {
        /* A retained PDF remains usable when current inputs cannot be inspected. */
      }
    }
    return { ...info, workspaceRevision, build, activeBuild, lastSuccessful }
  }

  async start(
    owner,
    projectId,
    input,
    { sourceRoot, signal, runId, origin } = {},
  ) {
    if (this.stopping)
      fail('The server is shutting down. Compile after it restarts.', 503)
    this.workspaces.get(projectId, owner)
    this.assertCanStart(owner, projectId)
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !['rootFile', 'engine'].includes(key))
    )
      fail('Choose the root TeX file and supported engine.')
    const rootFile = safeTexPath(input.rootFile)
    if (!isTexFile(rootFile)) fail('Choose a .tex root document.')
    const engine = input.engine ?? 'pdflatex'
    if (!TEX_ENGINES.includes(engine))
      fail(
        'Only pdfLaTeX is available. Choose pdflatex; other engines are not substituted.',
      )
    signal?.throwIfAborted()
    const info = await this.availability()
    this.workspaces.get(projectId, owner)
    this.assertCanStart(owner, projectId)
    if (!info.available) fail(info.error, 503)
    if (this.stopping)
      fail('The server is shutting down. Compile after it restarts.', 503)
    const key = this.#key(owner, projectId)
    if (
      this.projectBuilds.has(key) ||
      this.#rows(owner, projectId).some((entry) => entry.cleanupFailed)
    )
      fail(
        'A TeX build is already running for this project. Wait for it to finish or stop it.',
        409,
      )
    const job = this.events.create(owner, {
      kind: 'tex',
      projectId,
      rootFile,
      engine,
      diagnostics: [],
      ...(runId ? { originRunId: runId } : {}),
      ...(origin ? { origin } : {}),
    })
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('LaTeX build deadline reached.'))
    }, this.timeoutMs)
    timer.unref?.()
    const abort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    this.controllers.set(job.id, controller)
    this.projectBuilds.set(key, job.id)
    let pendingLog = ''
    let logTimer
    const flushLog = () => {
      clearTimeout(logTimer)
      logTimer = undefined
      if (pendingLog) {
        const text = pendingLog
        pendingLog = ''
        this.events.append(job.id, 'log', text, 'activity')
      }
    }
    const outputLog = (text) => {
      pendingLog += String(text).slice(-250000)
      if (pendingLog.length >= 32768) flushLog()
      else if (!logTimer) {
        logTimer = setTimeout(flushLog, 200)
        logTimer.unref?.()
      }
    }
    const task = Promise.resolve().then(async () => {
      const directory = this.#directory(job.id)
      try {
        controller.signal.throwIfAborted()
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
        if ((await fs.realpath(this.directory)) !== this.directory)
          fail('TeX storage is not safe.', 403)
        await fs.mkdir(directory, { mode: 0o700 })
        const source = await this.workspaces.captureTexSource(
          projectId,
          owner,
          path.join(directory, 'source'),
          { sourceRoot, runId, rootFile, signal: controller.signal },
        )
        if (!source.files.some((file) => file.path === rootFile))
          fail(
            'The selected root TeX file is missing or inaccessible. Choose a regular project .tex file.',
          )
        controller.signal.throwIfAborted()
        this.events.updateMetadata(job.id, {
          sourceRevision: source.sourceRevision,
          workspaceRevision: source.workspaceRevision,
          sourceBytes: source.bytes,
        })
        await fs.writeFile(
          path.join(directory, 'inputs.json'),
          JSON.stringify(source),
          { flag: 'wx', mode: 0o600 },
        )
        const output = path.join(directory, 'output')
        await fs.mkdir(output, { mode: 0o700 })
        const result = await this.runtime.runTex(
          path.join(directory, 'source'),
          output,
          {
            rootFile,
            engine,
            timeoutMs: this.timeoutMs,
            signal: controller.signal,
            onSpawn: () => {
              controller.signal.throwIfAborted()
              this.events.updateMetadata(job.id, { status: 'running' })
            },
            onOutput: outputLog,
          },
        )
        flushLog()
        controller.signal.throwIfAborted()
        const recordBytes = await artifact(
          output,
          'result.json',
          1024 * 1024,
          true,
        )
        let record
        if (recordBytes) {
          try {
            record = JSON.parse(recordBytes.toString('utf8'))
          } catch {
            fail(
              'The TeX worker returned an invalid build report. Retry or contact the administrator.',
              502,
            )
          }
        }
        const diagnostics = diagnosticsFrom(record, source.files)
        if (
          record?.log &&
          (record.logTruncated || !this.events.getMetadata(job.id).log)
        )
          this.events.append(
            job.id,
            'log',
            String(record.log).slice(-250000),
            'activity',
          )
        if (result.code !== 0 || result.timedOut || record?.success === false) {
          this.events.updateMetadata(job.id, {
            status: 'failed',
            diagnostics,
            error: result.timedOut
              ? 'LaTeX compilation reached its time limit. Check for loops or reduce the document, then compile again.'
              : 'LaTeX compilation failed. Fix the reported errors and compile again.',
          })
        } else {
          const pdf = await artifact(output, 'document.pdf', MAX_PDF_FILE_BYTES)
          validatePdfBytes('document.pdf', pdf)
          const documentText = await artifact(
            output,
            'document.txt',
            2 * 1024 * 1024,
            true,
          )
          this.events.updateMetadata(job.id, {
            status: 'completed',
            diagnostics,
            pdfRevision: hash(pdf),
            ...(documentText ? { textRevision: hash(documentText) } : {}),
            textAvailable: !!documentText && record?.textAvailable !== false,
            textTruncated: record?.textTruncated === true,
            ...(Number.isSafeInteger(record?.pageCount) && record.pageCount >= 0
              ? { pageCount: record.pageCount }
              : {}),
            ...(record?.versions && typeof record.versions === 'object'
              ? { versions: record.versions }
              : {}),
          })
        }
      } catch (error) {
        const cancelled =
          controller.signal.aborted && !timedOut && !error.workerCleanup
        this.events.updateMetadata(job.id, {
          status: cancelled ? 'cancelled' : 'failed',
          ...(error.workerCleanup ? { cleanupFailed: true } : {}),
          error: cancelled
            ? undefined
            : timedOut
              ? 'LaTeX compilation reached its time limit, including waiting for a worker. Retry when capacity is available, or reduce the document.'
              : error.status
                ? error.message
                : 'The TeX build could not finish. Retry, or ask the administrator to check the TeX worker.',
        })
        if (error.workerCleanup) throw error
      } finally {
        clearTimeout(timer)
        flushLog()
        signal?.removeEventListener('abort', abort)
        // Sources are immutable only for this build. Keep the hashes, logs and
        // bounded result artifacts; avoid accumulating copies of project inputs.
        try {
          if (!this.events.getMetadata(job.id).cleanupFailed)
            await fs.rm(path.join(directory, 'source'), {
              recursive: true,
              force: true,
            })
          if (
            !this.events.getMetadata(job.id).cleanupFailed &&
            this.events.getMetadata(job.id).status !== 'completed'
          )
            await fs.rm(path.join(directory, 'output'), {
              recursive: true,
              force: true,
            })
          await this.#prune(owner, projectId)
        } finally {
          this.controllers.delete(job.id)
          this.projectBuilds.delete(key)
          this.active.delete(job.id)
        }
      }
    })
    this.active.set(job.id, task)
    task.catch(() => {})
    return this.#public(job)
  }

  async wait(owner, id) {
    this.#job(owner, id)
    await this.active.get(id)
    return this.get(owner, id)
  }
  async stop(owner, id) {
    const job = this.#job(owner, id)
    if (!TERMINAL.has(job.status)) {
      const controller = this.controllers.get(id)
      if (!controller) fail('This TeX build is no longer running.', 409)
      this.events.updateMetadata(id, { status: 'stopping' })
      controller.abort(new Error('TeX build stopped.'))
    }
    try {
      await this.active.get(id)
    } catch (error) {
      if (!error.workerCleanup) throw error
    }
    await this.#retryCleanup(owner, job.projectId)
    return this.get(owner, id)
  }
  async stopProject(owner, projectId) {
    this.workspaces.get(projectId, owner)
    const ids = new Set(
      this.events.activeMetadata(owner, projectId, 'tex').map((job) => job.id),
    )
    for (const id of this.active.keys()) {
      const job = this.events.getMetadata(id)
      if (job.owner === owner && job.projectId === projectId) ids.add(id)
    }
    const results = await Promise.allSettled(
      [...ids].map((id) => this.stop(owner, id)),
    )
    await this.#retryCleanup(owner, projectId)
    const failed = results.find(
      (entry) => entry.status === 'rejected' && !entry.reason?.workerCleanup,
    )
    if (failed) throw failed.reason
  }
  async readPdf(owner, id) {
    const job = this.#job(owner, id)
    if (!job.pdfRevision || job.artifactsRemoved)
      fail('This build has no retained PDF. Compile the document again.', 404)
    const content = await artifact(
      path.join(this.#directory(id), 'output'),
      'document.pdf',
      MAX_PDF_FILE_BYTES,
    )
    validatePdfBytes('document.pdf', content)
    if (hash(content) !== job.pdfRevision)
      fail(
        'This PDF changed after compilation. Compile the document again.',
        409,
      )
    return {
      content,
      path:
        path.posix.basename(job.rootFile, path.posix.extname(job.rootFile)) +
        '.pdf',
    }
  }
  async readText(owner, id) {
    const job = this.#job(owner, id)
    if (
      !job.textRevision ||
      job.textAvailable === false ||
      job.artifactsRemoved
    )
      fail(
        'This build has no retained document text. Compile the document again.',
        404,
      )
    const content = await artifact(
      path.join(this.#directory(id), 'output'),
      'document.txt',
      2 * 1024 * 1024,
    )
    if (hash(content) !== job.textRevision)
      fail(
        'This document text changed after compilation. Compile the document again.',
        409,
      )
    return {
      content: content.toString('utf8'),
      path: 'document.txt',
      textAvailable: true,
      textTruncated: job.textTruncated === true,
      ...(Number.isSafeInteger(job.pageCount)
        ? { pageCount: job.pageCount }
        : {}),
    }
  }
  #rows(owner, projectId) {
    return this.events.db
      .prepare(
        "SELECT id,owner,json_extract(payload,'$.projectId') AS projectId,json_extract(payload,'$.status') AS status,json_extract(payload,'$.originRunId') AS originRunId,json_extract(payload,'$.pdfRevision') AS pdfRevision,json_extract(payload,'$.cleanupFailed') AS cleanupFailed FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND json_extract(payload,'$.kind')='tex' ORDER BY rowid DESC",
      )
      .all(owner, projectId)
  }

  workerRoots(owner, projectId) {
    return this.#rows(owner, projectId).map((job) =>
      path.join(this.#directory(job.id), 'source'),
    )
  }

  async #retryCleanup(owner, projectId) {
    for (const job of this.#rows(owner, projectId).filter(
      (entry) => entry.cleanupFailed,
    )) {
      if (!this.runtime.stopProject)
        fail(
          'The TeX worker is still stopping. Ask the administrator to retry worker cleanup.',
          409,
        )
      await this.runtime.stopProject(
        path.join(this.#directory(job.id), 'source'),
      )
      this.events.updateMetadata(job.id, { cleanupFailed: false })
      await fs.rm(path.join(this.#directory(job.id), 'source'), {
        recursive: true,
        force: true,
      })
      if (job.status !== 'completed')
        await fs.rm(path.join(this.#directory(job.id), 'output'), {
          recursive: true,
          force: true,
        })
    }
  }

  async #prune(owner, projectId) {
    const jobs = this.#rows(owner, projectId)
    const retained = new Set(
      jobs.slice(0, this.retainedBuilds).map((job) => job.id),
    )
    for (const origin of [false, true]) {
      const success = jobs.find(
        (job) =>
          !!job.originRunId === origin &&
          job.status === 'completed' &&
          job.pdfRevision,
      )
      if (success) retained.add(success.id)
    }
    const removed = []
    for (const job of jobs) {
      if (
        retained.has(job.id) ||
        !TERMINAL.has(job.status) ||
        this.active.has(job.id) ||
        job.cleanupFailed
      )
        continue
      await fs.rm(this.#directory(job.id), { recursive: true, force: true })
      removed.push(job.id)
    }
    if (removed.length) this.events.deleteRuns(owner, removed)
  }

  async removeRuns(owner, runIds) {
    const ids = new Set(runIds)
    const jobs = this.events.db
      .prepare(
        "SELECT id,json_extract(payload,'$.projectId') AS projectId,json_extract(payload,'$.originRunId') AS originRunId FROM jobs WHERE owner=? AND json_extract(payload,'$.kind')='tex'",
      )
      .all(owner)
      .filter((job) => ids.has(job.originRunId))
    for (const projectId of new Set(jobs.map((job) => job.projectId)))
      await this.#retryCleanup(owner, projectId)
    for (const job of jobs) {
      const metadata = this.events.getMetadata(job.id, owner)
      if (!TERMINAL.has(metadata.status) || this.active.has(job.id))
        fail('Stop TeX builds before permanently deleting this chat.', 409)
    }
    for (const job of jobs)
      await fs.rm(this.#directory(job.id), { recursive: true, force: true })
    if (jobs.length)
      this.events.deleteRuns(
        owner,
        jobs.map((job) => job.id),
      )
  }

  async removeProject(owner, projectId) {
    await this.#retryCleanup(owner, projectId)
    const jobs = this.#rows(owner, projectId)
    if (
      jobs.some((job) => !TERMINAL.has(job.status) || this.active.has(job.id))
    )
      fail('Stop TeX builds before permanently deleting this project.', 409)
    for (const job of jobs)
      await fs.rm(this.#directory(job.id), { recursive: true, force: true })
    if (jobs.length)
      this.events.deleteRuns(
        owner,
        jobs.map((job) => job.id),
      )
  }

  shutdown() {
    this.stopping = true
    for (const controller of this.controllers.values())
      controller.abort(new Error('Server shutting down.'))
    return Promise.allSettled([...this.active.values()]).then(() => {})
  }
}
