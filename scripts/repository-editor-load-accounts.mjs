// Operator helper for the disposable identities used by the repository editor gate.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Auth } from '../server/auth.mjs'
import { loadTestSetting } from './lib/compile-load-fixture.mjs'

assert.equal(process.env.STUDIO_RUN_LIVE_LOAD_TEST, '1')
const action = process.argv[2]
assert(['prepare', 'clean'].includes(action), 'Choose prepare or clean.')
const file = path.resolve(loadTestSetting('STUDIO_LOAD_FIXTURE'))
const stat = await fs.lstat(path.dirname(file))
assert(
  stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077),
  'Use a private account-owned fixture directory.',
)
const data = await fs.realpath(loadTestSetting('STUDIO_LOAD_DATA_DIR'))
await fs.access(path.join(data, 'auth/users.json'))
const auth = new Auth(data)
if (action === 'prepare') {
  const runTag =
    'LF load ' +
    new Date().toISOString().slice(0, 10).replaceAll('-', '') +
    ' ' +
    randomBytes(4).toString('hex')
  const accounts = []
  const json = () => JSON.stringify({ runTag, accounts }) + '\n'
  await fs.writeFile(file, json(), { mode: 0o600, flag: 'wx' })
  for (let i = 1; i <= 20; i++) {
    const name = runTag + ' U' + String(i).padStart(2, '0')
    const result = await auth.createUser(
      { id: 'owner' },
      { name, role: 'user' },
    )
    accounts.push({ id: result.user.id, name, token: result.token })
    const temporary = file + '.' + randomBytes(8).toString('hex')
    try {
      await fs.writeFile(temporary, json(), {
        mode: 0o600,
        flag: 'wx',
        flush: true,
      })
      await fs.rename(temporary, file)
    } catch (error) {
      await auth.removeUser(result.user.id)
      await fs.rm(temporary, { force: true })
      throw error
    }
  }
  console.log('Prepared ' + accounts.length + ' ordinary disposable accounts.')
} else {
  const stat = await fs.lstat(file)
  assert(
    stat.isFile() &&
      stat.nlink === 1 &&
      stat.uid === process.getuid() &&
      !(stat.mode & 0o077),
  )
  const { runTag, accounts } = JSON.parse(await fs.readFile(file, 'utf8'))
  assert(/^LF load \d{8} [a-f0-9]{8}$/.test(runTag))
  assert(Array.isArray(accounts) && accounts.length <= 20)
  const originURL = new URL(loadTestSetting('STUDIO_LOAD_ORIGIN'))
  assert(
    originURL.protocol === 'https:' ||
      ['localhost', '127.0.0.1', '[::1]'].includes(originURL.hostname),
  )
  const origin = originURL.origin
  for (const [i, account] of accounts.entries()) {
    assert.equal(account.name, runTag + ' U' + String(i + 1).padStart(2, '0'))
    assert.match(account.id, /^[a-f0-9]{24}$/)
    const headers = {
      Authorization: 'Bearer ' + account.token,
      Origin: origin,
      'X-LeanFlow-User': account.id,
    }
    const response = await fetch(origin + '/api/session', {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
    // A previous partial cleanup may have revoked this exact account already.
    if (response.status === 401) {
      await auth.refreshUsers()
      if (!auth.users.some((u) => u.id === account.id)) continue
    }
    assert.equal(response.status, 200)
    const { user } = await response.json()
    assert.equal(user.id, account.id)
    assert.equal(user.name, account.name)
    assert.equal(user.role, 'user')
    for (const endpoint of ['/api/projects', '/api/trash']) {
      const res = await fetch(origin + endpoint, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
      assert(res.ok)
      assert.equal(
        (await res.json()).length,
        0,
        'Remove remaining fixture work before revoking its account.',
      )
    }
    const removed = await auth.removeUser(account.id)
    assert.equal(removed.id, account.id)
  }
  await fs.unlink(file)
  console.log(
    'Revoked disposable accounts and removed their private token manifest.',
  )
}
