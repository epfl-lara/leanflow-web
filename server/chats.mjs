import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status, statusCode: status })
}
function identifier(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)
  )
    fail('Invalid chat identifier')
}
function ownerId(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 200 ||
    /[\x00-\x1f]/.test(value)
  )
    fail('Invalid chat owner')
}
function title(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 120 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail('Chat titles need 1–120 printable characters')
  return value.trim()
}
function promptTitle(prompt) {
  const clean = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(clean).slice(0, 80).join('') || 'New chat'
}

/** Chat metadata stores run references; EventStore retains the actual transcripts. */
export class ChatStore {
  constructor({ dataDir, workspaces, events, titleGenerator }) {
    if (!dataDir || !workspaces || !events)
      throw new Error('ChatStore requires dataDir, workspaces, and events')
    Object.assign(this, { workspaces, events, titleGenerator })
    this.titleTasks = new Map()
    this.titleQueue = []
    this.titleActive = 0
    this.closed = false
    this.db = new DatabaseSync(path.join(path.resolve(dataDir), 'chats.sqlite'))
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS chats_project ON chats(owner,project); CREATE TABLE IF NOT EXISTS chat_runs (position INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, run TEXT NOT NULL UNIQUE); CREATE INDEX IF NOT EXISTS chat_runs_chat ON chat_runs(chat,position);',
    )
  }

  init() {
    // Interrupted naming requests retain their prompt-based title. Never issue
    // model requests merely because the application restarted.
    for (const row of this.db
      .prepare(
        "SELECT data FROM chats WHERE json_extract(data,'$.titleStatus')='pending'",
      )
      .all()) {
      const chat = JSON.parse(row.data)
      chat.titleStatus = 'unavailable'
      delete chat.titleRequestId
      this.#save(chat)
    }
    // A one-time reference migration keeps earlier project tasks available in
    // the new chat picker without rewriting their transcripts or job records.
    if (!this.events.db) return this
    const legacy = new Map()
    for (const row of this.events.db
      .prepare(
        "SELECT payload FROM jobs WHERE json_extract(payload,'$.kind')='agent' ORDER BY rowid",
      )
      .all()) {
      const job = JSON.parse(row.payload)
      if (this.db.prepare('SELECT 1 FROM chat_runs WHERE run=?').get(job.id))
        continue
      try {
        this.workspaces.get(job.projectId, job.owner)
      } catch {
        continue
      }
      if (job.chatId) {
        const existing = this.db
          .prepare(
            'SELECT data FROM chats WHERE id=? AND owner=? AND project=?',
          )
          .get(job.chatId, job.owner, job.projectId)
        if (existing) {
          if (!JSON.parse(existing.data).archivedAt)
            this.appendRun(job.chatId, job.owner, job)
          continue
        }
      }
      const key = JSON.stringify([job.owner, job.projectId])
      if (!legacy.has(key)) {
        const existing = this.db
          .prepare(
            "SELECT data FROM chats WHERE owner=? AND project=? AND json_extract(data,'$.legacy')=1 AND json_extract(data,'$.archivedAt') IS NULL ORDER BY rowid DESC LIMIT 1",
          )
          .get(job.owner, job.projectId)
        let chat = existing ? JSON.parse(existing.data) : null
        if (!chat) {
          const created = this.create(job.owner, job.projectId, {
            title: 'Earlier tasks',
          })
          chat = this.#owned(created.id, job.owner)
          chat.legacy = true
          this.#save(chat)
        }
        legacy.set(key, chat.id)
      }
      this.#linkRun(legacy.get(key), job.owner, job, { legacy: true })
    }
    return this
  }

  #save(chat) {
    this.db
      .prepare(
        'INSERT INTO chats(id,owner,project,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(chat.id, chat.owner, chat.projectId, JSON.stringify(chat))
  }

  #owned(id, owner, { archived = false, project = true } = {}) {
    identifier(id)
    ownerId(owner)
    const row = this.db
      .prepare('SELECT data FROM chats WHERE id=? AND owner=?')
      .get(id, owner)
    if (!row) fail('Chat not found', 404)
    const chat = JSON.parse(row.data)
    if (chat.archivedAt && !archived) fail('Chat not found', 404)
    if (project) this.workspaces.get(chat.projectId, owner)
    return chat
  }

  #public(chat) {
    const count = this.db
      .prepare('SELECT COUNT(*) AS count FROM chat_runs WHERE chat=?')
      .get(chat.id).count
    const last = this.db
      .prepare(
        'SELECT run FROM chat_runs WHERE chat=? ORDER BY position DESC LIMIT 1',
      )
      .get(chat.id)
    let run = null
    try {
      if (last) run = this.events.getMetadata(last.run, chat.owner)
    } catch {
      /* Keep metadata usable if an old run is unavailable. */
    }
    return {
      id: chat.id,
      projectId: chat.projectId,
      title: chat.title,
      titleSource:
        chat.titleSource || (chat.explicitTitle ? 'manual' : 'prompt'),
      titleStatus: chat.titleStatus || 'ready',
      createdAt: chat.createdAt,
      updatedAt:
        run?.updatedAt > chat.updatedAt ? run.updatedAt : chat.updatedAt,
      runCount: Number(count),
      lastRunId: run?.id || null,
      status: run?.status || 'empty',
      lastMode: run?.mode || null,
    }
  }

  create(owner, projectId, input = {}) {
    ownerId(owner)
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('Invalid chat configuration')
    const project = this.workspaces.get(projectId, owner)
    const now = new Date().toISOString()
    const chat = {
      id: randomUUID(),
      owner,
      projectId,
      projectName: project.name,
      title: input.title === undefined ? 'New chat' : title(input.title),
      explicitTitle: input.title !== undefined,
      createdAt: now,
      updatedAt: now,
    }
    this.#save(chat)
    return this.#public(chat)
  }

  list(owner, projectId) {
    this.workspaces.get(projectId, owner)
    return this.db
      .prepare(
        "SELECT data FROM chats WHERE owner=? AND project=? AND json_extract(data,'$.archivedAt') IS NULL ORDER BY json_extract(data,'$.updatedAt') DESC, rowid DESC LIMIT 100",
      )
      .all(owner, projectId)
      .map((row) => this.#public(JSON.parse(row.data)))
  }

  get(id, owner) {
    return this.#public(this.#owned(id, owner))
  }

  rename(id, owner, input) {
    const chat = this.#owned(id, owner)
    if (!input || typeof input !== 'object' || Array.isArray(input))
      fail('Choose a chat title')
    chat.title = title(input.title)
    chat.explicitTitle = true
    chat.titleSource = 'manual'
    chat.titleStatus = 'ready'
    delete chat.titleRequestId
    chat.updatedAt = new Date().toISOString()
    this.#save(chat)
    return this.#public(chat)
  }

  suggestTitle(id, owner) {
    this.#owned(id, owner)
    if (this.closed || !this.titleGenerator?.available)
      return Promise.reject(
        Object.assign(
          new Error(
            'DeepSeek chat naming is unavailable. You can still enter a name manually.',
          ),
          { status: 503 },
        ),
      )
    const { runs } = this.history(id, owner)
    const selected = runs.length > 3 ? [runs[0], ...runs.slice(-2)] : runs
    const messages = []
    let remaining = 8000
    for (const run of selected) {
      for (const [role, value] of [
        ['user', run.prompt],
        ['assistant', run.message],
      ]) {
        if (typeof value !== 'string' || !value.trim() || remaining <= 0)
          continue
        const content = value.trim().slice(0, Math.min(2000, remaining))
        messages.push({ role, content })
        remaining -= content.length
      }
    }
    if (!messages.length)
      return Promise.reject(
        Object.assign(
          new Error('Send a message before asking DeepSeek to name this chat.'),
          { status: 400 },
        ),
      )
    const existing = this.titleTasks.get(id)
    if (existing) return existing.promise
    if (this.titleQueue.length >= 16)
      return Promise.reject(
        Object.assign(
          new Error(
            'Chat naming is busy. Try again shortly or enter a name manually.',
          ),
          { status: 503 },
        ),
      )
    const controller = new AbortController()
    const job = { id, owner, messages, controller }
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    this.titleTasks.set(id, job)
    this.titleQueue.push(job)
    this.#drainTitles()
    return job.promise
  }

  #drainTitles() {
    while (!this.closed && this.titleActive < 2 && this.titleQueue.length) {
      const job = this.titleQueue.shift()
      this.titleActive++
      Promise.resolve()
        .then(() => {
          this.#owned(job.id, job.owner)
          return this.titleGenerator.generate(job.messages, {
            signal: job.controller.signal,
          })
        })
        .then((result) => {
          if (this.closed) throw new Error('Chat naming stopped.')
          this.#owned(job.id, job.owner)
          return { title: title(result.title), model: result.model }
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          this.titleActive--
          if (this.titleTasks.get(job.id) === job)
            this.titleTasks.delete(job.id)
          this.#drainTitles()
        })
    }
  }

  async #autoTitle(chat) {
    try {
      const result = await this.suggestTitle(chat.id, chat.owner)
      if (this.closed) return
      const current = this.#owned(chat.id, chat.owner)
      // A manual rename, deletion, or newer request always wins this race.
      if (
        current.explicitTitle ||
        current.titleRequestId !== chat.titleRequestId
      )
        return
      current.title = result.title
      current.titleSource = 'generated'
      current.titleStatus = 'ready'
      current.titleModel = result.model
      delete current.titleRequestId
      this.#save(current)
    } catch {
      if (this.closed) return
      try {
        const current = this.#owned(chat.id, chat.owner)
        if (current.titleRequestId !== chat.titleRequestId) return
        current.titleStatus = 'unavailable'
        delete current.titleRequestId
        this.#save(current)
      } catch {
        /* Deleted or archived chats need no naming update. */
      }
    }
  }

  appendRun(id, owner, suppliedRun) {
    return this.#linkRun(id, owner, suppliedRun)
  }

  #linkRun(id, owner, suppliedRun, { legacy = false } = {}) {
    const chat = this.#owned(id, owner)
    if (!suppliedRun || typeof suppliedRun.id !== 'string')
      fail('Invalid chat run')
    const run = this.events.getMetadata(suppliedRun.id, owner)
    if (
      run.projectId !== chat.projectId ||
      run.kind !== 'agent' ||
      (!legacy && run.chatId && run.chatId !== id)
    )
      fail('Run does not belong to this chat', 404)
    const existing = this.db
      .prepare('SELECT chat FROM chat_runs WHERE run=?')
      .get(run.id)
    if (existing) {
      if (existing.chat !== id) fail('Run does not belong to this chat', 404)
      return this.#public(chat)
    }
    const count = Number(
      this.db
        .prepare('SELECT COUNT(*) AS count FROM chat_runs WHERE chat=?')
        .get(id).count,
    )
    const autoName =
      count === 0 &&
      !chat.explicitTitle &&
      this.titleGenerator?.available &&
      !this.closed
    if (count === 0 && !chat.explicitTitle) chat.title = promptTitle(run.prompt)
    if (autoName) {
      chat.titleStatus = 'pending'
      chat.titleRequestId = randomUUID()
    }
    chat.updatedAt = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT INTO chat_runs(chat,run) VALUES(?,?)')
        .run(id, run.id)
      this.#save(chat)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    if (autoName) void this.#autoTitle(chat)
    return this.#public(chat)
  }

  history(id, owner) {
    const chat = this.#owned(id, owner)
    const runs = []
    for (const row of this.db
      .prepare(
        'SELECT run FROM chat_runs WHERE chat=? ORDER BY position DESC LIMIT 100',
      )
      .all(id)
      .reverse()) {
      try {
        const run = this.events.getMetadata(row.run, owner)
        if (run.projectId === chat.projectId && run.kind === 'agent')
          runs.push(run)
      } catch (error) {
        if (error.status !== 404) throw error
      }
    }
    return { chat: this.#public(chat), runs }
  }

  #assertInactive(chat) {
    if (
      this.events.db
        ?.prepare(
          "SELECT 1 FROM jobs WHERE owner=? AND json_extract(payload,'$.chatId')=? AND json_extract(payload,'$.status') IN ('queued','running','stopping','verifying') LIMIT 1",
        )
        .get(chat.owner, chat.id)
    )
      fail(
        'Stop this chat’s active Lemex run before deleting or restoring it',
        409,
      )
    for (const row of this.db
      .prepare('SELECT run FROM chat_runs WHERE chat=?')
      .all(chat.id)) {
      let run
      try {
        run = this.events.getMetadata(row.run, chat.owner)
      } catch (error) {
        if (error.status === 404) continue
        throw error
      }
      if (['queued', 'running', 'stopping', 'verifying'].includes(run.status))
        fail(
          'Stop this chat’s active Lemex run before deleting or restoring it',
          409,
        )
    }
  }

  #receipt(chat) {
    let sizeBytes = Buffer.byteLength(JSON.stringify(chat))
    if (this.events.db) {
      const measured = this.events.db.prepare(
        `SELECT length(CAST(payload AS BLOB))
          + COALESCE((SELECT SUM(length(CAST(events.payload AS BLOB))) FROM events WHERE events.job=jobs.id),0)
          + COALESCE((SELECT SUM(length(CAST(job_changes.payload AS BLOB))) FROM job_changes WHERE job_changes.job=jobs.id),0)
        AS bytes FROM jobs WHERE owner=? AND id=?`,
      )
      for (const id of this.#runIds(chat))
        sizeBytes += Number(measured.get(chat.owner, id).bytes)
    }
    return {
      trashId: chat.trashId,
      chatId: chat.id,
      projectId: chat.projectId,
      projectName: chat.projectName,
      name: chat.title,
      kind: 'chat',
      path: null,
      createdAt: chat.archivedAt,
      sizeBytes,
      recoverable: true,
    }
  }

  trash(owner, id) {
    const chat = this.#owned(id, owner)
    this.#assertInactive(chat)
    chat.trashId = randomUUID()
    chat.archivedAt = new Date().toISOString()
    if (chat.titleStatus === 'pending') chat.titleStatus = 'unavailable'
    delete chat.titleRequestId
    chat.updatedAt = chat.archivedAt
    this.#save(chat)
    return this.#receipt(chat)
  }

  listTrash(owner) {
    ownerId(owner)
    return this.db
      .prepare(
        "SELECT data FROM chats WHERE owner=? AND json_extract(data,'$.archivedAt') IS NOT NULL ORDER BY json_extract(data,'$.archivedAt') DESC",
      )
      .all(owner)
      .map((row) => this.#receipt(JSON.parse(row.data)))
  }

  getTrash(trashId, owner) {
    identifier(trashId)
    ownerId(owner)
    const row = this.db
      .prepare(
        "SELECT data FROM chats WHERE owner=? AND json_extract(data,'$.trashId')=? AND json_extract(data,'$.archivedAt') IS NOT NULL",
      )
      .get(owner, trashId)
    if (!row) fail('Recoverable deletion not found', 404)
    return this.#receipt(JSON.parse(row.data))
  }

  restore(owner, trashId) {
    const receipt = this.getTrash(trashId, owner)
    const chat = this.#owned(receipt.chatId, owner, { archived: true })
    this.#assertInactive(chat)
    delete chat.archivedAt
    delete chat.trashId
    chat.updatedAt = new Date().toISOString()
    this.#save(chat)
    return { ...receipt, recoverable: false, restored: true }
  }

  #runIds(chat) {
    const ids = new Set(
      this.db
        .prepare('SELECT run FROM chat_runs WHERE chat=?')
        .all(chat.id)
        .map((row) => row.run),
    )
    if (this.events.db)
      for (const row of this.events.db
        .prepare(
          "SELECT id FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND json_extract(payload,'$.chatId')=?",
        )
        .all(chat.owner, chat.projectId, chat.id))
        ids.add(row.id)
    return [...ids].filter((id) => {
      try {
        const run = this.events.getMetadata(id, chat.owner)
        return run.projectId === chat.projectId && run.kind === 'agent'
      } catch (error) {
        if (error.status === 404) return false
        throw error
      }
    })
  }

  #deleteChat(chat) {
    this.titleTasks.get(chat.id)?.controller.abort(new Error('Chat deleted.'))
    this.db.prepare('DELETE FROM chat_runs WHERE chat=?').run(chat.id)
    this.db
      .prepare('DELETE FROM chats WHERE id=? AND owner=?')
      .run(chat.id, chat.owner)
  }

  texRunIds(owner, trashId) {
    const receipt = this.getTrash(trashId, owner)
    const chat = this.#owned(receipt.chatId, owner, {
      archived: true,
      project: false,
    })
    this.#assertInactive(chat)
    return this.#runIds(chat)
  }

  deleteForever(owner, trashId) {
    const receipt = this.getTrash(trashId, owner)
    const chat = this.#owned(receipt.chatId, owner, {
      archived: true,
      project: false,
    })
    this.#assertInactive(chat)
    this.events.deleteRuns(owner, this.#runIds(chat))
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.#deleteChat(chat)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { ...receipt, recoverable: false, deleted: true }
  }

  deleteProject(owner, projectId) {
    ownerId(owner)
    identifier(projectId)
    const chats = this.db
      .prepare('SELECT data FROM chats WHERE owner=? AND project=?')
      .all(owner, projectId)
      .map((row) => JSON.parse(row.data))
    chats.forEach((chat) => this.#assertInactive(chat))
    this.events.deleteProject(owner, projectId)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      chats.forEach((chat) => this.#deleteChat(chat))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  stopNaming() {
    this.closed = true
    for (const job of this.titleTasks.values()) job.controller.abort()
    for (const job of this.titleQueue.splice(0)) {
      this.titleTasks.delete(job.id)
      job.reject(
        Object.assign(new Error('Chat naming stopped.'), { status: 503 }),
      )
    }
  }

  close() {
    this.stopNaming()
    this.db.close()
  }
}
