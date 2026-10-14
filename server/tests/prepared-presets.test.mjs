import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Runtime } from '../runtime.mjs'

async function fixture(t) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'lean-prepared-preset-'),
  )
  const runtime = new Runtime({ dataDir, scope: 'helper' })
  runtime.ready = true
  runtime.imageId = 'fixture-image'
  const definition = runtime.presetDefinition('mathlib')
  const root = path.join(dataDir, 'runtime/templates/mathlib')
  const toolchain = path.join(dataDir, 'toolchain')
  await fs.mkdir(root, { recursive: true })
  await fs.mkdir(path.join(toolchain, 'bin'), { recursive: true })
  await fs.writeFile(path.join(toolchain, 'bin/lean'), 'fixture Lean binary')
  runtime.toolchains.set(definition.toolchain, toolchain)
  await fs.writeFile(
    path.join(root, 'lean-toolchain'),
    definition.toolchain + '\n',
  )
  await fs.writeFile(
    path.join(root, 'lakefile.toml'),
    'name = "ProofWorkspace"\n',
  )
  await fs.writeFile(
    path.join(root, 'lake-manifest.json'),
    JSON.stringify({
      packages: [{ name: definition.package, rev: definition.revision }],
    }),
  )
  await fs.writeFile(
    path.join(root, '.ready.json'),
    JSON.stringify({
      toolchain: definition.toolchain,
      revision: definition.revision,
      code: 0,
    }),
  )
  let calls = 0
  let fail = false
  runtime.run = async (_root, _args, options) => {
    calls++
    assert.equal(options.network, 'none')
    assert.equal(options.readOnlyWorkspace, true)
    assert.equal(options.writeLakeCache, true)
    return {
      code: fail ? 1 : 0,
      stdout: '',
      stderr: fail ? 'Import failed' : '',
    }
  }
  t.after(async () => {
    await runtime.shutdown()
    await fs.rm(dataDir, { recursive: true, force: true })
  })
  return {
    runtime,
    dataDir,
    root,
    definition,
    calls: () => calls,
    setFailure: (value) => {
      fail = value
    },
  }
}

test('prepared Mathlib verification is coalesced and reused across runtime restarts', async (t) => {
  const f = await fixture(t)
  assert.equal(f.runtime.preparedPresetEnvironment('mathlib'), null)
  const [a, b] = await Promise.all([
    f.runtime.preparePresetEnvironment('mathlib'),
    f.runtime.preparePresetEnvironment('mathlib'),
  ])
  assert.equal(a.key, b.key)
  assert.equal(f.calls(), 1)
  await f.runtime.preparePresetEnvironment('mathlib')
  assert.equal(f.calls(), 1)
  const restarted = new Runtime({ dataDir: f.dataDir, scope: 'helper' })
  restarted.ready = true
  restarted.imageId = f.runtime.imageId
  restarted.toolchains = f.runtime.toolchains
  restarted.run = async () => {
    throw new Error('Cached setup must not start a worker')
  }
  assert.equal((await restarted.preparePresetEnvironment('mathlib')).key, a.key)
  assert.equal(
    restarted.templates().find((p) => p.id === 'mathlib').playgroundReady,
    true,
  )
})

test('worker and configuration changes invalidate the prepared certificate', async (t) => {
  const f = await fixture(t)
  await f.runtime.preparePresetEnvironment('mathlib')
  f.runtime.imageId = 'another-image'
  assert.equal(f.runtime.preparedPresetEnvironment('mathlib'), null)
  await f.runtime.preparePresetEnvironment('mathlib')
  await fs.appendFile(
    path.join(f.root, 'lakefile.toml'),
    '\n[leanOptions]\nmaxRecDepth = 1000\n',
  )
  assert.equal(f.runtime.preparedPresetEnvironment('mathlib'), null)
  await f.runtime.preparePresetEnvironment('mathlib')
  assert.equal(f.calls(), 3)
  await fs.writeFile(
    path.join(f.root, 'lake-manifest.json'),
    JSON.stringify({
      packages: [{ name: f.definition.package, rev: 'bad-pin' }],
    }),
  )
  assert.equal(f.runtime.preparedPresetEnvironment('mathlib'), null)
  await assert.rejects(
    f.runtime.preparePresetEnvironment('mathlib'),
    /pinned dependency revision/,
  )
  assert.equal(f.calls(), 3)
})

test('failed verification cannot publish a ready environment and can be retried', async (t) => {
  const f = await fixture(t)
  f.setFailure(true)
  await assert.rejects(
    f.runtime.preparePresetEnvironment('mathlib'),
    /Import failed/,
  )
  assert.equal(f.runtime.preparedPresetEnvironment('mathlib'), null)
  assert.equal(
    f.runtime.templates().find((p) => p.id === 'mathlib').playgroundReady,
    false,
  )
  f.setFailure(false)
  await f.runtime.preparePresetEnvironment('mathlib')
  assert.equal(f.calls(), 2)
})

test('symbolic links cannot impersonate a prepared certificate or template marker', async (t) => {
  const f = await fixture(t)
  const prepared = await f.runtime.preparePresetEnvironment('mathlib')
  const certificate = path.join(
    f.dataDir,
    'runtime/prepared-presets',
    prepared.key + '.json',
  )
  const external = path.join(f.dataDir, 'external.json')
  await fs.rename(certificate, external)
  await fs.symlink(external, certificate)
  assert.equal(f.runtime.preparedPresetEnvironment('mathlib'), null)
  await f.runtime.preparePresetEnvironment('mathlib')
  assert.equal((await fs.lstat(certificate)).isSymbolicLink(), false)
  await fs.rename(
    path.join(f.root, '.ready.json'),
    path.join(f.root, 'real-ready.json'),
  )
  await fs.symlink(
    path.join(f.root, 'real-ready.json'),
    path.join(f.root, '.ready.json'),
  )
  assert.equal(f.runtime.preparedPresetEnvironment('mathlib'), null)
  await assert.rejects(
    f.runtime.preparePresetEnvironment('mathlib'),
    /regular file/,
  )
})
