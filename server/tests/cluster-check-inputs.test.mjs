import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BlobStore, captureTree } from '../cluster/blobs.mjs'
import { CheckInputs, manifestFingerprint } from '../cluster/check-inputs.mjs'
import { ClusterChecks } from '../cluster/checks.mjs'
import { sourceFingerprint } from '../source-fingerprint.mjs'
import { registeredToolchainRoot } from '../cluster/config.mjs'
import { publicPreset, presetTemplatePaths } from '../public-preset.mjs'

async function fixture(t) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'lf-inputs-')),
  )
  let inputs
  // Stop service-owned captures before removing the trees they read.
  t.after(async () => {
    await inputs?.close()
    await fs.rm(directory, { recursive: true, force: true })
  })
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
  const blobs = await new BlobStore(path.join(directory, 'objects'), {
    assetDataDir: directory,
  }).init()
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
  inputs = new CheckInputs({ blobs, runtime })
  return { root, directory, blobs, runtime, inputs }
}

// An ordinary check never waits for a cold immutable capture. The first one
// schedules it in the service-owned lane and runs locally.
async function warmAssets(f) {
  assert.equal(await f.inputs.capture(f.root), null)
  await f.inputs.settleAssets()
}

// Holds selected service-owned captures until released or stopped by close().
function holdCaptures(f, selected = () => true) {
  const gate = Promise.withResolvers()
  const held = { started: 0, release: () => gate.resolve() }
  const capture = f.inputs.captureAsset.bind(f.inputs)
  f.inputs.captureAsset = async (root, kind, signal) => {
    if (selected(root, kind)) {
      held.started++
      await new Promise((resolve, reject) => {
        gate.promise.then(resolve)
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    }
    return capture(root, kind, signal)
  }
  return held
}

async function until(condition, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for a capture.')
    await delay(5)
  }
}

const storedObjects = async (f) => (await fs.readdir(f.blobs.objects)).sort()

test('frozen source fingerprints match canonical Unicode, links and generated-cache exclusions', async (t) => {
  const f = await fixture(t)
  await warmAssets(f)
  for (const name of ['😀.lean', '.lean', 'é.lean'])
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
  await warmAssets(f)
  assert.ok(await f.inputs.capture(f.root))
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
  await warmAssets(f)
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

test('shared immutable assets are captured once in the background while source and changed asset roots stay fresh', async (t) => {
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
  assert.equal(
    await f.inputs.capture(f.root),
    null,
    'a cold environment keeps the first check local',
  )
  await f.inputs.settleAssets()
  assert.equal(f.inputs.assets.size, 2)
  const first = await f.inputs.capture(f.root)
  assert.ok(first.dependencies)
  const second = await f.inputs.capture(f.root)
  assert.deepEqual(second, first)
  assert.equal(f.inputs.assets.size, 2)
  // A changed toolchain root is a new identity; its old capture is not reused.
  const toolchain = f.runtime.toolchains.get('leanprover/lean4:v4.35.0')
  await fs.writeFile(path.join(toolchain, 'lake'), 'changed-toolchain')
  const changed = new Date(Date.now() + 60_000)
  await fs.utimes(toolchain, changed, changed)
  assert.equal(await f.inputs.capture(f.root), null)
  await f.inputs.settleAssets()
  const third = await f.inputs.capture(f.root)
  assert.notEqual(third.toolchain.manifest, first.toolchain.manifest)
  assert.equal(third.dependencies, first.dependencies)
})

test('template-bound, legacy and unregistered ordinary checks fall back before any snapshot or asset capture', async (t) => {
  const f = await fixture(t)
  await warmAssets(f)
  const stored = await storedObjects(f)
  const assets = f.inputs.assets.size
  const template = presetTemplatePaths(
    f.runtime.runtimeDir,
    publicPreset('mathlib'),
  )[0]
  const legacy = path.join(f.runtime.runtimeDir, 'shared-dependencies', 'old')
  // A snapshot with this outdated fingerprint would fail as source_changed.
  // These checks return first, without reading or copying project source.
  for (const [dependencyRoot, reason] of [
    [template, null],
    [legacy, 'This project uses an older dependency cache.'],
  ]) {
    f.runtime.dependencyRoot = () => dependencyRoot
    f.runtime.dependencyPreparationReason = () => reason
    assert.equal(
      await f.inputs.capture(f.root, { fingerprint: 'outdated' }),
      null,
    )
  }
  f.runtime.dependencyRoot = () => null
  f.runtime.toolchains.clear()
  assert.equal(
    await f.inputs.capture(f.root, { fingerprint: 'outdated' }),
    null,
  )
  assert.deepEqual(await storedObjects(f), stored)
  assert.equal(f.inputs.assets.size, assets)
})

test('a first requester leaving never cancels the shared capture that later checks reuse', async (t) => {
  const f = await fixture(t)
  const held = holdCaptures(f)
  const user = new AbortController()
  assert.equal(await f.inputs.capture(f.root, { signal: user.signal }), null)
  user.abort(new Error('The first user left.'))
  await until(() => held.started === 1)
  assert.equal(
    await f.inputs.capture(f.root),
    null,
    'a capture in progress keeps checks local without starting another',
  )
  held.release()
  await f.inputs.settleAssets()
  assert.equal(held.started, 1)
  assert.ok((await f.inputs.capture(f.root)).toolchain.manifest)
})

test('close stops and drains service-owned captures and schedules no more', async (t) => {
  const f = await fixture(t)
  const started = Promise.withResolvers()
  let captures = 0,
    stopped = false
  f.inputs.captureAsset = (_root, _kind, signal) => {
    captures++
    started.resolve()
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        'abort',
        // A real helper exits shortly after its stop signal.
        () =>
          setTimeout(() => {
            stopped = true
            reject(signal.reason)
          }, 20),
        { once: true },
      ),
    )
  }
  assert.equal(await f.inputs.capture(f.root), null)
  await started.promise
  await f.inputs.close()
  assert.equal(stopped, true, 'close waits until the stopped capture settles')
  assert.equal(await f.inputs.capture(f.root), null)
  await f.inputs.settleAssets()
  assert.equal(captures, 1, 'no capture starts after close')
})

test('with one request slot, a held asset capture never blocks editor or check snapshots', async (t) => {
  const f = await fixture(t)
  await warmAssets(f)
  const version = 'leanprover/lean4:v4.34.1'
  const other = path.join(f.directory, 'other')
  const otherToolchain = path.join(f.directory, 'other-toolchain')
  await fs.mkdir(other)
  await fs.mkdir(otherToolchain)
  await fs.writeFile(path.join(otherToolchain, 'lean'), 'other-toolchain')
  await fs.writeFile(path.join(other, 'lean-toolchain'), version + '\n')
  await fs.writeFile(
    path.join(other, 'Main.lean'),
    'example : True := by trivial\n',
  )
  f.runtime.toolchains.set(version, otherToolchain)
  const held = holdCaptures(f, (root) => root === otherToolchain)
  const runs = []
  const checks = new ClusterChecks({
    mode: 'serve',
    maxCaptures: 1,
    inputs: f.inputs,
    controller: {
      async run(input) {
        runs.push(input)
        return { code: 0, stdout: 'remote', stderr: '' }
      },
    },
  })
  const context = (jobId) => ({
    project: { id: 'other', root: other },
    owner: 'alice',
    jobId,
    file: 'Main.lean',
    kernelCheck: false,
    options: {
      timeoutMs: 60000,
      signal: new AbortController().signal,
      onOutput: () => {},
    },
  })
  const local = async () => ({ code: 0, stdout: 'local', stderr: '' })
  assert.equal((await checks.execute(context('cold'), local)).stdout, 'local')
  await until(() => held.started === 1)
  const editor = await checks.captureEditor(
    f.root,
    new AbortController().signal,
  )
  assert.ok(editor.sourceManifest, 'the editor snapshot used the only slot')
  assert.equal(runs.length, 0)
  held.release()
  await f.inputs.settleAssets()
  assert.equal((await checks.execute(context('warm'), local)).stdout, 'remote')
  assert.equal(runs[0].toolchain.version, version)
  assert.equal(held.started, 1)
  await checks.close()
})

for (const versioned of [false, true])
  test(`only verified ${versioned ? 'versioned' : 'legacy'} public templates extend dependency eligibility for editor captures`, async (t) => {
    const f = await fixture(t)
    const preset = publicPreset('lean')
    f.runtime.toolchains.set(
      preset.toolchain,
      [...f.runtime.toolchains.values()][0],
    )
    await fs.writeFile(
      path.join(f.root, 'lean-toolchain'),
      preset.toolchain + '\n',
    )
    const environment = presetTemplatePaths(f.runtime.runtimeDir, preset)[
      versioned ? 0 : 1
    ]
    await fs.mkdir(path.join(environment, '.lake/packages'), {
      recursive: true,
      mode: 0o700,
    })
    await fs.writeFile(
      path.join(environment, '.lake/packages/dependency'),
      'public',
      { mode: 0o600 },
    )
    await fs.writeFile(
      path.join(environment, 'lake-manifest.json'),
      JSON.stringify({ packages: [] }),
      { mode: 0o600 },
    )
    f.runtime.dependencyRoot = () => environment
    assert.equal(await f.inputs.capture(f.root, { editor: true }), null)
    f.runtime.transferableDependencyRoot = () => environment
    assert.equal(
      await f.inputs.capture(f.root),
      null,
      'ordinary check eligibility stays unchanged',
    )
    await fs.writeFile(
      path.join(environment, 'lean-toolchain'),
      preset.toolchain + '\n',
      { mode: 0o600 },
    )
    await fs.writeFile(
      path.join(environment, 'lakefile.toml'),
      'name = "TemplateFixture"\n',
      { mode: 0o600 },
    )
    await fs.writeFile(
      path.join(environment, '.ready.json'),
      JSON.stringify({
        code: 0,
        toolchain: preset.toolchain,
        revision: preset.revision,
      }),
      { mode: 0o600 },
    )
    let captures = 0
    const captureAsset = f.inputs.captureAsset.bind(f.inputs)
    f.inputs.captureAsset = (...args) => {
      captures++
      return captureAsset(...args)
    }
    // A stopped warm-up wait leaves its service-owned capture running.
    const stopped = new AbortController()
    const waiting = f.inputs.prepareEditorAssets({
      root: environment,
      preset: 'lean',
      signal: stopped.signal,
    })
    stopped.abort(new Error('Warm-up wait stopped.'))
    await assert.rejects(waiting, /Warm-up wait stopped/)
    await f.inputs.prepareEditorAssets({ root: environment, preset: 'lean' })
    assert.equal(captures, 2, 'toolchain and dependencies are captured once')
    const captured = await f.inputs.capture(f.root, { editor: true })
    assert.ok(captured.dependencies)
    assert.ok(captured.editorSource)
    const prepared = f.inputs.editorEnvironment
    f.inputs.editorEnvironment = undefined
    assert.equal(await f.inputs.capture(f.root, { editor: true }), null)
    f.inputs.editorEnvironment = { ...prepared, dependencies: 'f'.repeat(64) }
    assert.equal(await f.inputs.capture(f.root, { editor: true }), null)
    f.inputs.editorEnvironment = prepared
    assert.equal(
      await f.inputs.prepareEditorAssets({
        root: environment,
        preset: 'mathlib',
      }),
      null,
    )
  })

test('preset preloading uses the protected toolchain directory registered by the running coordinator', async (t) => {
  const f = await fixture(t)
  await fs.mkdir(f.runtime.runtimeDir, { recursive: true, mode: 0o700 })
  const registry = path.join(f.runtime.runtimeDir, 'toolchains.json')
  const version = 'leanprover/lean4:v4.35.0'
  await fs.writeFile(
    registry,
    JSON.stringify({ [version]: f.runtime.toolchains.get(version) }),
    { mode: 0o600 },
  )
  assert.equal(
    await registeredToolchainRoot(f.directory, version),
    f.runtime.toolchains.get(version),
  )
  await fs.chmod(registry, 0o664)
  await assert.rejects(
    registeredToolchainRoot(f.directory, version),
    /protected/,
  )
  await fs.chmod(registry, 0o600)
  await assert.rejects(
    registeredToolchainRoot(f.directory, 'not-a-version'),
    /exact official/,
  )
})
