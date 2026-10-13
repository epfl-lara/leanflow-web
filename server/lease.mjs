import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { promises as fs, readFileSync, readlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const studioScript = fileURLToPath(new URL('./studio.mjs', import.meta.url))

/** Linux process identity survives neither PID reuse nor a machine reboot. */
export function processIdentity(pid = process.pid, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) return null
  try {
    const bootId = readFileSync(path.join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim()
    const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
    // /proc comm can contain spaces and parentheses. The final closing bracket
    // separates comm from fields 3 onward; starttime is field 22 (offset 19).
    const close = stat.lastIndexOf(')')
    if (close < 0 || Number(stat.slice(0, stat.indexOf(' '))) !== pid) return null
    const fields = stat.slice(close + 1).trim().split(/\s+/)
    if (!/^[a-f0-9-]{36}$/i.test(bootId) || !/^\d+$/.test(fields[19] || '') || ['Z', 'X', 'x'].includes(fields[0])) return null
    return { pid, bootId, startTime: fields[19] }
  } catch { return null }
}

function legacyStudioProcess(pid, scriptPath) {
  if (!processIdentity(pid)) return false
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    const cwd = readlinkSync(`/proc/${pid}/cwd`)
    return args.some(argument => path.resolve(cwd, argument) === scriptPath)
  } catch { return false }
}

function liveLease(previous, scriptPath) {
  if (!previous || typeof previous !== 'object') return false
  const identity = processIdentity(previous.pid)
  if (!identity) return false
  if (previous.bootId && previous.startTime) return previous.bootId === identity.bootId && previous.startTime === identity.startTime
  // Preserve an active server from the earlier PID-only format while allowing
  // stale records whose PID now belongs to an unrelated process to recover.
  if (previous.bootId === undefined && previous.startTime === undefined) return legacyStudioProcess(previous.pid, scriptPath)
  return false
}

function readLease(filename) {
  try { return JSON.parse(readFileSync(filename, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function guarded(dataDir, operation) {
  const lockFile = path.join(dataDir, '.server-lease.sqlite')
  const db = new DatabaseSync(lockFile)
  try {
    chmodSync(lockFile, 0o600)
    db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS lease_guard (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;')
    try { const result = operation(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  } finally { db.close() }
}

export async function acquireServerLease(dataDir, { scriptPath = studioScript } = {}) {
  dataDir = path.resolve(dataDir)
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  const identity = processIdentity()
  if (!identity) throw new Error('Cannot determine the Linux process identity for the server lease.')
  const filename = path.join(dataDir, 'server.pid')
  const lease = { ...identity, token: randomUUID() }
  guarded(dataDir, () => {
    const previous = readLease(filename)
    if (liveLease(previous, path.resolve(scriptPath))) throw new Error(`A Lemex Web server is already running (PID ${previous.pid}).`)
    try { unlinkSync(filename) } catch (error) { if (error.code !== 'ENOENT') throw error }
    writeFileSync(filename, JSON.stringify(lease), { mode: 0o600, flag: 'wx' })
  })
  const release = async () => {
    guarded(dataDir, () => {
      const current = readLease(filename)
      if (current?.token === lease.token) {
        try { unlinkSync(filename) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    })
  }
  return { filename, lease, release }
}
