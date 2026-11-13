import test from 'node:test'
import assert from 'node:assert/strict'
import {
  controllerConfig,
  resolveExecutionProfile,
  workerBundleDigest,
} from '../cluster/config.mjs'
import { PROTOCOL_VERSION } from '../cluster/protocol.mjs'

const config = { version: 1, lineage: 'profile-test', mode: 'serve', nodes: [] }
const old = {
  version: PROTOCOL_VERSION,
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
      version: PROTOCOL_VERSION,
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
    { ...old, version: 1 },
    { ...old, version: PROTOCOL_VERSION + 1 },
    { ...old, bundleDigest: 'latest' },
    { ...old, imageDigest: 'worker:latest' },
    { version: PROTOCOL_VERSION, bundleDigest: old.bundleDigest },
    { version: PROTOCOL_VERSION, imageDigest: old.imageDigest },
  ])
    assert.throws(() =>
      controllerConfig({ ...config, executionProfile: value }),
    )
})
