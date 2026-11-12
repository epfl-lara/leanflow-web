import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BlobStore, captureTree } from '../cluster/blobs.mjs'
import { CheckInputs, manifestFingerprint } from '../cluster/check-inputs.mjs'
import { sourceFingerprint } from '../source-fingerprint.mjs'

async function fixture(t) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lf-inputs-')),
  )
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = path.join(directory, 'project')
  const toolchain = path.join(directory, 'toolchain')
  await fs.mkdir(root)
  await fs.mkdir(toolchain)
  await fs.writeFile(path.join(toolchain, 'lean'), 'pinned-toolchain')
  await fs.writeFile(
    path.join(root, 'lean-toolchain'),
    'leanprover/lean4:v4.35.0\n',
  )
  await fs.writeFile(
    path.join(root, 'Main.lean'),
    'example : True := by trivial\n',
  )
  const blobs = await new BlobStore(path.join(directory, 'objects')).init()
  const runtime = {
    runtimeDir: path.join(directory, 'runtime'),
    toolchains: new Map([['leanprover/lean4:v4.35.0', toolchain]]),
    dependencyRoot() {
      return null
    },
    dependencyPreparationReason() {
      return null
    },
  }
  return {
    root,
    directory,
    blobs,
    runtime,
    inputs: new CheckInputs({ blobs, runtime }),
  }
}

test('frozen source fingerprints match canonical Unicode, links and generated-cache exclusions', async (t) => {
  const f = await fixture(t)
  for (const name of ['😀.lean', '\ue000.lean', 'é.lean'])
    await fs.writeFile(path.join(f.root, name), name)
  await fs.symlink('Main.lean', path.join(f.root, 'link.lean'))
  await fs.mkdir(path.join(f.root, '.lake'))
  await fs.writeFile(path.join(f.root, '.lake', 'generated'), 'ignored')
  const source = await captureTree(f.blobs, f.root, { ignoreLake: true })
  assert.equal(
    manifestFingerprint(source.manifest),
    await sourceFingerprint(f.root),
  )
  const input = await f.inputs.capture(f.root)
  assert.equal(input.sourceManifest, source.hash)
  await fs.writeFile(path.join(f.root, 'Main.lean'), 'changed')
  assert.notEqual(
    (await f.inputs.capture(f.root)).sourceManifest,
    input.sourceManifest,
  )
})

test('private inputs cause local eligibility fallback and never enter a transferred manifest', async (t) => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.root, '.env'), 'private-value')
  assert.equal(await f.inputs.capture(f.root), null)
  const source = await captureTree(f.blobs, f.root, { ignoreLake: true })
  assert.equal(
    source.manifest.entries.some((entry) => entry.path === '.env'),
    false,
  )
})

test('changed source, unknown toolchains and mutable dependency trees cannot silently pass remotely', async (t) => {
  const f = await fixture(t)
  const fingerprint = await sourceFingerprint(f.root)
  await fs.writeFile(path.join(f.root, 'Main.lean'), 'changed')
  await assert.rejects(f.inputs.capture(f.root, { fingerprint }), {
    code: 'source_changed',
  })
  f.runtime.dependencyRoot = () => path.join(f.directory, 'mutable')
  assert.equal(await f.inputs.capture(f.root), null)
  f.runtime.dependencyRoot = () => null
  f.runtime.toolchains.clear()
  assert.equal(await f.inputs.capture(f.root), null)
})

test('shared immutable dependencies and toolchains are captured once while source stays fresh', async (t) => {
  const f = await fixture(t)
  const environment = path.join(
    f.runtime.runtimeDir,
    'shared-dependencies',
    'environment',
  )
  await fs.mkdir(path.join(environment, '.lake/packages'), { recursive: true })
  await fs.writeFile(
    path.join(environment, '.lake/packages', 'dependency'),
    'immutable',
  )
  await fs.writeFile(
    path.join(environment, 'lake-manifest.json'),
    '{"packages":[]}',
  )
  f.runtime.dependencyRoot = () => environment
  const first = await f.inputs.capture(f.root)
  assert.ok(first.dependencies)
  assert.equal(f.inputs.assets.size, 2)
  const second = await f.inputs.capture(f.root)
  assert.deepEqual(second, first)
  assert.equal(f.inputs.assets.size, 2)
})
