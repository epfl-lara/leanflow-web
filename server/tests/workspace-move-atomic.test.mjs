import test from 'node:test'
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { moveWithoutReplacing } from '../workspace-moves.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-atomic-moves-'),
  )
  const handle = await fs.open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  t.after(async () => {
    await handle.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const move = (from, to, kind = 'file') =>
    moveWithoutReplacing({ handle, name: from }, { handle, name: to }, kind)
  return { root, move }
}

test('atomic file moves preserve bytes, inode and mode without retaining a second link', async (t) => {
  const f = await fixture(t)
  const name = 'proof üñïcode.lean'
  await fs.writeFile(
    path.join(f.root, name),
    'example : True := by trivial\n',
    { mode: 0o640 },
  )
  const before = await fs.stat(path.join(f.root, name))
  await f.move(name, 'Renamed.lean')
  const after = await fs.stat(path.join(f.root, 'Renamed.lean'))
  assert.equal(after.ino, before.ino)
  assert.equal(after.mode, before.mode)
  assert.equal(after.nlink, 1)
  assert.equal(
    await fs.readFile(path.join(f.root, 'Renamed.lean'), 'utf8'),
    'example : True := by trivial\n',
  )
  assert.deepEqual(await fs.readdir(f.root), ['Renamed.lean'])
})

test('racing moves to the same destination preserve the losing source for files and folders', async (t) => {
  for (const kind of ['file', 'folder']) {
    const f = await fixture(t)
    for (const name of ['A', 'B']) {
      if (kind === 'folder') await fs.mkdir(path.join(f.root, name))
      await fs.writeFile(
        path.join(f.root, name, ...(kind === 'folder' ? ['proof.lean'] : [])),
        name,
      )
    }
    const results = await Promise.allSettled([
      f.move('A', 'Moved', kind),
      f.move('B', 'Moved', kind),
    ])
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    )
    const failure = results.find((result) => result.status === 'rejected')
    assert.equal(failure.reason.status, 409)
    assert(!failure.reason.message.includes('/proc/'))
    const winner = results[0].status === 'fulfilled' ? 'A' : 'B'
    const loser = winner === 'A' ? 'B' : 'A'
    const content = (name) =>
      fs.readFile(
        path.join(f.root, name, ...(kind === 'folder' ? ['proof.lean'] : [])),
        'utf8',
      )
    assert.equal(await content('Moved'), winner)
    assert.equal(await content(loser), loser)
    await assert.rejects(fs.stat(path.join(f.root, winner)), { code: 'ENOENT' })
  }
})

test('an occupied destination, including an empty directory, is never replaced', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.root, 'Source'))
  await fs.mkdir(path.join(f.root, 'Existing'))
  await fs.writeFile(path.join(f.root, 'Source', 'proof.lean'), 'keep source')
  const before = await fs.stat(path.join(f.root, 'Existing'))
  await assert.rejects(f.move('Source', 'Existing', 'folder'), { status: 409 })
  assert.equal((await fs.stat(path.join(f.root, 'Existing'))).ino, before.ino)
  assert.equal(
    await fs.readFile(path.join(f.root, 'Source', 'proof.lean'), 'utf8'),
    'keep source',
  )
  assert.deepEqual(await fs.readdir(path.join(f.root, 'Existing')), [])
})

test('a missing source produces an actionable error without leaving a destination', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.move('Gone.lean', 'New.lean'), (error) => {
    assert.equal(error.status, 404)
    assert(!error.message.includes('/proc/'))
    return true
  })
  assert.deepEqual(await fs.readdir(f.root), [])
})

function failRunner(t, error, beforeClose = async () => {}) {
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    queueMicrotask(async () => {
      await beforeClose()
      child.emit('error', error)
      child.emit('close', null)
    })
    return child
  })
}

test('transient helper failures offer a retry and leave the source intact', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'Old.lean'), 'source')
  failRunner(
    t,
    Object.assign(new Error('spawn resource limit'), { code: 'EAGAIN' }),
  )
  await assert.rejects(f.move('Old.lean', 'Moved.lean'), (error) => {
    assert.equal(error.status, 503)
    assert.match(error.message, /try again shortly/i)
    assert.doesNotMatch(error.message, /unavailable|resource limit/)
    return true
  })
  assert.deepEqual(await fs.readdir(f.root), ['Old.lean'])
})

test('an absent helper reports that safe moves are unavailable without exposing process errors', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'Old.lean'), 'source')
  failRunner(
    t,
    Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }),
  )
  await assert.rejects(f.move('Old.lean', 'Moved.lean'), (error) => {
    assert.equal(error.status, 503)
    assert.match(error.message, /safe file moves are unavailable/i)
    assert.doesNotMatch(error.message, /python3|ENOENT/)
    return true
  })
  assert.deepEqual(await fs.readdir(f.root), ['Old.lean'])
})

test('a timed out move offers a location check and leaves an untouched source intact', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'Old.lean'), 'source')
  failRunner(
    t,
    Object.assign(new Error('aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    }),
  )
  await assert.rejects(f.move('Old.lean', 'Moved.lean'), (error) => {
    assert.equal(error.status, 504)
    assert.match(error.message, /refresh.*location before retrying/i)
    return true
  })
  assert.deepEqual(await fs.readdir(f.root), ['Old.lean'])
})

test('a move committed just before timeout is acknowledged as successful', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, 'Old.lean'), 'source')
  const before = await fs.stat(path.join(f.root, 'Old.lean'))
  failRunner(
    t,
    Object.assign(new Error('aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    }),
    () =>
      fs.rename(path.join(f.root, 'Old.lean'), path.join(f.root, 'Moved.lean')),
  )
  await f.move('Old.lean', 'Moved.lean')
  assert.deepEqual(await fs.readdir(f.root), ['Moved.lean'])
  assert.equal((await fs.stat(path.join(f.root, 'Moved.lean'))).ino, before.ino)
  assert.equal(
    await fs.readFile(path.join(f.root, 'Moved.lean'), 'utf8'),
    'source',
  )
})
