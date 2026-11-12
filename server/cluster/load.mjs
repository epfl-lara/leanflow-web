import fs from 'node:fs/promises'
import path from 'node:path'
import { BlobStore } from './blobs.mjs'
import { CheckInputs } from './check-inputs.mjs'
import { ClusterChecks } from './checks.mjs'
import { readControllerConfig, resolveExecutionProfile } from './config.mjs'

export async function loadClusterChecks({
  filename = process.env.STUDIO_CLUSTER_CONFIG,
  dataDir,
  runtime,
} = {}) {
  if (!filename) return null
  const config = await readControllerConfig(filename)
  if (config.mode === 'off') return null
  const imageDigest = runtime.info().imageId
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest || ''))
    throw new Error(
      'Initialize the pinned local worker image before enabling distributed checks.',
    )
  const directory = path.join(dataDir, 'cluster')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await fs.realpath(directory)) !== directory)
    throw new Error('Cluster state must use a private local directory.')
  const blobs = new BlobStore(path.join(directory, 'blobs'), {
    maxBytes: config.maxStoreBytes,
    maxFiles: config.maxStoreFiles,
    reserveBytes: config.reserveBytes,
  })
  const { ClusterController } = await import('./controller.mjs')
  const executionProfile = await resolveExecutionProfile(config, imageDigest)
  const controller = new ClusterController({
    config,
    dataDir: directory,
    blobs,
    bundleDigest: executionProfile.bundleDigest,
    imageDigest: executionProfile.imageDigest,
  })
  try {
    await controller.init()
    await blobs.init()
  } catch (error) {
    await controller.shutdown().catch(() => {})
    blobs.close()
    throw error
  }
  const checks = new ClusterChecks({
    controller,
    inputs: new CheckInputs({ blobs, runtime }),
    mode: config.mode,
    maxQueue: config.maxQueue,
    maxPerActor: config.maxPerActor,
  })
  return checks
}
