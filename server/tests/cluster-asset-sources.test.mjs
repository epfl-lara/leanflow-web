import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BlobStore, captureTree } from '../cluster/blobs.mjs'
import { sha256 } from '../cluster/state.mjs'

async function writeProtected(filename, data, options = {}) {
  return fs.writeFile(filename, data, { mode: 0o600, ...options })
}

async function fixture(
  t,
  { maxBytes = 4 * 1024 ** 2, maxFiles = 100, physical = false } = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-asset-sources-')),
  )
  const data = path.join(root, 'data'),
    directory = path.join(data, 'cluster/blobs')
  const toolchain = path.join(
    data,
    'runtime/elan/toolchains/leanprover--lean4---v4.35.0',
  )
  await fs.mkdir(path.join(toolchain, 'bin'), { recursive: true, mode: 0o700 })
  const options = {
    reserveBytes: 0,
    maxBytes,
    maxFiles,
    ...(!physical ? { assetDataDir: data } : {}),
  }
  const store = await new BlobStore(directory, options).init()
  t.after(async () => {
    store.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, data, directory, toolchain, store, options }
}

test('managed toolchain captures keep exact bytes available without duplicating payloads, including after restart', async (t) => {
  const { store, toolchain, options } = await fixture(t, { maxBytes: 4096 })
  const bytes = Buffer.alloc(600000, 71),
    hash = sha256(bytes)
  await writeProtected(path.join(toolchain, 'bin/lean'), bytes, { mode: 0o700 })
  const captured = await captureTree(store, toolchain, { kind: 'toolchain' })
  await assert.rejects(fs.stat(store.object(hash)), { code: 'ENOENT' })
  assert(store.usage().bytes < 4096)
  assert.equal(store.assetSources.usage().files, 1)
  assert.deepEqual(await store.has([hash]), [hash])
  assert.deepEqual(await store.offset(hash), { complete: true })
  assert.deepEqual(await store.read(hash), bytes)
  await store.verify(hash)
  const chunks = []
  for (let offset = 0; offset < bytes.length;) {
    const chunk = await store.readChunk(hash, offset)
    chunks.push(Buffer.from(chunk.data, 'base64'))
    offset = chunk.offset
  }
  assert.deepEqual(Buffer.concat(chunks), bytes)
  assert.deepEqual(
    await store.writeChunk({
      hash,
      offset: 0,
      data: bytes.subarray(0, 10).toString('base64'),
      totalBytes: bytes.length,
      final: false,
    }),
    { offset: bytes.length, complete: true },
  )
  await assert.rejects(
    store.writeChunk({ hash, offset: 0, data: '', totalBytes: 0, final: true }),
    { code: 'digest_mismatch' },
  )
  await store.materialize(
    captured.hash,
    path.join(toolchain, '../../../materialized'),
  )
  store.close()
  await store.init()
  assert.deepEqual(await store.read(hash), bytes)
  assert.equal((await store.manifest(captured.hash)).kind, 'toolchain')
  assert.equal(store.maxBytes, options.maxBytes)
})

test('private project sources, results and assets outside managed roots remain physical', async (t) => {
  const { root, data, store } = await fixture(t)
  const source = path.join(data, 'projects/disposable')
  const outside = path.join(root, 'unmanaged')
  await fs.mkdir(source, { recursive: true })
  await fs.mkdir(outside)
  await writeProtected(
    path.join(source, 'Main.lean'),
    'example : True := by trivial\n',
  )
  await writeProtected(path.join(outside, 'file'), 'unmanaged asset')
  const captured = await captureTree(store, source)
  await captureTree(store, outside, { kind: 'toolchain' })
  const result = await store.put(
    JSON.stringify({ code: 0, stdout: 'private fixture result' }),
  )
  for (const hash of [
    captured.hash,
    result.hash,
    sha256('unmanaged asset'),
    sha256('example : True := by trivial\n'),
  ])
    assert((await fs.stat(store.object(hash))).isFile())
  assert.equal(store.assetSources.usage().files, 0)
})

test('idle trimming frees only verified duplicate payloads and retains manifests and private objects', async (t) => {
  const { toolchain, store, data, directory } = await fixture(t)
  const bytes = Buffer.alloc(120000, 82),
    hash = sha256(bytes)
  await writeProtected(path.join(toolchain, 'bin/lean'), bytes)
  await store.put(bytes)
  const privateObject = await store.put('retained private source or result')
  const manifest = await captureTree(store, toolchain, { kind: 'toolchain' })
  const before = store.usage()
  const result = await store.trimAssetCopies()
  assert.equal(result.files, 1)
  assert.equal(result.bytes, bytes.length)
  assert.equal(store.usage().bytes, before.bytes - bytes.length)
  assert.equal(
    await fs.readFile(path.join(toolchain, 'bin/lean'), 'utf8'),
    bytes.toString(),
  )
  await assert.rejects(fs.stat(store.object(hash)), { code: 'ENOENT' })
  assert.equal(
    (await store.read(privateObject.hash)).toString(),
    'retained private source or result',
  )
  assert.equal((await store.manifest(manifest.hash)).entries.at(-1).hash, hash)
  const destination = path.join(data, 'restored')
  await store.materialize(manifest.hash, destination)
  assert.deepEqual(await fs.readFile(path.join(destination, 'bin/lean')), bytes)
  assert.equal((await store.trimAssetCopies()).files, 0)
  assert.equal(
    (await fs.stat(path.join(directory, 'asset-sources.sqlite'))).mode & 0o077,
    0,
  )
})

test('stale, replaced and symlinked backing files cannot serve bytes or cause the last physical copy to be trimmed', async (t) => {
  const { toolchain, root, store } = await fixture(t)
  const filename = path.join(toolchain, 'bin/lean'),
    bytes = Buffer.from('original bytes'),
    hash = sha256(bytes)
  await writeProtected(filename, bytes)
  await store.put(bytes)
  await captureTree(store, toolchain, { kind: 'toolchain' })
  await writeProtected(filename, 'modified bytes')
  assert.equal((await store.trimAssetCopies()).files, 0)
  assert.deepEqual(await store.read(hash), bytes)
  await fs.unlink(store.object(hash))
  assert.deepEqual(await store.has([hash]), [])
  await assert.rejects(store.read(hash), { code: 'asset_missing' })
  const secret = path.join(root, 'private-file')
  await writeProtected(secret, 'private bytes')
  await fs.unlink(filename)
  await fs.symlink(secret, filename)
  assert.deepEqual(await store.has([hash]), [])
  await assert.rejects(store.readChunk(hash), { code: 'asset_missing' })
  store.assetSources.db
    .prepare('UPDATE asset_sources SET filename=? WHERE hash=?')
    .run(secret, hash)
  assert.deepEqual(await store.has([hash]), [])
})

test('trimming drains concurrent work across quota-release batches', async (t) => {
  const count = 2057
  const { toolchain, store } = await fixture(t, { maxFiles: 3000 })
  let next = 0,
    total = 0
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < count) {
        const index = next++,
          bytes = Buffer.from('distinct protected runtime asset ' + index)
        total += bytes.length
        await writeProtected(path.join(toolchain, 'bin', String(index)), bytes)
        await store.put(bytes)
      }
    }),
  )
  const manifest = await captureTree(store, toolchain, { kind: 'toolchain' })
  const before = store.usage()
  const trimmed = await store.trimAssetCopies()
  assert.equal(trimmed.files, count)
  assert.equal(trimmed.bytes, total)
  assert.equal(trimmed.released, count)
  assert.equal(trimmed.skipped, 0)
  assert.equal(store.usage().bytes, before.bytes - total)
  assert.equal(store.usage().files, 1)
  assert.equal((await store.manifest(manifest.hash)).kind, 'toolchain')
  for (const index of [0, 2047, 2056]) {
    const text = 'distinct protected runtime asset ' + index
    assert.equal((await store.read(sha256(text))).toString(), text)
  }
  assert.equal((await store.trimAssetCopies()).released, 0)
})

test('identical content in different managed roots shares one valid backing reference', async (t) => {
  const { data, toolchain, store } = await fixture(t)
  const second = path.join(
    data,
    'runtime/elan/toolchains/leanprover--lean4---v4.34.1',
  )
  await fs.mkdir(second, { recursive: true, mode: 0o700 })
  const text = 'identical managed bytes',
    hash = sha256(text)
  await writeProtected(path.join(toolchain, 'bin/lean'), text)
  await writeProtected(path.join(second, 'shared-file'), text)
  await store.put(text)
  const first = await captureTree(store, toolchain, { kind: 'toolchain' })
  const other = await captureTree(store, second, { kind: 'toolchain' })
  assert.equal(store.assetSources.usage().files, 1)
  assert.equal((await store.trimAssetCopies()).files, 1)
  await fs.unlink(path.join(toolchain, 'bin/lean'))
  assert.equal((await store.read(hash)).toString(), text)
  for (const manifest of [first, other]) {
    assert(
      (await store.manifest(manifest.hash)).entries.some(
        (entry) => entry.hash === hash,
      ),
    )
  }
})

test('a crash between unlink and quota release remains conservatively charged and is recoverable', async (t) => {
  const { toolchain, store } = await fixture(t)
  const bytes = Buffer.alloc(20000, 82),
    hash = sha256(bytes)
  await writeProtected(path.join(toolchain, 'bin/lean'), bytes)
  await store.put(bytes)
  await captureTree(store, toolchain, { kind: 'toolchain' })
  const before = store.usage().bytes,
    release = store.budget.release.bind(store.budget)
  store.budget.release = () => {
    throw new Error('simulated interrupted quota release')
  }
  await assert.rejects(store.trimAssetCopies(), /interrupted quota/)
  await assert.rejects(fs.stat(store.object(hash)), { code: 'ENOENT' })
  assert.equal(store.usage().bytes, before)
  store.budget.release = release
  const retried = await store.trimAssetCopies()
  assert.equal(retried.files, 0)
  assert.equal(retried.released, 1)
  assert.equal(store.usage().bytes, before - bytes.length)
  await store.verify(hash)
})

test('partial uploads and in-flight captures prevent unsafe quota release', async (t) => {
  const { toolchain, store } = await fixture(t)
  const bytes = Buffer.from('public runtime file'),
    hash = sha256(bytes)
  await writeProtected(path.join(toolchain, 'bin/lean'), bytes)
  await store.put(bytes)
  await captureTree(store, toolchain, { kind: 'toolchain' })
  await writeProtected(path.join(store.partial, hash), 'partial')
  const before = store.usage()
  assert.equal((await store.trimAssetCopies()).files, 0)
  assert.deepEqual(store.usage(), before)
  store.captures++
  try {
    await assert.rejects(store.trimAssetCopies(), { code: 'worker_busy' })
  } finally {
    store.captures--
  }
  await fs.unlink(path.join(store.partial, hash))
  assert.equal((await store.trimAssetCopies()).files, 1)
})

test('only protected managed dependency environments can register sources, without relabeling legacy caches', async (t) => {
  const { data, store } = await fixture(t)
  for (const schema of [5, 6]) {
    const key = String(schema).repeat(64),
      env = path.join(data, 'runtime/shared-dependencies', key)
    const packages = path.join(env, '.lake/packages')
    await fs.mkdir(packages, { recursive: true, mode: 0o700 })
    const metadata = JSON.stringify({ schema, key })
    await writeProtected(path.join(env, '.ready.json'), metadata)
    await writeProtected(
      path.join(packages, 'library-file'),
      'public runtime file ' + schema,
    )
    await captureTree(store, packages, { kind: 'dependencies' })
    const hash = sha256('public runtime file ' + schema)
    assert.deepEqual(await store.has([hash]), [hash])
    await assert.rejects(fs.stat(store.object(hash)), { code: 'ENOENT' })
    assert.equal(
      await fs.readFile(path.join(env, '.ready.json'), 'utf8'),
      metadata,
    )
    await fs.chmod(path.join(env, '.ready.json'), 0o666)
    await assert.rejects(
      captureTree(store, packages, { kind: 'dependencies' }),
      /not protected/,
    )
  }
})

test('backing-index limits are transactional and unprotected or hardlinked files use normal copies', async (t) => {
  const { toolchain, store } = await fixture(t, { maxFiles: 1 })
  await writeProtected(path.join(toolchain, 'bin/a'), 'A')
  await writeProtected(path.join(toolchain, 'bin/b'), 'B')
  await assert.rejects(
    captureTree(store, toolchain, { kind: 'toolchain' }),
    /index budget reached/,
  )
  assert.equal(store.assetSources.usage().files, 0)
  await fs.unlink(path.join(toolchain, 'bin/b'))
  await fs.chmod(path.join(toolchain, 'bin/a'), 0o666)
  // Two physical objects (payload and manifest) exceed this fixture's one-file budget.
  await assert.rejects(
    captureTree(store, toolchain, { kind: 'toolchain' }),
    /budget/,
  )
  assert.equal(store.assetSources.usage().files, 0)
})

test('reset drops source references as well as physical cached objects', async (t) => {
  const { toolchain, store } = await fixture(t)
  await writeProtected(path.join(toolchain, 'bin/lean'), 'runtime file')
  await captureTree(store, toolchain, { kind: 'toolchain' })
  const hash = sha256('runtime file')
  await store.reset()
  assert.equal(store.assetSources.usage().files, 0)
  assert.deepEqual(await store.has([hash]), [])
  assert.equal(
    await fs.readFile(path.join(toolchain, 'bin/lean'), 'utf8'),
    'runtime file',
  )
})

test(
  'maintenance cannot unlink an in-flight reader and excludes new reads, captures and writes',
  { timeout: 10000 },
  async (t) => {
    const { toolchain, store } = await fixture(t)
    const text = 'public runtime file',
      hash = sha256(text)
    await writeProtected(path.join(toolchain, 'bin/lean'), text)
    await captureTree(store, toolchain, { kind: 'toolchain' })
    assert.equal(store.assetSources.usage().files, 1)
    const original = store.assetSources.open.bind(store.assetSources)
    let gate = Promise.withResolvers(),
      started = Promise.withResolvers()
    store.assetSources.open = async (value) => {
      const source = await original(value)
      if (value === hash && source) {
        started.resolve()
        await gate.promise
      }
      return source
    }
    const reading = store.readChunk(hash)
    await started.promise
    try {
      await assert.rejects(store.trimAssetCopies(), { code: 'worker_busy' })
    } finally {
      gate.resolve()
    }
    assert.equal(Buffer.from((await reading).data, 'base64').toString(), text)
    assert.equal(store.readers, 0)
    await store.put('independent source object')
    gate = Promise.withResolvers()
    started = Promise.withResolvers()
    const trimming = store.trimAssetCopies()
    await started.promise
    try {
      await assert.rejects(store.read(hash), { code: 'worker_busy' })
      await assert.rejects(store.put('new private result'), {
        code: 'worker_busy',
      })
      await assert.rejects(
        captureTree(store, toolchain, { kind: 'toolchain' }),
        {
          code: 'worker_busy',
        },
      )
      await assert.rejects(store.trimAssetCopies(), { code: 'worker_busy' })
    } finally {
      gate.resolve()
    }
    await trimming
    assert.equal(store.trimming, false)
  },
)

test('hardlinked managed files keep normal private copies and cannot become backing sources', async (t) => {
  const { toolchain, root, store } = await fixture(t)
  const text = 'hardlinked public input',
    filename = path.join(toolchain, 'bin/lean')
  await writeProtected(filename, text)
  await fs.link(filename, path.join(root, 'other-link'))
  await captureTree(store, toolchain, { kind: 'toolchain' })
  assert.equal(store.assetSources.usage().files, 0)
  assert.equal((await fs.stat(store.object(sha256(text)))).nlink, 1)
  assert.equal((await store.read(sha256(text))).toString(), text)
})
