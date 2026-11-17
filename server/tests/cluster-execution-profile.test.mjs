import test from 'node:test'
import assert from 'node:assert/strict'
import {
  controllerConfig,
  resolveExecutionProfile,
  workerBundleDigest,
  nodeConfig,
} from '../cluster/config.mjs'
import { PROTOCOL_VERSION } from '../cluster/protocol.mjs'

const config = { version: 1, lineage: 'profile-test', mode: 'serve', nodes: [] }
const old = {
  version: PROTOCOL_VERSION,
  bundleDigest: 'a'.repeat(64),
  imageDigest: 'sha256:' + 'b'.repeat(64),
}
const current = 'sha256:' + 'c'.repeat(64)

test('eight editors preserve a native grant inside the shared 48 GiB and 16 CPU boundary', () => {
  const parsed = nodeConfig({
    version: 1,
    nodeId: 'native-headroom',
    controllerLineage: 'lineage',
    dataDir: '/private/worker',
    image: current,
    workerMemory: '6g',
    workerCpus: 2,
    memoryBudget: '42g',
    maxCpus: 14,
    maxConcurrent: 11,
    parentMemoryMax: '48g',
    parentMaxCpus: 16,
    editors: {
      maxConcurrent: 8,
      memory: '3g',
      cpus: 1,
      cpuReservation: 1,
      reservedBatchMemory: '18g',
      reservedBatchCpus: 6,
    },
  })
  assert.equal(
    parsed.maxEditors * parsed.editorMemoryBytes +
      parsed.editorBatchMemoryBytes,
    parsed.budgetBytes,
  )
  assert.equal(
    parsed.maxEditors * parsed.editorCpuReservation + parsed.editorBatchCpus,
    parsed.maxCpus,
  )
  assert.equal(parsed.maxConcurrent, parsed.maxEditors + 3)
})

test('worker image overrides require an exact local digest and survive normalization', () => {
  const node = {
    id: 'worker-a',
    host: 'worker.test',
    user: 'leanflow',
    identityFile: '/private/key',
    knownHostsFile: '/private/known_hosts',
    imageDigest: current,
  }
  const parsed = controllerConfig({ ...config, nodes: [node] })
  assert.equal(parsed.nodes[0].imageDigest, current)
  assert.deepEqual(controllerConfig(parsed), parsed)
  for (const imageDigest of [
    null,
    '',
    'worker:latest',
    'sha256:' + 'z'.repeat(64),
    123,
    {},
  ])
    assert.throws(
      () => controllerConfig({ ...config, nodes: [{ ...node, imageDigest }] }),
      /exact digest/,
    )
})

test('shared worker editor CPU caps fit the agreed pool and normalized policies survive reload', () => {
  const value = {
    version: 1,
    nodeId: 'node',
    controllerLineage: 'lineage',
    dataDir: '/private/worker',
    image: current,
    workerMemory: '6g',
    memoryBudget: '24g',
    maxCpus: 8,
    parentMaxCpus: 16,
    editors: {
      maxConcurrent: 6,
      memory: '3g',
      cpus: 1,
      cpuReservation: 1,
      reservedBatchMemory: '6g',
      reservedBatchCpus: 2,
    },
  }
  const parsed = nodeConfig(value)
  assert.equal(parsed.maxConcurrent, 7)
  assert.deepEqual(nodeConfig(parsed), parsed)
  assert.throws(
    () => nodeConfig({ ...value, editors: { ...value.editors, cpus: 2 } }),
    /CPU bursts/,
  )
  assert.equal(
    nodeConfig({
      ...value,
      parentMaxCpus: 8,
      editors: { ...value.editors, cpus: 2 },
    }).editorCpus,
    2,
  )
  assert.throws(() => nodeConfig({ ...value, maxConcurrent: 6 }), /concurrency/)
})

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
