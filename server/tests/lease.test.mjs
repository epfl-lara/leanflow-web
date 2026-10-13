import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireServerLease, processIdentity } from '../lease.mjs'

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lemex-lease-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('live lease blocks a second server and release only removes its own token', async t => {
  const root = await directory(t)
  const first = await acquireServerLease(root)
  assert.deepEqual({ pid: first.lease.pid, bootId: first.lease.bootId, startTime: first.lease.startTime }, processIdentity())
  assert.equal((await fs.stat(first.filename)).mode & 0o777, 0o600)
  await assert.rejects(acquireServerLease(root), /already running/)
  await first.release()
  const second = await acquireServerLease(root)
  await first.release()
  assert.equal(JSON.parse(await fs.readFile(second.filename, 'utf8')).token, second.lease.token)
  await second.release()
  await assert.rejects(fs.stat(second.filename), { code: 'ENOENT' })
});

test('crashed server records with a reused PID or previous boot do not block startup', async t => {
  const root = await directory(t), identity = processIdentity()
  assert.ok(identity)
  for (const stale of [
    { ...identity, startTime: String(BigInt(identity.startTime) - 1n), token: 'crashed-server' },
    { ...identity, bootId: '00000000-0000-0000-0000-000000000000', token: 'previous-boot' },
    { ...identity, pid: 2147483647, token: 'dead-process' },
    { pid: process.pid, token: 'legacy-unrelated-process' },
  ]) {
    await fs.writeFile(path.join(root, 'server.pid'), JSON.stringify(stale))
    const current = await acquireServerLease(root)
    assert.notEqual(current.lease.token, stale.token)
    await current.release()
  }
  await fs.writeFile(path.join(root, 'server.pid'), '{"pid":')
  const recovered = await acquireServerLease(root)
  await recovered.release()
});

test('concurrent startup has a single winner', async t => {
  const root = await directory(t)
  const acquired = await Promise.allSettled([acquireServerLease(root), acquireServerLease(root)])
  assert.equal(acquired.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(acquired.filter(result => result.status === 'rejected' && /already running/.test(result.reason.message)).length, 1)
  await acquired.find(result => result.status === 'fulfilled').value.release()
});

test('an active server with a legacy PID-only record is preserved during upgrade', async t => {
  const root = await directory(t), scriptPath = path.join(root, 'legacy-server.mjs')
  await fs.writeFile(scriptPath, 'setInterval(() => {}, 1000)\n')
  const child = spawn(process.execPath, [scriptPath], { stdio: 'ignore' })
  await once(child, 'spawn')
  try {
    await fs.writeFile(path.join(root, 'server.pid'), JSON.stringify({ pid: child.pid, token: 'legacy-server-token' }))
    await assert.rejects(acquireServerLease(root, { scriptPath }), /already running/)
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'server.pid'), 'utf8')).token, 'legacy-server-token')
  } finally { child.kill(); await once(child, 'exit') }
});

test('Linux stat parsing handles spaces and parentheses in comm and treats zombies as dead', async t => {
  const root = await directory(t), pid = 123
  await fs.mkdir(path.join(root, 'sys/kernel/random'), { recursive: true })
  await fs.mkdir(path.join(root, String(pid)))
  const bootId = '11111111-2222-3333-4444-555555555555'
  await fs.writeFile(path.join(root, 'sys/kernel/random/boot_id'), bootId + '\n')
  const fields = Array(20).fill('0'); fields[0] = 'S'; fields[19] = '12345678901234567890'
  const stat = state => `${pid} (a worker) with spaces) ${[state, ...fields.slice(1)].join(' ')}\n`
  await fs.writeFile(path.join(root, String(pid), 'stat'), stat('S'))
  assert.deepEqual(processIdentity(pid, root), { pid, bootId, startTime: fields[19] })
  await fs.writeFile(path.join(root, String(pid), 'stat'), stat('Z'))
  assert.equal(processIdentity(pid, root), null)
  assert.equal(processIdentity(0, root), null)
  assert.equal(processIdentity(-1, root), null)
});
