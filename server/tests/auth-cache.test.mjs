import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
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

test('25 concurrent invitations and EPFL signups survive an administrator adding and removing accounts from another process', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-auth-cohort-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const auth = new Auth(directory)
  await auth.init()
  const owner = auth.users[0]
  const revoked = await auth.createUser(owner, { name: 'Previous participant' })
  const accounts = Array.from({ length: 24 }, (_, index) => {
    const separateWriter = new Auth(directory)
    const name = `Participant ${index + 1}`
    if (index % 2 === 0) return separateWriter.createUser(owner, { name })
    const identity = {
      name,
      tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      objectId: `11111111-2222-3333-4444-${String(index).padStart(12, '0')}`,
    }
    return separateWriter
      .signInEntra(identity, { allowSignup: true })
      .then((user) => ({ user, identity }))
  })
  const cli = promisify(execFile)
  const options = { env: { ...process.env, STUDIO_DATA_DIR: directory } }
  const tokenFile = path.join(directory, 'fixture.token')
  const [, , ...created] = await Promise.all([
    cli(
      process.execPath,
      [
        fileURLToPath(
          new URL('../../scripts/remove-user.mjs', import.meta.url),
        ),
        revoked.user.id,
      ],
      options,
    ),
    cli(
      process.execPath,
      [
        fileURLToPath(new URL('../../scripts/add-user.mjs', import.meta.url)),
        'Participant 25',
        'user',
        tokenFile,
      ],
      options,
    ),
    ...accounts,
  ])
  const reopened = new Auth(directory)
  await reopened.init()
  assert.equal(reopened.users.length, 26)
  assert.equal(reopened.isActive(revoked.user.id), false)
  for (const { user, token, identity } of created) {
    const login = identity
      ? await reopened.signInEntra(identity)
      : await reopened.login(token, 'fixture-ip')
    assert.equal(login.id, user.id)
  }
  assert.equal(
    (await reopened.login(await fs.readFile(tokenFile, 'utf8'), 'fixture-ip'))
      .name,
    'Participant 25',
  )
})

test('readers see the saved profile while another account update is pending or fails', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-auth-profile-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const auth = new Auth(directory)
  await auth.init()
  const { user, token } = await auth.createUser(auth.users[0], {
    name: 'Original name',
  })
  const session = { headers: { cookie: auth.cookie(user).split(';')[0] } }
  assert.equal(auth.identify(session).name, 'Original name')
  const { resolve: entered, promise: pending } = Promise.withResolvers()
  const { resolve: finish, promise: blocked } = Promise.withResolvers()
  t.mock.method(fs, 'rename', async () => {
    entered()
    await blocked
    throw Object.assign(new Error('Fixture storage unavailable'), {
      code: 'EIO',
    })
  })
  const rejected = assert.rejects(
    auth.updateProfile(user, { name: 'Pending name' }),
    { code: 'EIO' },
  )
  await pending
  try {
    assert.equal(auth.identify(session).name, 'Original name')
    assert.equal((await auth.login(token, 'fixture-ip')).name, 'Original name')
    assert.equal(
      auth.users.find((account) => account.id === user.id).name,
      'Original name',
    )
  } finally {
    finish()
    await rejected
  }
  assert.equal(auth.identify(session).name, 'Original name')
})

test('removing an exact account ID selects that account even when another participant uses it as a display name', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-auth-remove-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const auth = new Auth(directory)
  await auth.init()
  const owner = auth.users[0]
  const earlier = await auth.createUser(owner, { name: 'Participant' })
  const duplicate = await auth.createUser(owner, { name: 'Duplicate account' })
  await auth.updateProfile(earlier.user, { name: duplicate.user.id })
  assert.equal((await auth.removeUser(duplicate.user.id)).id, duplicate.user.id)
  assert.equal(auth.isActive(duplicate.user.id), false)
  assert.equal(auth.isActive(earlier.user.id), true)
  await assert.rejects(auth.removeUser(owner.id), /owner account/)
  assert.equal(auth.isActive(owner.id), true)
})
