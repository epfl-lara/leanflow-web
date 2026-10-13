import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'applied'])

export class EventStore extends EventEmitter {
  constructor(dataDir) {
    super()
    this.setMaxListeners(100)
    this.db = new DatabaseSync(path.join(dataDir, 'activity.sqlite'))
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (job TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(job,seq));')
    for (const row of this.db.prepare('SELECT payload FROM jobs').all()) {
      const job = JSON.parse(row.payload)
      if (!TERMINAL.has(job.status)) this.update(job.id, { status: 'interrupted', error: 'The server restarted during this job. Start a new run to continue.' })
    }
  }
  create(owner, fields) {
    const job = { ...fields, id: randomUUID(), owner, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: '', message: '', changes: [] }
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(job.id, owner, JSON.stringify(job))
    this.event(job.id, 'status', { status: job.status })
    return job
  }
  get(id, owner) {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id)
    if (!row) throw Object.assign(new Error('Job not found.'), { status: 404 })
    const job = JSON.parse(row.payload)
    if (owner !== undefined && job.owner !== owner) throw Object.assign(new Error('Job not found.'), { status: 404 })
    return job
  }
  snapshot(id, owner) {
    // Both reads are synchronous: no event producer can run between reading the
    // accumulated fields and the replay cursor in this server process.
    const job = this.get(id, owner)
    const eventCursor = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM events WHERE job=?').get(id).cursor)
    return { ...job, eventCursor }
  }
  list(owner, projectId, kind = 'agent') {
    return this.db.prepare("SELECT payload FROM jobs WHERE owner=? AND json_extract(payload,'$.projectId')=? AND json_extract(payload,'$.kind')=? ORDER BY rowid DESC LIMIT 100").all(owner, projectId, kind).map(row => JSON.parse(row.payload))
  }
  update(id, fields) {
    const job = { ...this.get(id), ...fields, updatedAt: new Date().toISOString() }
    this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(job), id)
    if (fields.status) this.event(id, 'status', { status: fields.status })
    return job
  }
  event(id, type, data) {
    const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM events WHERE job=?').get(id).next)
    const event = { seq, type, data, at: new Date().toISOString() }
    this.db.prepare('INSERT INTO events VALUES(?,?,?)').run(id, seq, JSON.stringify(event))
    this.emit(id, event)
    return event
  }
  events(id, after = 0) { return this.db.prepare('SELECT payload FROM events WHERE job=? AND seq>? ORDER BY seq').all(id, after).map(row => JSON.parse(row.payload)) }
  append(id, field, text, type) {
    const job = this.get(id)
    this.update(id, { [field]: ((job[field] || '') + text).slice(-250_000) })
    this.event(id, type, { text })
  }
  close() { this.db.close() }
}

export class JobManager {
  constructor({ events, runtime, workspaces }) { Object.assign(this, { events, runtime, workspaces }); this.active = new Map(); this.stopping = false }
  check(owner, projectId, file) {
    if (this.stopping) throw Object.assign(new Error('The server is shutting down. Reopen the project after it restarts.'), { status: 503 })
    const project = this.workspaces.get(projectId, owner)
    if (project.status !== 'ready') throw Object.assign(new Error('Prepare this project before checking it.'), { status: 409 })
    const job = this.events.create(owner, { kind: 'check', projectId, file })
    const task = Promise.resolve().then(async () => {
      try {
        if (file) await this.workspaces.readFile(projectId, owner, file)
        this.events.update(job.id, { status: 'running' })
        const options = { network: 'none', timeoutMs: 600_000, onOutput: text => this.events.append(job.id, 'log', text, 'activity') }
        let result = await this.runtime.run(project.root, ['lake', 'build'], options)
        if (file && file.endsWith('.lean') && result.code === 0) {
          const checked = await this.runtime.run(project.root, ['lake', 'env', 'lean', '--json', '-Dwarn.sorry=true', file], options)
          result = { ...checked, stdout: result.stdout + checked.stdout, stderr: result.stderr + checked.stderr }
        }
        this.events.update(job.id, { status: result.code === 0 ? 'completed' : 'failed', result, error: result.code === 0 ? undefined : 'Lean build failed. See the build output.' })
      } catch (error) { this.events.update(job.id, { status: 'failed', error: error.message }) }
    }).finally(() => this.active.delete(job.id))
    this.active.set(job.id, task)
    task.catch(() => {}) // shutdown() retains and observes the original promise.
    return job
  }
  shutdown() {
    this.stopping = true
    this.shutdownPromise ||= Promise.allSettled([...this.active.values()]).then(() => {})
    return this.shutdownPromise
  }
}
