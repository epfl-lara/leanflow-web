import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../runtime.mjs'
import { StorageCapacity } from '../storage-capacity.mjs'

async function fixture(t, id) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-preset-'))
  const docker = path.join(dataDir, 'docker-fixture')
  await fs.writeFile(docker, `#!${process.execPath}\n`, { mode: 0o700 })
  const runtime = new Runtime({ dataDir, docker, scope: 'helper' })
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  const preset = runtime.presetDefinition(id)
  const root = runtime.templateInstallRoot(id)
  const calls = []
  let onRun = async () => {}
  runtime.prepareToolchain = async () => ({ ready: true })
  runtime.run = async (directory, args, options) => {
    const command = args.filter((arg) => arg !== '--keep-toolchain')
    calls.push({ root: directory, args, command, options })
    if (command.join(' ') === 'lake update') {
      const packages = [
        { name: 'mathlib', rev: 'a'.repeat(40) },
        ...(id === 'mathlib'
          ? []
          : [{ name: preset.package, rev: preset.revision }]),
      ].map((pkg) => ({
        type: 'git',
        url: 'https://example.invalid/' + pkg.name,
        ...pkg,
        ...(pkg.name === preset.package ? { rev: preset.revision } : {}),
      }))
      await fs.writeFile(
        path.join(directory, 'lake-manifest.json'),
        JSON.stringify({ name: 'ProofWorkspace', packages }),
      )
      for (const pkg of packages)
        await fs.mkdir(path.join(directory, '.lake/packages', pkg.name), {
          recursive: true,
        })
      if (id === 'physlib')
        await fs.writeFile(
          path.join(directory, '.lake/packages/Physlib/lake-cache.toml'),
          'service = "fixture"\n',
        )
    }
    await onRun(directory, command, options)
    return { code: 0, stdout: '', stderr: '' }
  }
  t.after(async () => {
    await runtime.shutdown()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return {
    runtime,
    root,
    preset,
    calls,
    onRun: (callback) => {
      onRun = callback
    },
    install: () =>
      runtime.presetInstaller.install(
        preset,
        new AbortController().signal,
        () => {},
      ),
  }
}

for (const id of ['lean', 'mathlib', 'cslib', 'physlib']) {
  test(`${id} preset keeps its Lean pin and publishes only after offline replay`, async (t) => {
    const f = await fixture(t, id)
    await f.install()
    assert.equal(f.runtime.templateRoot(id), f.root)
    assert.equal(
      await fs.readFile(path.join(f.root, 'lean-toolchain'), 'utf8'),
      f.preset.toolchain + '\n',
    )
    assert(
      f.calls.every(
        ({ args }) => args[0] === 'lake' && args[1] === '--keep-toolchain',
      ),
    )
    const replay = f.calls.filter(({ root }) => root !== f.root)
    if (id === 'lean') assert.equal(replay.length, 0)
    else {
      assert(
        replay.some(({ command }) => command.join(' ') === 'lake build Main'),
      )
      assert(replay.every(({ options }) => options.network === 'none'))
    }
    if (id === 'physlib') {
      const cache = f.calls.find(({ command }) => command[1] === 'cache')
      assert.deepEqual(cache.command, [
        'lake',
        'cache',
        'get',
        '--package=Physlib',
        '--scope=physlib-master/' +
          f.preset.toolchain.replaceAll('/', '-').replaceAll(':', '-') +
          '/physlib',
      ])
      assert.equal(cache.root, f.root)
      assert.equal(
        cache.options.env.LAKE_CONFIG,
        '/workspace/.lake/packages/Physlib/lake-cache.toml',
      )
    }
  })
}

test('a preset toolchain mutation is restored and cannot be certified as ready', async (t) => {
  const f = await fixture(t, 'mathlib')
  f.onRun(async (root, command) => {
    if (command[1] === 'update')
      await fs.writeFile(
        path.join(root, 'lean-toolchain'),
        'leanprover/lean4:v4.99.0\n',
      )
  })
  await assert.rejects(f.install(), /original release was restored/)
  assert.equal(f.runtime.templateRoot('mathlib'), null)
  await assert.rejects(fs.stat(path.join(f.root, '.ready.json')), {
    code: 'ENOENT',
  })
  assert.equal(
    await fs.readFile(path.join(f.root, 'lean-toolchain'), 'utf8'),
    f.preset.toolchain + '\n',
  )
})

test('a bad initial preset lockfile is rejected and a retry can replace it', async (t) => {
  const f = await fixture(t, 'cslib')
  f.onRun(async (root, command) => {
    if (command[1] === 'update') {
      const filename = path.join(root, 'lake-manifest.json')
      const manifest = JSON.parse(await fs.readFile(filename, 'utf8'))
      manifest.packages.find((pkg) => pkg.name === f.preset.package).rev =
        'b'.repeat(40)
      await fs.writeFile(filename, JSON.stringify(manifest))
    }
  })
  await assert.rejects(f.install(), /pinned dependency revision/)
  assert.equal(f.runtime.templateRoot('cslib'), null)
  f.onRun(async () => {})
  await f.install()
  assert.equal(f.runtime.templateRoot('cslib'), f.root)
})

test('a dependency pin changed by a later preset build is restored and not published', async (t) => {
  const f = await fixture(t, 'mathlib')
  f.onRun(async (root, command) => {
    if (command[1] === 'build') {
      const filename = path.join(root, 'lake-manifest.json')
      const manifest = JSON.parse(await fs.readFile(filename, 'utf8'))
      manifest.packages[0].rev = 'b'.repeat(40)
      await fs.writeFile(filename, JSON.stringify(manifest))
    }
  })
  await assert.rejects(f.install(), /original lockfile was restored/)
  assert.equal(f.runtime.templateRoot('mathlib'), null)
  const manifest = JSON.parse(
    await fs.readFile(path.join(f.root, 'lake-manifest.json'), 'utf8'),
  )
  assert.equal(manifest.packages[0].rev, f.preset.revision)
})

test('refused preset replay allocation removes only its empty candidate and preserves another stage and claim', async (t) => {
  const f = await fixture(t, 'mathlib')
  const parent = path.join(f.runtime.runtimeDir, 'template-check')
  const retained = path.join(parent, 'another-stage')
  await fs.mkdir(retained, { recursive: true })
  await fs.writeFile(
    path.join(retained, 'keep.txt'),
    'another retained candidate',
  )
  await f.runtime.claimTemporaryWorkspace(retained)
  const claims = await fs.readdir(f.runtime.temporaryWorkspaces.directory)
  let released = false
  const release = f.runtime.releaseTemporaryWorkspace.bind(f.runtime)
  f.runtime.releaseTemporaryWorkspace = async (...args) => {
    released = true
    return release(...args)
  }
  f.runtime.storage = new StorageCapacity({
    dataDir: f.runtime.dataDir,
    minimumFreeBytes: 100,
    warningFreeBytes: 200,
    allocationBytes: 200,
    sample: async () => ({ bavail: 150n, bsize: 1n }),
  })
  await assert.rejects(f.install(), { status: 503, code: 'STORAGE_PRESSURE' })
  assert.equal(
    released,
    false,
    'A refused allocation has no stage claim to release',
  )
  assert.deepEqual(await fs.readdir(parent), ['another-stage'])
  assert.deepEqual(
    await fs.readdir(f.runtime.temporaryWorkspaces.directory),
    claims,
  )
  assert.equal(
    await fs.readFile(path.join(retained, 'keep.txt'), 'utf8'),
    'another retained candidate',
  )
  assert.equal(f.runtime.temporaryStorageReservations.size, 0)
  assert.equal((await f.runtime.storage.status()).reservedBytes, 0)
  assert.equal(f.runtime.templateRoot('mathlib'), null)
})

test('a replaced unclaimed preset candidate is preserved when claim allocation fails', async (t) => {
  const f = await fixture(t, 'mathlib')
  let replacement
  f.runtime.claimTemporaryWorkspace = async (candidate) => {
    replacement = candidate
    await fs.rename(candidate, candidate + '-original')
    await fs.mkdir(candidate)
    await fs.writeFile(
      path.join(candidate, 'keep.txt'),
      'replacement belongs to another operation',
    )
    throw Object.assign(new Error('Storage allocation refused.'), {
      status: 503,
    })
  }
  f.runtime.releaseTemporaryWorkspace = () =>
    assert.fail('An unclaimed replacement must never be released.')
  await assert.rejects(f.install(), { status: 503 })
  assert.equal(
    await fs.readFile(path.join(replacement, 'keep.txt'), 'utf8'),
    'replacement belongs to another operation',
  )
  assert((await fs.stat(replacement + '-original')).isDirectory())
  assert.equal(f.runtime.templateRoot('mathlib'), null)
})

test('a conflicting claim preserves the unchanged candidate for the operation that claimed it', async (t) => {
  const f = await fixture(t, 'mathlib')
  const claim = f.runtime.claimTemporaryWorkspace.bind(f.runtime)
  let candidate
  f.runtime.claimTemporaryWorkspace = async (root) => {
    candidate = root
    await claim(root)
    throw Object.assign(
      new Error('Another operation claimed this candidate.'),
      { code: 'EEXIST' },
    )
  }
  f.runtime.releaseTemporaryWorkspace = () =>
    assert.fail('A conflicting claim belongs to another operation.')
  await assert.rejects(f.install(), { code: 'EEXIST' })
  assert((await fs.stat(candidate)).isDirectory())
  assert.equal(
    (await fs.readdir(f.runtime.temporaryWorkspaces.directory)).length,
    1,
  )
  assert.equal(f.runtime.templateRoot('mathlib'), null)
})
