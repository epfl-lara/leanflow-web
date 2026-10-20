import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Auth } from '../auth.mjs'

for (const replacement of ['atomic', 'in-place']) {
  test(`account cache sees ${replacement} revocation with the same size and modification time`, async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'leanflow-auth-cache-'),
    )
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const auth = new Auth(directory)
    await auth.init()
    const filename = path.join(auth.dir, 'users.json')
    const original = await fs.readFile(filename, 'utf8')
    const token = (
      await fs.readFile(path.join(auth.dir, 'owner.token'), 'utf8')
    ).trim()
    const stamp = new Date('2026-01-01T00:00:00Z')
    await fs.utimes(filename, stamp, stamp)
    const cookie = auth.cookie(auth.users[0]).split(';')[0]
    const request = { headers: { cookie } }
    assert.equal(auth.identify(request).id, 'owner')
    const removed = original.replace('"id": "owner"', '"id": "other"')
    assert.notEqual(removed, original)
    assert.equal(removed.length, original.length)
    const target = replacement === 'atomic' ? filename + '.next' : filename
    await fs.writeFile(target, removed, { mode: 0o600 })
    await fs.utimes(target, stamp, stamp)
    if (target !== filename) await fs.rename(target, filename)
    assert.equal(auth.identify(request), null)
    assert.equal(
      auth.identify({ headers: { authorization: `Bearer ${token}` } }).id,
      'other',
    )
    // Restoring the exact original timestamp and content must also be seen.
    await fs.writeFile(filename, original)
    await fs.utimes(filename, stamp, stamp)
    assert.equal(auth.identify(request).id, 'owner')
    await fs.rm(filename)
    assert.equal(auth.identify(request), null)
  })
}

test('failed sign-in tracking remains bounded with many client addresses', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-auth-cache-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const auth = new Auth(directory)
  await auth.init()
  for (let client = 0; client < 1100; client++)
    await assert.rejects(auth.login('invalid', `fixture-${client}`), {
      status: 401,
    })
  assert(auth.attempts.size <= 1000)
  for (let attempt = 1; attempt < 12; attempt++)
    await assert.rejects(auth.login('invalid', 'fixture-1099'), { status: 401 })
  await assert.rejects(auth.login('invalid', 'fixture-1099'), { status: 429 })
})
