import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  managedWorkerDirectory,
  managedWorkerFile,
  copyManagedWorkerTree,
} from '../managed-worker-files.mjs'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-worker-'))
  const home = path.join(directory, 'home'),
    outside = path.join(directory, 'outside')
  fs.mkdirSync(home)
  fs.mkdirSync(outside)
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, home, outside }
}

test('managed worker files preserve exact bytes and bound reads and writes before truncation', (t) => {
  const { home } = fixture(t)
  managedWorkerDirectory(home, '.cache/lake', () => {}, { create: true })
  const bytes = Buffer.from([0, 255, 128, 65])
  assert.equal(managedWorkerFile(home, '.cache/lake/missing'), null)
  managedWorkerFile(home, '.cache/lake/map', { content: bytes })
  assert.deepEqual(
    managedWorkerFile(home, '.cache/lake/map', { encoding: null }),
    bytes,
  )
  assert.throws(
    () => managedWorkerFile(home, '.cache/lake/map', { maxBytes: 3 }),
    /too large/,
  )
  assert.throws(
    () =>
      managedWorkerFile(home, '.cache/lake/map', {
        content: 'too big',
        maxBytes: 2,
      }),
    /too large/,
  )
  assert.deepEqual(fs.readFileSync(path.join(home, '.cache/lake/map')), bytes)
  for (const relative of [
    '../outside',
    '/absolute',
    'nested//file',
    'a\\b',
    'a\0b',
  ])
    assert.throws(() => managedWorkerFile(home, relative), /Invalid managed/)
})

test('managed writes reject symlinks and hardlinks without changing their targets', (t) => {
  const { home, outside } = fixture(t)
  const target = path.join(outside, 'settings.toml')
  fs.writeFileSync(target, 'protected')
  fs.symlinkSync(outside, path.join(home, '.elan'))
  assert.throws(() =>
    managedWorkerFile(home, '.elan/settings.toml', { content: 'changed' }),
  )
  fs.unlinkSync(path.join(home, '.elan'))
  fs.mkdirSync(path.join(home, '.elan'))
  const filename = path.join(home, '.elan/settings.toml')
  fs.symlinkSync(target, filename)
  assert.throws(() =>
    managedWorkerFile(home, '.elan/settings.toml', { content: 'changed' }),
  )
  fs.unlinkSync(filename)
  fs.linkSync(target, filename)
  assert.throws(
    () =>
      managedWorkerFile(home, '.elan/settings.toml', { content: 'changed' }),
    /without hardlinks/,
  )
  assert.equal(fs.readFileSync(target, 'utf8'), 'protected')
})

test('managed file writes pin a parent renamed after it was opened', (t) => {
  const { home, outside } = fixture(t)
  const parent = path.join(home, '.elan'),
    moved = path.join(home, 'old-elan')
  fs.mkdirSync(parent)
  fs.writeFileSync(path.join(parent, 'settings.toml'), 'original')
  fs.writeFileSync(path.join(outside, 'settings.toml'), 'protected')
  const original = fs.openSync
  let swapped = false
  const mock = t.mock.method(fs, 'openSync', (...args) => {
    const fd = original(...args)
    if (!swapped && String(args[0]).endsWith('/.elan')) {
      swapped = true
      fs.renameSync(parent, moved)
      fs.symlinkSync(outside, parent)
    }
    return fd
  })
  try {
    managedWorkerFile(home, '.elan/settings.toml', { content: 'changed' })
  } finally {
    mock.mock.restore()
  }
  assert.equal(swapped, true)
  assert.equal(
    fs.readFileSync(path.join(outside, 'settings.toml'), 'utf8'),
    'protected',
  )
  assert.equal(
    fs.readFileSync(path.join(moved, 'settings.toml'), 'utf8'),
    'changed',
  )
})

test('managed directory creation stays inside an opened parent during a symlink swap', (t) => {
  const { home, outside } = fixture(t)
  const parent = path.join(home, '.cache'),
    moved = path.join(home, 'old-cache')
  fs.mkdirSync(parent)
  const original = fs.openSync
  let swapped = false
  const mock = t.mock.method(fs, 'openSync', (...args) => {
    const fd = original(...args)
    if (!swapped && String(args[0]).endsWith('/.cache')) {
      swapped = true
      fs.renameSync(parent, moved)
      fs.symlinkSync(outside, parent)
    }
    return fd
  })
  try {
    managedWorkerDirectory(home, '.cache/lake', () => {}, { create: true })
  } finally {
    mock.mock.restore()
  }
  assert.equal(swapped, true)
  assert.deepEqual(fs.readdirSync(outside), [])
  assert(fs.statSync(path.join(moved, 'lake')).isDirectory())
})

for (const writing of [false, true])
  test(`managed FIFO ${writing ? 'write' : 'read'} rejects promptly`, (t) => {
    const { home } = fixture(t)
    const fifo = path.join(home, 'fifo')
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict'
      import {managedWorkerFile} from ${JSON.stringify(new URL('../managed-worker-files.mjs', import.meta.url).href)}
      assert.throws(() => managedWorkerFile(process.argv[1], 'fifo', ${writing ? "{content: 'changed'}" : '{}'}))
      console.log('rejected')
    `,
        home,
      ],
      { encoding: 'utf8', timeout: 3000 },
    )
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /rejected/)
  })

test('cache lookup copies preserve binary bytes and reject source or destination links', (t) => {
  const { home, outside } = fixture(t)
  const source = path.join(home, 'source'),
    target = path.join(home, 'target')
  fs.mkdirSync(path.join(source, 'outputs/nested'), { recursive: true })
  fs.mkdirSync(target)
  const content = Buffer.from([0, 255, 128, 65])
  fs.writeFileSync(path.join(source, 'outputs/nested/map'), content)
  copyManagedWorkerTree(source, 'outputs', target, 'outputs')
  assert.deepEqual(
    fs.readFileSync(path.join(target, 'outputs/nested/map')),
    content,
  )
  fs.writeFileSync(path.join(outside, 'private'), 'protected')
  fs.symlinkSync(
    path.join(outside, 'private'),
    path.join(source, 'outputs/link'),
  )
  assert.throws(
    () => copyManagedWorkerTree(source, 'outputs', target, 'outputs'),
    /only regular/,
  )
  fs.unlinkSync(path.join(source, 'outputs/link'))
  fs.rmSync(path.join(target, 'outputs'), { recursive: true })
  fs.symlinkSync(outside, path.join(target, 'outputs'))
  assert.throws(() =>
    copyManagedWorkerTree(source, 'outputs', target, 'outputs'),
  )
  assert.deepEqual(fs.readdirSync(outside), ['private'])
  assert.equal(
    fs.readFileSync(path.join(outside, 'private'), 'utf8'),
    'protected',
  )
})

test('cache lookup copies reject a directory swapped after source listing', (t) => {
  const { home, outside } = fixture(t)
  fs.mkdirSync(path.join(home, 'outputs/nested'), { recursive: true })
  fs.mkdirSync(path.join(home, 'target'))
  fs.writeFileSync(path.join(outside, 'private'), 'protected')
  const original = fs.readdirSync
  let swapped = false
  const mock = t.mock.method(fs, 'readdirSync', (...args) => {
    const entries = original(...args)
    if (!swapped && fs.realpathSync(args[0]) === path.join(home, 'outputs')) {
      swapped = true
      fs.renameSync(
        path.join(home, 'outputs/nested'),
        path.join(home, 'original'),
      )
      fs.symlinkSync(outside, path.join(home, 'outputs/nested'))
    }
    return entries
  })
  try {
    assert.throws(() => copyManagedWorkerTree(home, 'outputs', home, 'target'))
  } finally {
    mock.mock.restore()
  }
  assert.equal(swapped, true)
  assert.deepEqual(fs.readdirSync(path.join(home, 'target')), [])
})
