import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import childProcess from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  createTerminalReconciliation,
  queueTerminalChanges,
  reconcileTerminal,
  preserveTerminalBackups,
  recoverTerminalBackups,
  TERMINAL_RECOVERY_DIRECTORY,
} from '../terminal-reconcile.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
async function fixture(t, files = { 'Main.lean': '-- original\n' }) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'leanflow-terminal-pull-'),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const sharedRoot = path.join(directory, 'shared')
  const container = path.join(directory, 'copy')
  const root = path.join(container, 'workspace')
  for (const base of [sharedRoot, root, path.join(container, 'baseline')]) {
    await fs.mkdir(base, { recursive: true })
    for (const [filename, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(base, filename)), {
        recursive: true,
      })
      await fs.writeFile(path.join(base, filename), content)
    }
  }
  const openParent = async (base, filename, { create = true } = {}) => {
    const parts = filename.split('/')
    const name = parts.pop()
    let current = base
    let handle = await fs.open(
      base,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      for (const part of parts) {
        const anchored = `/proc/self/fd/${handle.fd}/${part}`
        if (create)
          await fs.mkdir(anchored).catch((error) => {
            if (error.code !== 'EEXIST') throw error
          })
        const next = await fs.open(
          anchored,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        await handle.close()
        handle = next
        current = path.join(current, part)
        assert.equal(await fs.realpath(`/proc/self/fd/${handle.fd}`), current)
      }
      return { handle, anchor: `/proc/self/fd/${handle.fd}`, name }
    } catch (error) {
      await handle.close()
      throw error
    }
  }
  const context = {
    state: createTerminalReconciliation(),
    manifest: {
      root,
      files: Object.entries(files).map(([filename, content]) => ({
        path: filename,
        hash: hash(content),
      })),
    },
    container,
    sharedRoot,
    openParent,
    authorize() {},
  }
  return {
    ...context,
    context,
    event(paths, moves = [], removedPaths = []) {
      queueTerminalChanges(context.state, {
        kind: 'files',
        paths,
        moves,
        removedPaths,
      })
    },
    pull(previousChanges = []) {
      return reconcileTerminal({ ...context, previousChanges })
    },
    read(filename) {
      return fs.readFile(path.join(root, filename), 'utf8')
    },
  }
}

test('an authoritative folder move carries dirty files, private-only files and the live directory inode', async (t) => {
  const f = await fixture(t, { 'Old/A.lean': '-- original\n' })
  const directory = await fs.open(
    path.join(f.manifest.root, 'Old'),
    constants.O_RDONLY | constants.O_DIRECTORY,
  )
  t.after(() => directory.close())
  await fs.writeFile(path.join(f.manifest.root, 'Old/A.lean'), '-- private\n')
  await fs.writeFile(path.join(f.manifest.root, 'Old/Private.txt'), 'keep me')
  await fs.rename(
    path.join(f.sharedRoot, 'Old'),
    path.join(f.sharedRoot, 'New'),
  )
  f.event(['Old', 'New'], [{ from: 'Old', to: 'New' }], ['Old'])
  const previous = await f.pull()
  assert.equal(
    await fs.realpath(`/proc/self/fd/${directory.fd}`),
    path.join(f.manifest.root, 'New'),
  )
  assert.equal(await f.read('New/A.lean'), '-- private\n')
  assert.equal(await f.read('New/Private.txt'), 'keep me')
  assert.equal(
    previous.find((change) => change.path === 'New/A.lean').after,
    '-- original\n',
  )
  assert.equal(
    previous.find((change) => change.path === 'Old/A.lean').after,
    null,
  )
  assert.equal(f.state.deletedPaths.has('Old'), true)
})

test('clean project updates rebase a previously published terminal edit without reverting it on the next push', async (t) => {
  const f = await fixture(t)
  const previous = [
    {
      path: 'Main.lean',
      before: '-- original\n',
      beforeHash: hash('-- original\n'),
      after: '-- published\n',
    },
  ]
  await fs.writeFile(path.join(f.manifest.root, 'Main.lean'), '-- published\n')
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  assert.equal((await f.pull(previous))[0].after, '-- browser\n')
  assert.equal(await f.read('Main.lean'), '-- browser\n')
  assert.deepEqual(await f.pull(previous), f.state.previousChanges)
  await fs.writeFile(
    path.join(f.manifest.root, 'Main.lean'),
    '-- new private\n',
  )
  assert.equal((await f.pull(previous))[0].after, '-- browser\n')
  assert.equal(await f.read('Main.lean'), '-- new private\n')
})

test('multiple queued folder moves preserve private directory and file identities through intermediate missing shared paths', async (t) => {
  const f = await fixture(t, { 'First/Main.lean': '-- original\n' })
  const before = await fs.stat(path.join(f.manifest.root, 'First/Main.lean'))
  await fs.rename(
    path.join(f.sharedRoot, 'First'),
    path.join(f.sharedRoot, 'Second'),
  )
  f.event(['First', 'Second'], [{ from: 'First', to: 'Second' }], ['First'])
  await fs.rename(
    path.join(f.sharedRoot, 'Second'),
    path.join(f.sharedRoot, 'Final'),
  )
  f.event(['Second', 'Final'], [{ from: 'Second', to: 'Final' }], ['Second'])
  await f.pull()
  assert.equal(
    (await fs.stat(path.join(f.manifest.root, 'Final/Main.lean'))).ino,
    before.ino,
  )
  assert.equal(await f.read('Final/Main.lean'), '-- original\n')
  assert.equal(f.state.backups.length, 0)
})

test('pulling shared writes preserves independently dirty private bytes and their old CAS baseline', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.manifest.root, 'Main.lean'), '-- private\n')
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  assert.deepEqual(await f.pull(), [])
  assert.equal(await f.read('Main.lean'), '-- private\n')
  assert.equal(
    await fs.readFile(path.join(f.sharedRoot, 'Main.lean'), 'utf8'),
    '-- browser\n',
  )
})

test('already captured and own published moves do not move or overwrite a new file at the old path', async (t) => {
  const f = await fixture(t, { 'New.lean': '-- already moved\n' })
  await fs.writeFile(
    path.join(f.manifest.root, 'Old.lean'),
    '-- private old path\n',
  )
  f.event(
    ['Old.lean', 'New.lean'],
    [{ from: 'Old.lean', to: 'New.lean' }],
    ['Old.lean'],
  )
  await f.pull()
  assert.equal(await f.read('New.lean'), '-- already moved\n')
  assert.equal(await f.read('Old.lean'), '-- private old path\n')
  assert.equal(f.state.deletedPaths.has('Old.lean'), true)
})

test('moves of binary assets follow the private file and do not create editable publication records', async (t) => {
  const bytes = Buffer.from([137, 80, 78, 71, 0, 1, 2])
  const f = await fixture(t, { 'Old/image.png': bytes })
  await fs.rename(
    path.join(f.sharedRoot, 'Old'),
    path.join(f.sharedRoot, 'New'),
  )
  f.event(['Old', 'New'], [{ from: 'Old', to: 'New' }], ['Old'])
  assert.deepEqual(await f.pull(), [])
  assert.deepEqual(
    await fs.readFile(path.join(f.manifest.root, 'New/image.png')),
    bytes,
  )
  assert.equal(f.state.ignoredPaths.has('Old/image.png'), true)
  assert.equal(f.state.ignoredPaths.has('New/image.png'), true)
  await fs.rename(
    path.join(f.sharedRoot, 'New'),
    path.join(f.sharedRoot, 'Final'),
  )
  f.event(['New', 'Final'], [{ from: 'New', to: 'Final' }], ['New'])
  assert.deepEqual(await f.pull(), [])
  assert.deepEqual(
    await fs.readFile(path.join(f.manifest.root, 'Final/image.png')),
    bytes,
  )
})

test('a late write through an old descriptor is retained at a downloadable recovery path', async (t) => {
  const f = await fixture(t)
  const old = await fs.open(path.join(f.manifest.root, 'Main.lean'), 'r+')
  t.after(() => old.close())
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  await f.pull()
  await old.truncate(0)
  await old.writeFile('-- delayed terminal write\n')
  await assert.rejects(f.pull(), { status: 409 })
  assert.equal(await f.read('Main.lean'), '-- browser\n')
  const folders = await fs.readdir(
    path.join(f.manifest.root, TERMINAL_RECOVERY_DIRECTORY),
  )
  assert.equal(folders.length, 1)
  assert.equal(
    await f.read(`${TERMINAL_RECOVERY_DIRECTORY}/${folders[0]}/Main.lean`),
    '-- delayed terminal write\n',
  )
})

test('clean displaced files compact when the kernel proves no descriptor or hardlink can write them', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  await f.pull()
  assert.equal(f.state.backups.length, 1)
  await f.pull()
  assert.equal(f.state.backups.length, 0)
  assert.equal(f.state.backupBytes, 0)
})

test('partial compaction acknowledgements cannot turn already removed backups into conflicts', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  await f.pull()
  await fs.unlink(path.join(f.container, f.state.backups[0].filename))
  await f.pull()
  assert.equal(f.state.backups.length, 0)
  assert.equal(f.state.backupBytes, 0)
  assert.equal(await f.read('Main.lean'), '-- browser\n')
})

test('queued updates bound aggregate paths even when each event contains many files', () => {
  const state = createTerminalReconciliation()
  const paths = Array.from(
    { length: 1000 },
    (_, index) => `Proofs/${index}.lean`,
  )
  for (let index = 0; index < 13; index++)
    queueTerminalChanges(state, {
      kind: 'files',
      paths,
      removedPaths: [],
      moves: [],
    })
  assert.equal(state.overflow, true)
  assert.equal(state.queuedEntries, 12000)
  assert.equal(state.pendingEvents.length, 12)
})

test('the pull time budget preserves private files and reports how to reopen the latest copy', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  let time = 0
  f.context.now = () => {
    time += 6000
    return time
  }
  await assert.rejects(
    f.pull(),
    (error) =>
      error.code === 'TERMINAL_RECONCILIATION_LIMIT' &&
      /private files are preserved/i.test(error.message) &&
      /reopen/i.test(error.message),
  )
  assert.equal(await f.read('Main.lean'), '-- original\n')
  assert.equal(
    await fs.readFile(path.join(f.sharedRoot, 'Main.lean'), 'utf8'),
    '-- browser\n',
  )
})

test('committed folder removal prunes only an empty private folder and retains private contents', async (t) => {
  const f = await fixture(t, { 'Old/A.lean': '-- A\n' })
  await fs.rename(
    path.join(f.sharedRoot, 'Old'),
    path.join(f.sharedRoot, 'New'),
  )
  f.event(
    ['Old/A.lean', 'New/A.lean'],
    [{ from: 'Old/A.lean', to: 'New/A.lean' }],
    ['Old/A.lean'],
  )
  f.event(['Old'], [], ['Old'])
  await f.pull()
  await assert.rejects(fs.stat(path.join(f.manifest.root, 'Old')), {
    code: 'ENOENT',
  })
  assert.equal(await f.read('New/A.lean'), '-- A\n')
  await fs.mkdir(path.join(f.manifest.root, 'Old'))
  await fs.writeFile(path.join(f.manifest.root, 'Old/Private.txt'), 'keep me')
  f.event(['Old'], [], ['Old'])
  await f.pull()
  assert.equal(await f.read('Old/Private.txt'), 'keep me')
})

test('complete verified file moves preserve the peer private folder inode and its private extras', async (t) => {
  const f = await fixture(t, { 'Old/A.lean': '-- A\n', 'Old/B.lean': '-- B\n' })
  const cwd = await fs.open(
    path.join(f.manifest.root, 'Old'),
    constants.O_RDONLY | constants.O_DIRECTORY,
  )
  t.after(() => cwd.close())
  await fs.writeFile(
    path.join(f.manifest.root, 'Old/Private.txt'),
    'private notes',
  )
  await fs.writeFile(path.join(f.manifest.root, 'Old/A.lean'), '-- dirty A\n')
  await fs.rename(
    path.join(f.sharedRoot, 'Old'),
    path.join(f.sharedRoot, 'New'),
  )
  f.event(
    ['Old/A.lean', 'Old/B.lean', 'New/A.lean', 'New/B.lean'],
    [
      { from: 'Old/A.lean', to: 'New/A.lean' },
      { from: 'Old/B.lean', to: 'New/B.lean' },
    ],
    ['Old/A.lean', 'Old/B.lean'],
  )
  f.event(['Old'], [], ['Old'])
  await f.pull()
  assert.equal(
    await fs.realpath(`/proc/self/fd/${cwd.fd}`),
    path.join(f.manifest.root, 'New'),
  )
  assert.equal(await f.read('New/Private.txt'), 'private notes')
  assert.equal(await f.read('New/A.lean'), '-- dirty A\n')
})

test('an incomplete verified file mapping never guesses a private folder move', async (t) => {
  const f = await fixture(t, {
    'Old/A.lean': '-- A\n',
    'Old/B.lean': '-- duplicate\n',
    'Old/C.lean': '-- duplicate\n',
  })
  const cwd = await fs.open(
    path.join(f.manifest.root, 'Old'),
    constants.O_RDONLY | constants.O_DIRECTORY,
  )
  t.after(() => cwd.close())
  await fs.writeFile(
    path.join(f.manifest.root, 'Old/Private.txt'),
    'private notes',
  )
  await fs.rename(
    path.join(f.sharedRoot, 'Old'),
    path.join(f.sharedRoot, 'New'),
  )
  // B/C have duplicate contents and no verified move identity in this event.
  f.event(
    [
      'Old/A.lean',
      'Old/B.lean',
      'Old/C.lean',
      'New/A.lean',
      'New/B.lean',
      'New/C.lean',
    ],
    [{ from: 'Old/A.lean', to: 'New/A.lean' }],
    ['Old/A.lean', 'Old/B.lean', 'Old/C.lean'],
  )
  f.event(['Old'], [], ['Old'])
  await f.pull()
  assert.equal(
    await fs.realpath(`/proc/self/fd/${cwd.fd}`),
    path.join(f.manifest.root, 'Old'),
  )
  assert.equal(await f.read('Old/Private.txt'), 'private notes')
  assert.equal(await f.read('New/A.lean'), '-- A\n')
  await assert.rejects(fs.stat(path.join(f.manifest.root, 'New/Private.txt')), {
    code: 'ENOENT',
  })
})

test('a hardlinked private alias prevents compaction and later edits remain downloadable', async (t) => {
  const f = await fixture(t)
  const alias = path.join(f.manifest.root, 'Alias.lean')
  await fs.link(path.join(f.manifest.root, 'Main.lean'), alias)
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  await f.pull()
  await f.pull()
  assert.equal(f.state.backups.length, 1)
  await fs.writeFile(alias, '-- private alias edit\n')
  const preserved = await preserveTerminalBackups(f.context)
  assert.equal(preserved.length, 1)
  assert.equal(await f.read(preserved[0]), '-- private alias edit\n')
  assert.equal(await f.read('Main.lean'), '-- browser\n')
})

test('a writable mmap retains its displaced inode after its original file descriptor closes', async (t) => {
  const f = await fixture(t)
  const mapper = childProcess.spawn(
    'python3',
    [
      '-I',
      '-c',
      `import ctypes, os, sys
native = ctypes.CDLL(None, use_errno=True)
native.mmap.restype = ctypes.c_void_p
native.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
native.munmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
descriptor = os.open(sys.argv[1], os.O_RDWR)
address = native.mmap(None, 12, 3, 1, descriptor, 0)
assert address != ctypes.c_void_p(-1).value
os.close(descriptor)
print('ready', flush=True)
sys.stdin.readline()
ctypes.memmove(address, b'-- mapped!!\\n', 12)
print('written', flush=True)
sys.stdin.readline()
native.munmap(address, 12)
`,
      path.join(f.manifest.root, 'Main.lean'),
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  )
  t.after(() => mapper.kill())
  const lines = createInterface({ input: mapper.stdout })[
    Symbol.asyncIterator
  ]()
  assert.equal((await lines.next()).value, 'ready')
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  await f.pull()
  await f.pull()
  assert.equal(f.state.backups.length, 1)
  mapper.stdin.write('write\n')
  assert.equal((await lines.next()).value, 'written')
  const preserved = await preserveTerminalBackups(f.context)
  assert.equal(preserved.length, 1)
  assert.equal(await f.read(preserved[0]), '-- mapped!!\n')
  assert.equal(await f.read('Main.lean'), '-- browser\n')
  mapper.stdin.end('close\n')
})

test('finalization exposes late descriptor writes even after the polling mirror paused', async (t) => {
  const f = await fixture(t)
  const old = await fs.open(path.join(f.manifest.root, 'Main.lean'), 'r+')
  t.after(() => old.close())
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  await f.pull()
  // A different publication conflict can pause the mirror before this write.
  await old.truncate(0)
  await old.writeFile('-- final delayed write\n')
  const preserved = await preserveTerminalBackups(f.context)
  assert.equal(preserved.length, 1)
  assert.equal(await f.read(preserved[0]), '-- final delayed write\n')
})

test('durable backup mappings survive lost in-memory state and recover delayed private writes repeatedly', async (t) => {
  const f = await fixture(t)
  const old = await fs.open(path.join(f.manifest.root, 'Main.lean'), 'r+')
  try {
    await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
    f.event(['Main.lean'])
    await f.pull()
    const backup = f.state.backups[0]
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(f.container, backup.filename + '.json'),
        'utf8',
      ),
    )
    assert.deepEqual(metadata, {
      version: 1,
      path: 'Main.lean',
      filename: backup.filename,
    })
    await old.truncate(0)
    await old.writeFile('-- write after coordinator crash\n')
  } finally {
    await old.close()
  }
  const recovered = await recoverTerminalBackups({
    ...f.context,
    state: createTerminalReconciliation(),
  })
  assert.equal(recovered.length, 1)
  assert.equal(await f.read(recovered[0]), '-- write after coordinator crash\n')
  assert.equal(await f.read('Main.lean'), '-- browser\n')
  assert.deepEqual(
    await recoverTerminalBackups({
      ...f.context,
      state: createTerminalReconciliation(),
    }),
    [],
  )
  assert.deepEqual(
    await fs.readdir(path.join(f.container, 'terminal-pull-backups')),
    [],
  )
})

test('recovery rejects unsafe sidecar paths without moving or deleting the protected bytes', async (t) => {
  const f = await fixture(t)
  const old = await fs.open(path.join(f.manifest.root, 'Main.lean'), 'r+')
  try {
    await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
    f.event(['Main.lean'])
    await f.pull()
    const backup = f.state.backups[0]
    await fs.writeFile(
      path.join(f.container, backup.filename + '.json'),
      JSON.stringify({
        version: 1,
        path: '../outside.lean',
        filename: backup.filename,
      }),
    )
    await assert.rejects(recoverTerminalBackups(f.context), { status: 409 })
    assert.equal(
      await fs.readFile(path.join(f.container, backup.filename), 'utf8'),
      '-- original\n',
    )
  } finally {
    await old.close()
  }
})

test('recovery includes unknown staged bytes and safely ignores an orphaned partial sidecar', async (t) => {
  const f = await fixture(t)
  const directory = path.join(f.container, 'terminal-pull-backups')
  await fs.mkdir(directory)
  const staged = randomUUID()
  await fs.writeFile(
    path.join(directory, staged),
    '-- staged before exchange\n',
  )
  const orphan = randomUUID()
  await fs.writeFile(path.join(directory, orphan + '.json'), '{"version":')
  const recovered = await recoverTerminalBackups(f.context)
  assert.equal(recovered.length, 1)
  assert.match(recovered[0], /unmapped-[a-f0-9-]+\.bin$/)
  assert.equal(await f.read(recovered[0]), '-- staged before exchange\n')
  assert.deepEqual(await fs.readdir(directory), [])
})

test('recovery keeps bytes downloadable when the original valid path cannot fit an added recovery prefix', async (t) => {
  const filename = [...Array(5).fill('a'.repeat(190)), 'Main.lean'].join('/')
  const f = await fixture(t, { [filename]: '-- original\n' })
  const old = await fs.open(path.join(f.manifest.root, filename), 'r+')
  try {
    await fs.writeFile(path.join(f.sharedRoot, filename), '-- browser\n')
    f.event([filename])
    await f.pull()
    await old.truncate(0)
    await old.writeFile('-- long-path private write\n')
  } finally {
    await old.close()
  }
  const recovered = await recoverTerminalBackups({
    ...f.context,
    state: createTerminalReconciliation(),
  })
  assert.equal(recovered.length, 1)
  assert.ok(recovered[0].length <= 1024)
  assert.equal(await f.read(recovered[0]), '-- long-path private write\n')
})

test('recovery keeps a valid 63-segment source path within the workspace nesting limit', async (t) => {
  const filename = [...Array(62).fill('a'), 'Main.lean'].join('/')
  const f = await fixture(t, { [filename]: '-- original\n' })
  const old = await fs.open(path.join(f.manifest.root, filename), 'r+')
  try {
    await fs.writeFile(path.join(f.sharedRoot, filename), '-- browser\n')
    f.event([filename])
    await f.pull()
    await old.truncate(0)
    await old.writeFile('-- deeply nested private write\n')
  } finally {
    await old.close()
  }
  const recovered = await recoverTerminalBackups({
    ...f.context,
    state: createTerminalReconciliation(),
  })
  assert.equal(recovered.length, 1)
  assert.ok(recovered[0].split('/').length <= 64)
  assert.equal(await f.read(recovered[0]), '-- deeply nested private write\n')
})

test('cached binary checks detect same-inode writes even when a command restores the old modification time', async (t) => {
  const f = await fixture(t, {
    'Old/image.png': Buffer.from([137, 80, 78, 71, 0, 1]),
  })
  await fs.rename(
    path.join(f.sharedRoot, 'Old'),
    path.join(f.sharedRoot, 'New'),
  )
  f.event(['Old', 'New'], [{ from: 'Old', to: 'New' }], ['Old'])
  await f.pull()
  const filename = path.join(f.manifest.root, 'New/image.png')
  const before = await fs.stat(filename)
  const handle = await fs.open(filename, 'r+')
  try {
    await handle.writeFile(Buffer.from([137, 80, 78, 71, 0, 2]))
  } finally {
    await handle.close()
  }
  await fs.utimes(filename, before.atime, before.mtime)
  await assert.rejects(f.pull(), { status: 409 })
  assert.deepEqual(
    await fs.readFile(filename),
    Buffer.from([137, 80, 78, 71, 0, 2]),
  )
})

test('a complete folder relocation with a colliding private destination preserves cwd and both trees', async (t) => {
  const f = await fixture(t, { 'Old/A.lean': '-- A\n' })
  const cwd = await fs.open(
    path.join(f.manifest.root, 'Old'),
    constants.O_RDONLY | constants.O_DIRECTORY,
  )
  t.after(() => cwd.close())
  await fs.mkdir(path.join(f.manifest.root, 'New'))
  await fs.writeFile(
    path.join(f.manifest.root, 'New/Private.txt'),
    'private destination',
  )
  await fs.rename(
    path.join(f.sharedRoot, 'Old'),
    path.join(f.sharedRoot, 'New'),
  )
  f.event(
    ['Old/A.lean', 'New/A.lean'],
    [{ from: 'Old/A.lean', to: 'New/A.lean' }],
    ['Old/A.lean'],
  )
  f.event(['Old'], [], ['Old'])
  await assert.rejects(
    f.pull(),
    (error) =>
      error.status === 409 && /destination already exists/i.test(error.message),
  )
  assert.equal(
    await fs.realpath(`/proc/self/fd/${cwd.fd}`),
    path.join(f.manifest.root, 'Old'),
  )
  assert.equal(await f.read('Old/A.lean'), '-- A\n')
  assert.equal(await f.read('New/Private.txt'), 'private destination')
})

test('a verified file merge into an existing shared destination keeps its files and removes the old empty folder', async (t) => {
  const f = await fixture(t, {
    'Old/A.lean': '-- A\n',
    'Old/B.lean': '-- B\n',
    'New/Existing.lean': '-- existing destination\n',
  })
  for (const filename of ['A.lean', 'B.lean'])
    await fs.rename(
      path.join(f.sharedRoot, 'Old', filename),
      path.join(f.sharedRoot, 'New', filename),
    )
  await fs.rmdir(path.join(f.sharedRoot, 'Old'))
  f.event(
    ['Old/A.lean', 'Old/B.lean', 'New/A.lean', 'New/B.lean'],
    [
      { from: 'Old/A.lean', to: 'New/A.lean' },
      { from: 'Old/B.lean', to: 'New/B.lean' },
    ],
    ['Old/A.lean', 'Old/B.lean'],
  )
  f.event(['Old'], [], ['Old'])
  await f.pull()
  assert.equal(await f.read('New/A.lean'), '-- A\n')
  assert.equal(await f.read('New/B.lean'), '-- B\n')
  assert.equal(await f.read('New/Existing.lean'), '-- existing destination\n')
  await assert.rejects(fs.stat(path.join(f.manifest.root, 'Old')), {
    code: 'ENOENT',
  })
})

test('only acknowledged pulled namespaces refresh identity proofs, while dirty private paths keep the scanned identity', async (t) => {
  const f = await fixture(t, {
    'Clean.lean': '-- clean\n',
    'Dirty.lean': '-- old\n',
  })
  await fs.writeFile(
    path.join(f.sharedRoot, 'Clean.lean'),
    '-- browser clean\n',
  )
  await fs.writeFile(
    path.join(f.sharedRoot, 'Dirty.lean'),
    '-- browser dirty\n',
  )
  await fs.writeFile(
    path.join(f.manifest.root, 'Dirty.lean'),
    '-- private dirty\n',
  )
  f.event(['Clean.lean', 'Dirty.lean'])
  await f.pull()
  assert.deepEqual([...f.state.identityPaths], ['Clean.lean'])
})

test('own published removals never create foreign stale-path tombstones', async (t) => {
  const f = await fixture(t)
  await fs.unlink(path.join(f.sharedRoot, 'Main.lean'))
  await fs.unlink(path.join(f.manifest.root, 'Main.lean'))
  f.state.previousChanges = [
    {
      path: 'Main.lean',
      before: '-- original\n',
      beforeHash: hash('-- original\n'),
      after: null,
    },
  ]
  queueTerminalChanges(f.state, {
    kind: 'files',
    own: true,
    paths: ['Main.lean'],
    removedPaths: ['Main.lean'],
    moves: [],
  })
  await f.pull()
  assert.equal(f.state.deletedPaths.has('Main.lean'), false)
})

for (const when of ['before', 'after'])
  test(`a binary edit ${when} a web folder move is retained instead of hidden by publication exclusions`, async (t) => {
    const original = Buffer.from([137, 80, 78, 71, 0, 1])
    const privateBytes = Buffer.from([137, 80, 78, 71, 0, 2])
    const f = await fixture(t, { 'Old/image.png': original })
    if (when === 'before')
      await fs.writeFile(
        path.join(f.manifest.root, 'Old/image.png'),
        privateBytes,
      )
    await fs.rename(
      path.join(f.sharedRoot, 'Old'),
      path.join(f.sharedRoot, 'New'),
    )
    f.event(['Old', 'New'], [{ from: 'Old', to: 'New' }], ['Old'])
    if (when === 'after') {
      await f.pull()
      await fs.writeFile(
        path.join(f.manifest.root, 'New/image.png'),
        privateBytes,
      )
    }
    await assert.rejects(f.pull(), { status: 409 })
    assert.deepEqual(
      await fs.readFile(path.join(f.manifest.root, 'New/image.png')),
      privateBytes,
    )
    assert.deepEqual(
      await fs.readFile(path.join(f.sharedRoot, 'New/image.png')),
      original,
    )
  })

test('recreating one shared child never clears a moved-away folder tombstone', async (t) => {
  const f = await fixture(t, { 'Old/A.lean': '-- A\n', 'Old/B.lean': '-- B\n' })
  await fs.rename(
    path.join(f.sharedRoot, 'Old'),
    path.join(f.sharedRoot, 'New'),
  )
  f.event(['Old', 'New'], [{ from: 'Old', to: 'New' }], ['Old'])
  await f.pull()
  await fs.mkdir(path.join(f.sharedRoot, 'Old'))
  await fs.writeFile(
    path.join(f.sharedRoot, 'Old/A.lean'),
    '-- replacement A\n',
  )
  f.event(['Old/A.lean'])
  await f.pull()
  assert.equal(f.state.deletedPaths.has('Old'), true)
  assert.equal(f.state.deletedPaths.has('Old/B.lean'), true)
  assert.equal(await f.read('Old/A.lean'), '-- replacement A\n')
})

test('a private write between the clean-file check and displacement is restored, never overwritten', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  const openParent = f.context.openParent
  let reads = 0
  f.context.openParent = async (root, filename, options) => {
    if (root === f.manifest.root && filename === 'Main.lean' && ++reads === 2)
      await fs.writeFile(path.join(root, filename), '-- racing private\n')
    return openParent(root, filename, options)
  }
  await assert.rejects(f.pull(), { status: 409 })
  assert.equal(await f.read('Main.lean'), '-- racing private\n')
  assert.equal(
    await fs.readFile(path.join(f.sharedRoot, 'Main.lean'), 'utf8'),
    '-- browser\n',
  )
})

test('revoked authorization stops pull before any private update', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.sharedRoot, 'Main.lean'), '-- browser\n')
  f.event(['Main.lean'])
  f.context.authorize = () => {
    throw Object.assign(new Error('Access removed'), { status: 403 })
  }
  await assert.rejects(f.pull(), { status: 403 })
  assert.equal(await f.read('Main.lean'), '-- original\n')
})

for (const keepPrivate of [false, true])
  test(`removed folders reconcile in postorder after child updates (${keepPrivate ? 'private contents kept' : 'empty parent removed'})`, async (t) => {
    const f = await fixture(t, {
      'Temporary/A.lean': '-- A\n',
      'Temporary/Nested/B.lean': '-- B\n',
    })
    if (keepPrivate)
      await fs.writeFile(
        path.join(f.manifest.root, 'Temporary/Private.txt'),
        'keep my private file',
      )
    await fs.rm(path.join(f.sharedRoot, 'Temporary'), { recursive: true })
    f.event(['Temporary'], [], ['Temporary'])
    await f.pull()
    await assert.rejects(
      fs.stat(path.join(f.manifest.root, 'Temporary/A.lean')),
      { code: 'ENOENT' },
    )
    await assert.rejects(
      fs.stat(path.join(f.manifest.root, 'Temporary/Nested')),
      { code: 'ENOENT' },
    )
    if (keepPrivate)
      assert.equal(
        await f.read('Temporary/Private.txt'),
        'keep my private file',
      )
    else
      await assert.rejects(fs.stat(path.join(f.manifest.root, 'Temporary')), {
        code: 'ENOENT',
      })
  })
