import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const activeStates = [
  'queued',
  'assigned',
  'starting',
  'running',
  'validating',
  'stopping',
  'reconciling',
]
const transitions = new Map([
  ['queued', ['assigned', 'cancelled', 'failed', 'lost']],
  [
    'assigned',
    ['starting', 'running', 'stopping', 'cancelled', 'failed', 'lost'],
  ],
  ['starting', ['running', 'stopping', 'failed', 'lost']],
  ['running', ['validating', 'completed', 'stopping', 'failed', 'lost']],
  ['validating', ['completed', 'stopping', 'failed', 'lost']],
  ['stopping', ['cancelled', 'failed', 'lost']],
  ['lost', ['reconciling']],
  ['reconciling', ['completed', 'cancelled', 'failed', 'interrupted', 'lost']],
])

export function clusterError(message, code = 'cluster_error', status = 400) {
  return Object.assign(new Error(message), { code, status })
}

export function identifier(value, label = 'identifier') {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
  )
    throw clusterError(`Invalid cluster ${label}.`)
  return value
}

export function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw clusterError('Invalid cluster content digest.')
  return value
}

export const sha256 = (value) =>
  createHash('sha256').update(value).digest('hex')

export function executionDigest(value) {
  digest(value.sourceManifest)
  if (value.dependencies) digest(value.dependencies)
  if (value.toolchain?.manifest) digest(value.toolchain.manifest)
  return sha256(
    JSON.stringify({
      sourceManifest: value.sourceManifest,
      dependencies: value.dependencies || null,
      toolchain: value.toolchain || null,
      operation: value.operation,
      file: value.file || null,
    }),
  )
}

function boundedJson(value) {
  const text = JSON.stringify(value)
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024)
    throw clusterError('Cluster metadata exceeds its limit.')
  return text
}

export function resourceVector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw clusterError('Invalid cluster resource request.')
  const result = {}
  for (const key of ['memoryBytes', 'cpus', 'scratchBytes']) {
    const number = value[key] ?? (key === 'scratchBytes' ? 0 : undefined)
    if (
      !Number.isFinite(number) ||
      number < 0 ||
      (key !== 'scratchBytes' && number === 0) ||
      (key !== 'cpus' && !Number.isSafeInteger(number))
    )
      throw clusterError(`Invalid cluster ${key}.`)
    result[key] = number
  }
  return result
}

// Controller and worker databases are private, local files outside all sandbox
// mounts. A supplied database lets the controller share WorkspaceStore's atomic
// transaction boundary instead of pretending separate SQLite files are atomic.
export class ClusterState {
  constructor({ filename, database } = {}) {
    if (!database && !filename)
      throw clusterError('A cluster database is required.')
    this.owned = !database
    if (!database) {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
      try {
        const stat = fs.lstatSync(filename)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
          throw clusterError(
            'The cluster database must be a private regular file.',
          )
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    this.db = database || new DatabaseSync(filename)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cluster_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cluster_nodes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cluster_cancelled_starts (id TEXT PRIMARY KEY, lineage TEXT NOT NULL, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cluster_attempts (
        id TEXT PRIMARY KEY, job TEXT NOT NULL, node TEXT, state TEXT NOT NULL,
        fingerprint TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cluster_attempt_state ON cluster_attempts(state);
      CREATE INDEX IF NOT EXISTS cluster_attempt_job ON cluster_attempts(job);
      CREATE TABLE IF NOT EXISTS cluster_events (
        attempt TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(attempt, seq)
      );
    `)
    if (!database) fs.chmodSync(filename, 0o600)
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      if (result && typeof result.then === 'function')
        throw clusterError('Cluster transactions must be synchronous.')
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  meta(key) {
    const value = this.db
      .prepare('SELECT value FROM cluster_meta WHERE key=?')
      .get(key)?.value
    return value === undefined ? undefined : JSON.parse(value)
  }

  setMeta(key, value) {
    this.db
      .prepare(
        'INSERT INTO cluster_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, boundedJson(value))
  }

  startController(lineage) {
    return this.transaction(() => {
      const previous = this.meta('controller')
      lineage ||= previous?.lineage || randomUUID()
      identifier(lineage, 'controller lineage')
      if (previous && previous.lineage !== lineage)
        throw clusterError(
          'Controller lineage changed. Use an explicit restore and node enrollment.',
          'lineage_changed',
          409,
        )
      if (
        previous &&
        (!Number.isSafeInteger(previous.epoch) ||
          previous.epoch >= Number.MAX_SAFE_INTEGER)
      )
        throw clusterError('Invalid persisted controller generation.')
      const identity = { lineage, epoch: (previous?.epoch || 0) + 1 }
      this.setMeta('controller', identity)
      for (const attempt of this.list({ active: true })) {
        if (attempt.lineage === lineage && attempt.epoch < identity.epoch)
          this.transition(attempt.id, 'lost', {
            reason: 'controller-restarted',
          })
      }
      return identity
    })
  }

  acceptController(identity, enrolledLineage) {
    identifier(identity?.lineage, 'controller lineage')
    if (!Number.isSafeInteger(identity.epoch) || identity.epoch < 1)
      throw clusterError('Invalid controller generation.')
    if (identity.lineage !== enrolledLineage)
      throw clusterError(
        'This controller lineage is not enrolled.',
        'lineage_changed',
        403,
      )
    return this.transaction(() => {
      const previous = this.meta('acceptedController')
      if (
        previous &&
        (previous.lineage !== identity.lineage ||
          previous.epoch > identity.epoch)
      )
        throw clusterError(
          'Stale controller generation.',
          'stale_generation',
          409,
        )
      this.setMeta('acceptedController', identity)
      return identity
    })
  }

  putNode(value) {
    identifier(value?.id, 'node identifier')
    this.db
      .prepare(
        'INSERT INTO cluster_nodes(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(value.id, boundedJson(value))
    return value
  }

  nodes() {
    return this.db
      .prepare('SELECT payload FROM cluster_nodes ORDER BY id')
      .all()
      .map((row) => JSON.parse(row.payload))
  }

  create(value) {
    identifier(value?.id, 'attempt identifier')
    if (
      this.db
        .prepare('SELECT 1 FROM cluster_cancelled_starts WHERE id=?')
        .get(value.id)
    )
      throw clusterError(
        'This attempt was cancelled before it started.',
        'attempt_cancelled',
        409,
      )
    identifier(value.jobId, 'job identifier')
    identifier(value.lineage, 'controller lineage')
    identifier(value.operation, 'operation')
    digest(value.inputDigest)
    for (const key of ['actor', 'projectId'])
      if (
        value[key] !== undefined &&
        value[key] !== null &&
        (typeof value[key] !== 'string' ||
          value[key].length > 200 ||
          /[\x00-\x1f]/.test(value[key]))
      )
        throw clusterError(`Invalid cluster ${key}.`)
    for (const key of ['nodeId', 'nodeEpoch'])
      if (value[key] !== undefined && value[key] !== null)
        identifier(value[key], key)
    if (value.bundleDigest !== undefined && value.bundleDigest !== null)
      digest(value.bundleDigest)
    if (
      value.imageDigest !== undefined &&
      value.imageDigest !== null &&
      !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest)
    )
      throw clusterError('Invalid worker image identity.')
    if (!Number.isSafeInteger(value.epoch) || value.epoch < 1)
      throw clusterError('Invalid attempt generation.')
    const resources = resourceVector(value.resources)
    const immutable = {
      id: value.id,
      jobId: value.jobId,
      lineage: value.lineage,
      epoch: value.epoch,
      inputDigest: value.inputDigest,
      operation: value.operation,
      resources,
      actor: value.actor ?? null,
      projectId: value.projectId ?? null,
      nodeId: value.nodeId ?? null,
      nodeEpoch: value.nodeEpoch ?? null,
      bundleDigest: value.bundleDigest ?? null,
      imageDigest: value.imageDigest ?? null,
      sourceManifest: value.sourceManifest ?? null,
      dependencies: value.dependencies ?? null,
      toolchain: value.toolchain ?? null,
      file: value.file ?? null,
      timeoutMs: value.timeoutMs ?? null,
    }
    const fingerprint = sha256(boundedJson(immutable))
    const existing = this.db
      .prepare('SELECT fingerprint,payload FROM cluster_attempts WHERE id=?')
      .get(value.id)
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw clusterError(
          'An attempt identifier cannot be reused for different work.',
          'attempt_conflict',
          409,
        )
      return { attempt: JSON.parse(existing.payload), duplicate: true }
    }
    if (
      this.db.prepare('SELECT COUNT(*) AS count FROM cluster_attempts').get()
        .count >= 100000
    )
      throw clusterError(
        'Compact completed cluster receipts during idle maintenance.',
        'storage_full',
        507,
      )
    const state = value.state || 'queued'
    if (!['queued', 'assigned'].includes(state))
      throw clusterError('Invalid initial attempt state.')
    const attempt = {
      ...immutable,
      state,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.db
      .prepare(
        'INSERT INTO cluster_attempts(id,job,node,state,fingerprint,payload) VALUES(?,?,?,?,?,?)',
      )
      .run(
        value.id,
        value.jobId,
        value.nodeId ?? null,
        state,
        fingerprint,
        boundedJson(attempt),
      )
    return { attempt, duplicate: false }
  }

  cancelBeforeStart(id, identity) {
    identifier(id, 'attempt identifier')
    identifier(identity?.lineage, 'controller lineage')
    if (!Number.isSafeInteger(identity.epoch) || identity.epoch < 1)
      throw clusterError('Invalid controller generation.')
    // A missing attempt is not evidence of shutdown: an older start frame can
    // still arrive on another SSH connection. The durable tombstone fences it.
    this.db
      .prepare(
        'INSERT OR IGNORE INTO cluster_cancelled_starts(id,lineage,epoch) VALUES(?,?,?)',
      )
      .run(id, identity.lineage, identity.epoch)
  }

  compactHistory(beforeEpoch) {
    const current = this.meta('controller') || this.meta('acceptedController')
    if (
      !Number.isSafeInteger(beforeEpoch) ||
      beforeEpoch < 1 ||
      beforeEpoch > current?.epoch
    )
      throw clusterError('Invalid history-compaction generation.')
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id FROM cluster_attempts WHERE state IN ('completed','failed','cancelled','interrupted') AND json_extract(payload,'$.epoch')<?",
        )
        .all(beforeEpoch)
      const removeEvents = this.db.prepare(
        'DELETE FROM cluster_events WHERE attempt=?',
      )
      const removeAttempt = this.db.prepare(
        'DELETE FROM cluster_attempts WHERE id=?',
      )
      for (const row of rows) {
        removeEvents.run(row.id)
        removeAttempt.run(row.id)
      }
      this.db
        .prepare('DELETE FROM cluster_cancelled_starts WHERE epoch<?')
        .run(beforeEpoch)
      return { receipts: rows.length }
    })
  }

  get(id) {
    identifier(id, 'attempt identifier')
    const row = this.db
      .prepare('SELECT payload FROM cluster_attempts WHERE id=?')
      .get(id)
    return row ? JSON.parse(row.payload) : null
  }

  list({ active = false, jobId } = {}) {
    const predicates = [],
      values = []
    if (active) {
      predicates.push(
        'state IN (' + activeStates.map(() => '?').join(',') + ')',
      )
      values.push(...activeStates)
    }
    if (jobId !== undefined) {
      predicates.push('job=?')
      values.push(jobId)
    }
    const where = predicates.length ? ' WHERE ' + predicates.join(' AND ') : ''
    return this.db
      .prepare(
        'SELECT payload FROM cluster_attempts' + where + ' ORDER BY rowid',
      )
      .all(...values)
      .map((row) => JSON.parse(row.payload))
  }

  transition(id, state, patch = {}) {
    const current = this.get(id)
    if (!current)
      throw clusterError('Unknown cluster attempt.', 'attempt_missing', 404)
    if (!transitions.get(current.state)?.includes(state))
      throw clusterError(
        `Invalid attempt transition from ${current.state} to ${state}.`,
        'attempt_state',
        409,
      )
    const allowed = {}
    for (const key of [
      'reason',
      'result',
      'error',
      'lastSequence',
      'leaseUntil',
    ])
      if (patch[key] !== undefined) allowed[key] = patch[key]
    const next = {
      ...current,
      ...allowed,
      state,
      updatedAt: new Date().toISOString(),
    }
    const update = this.db
      .prepare(
        'UPDATE cluster_attempts SET state=?,payload=? WHERE id=? AND state=?',
      )
      .run(state, boundedJson(next), id, current.state)
    if (update.changes !== 1)
      throw clusterError(
        'Attempt state changed concurrently.',
        'attempt_state',
        409,
      )
    return next
  }

  assertFence(id, fence) {
    const attempt = this.get(id)
    if (
      !attempt ||
      attempt.lineage !== fence.lineage ||
      attempt.epoch !== fence.epoch ||
      attempt.nodeId !== fence.nodeId ||
      attempt.nodeEpoch !== fence.nodeEpoch ||
      attempt.inputDigest !== fence.inputDigest
    )
      throw clusterError(
        'Stale or mismatched cluster attempt.',
        'stale_attempt',
        409,
      )
    const current = this.meta('controller') || this.meta('acceptedController')
    if (
      !current ||
      current.lineage !== fence.lineage ||
      current.epoch !== fence.epoch
    )
      throw clusterError(
        'Stale controller generation.',
        'stale_generation',
        409,
      )
    if (!activeStates.includes(attempt.state))
      throw clusterError(
        'This attempt no longer accepts results.',
        'stale_attempt',
        409,
      )
    return attempt
  }

  appendEvent(id, sequence, value) {
    if (!Number.isSafeInteger(sequence) || sequence < 1)
      throw clusterError('Invalid worker sequence.')
    if (!this.get(id))
      throw clusterError('Unknown cluster attempt.', 'attempt_missing', 404)
    const payload = boundedJson(value)
    const existing = this.db
      .prepare('SELECT payload FROM cluster_events WHERE attempt=? AND seq=?')
      .get(id, sequence)
    if (existing) {
      if (existing.payload !== payload)
        throw clusterError(
          'Worker sequence was reused with different content.',
          'sequence_conflict',
          409,
        )
      return false
    }
    const last =
      this.db
        .prepare('SELECT MAX(seq) AS seq FROM cluster_events WHERE attempt=?')
        .get(id).seq || 0
    if (sequence !== last + 1)
      throw clusterError(
        'Worker event sequence has a gap.',
        'sequence_gap',
        409,
      )
    this.db
      .prepare('INSERT INTO cluster_events(attempt,seq,payload) VALUES(?,?,?)')
      .run(id, sequence, payload)
    return true
  }

  events(id, after = 0, limit = 128) {
    identifier(id, 'attempt identifier')
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 512
    )
      throw clusterError('Invalid worker event cursor.')
    return this.db
      .prepare(
        'SELECT seq,payload FROM cluster_events WHERE attempt=? AND seq>? ORDER BY seq LIMIT ?',
      )
      .all(id, after, limit)
      .map((row) => ({ sequence: row.seq, value: JSON.parse(row.payload) }))
  }

  close() {
    if (this.owned) this.db.close()
  }
}

export function chooseNode(
  nodes,
  request,
  activeAttempts,
  { allowReserve = false, now = Date.now() } = {},
) {
  const resources = resourceVector(request.resources)
  const candidates = []
  for (const node of nodes) {
    if (
      request.operation === 'check.kernel' &&
      activeAttempts.some(
        (row) =>
          row.nodeId === node.id &&
          row.operation === 'check.kernel' &&
          activeStates.includes(row.state),
      )
    )
      continue
    if (
      node.status !== 'ready' ||
      node.draining ||
      (node.role === 'reserve' && !allowReserve)
    )
      continue
    if (!node.capabilities?.includes(request.operation)) continue
    if (
      node.bundleDigest !== request.bundleDigest ||
      node.imageDigest !== request.imageDigest
    )
      continue
    if (
      !Number.isSafeInteger(node.lastSeen) ||
      now - node.lastSeen > (node.heartbeatTimeoutMs || 15000)
    )
      continue
    const used = activeAttempts
      .filter(
        (row) => row.nodeId === node.id && activeStates.includes(row.state),
      )
      .reduce(
        (total, row) => ({
          memoryBytes: total.memoryBytes + row.resources.memoryBytes,
          cpus: total.cpus + row.resources.cpus,
          scratchBytes: total.scratchBytes + row.resources.scratchBytes,
        }),
        { memoryBytes: 0, cpus: 0, scratchBytes: 0 },
      )
    if (
      ['memoryBytes', 'cpus', 'scratchBytes'].some(
        (key) =>
          !Number.isFinite(node.budget?.[key]) ||
          used[key] + resources[key] > node.budget[key],
      )
    )
      continue
    const share = Math.max(
      used.memoryBytes / node.budget.memoryBytes,
      used.cpus / node.budget.cpus,
    )
    const locality = node.cachedInputs?.includes(request.inputDigest) ? 0.1 : 0
    candidates.push({ node, score: share - locality })
  }
  candidates.sort(
    (left, right) =>
      left.score - right.score || left.node.id.localeCompare(right.node.id),
  )
  return candidates[0]?.node || null
}
