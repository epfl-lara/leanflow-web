import test from 'node:test'
import assert from 'node:assert/strict'
import {
  controllerConfig,
  resolveExecutionProfile,
  workerBundleDigest,
} from '../cluster/config.mjs'

const config = { version: 1, lineage: 'profile-test', mode: 'serve', nodes: [] }
const old = {
  version: 1,
  bundleDigest: 'a'.repeat(64),
  imageDigest: 'sha256:' + 'b'.repeat(64),
}
const current = 'sha256:' + 'c'.repeat(64)

test('a certified worker execution profile stays pinned across coordinator image and source updates', async () => {
  const normalized = controllerConfig({ ...config, executionProfile: old })
  assert.deepEqual(await resolveExecutionProfile(normalized, current), old)
  assert.deepEqual(controllerConfig(normalized).executionProfile, old)
})

test('without an explicit execution profile the coordinator still requires matching local bundle and image', async () => {
  assert.deepEqual(
    await resolveExecutionProfile(controllerConfig(config), current),
    {
      version: 1,
      bundleDigest: await workerBundleDigest(),
      imageDigest: current,
    },
  )
  await assert.rejects(
    resolveExecutionProfile(controllerConfig(config), 'latest'),
  )
})

test('an execution profile cannot accept another protocol, partial pins or malformed digests', () => {
  for (const value of [
    null,
    [],
    {},
    { ...old, version: 2 },
    { ...old, bundleDigest: 'latest' },
    { ...old, imageDigest: 'worker:latest' },
    { version: 1, bundleDigest: old.bundleDigest },
    { version: 1, imageDigest: old.imageDigest },
  ])
    assert.throws(() =>
      controllerConfig({ ...config, executionProfile: value }),
    )
})
