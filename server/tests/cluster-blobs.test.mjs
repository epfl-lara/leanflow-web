import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { BlobStore, captureTree, validateManifest } from '../cluster/blobs.mjs'
import { sha256 } from '../cluster/state.mjs'

async function fixture(t, options = {}) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-cluster-blobs-')),
  )
  const store = await new BlobStore(path.join(directory, 'store'), {
    reserveBytes: 0,
    ...options,
  }).init()
  t.after(async () => {
    store.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { directory, store }
}

test('storage admission charges full partial objects durably and idle reset recovers capacity', async (t) => {
  const { directory, store } = await fixture(t, { maxBytes: 10, maxFiles: 2 })
  const hash = sha256('12345678')
  await store.writeChunk({
    hash,
    offset: 0,
    totalBytes: 8,
    data: Buffer.from('12').toString('base64'),
    final: false,
  })
  assert.equal(store.usage().bytes, 8)
  await assert.rejects(store.put('abc'), { code: 'storage_full' })
  store.close()
  await store.init()
  assert.equal(store.usage().bytes, 8)
  await store.writeChunk({
    hash,
    offset: 2,
    totalBytes: 8,
    data: Buffer.from('345678').toString('base64'),
    final: true,
  })
  await store.put('xy')
  assert.deepEqual(store.usage(), {
    bytes: 10,
    files: 2,
    maxBytes: 10,
    maxFiles: 2,
  })
  await assert.rejects(store.put(''), { code: 'storage_full' })
  assert.equal(
    (await fs.readdir(path.join(directory, 'store/partial'))).length,
    0,
  )
  await store.reset()
  assert.equal(store.usage().bytes, 0)
  assert.equal(store.usage().files, 0)
  assert.deepEqual(await store.has([hash]), [])
  await store.put('new')
})

test('snapshot helpers share the storage budget and deduplicate unchanged files before copying', async (t) => {
  const { directory, store } = await fixture(t, { maxBytes: 4096, maxFiles: 2 })
  const source = path.join(directory, 'source')
  await fs.mkdir(source)
  await fs.writeFile(
    path.join(source, 'Main.lean'),
    'example : True := by trivial\n',
  )
  const first = await captureTree(store, source)
  const usage = store.usage()
  assert.equal(usage.files, 2)
  assert.equal((await captureTree(store, source)).hash, first.hash)
  assert.deepEqual(store.usage(), usage)
  await fs.writeFile(
    path.join(source, 'Other.lean'),
    'example : True := True.intro\n',
  )
  await assert.rejects(captureTree(store, source), /budget reached/)
  assert.deepEqual(store.usage(), usage)
  assert.equal(
    (await fs.readdir(store.objects)).filter((name) =>
      name.startsWith('.capture-'),
    ).length,
    0,
  )
})

test('image-file imports stream, resume partial data and reject symbolic links', async (t) => {
  const { directory, store } = await fixture(t)
  const data = Buffer.alloc(600000, 71),
    hash = sha256(data)
  const filename = path.join(directory, 'image.tar.gz')
  await fs.writeFile(filename, data)
  await store.writeChunk({
    hash,
    offset: 0,
    totalBytes: data.length,
    data: data.subarray(0, 32000).toString('base64'),
    final: false,
  })
  assert.deepEqual(await store.putFile(filename), { hash, size: data.length })
  await store.verify(hash)
  assert.deepEqual(await store.read(hash), data)
  await fs.symlink(filename, path.join(directory, 'link'))
  await assert.rejects(store.putFile(path.join(directory, 'link')))
})

test('object transfers resume at an exact byte offset and publish only verified content', async (t) => {
  const { store } = await fixture(t)
  const data = Buffer.from('bytes 🙂 remain exact')
  const hash = sha256(data)
  await store.writeChunk({
    hash,
    offset: 0,
    data: data.subarray(0, 7).toString('base64'),
    totalBytes: data.length,
    final: false,
  })
  assert.deepEqual(await store.has([hash]), [])
  assert.deepEqual(await store.offset(hash), { complete: false, offset: 7 })
  await assert.rejects(
    store.writeChunk({
      hash,
      offset: 0,
      data: 'Yg==',
      totalBytes: data.length,
      final: false,
    }),
    { code: 'offset_conflict' },
  )
  await store.writeChunk({
    hash,
    offset: 7,
    data: data.subarray(7).toString('base64'),
    totalBytes: data.length,
    final: true,
  })
  assert.deepEqual(await store.read(hash), data)
  assert.deepEqual(await store.has([hash]), [hash])
  await assert.rejects(
    store.writeChunk({ hash, offset: 0, data: '', totalBytes: 0, final: true }),
    { code: 'digest_mismatch' },
  )
})

test('incorrect checksums and noncanonical chunks cannot create a published object', async (t) => {
  const { store } = await fixture(t)
  const hash = sha256('expected')
  await assert.rejects(
    store.writeChunk({
      hash,
      offset: 0,
      data: Buffer.from('wrong').toString('base64'),
      totalBytes: 5,
      final: true,
    }),
    { code: 'digest_mismatch' },
  )
  for (const data of ['====', 'Yg', 'Yg==\n', 'Zh=='])
    await assert.rejects(
      store.writeChunk({ hash, offset: 0, data, totalBytes: 1, final: true }),
    )
  assert.deepEqual(await store.has([hash]), [])
})

test('zero-byte and chunked object reads retain the exact content digest', async (t) => {
  const { store } = await fixture(t)
  const empty = await store.put(Buffer.alloc(0))
  assert.equal((await store.read(empty.hash)).length, 0)
  const bytes = Buffer.alloc(600000, 137)
  const object = await store.put(bytes)
  let offset = 0
  const chunks = []
  while (offset < bytes.length) {
    const chunk = await store.readChunk(object.hash, offset, 100000)
    chunks.push(Buffer.from(chunk.data, 'base64'))
    offset = chunk.offset
  }
  assert.deepEqual(Buffer.concat(chunks), bytes)
  await assert.rejects(store.readChunk(object.hash, -1))
  await assert.rejects(store.read(object.hash, 10))
})

test('manifests reject traversal, secret paths, escaped links and file/link ancestors', () => {
  const file = {
    path: 'Main.lean',
    type: 'file',
    hash: sha256('source'),
    size: 6,
    mode: 0o600,
  }
  const manifest = (entries) => ({ version: 1, kind: 'source', entries })
  for (const name of [
    '../other',
    '/absolute',
    'a/../b',
    'a\\b',
    '.env',
    'dir/.ssh/key',
    'a\u0000b',
    'a\ud800',
  ])
    assert.throws(() => validateManifest(manifest([{ ...file, path: name }])))
  assert.throws(() => validateManifest(manifest([file, file])))
  assert.throws(() =>
    validateManifest(
      manifest([{ path: 'link', type: 'symlink', target: '../outside' }]),
    ),
  )
  assert.throws(() =>
    validateManifest(
      manifest([
        { path: 'link', type: 'symlink', target: 'inside' },
        { ...file, path: 'link/file' },
      ]),
    ),
  )
  assert.throws(() =>
    validateManifest(manifest([file, { ...file, path: 'Main.lean/other' }])),
  )
  assert.throws(() =>
    validateManifest(
      manifest([
        { path: 'dir', type: 'directory' },
        { path: 'dir/sub', type: 'symlink', target: '.' },
        { path: 'dir/x', type: 'symlink', target: 'sub/../../outside' },
      ]),
    ),
  )
  assert.throws(() =>
    validateManifest(
      manifest([
        { path: 'a', type: 'symlink', target: 'b' },
        { path: 'b', type: 'symlink', target: 'a' },
      ]),
    ),
  )
  assert.equal(validateManifest(manifest([file])).totalBytes, 6)
})

test('capture excludes private state and generated Lake files when requested', async (t) => {
  const { directory, store } = await fixture(t)
  const source = path.join(directory, 'source')
  await fs.mkdir(path.join(source, '.lake'), { recursive: true })
  await fs.mkdir(path.join(source, '.git'))
  await fs.mkdir(path.join(source, 'empty'))
  await fs.writeFile(
    path.join(source, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await fs.writeFile(path.join(source, '.env'), 'PRIVATE=do-not-transfer')
  await fs.writeFile(path.join(source, '.git/config'), 'private URL')
  await fs.writeFile(path.join(source, '.lake/compiled'), Buffer.from([0, 255]))
  const captured = await captureTree(store, source, { ignoreLake: true })
  assert.deepEqual(
    captured.manifest.entries.map((entry) => entry.path),
    ['Main.lean', 'empty'],
  )
  const output = path.join(directory, 'output')
  await store.materialize(captured.hash, output)
  assert.equal(
    await fs.readFile(path.join(output, 'Main.lean'), 'utf8'),
    'example : True := by trivial\n',
  )
  assert.equal((await fs.stat(path.join(output, 'empty'))).isDirectory(), true)
  await fs.writeFile(path.join(output, 'Main.lean'), 'changed privately')
  assert.equal(
    await fs.readFile(path.join(source, 'Main.lean'), 'utf8'),
    'example : True := by trivial\n',
  )
})

test('materialization detects a corrupt cached object and never merges into an existing tree', async (t) => {
  const { directory, store } = await fixture(t)
  const file = await store.put('valid')
  const manifest = await store.seal([
    {
      path: 'Main.lean',
      type: 'file',
      hash: file.hash,
      size: file.size,
      mode: 0o600,
    },
  ])
  await fs.chmod(store.object(file.hash), 0o600)
  await fs.writeFile(store.object(file.hash), 'wrong')
  const output = path.join(directory, 'output')
  await assert.rejects(store.materialize(manifest.hash, output), {
    code: 'digest_mismatch',
  })
  await assert.rejects(fs.stat(output), { code: 'ENOENT' })
  await fs.mkdir(output)
  await fs.writeFile(path.join(output, 'sentinel'), 'keep')
  await assert.rejects(store.materialize(manifest.hash, output), {
    code: 'EEXIST',
  })
  assert.equal(await fs.readFile(path.join(output, 'sentinel'), 'utf8'), 'keep')
})
