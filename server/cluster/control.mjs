#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { BlobStore, captureTree } from './blobs.mjs'
import { ClusterController } from './controller.mjs'
import {
  readControllerConfig,
  resolveExecutionProfile,
  registeredToolchainRoot,
} from './config.mjs'
import { clusterError, digest } from './state.mjs'
import {
  capturePreparedDependencies,
  capturePresetDependencies,
  capturePresetEditorSource,
} from './dependencies.mjs'

const usage =
  'Usage: node server/cluster/control.mjs status|image|prepare|fixture|gc|trim --config /private/controller.json --data /coordinator/data --image sha256:... [--node id] [--archive /image.tar.gz] [--toolchain leanprover/lean4:v...] [--toolchain-dir /pinned/toolchain | --toolchain-manifest sha256] [--dependency-dir /coordinator/data/runtime/shared-dependencies/DIGEST | --dependencies sha256 | --preset mathlib] [--certify true|false] [--operation check.build|check.kernel]'

async function fixtureSource(blobs, version) {
  const files = {
    'lean-toolchain': version + '\n',
    'lakefile.toml':
      'name = "cluster_fixture"\nversion = "0.0.0"\ndefaultTargets = ["ClusterFixture"]\n[[lean_lib]]\nname = "ClusterFixture"\n',
    'lake-manifest.json': JSON.stringify({
      version: '1.1.0',
      packagesDir: '.lake/packages',
      packages: [],
      name: 'cluster_fixture',
      lakeDir: '.lake',
    }),
    'ClusterFixture.lean':
      'import ClusterFixture.Helper\nexample : True := cluster_fixture_helper\n',
    'ClusterFixture/Helper.lean':
      'theorem cluster_fixture_helper : True := by trivial\n',
    'Loose.lean':
      'import ClusterFixture.Helper\nexample : True := cluster_fixture_helper\n',
    'Invalid.lean': 'example : False := by trivial\n',
  }
  const entries = [{ path: 'ClusterFixture', type: 'directory' }]
  for (const [name, text] of Object.entries(files)) {
    const object = await blobs.put(text)
    entries.push({ path: name, type: 'file', ...object, mode: 0o600 })
  }
  return (await blobs.seal(entries)).hash
}

export async function controlMain(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(usage + '\n')
    return
  }
  const [command, ...args] = argv
  if (
    !['status', 'image', 'prepare', 'fixture', 'gc', 'trim'].includes(
      command,
    ) ||
    args.length % 2
  )
    throw clusterError(usage)
  const allowed = new Set([
    '--config',
    '--data',
    '--image',
    '--node',
    '--archive',
    '--toolchain',
    '--toolchain-dir',
    '--toolchain-manifest',
    '--operation',
    '--dependency-dir',
    '--dependencies',
    '--preset',
    '--certify',
  ])
  const flags = new Map()
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || flags.has(args[index]) || !args[index + 1])
      throw clusterError(usage)
    flags.set(args[index], args[index + 1])
  }
  for (const name of ['--config', '--data', '--image'])
    if (!flags.has(name)) throw clusterError(usage)
  if (!['status', 'gc', 'trim'].includes(command) && !flags.has('--node'))
    throw clusterError('Select an enrolled worker with --node.')
  const dependencyFlags = [
    '--dependency-dir',
    '--dependencies',
    '--preset',
  ].filter((flag) => flags.has(flag))
  if (
    dependencyFlags.length &&
    (command !== 'prepare' || dependencyFlags.length !== 1)
  )
    throw clusterError('Use one dependency directory or manifest with prepare.')
  if (
    flags.has('--certify') &&
    (command !== 'prepare' ||
      !['true', 'false'].includes(flags.get('--certify')))
  )
    throw clusterError('Use --certify true|false only with prepare.')
  if (flags.has('--preset') && flags.get('--preset') !== 'mathlib')
    throw clusterError(
      'Remote editor preset preloading currently supports mathlib only.',
    )
  const config = await readControllerConfig(flags.get('--config'))
  if (config.mode !== 'off')
    throw clusterError(
      'Drain distributed checks and switch the website configuration to off before running maintenance commands.',
      'maintenance_required',
      409,
    )
  const dataDir = flags.get('--data')
  if (!path.isAbsolute(dataDir) || (await fs.realpath(dataDir)) !== dataDir)
    throw clusterError(
      'Coordinator data must be an existing real absolute directory.',
    )
  const directory = path.join(dataDir, 'cluster')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  if ((await fs.realpath(directory)) !== directory)
    throw clusterError('Cluster state must be a real directory.')
  const blobs = new BlobStore(path.join(directory, 'blobs'), {
    maxBytes: config.maxStoreBytes,
    maxFiles: config.maxStoreFiles,
    reserveBytes: config.reserveBytes,
    assetDataDir: dataDir,
  })
  const { bundleDigest } = await resolveExecutionProfile(
    config,
    flags.get('--image'),
  )
  if (
    config.executionProfile &&
    config.executionProfile.imageDigest !== flags.get('--image')
  )
    throw clusterError(
      'The maintenance image must match the enrolled execution profile.',
      'release_mismatch',
      409,
    )
  const nodeId = flags.get('--node')
  const selected = nodeId
    ? config.nodes.filter((node) => node.id === nodeId)
    : config.nodes
  if (nodeId && !selected.length)
    throw clusterError('This worker is not enrolled.')
  const controller = new ClusterController({
    config: {
      ...config,
      mode: 'shadow',
      nodes: command === 'trim' ? [] : selected,
    },
    dataDir: directory,
    blobs,
    bundleDigest,
    imageDigest: flags.get('--image'),
  })
  const abort = new AbortController()
  const stop = () =>
    abort.abort(clusterError('Maintenance command stopped.', 'cancelled', 499))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await controller.init()
    await blobs.init()
    if (command === 'trim') {
      process.stdout.write(
        JSON.stringify(
          await blobs.trimAssetCopies({ signal: abort.signal }),
          null,
          2,
        ) + '\n',
      )
      return
    }
    if (command === 'gc') {
      process.stdout.write(
        JSON.stringify(await controller.compactCaches({ nodeId }), null, 2) +
          '\n',
      )
      return
    }
    if (command === 'status') {
      const deadline = performance.now() + 30000
      while (
        controller
          .status()
          .workers.some((node) => node.state === 'connecting') &&
        performance.now() < deadline
      ) {
        abort.signal.throwIfAborted()
        await delay(100)
      }
      process.stdout.write(
        JSON.stringify(
          {
            bundleDigest,
            ...controller.status(),
            cache: {
              objects: blobs.usage(),
              assets: blobs.assetSources?.usage() || null,
            },
          },
          null,
          2,
        ) + '\n',
      )
      return
    }
    if (command === 'image') {
      if (!flags.has('--archive'))
        throw clusterError(
          'Provide the reviewed compressed image archive with --archive.',
        )
      const object = await blobs.putFile(flags.get('--archive'), {
        signal: abort.signal,
      })
      process.stdout.write(
        JSON.stringify(
          await controller.loadImage(nodeId, object.hash, {
            signal: abort.signal,
          }),
          null,
          2,
        ) + '\n',
      )
      return
    }
    const version = flags.get('--toolchain')
    if (
      !/^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/.test(
        version || '',
      )
    )
      throw clusterError('Provide the exact official --toolchain pin.')
    let toolchainManifest = flags.get('--toolchain-manifest')
    if (flags.has('--preset')) {
      const root = await registeredToolchainRoot(dataDir, version)
      if (flags.has('--toolchain-dir') && flags.get('--toolchain-dir') !== root)
        throw clusterError(
          'The preset toolchain directory must match the coordinator runtime registry.',
        )
      const captured = await captureTree(blobs, root, {
        kind: 'toolchain',
        signal: abort.signal,
      })
      if (toolchainManifest && digest(toolchainManifest) !== captured.hash)
        throw clusterError(
          'The provided toolchain manifest differs from the coordinator runtime.',
        )
      toolchainManifest = captured.hash
    } else if (toolchainManifest) digest(toolchainManifest)
    else {
      const root = flags.get('--toolchain-dir')
      if (!root || !path.isAbsolute(root) || (await fs.realpath(root)) !== root)
        throw clusterError(
          'Provide the real pinned toolchain directory or its recorded manifest.',
        )
      toolchainManifest = (
        await captureTree(blobs, root, {
          kind: 'toolchain',
          signal: abort.signal,
        })
      ).hash
    }
    const input = { toolchain: { version, manifest: toolchainManifest } }
    if (command === 'prepare') {
      if (flags.has('--preset')) {
        input.dependencies = (
          await capturePresetDependencies(blobs, {
            dataDir,
            preset: flags.get('--preset'),
            version,
            signal: abort.signal,
          })
        ).hash
        input.editorSource = (
          await capturePresetEditorSource(blobs, {
            dataDir,
            preset: flags.get('--preset'),
            version,
            signal: abort.signal,
          })
        ).hash
      } else if (flags.has('--dependencies'))
        input.dependencies = digest(flags.get('--dependencies'))
      else if (flags.has('--dependency-dir'))
        input.dependencies = (
          await capturePreparedDependencies(
            blobs,
            flags.get('--dependency-dir'),
            {
              dataDir,
              version,
              signal: abort.signal,
            },
          )
        ).hash
      const report = await controller.prepareNode(nodeId, input, {
        certify: flags.get('--certify') !== 'false',
        signal: abort.signal,
      })
      const editorEnvironmentReady =
        !input.editorSource ||
        report.editorEnvironments.some(
          (environment) =>
            environment.toolchain.version === input.toolchain.version &&
            environment.toolchain.manifest === input.toolchain.manifest &&
            environment.dependencies === input.dependencies &&
            environment.editorSource === input.editorSource,
        )
      process.stdout.write(
        JSON.stringify(
          { ...report, editorEnvironmentReady, bundleDigest, ...input },
          null,
          2,
        ) + '\n',
      )
      if (
        !report.ready ||
        !report.capabilities.length ||
        !editorEnvironmentReady
      )
        process.exitCode = 2
      return
    }
    const operation = flags.get('--operation') || 'check.build'
    if (!['check.build', 'check.kernel'].includes(operation))
      throw clusterError(
        'Fixture operation must be check.build or check.kernel.',
      )
    // Wait only for the initial connection. An uncertified or incompatible
    // worker is reported as unavailable; a local check cannot satisfy this gate.
    const deadline = performance.now() + 30000
    while (
      controller.status().workers.some((node) => node.state === 'connecting') &&
      performance.now() < deadline
    ) {
      abort.signal.throwIfAborted()
      await delay(100)
    }
    input.sourceManifest = await fixtureSource(blobs, version)
    const options = {
      actor: 'cluster-conformance',
      projectId: 'synthetic-fixture',
      jobId: 'fixture-' + Date.now(),
      timeoutMs: 300000,
      signal: abort.signal,
    }
    const started = performance.now()
    const valid = await controller.run(input, {
      ...options,
      operation,
      file: 'Loose.lean',
    })
    const invalid = valid
      ? await controller.run(input, {
          ...options,
          jobId: options.jobId + '-invalid',
          operation: 'lean.file',
          file: 'Invalid.lean',
        })
      : null
    const ok =
      valid?.code === 0 && Number.isInteger(invalid?.code) && invalid.code !== 0
    process.stdout.write(
      JSON.stringify(
        {
          ok,
          nodeId,
          bundleDigest,
          toolchain: input.toolchain,
          operation,
          valid,
          invalid,
          durationMs: Math.round(performance.now() - started),
        },
        null,
        2,
      ) + '\n',
    )
    if (!ok) process.exitCode = 2
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    const report = await controller.shutdown()
    blobs.close()
    if (report.unresolved) {
      process.stderr.write(
        'Unconfirmed remote cleanup remains quarantined. Reconcile before serving traffic.\n',
      )
      process.exitCode = 2
    }
  }
}

if (
  process.argv[1] &&
  (await fs.realpath(path.resolve(process.argv[1])).catch(() => null)) ===
    fileURLToPath(import.meta.url)
) {
  try {
    await controlMain()
  } catch (error) {
    process.stderr.write(
      (error.status
        ? error.message
        : 'Cluster maintenance failed. Check the configuration and worker logs.') +
        '\n',
    )
    process.exitCode = 1
  }
}
