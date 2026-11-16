import {
  runPinnedLake,
  dependencyCacheCommands,
  runDependencyCache,
} from './pinned-lake.mjs'
import {
  dependencyBuildTargets,
  dependencyBuildCommand,
} from './project-libraries.mjs'
import { readDependencyConfiguration } from './shared-dependencies.mjs'
import { sourceFingerprint } from './source-fingerprint.mjs'

// A verification workspace must rebuild its own missing private dependencies.
// Never inherit a failed project's partial cache or trust the agent's artifacts.
export async function preparePrivateSetupDependencies(
  runtime,
  root,
  { toolchain, signal, timeoutMs = 1800000, onOutput } = {},
) {
  const fingerprint = await sourceFingerprint(root, { signal })
  const configuration = readDependencyConfiguration(root)
  const manifest = configuration['lake-manifest.json']
    ? JSON.parse(configuration['lake-manifest.json'])
    : null
  const options = {
    signal,
    network: 'bridge',
    readOnlyWorkspace: true,
    writeLakeCache: true,
    writePrivateDependencyCache: true,
    timeoutMs,
    onOutput,
  }
  const run = async (args) => {
    const result = await runPinnedLake(runtime, root, args, options)
    signal?.throwIfAborted()
    if (result.code !== 0)
      throw new Error(
        `The independent setup environment could not be prepared: ${(result.stderr || result.stdout || 'Lake failed.').slice(-2000)}`,
      )
  }
  await run(['lake', 'env', 'lean', '--version'])
  for (const command of dependencyCacheCommands(manifest, { toolchain }))
    await runDependencyCache(runtime, root, command, options)
  const plan = await runtime.dependencyBuildPlan?.(root, { signal, onOutput })
  for (const target of dependencyBuildTargets(manifest, {
    includeInherited: true,
    includeMathlib: true,
  }))
    await run(dependencyBuildCommand(target, plan))
  if (fingerprint !== (await sourceFingerprint(root, { signal })))
    throw Object.assign(
      new Error(
        'Project source or configuration changed while preparing the independent setup check. The saved project was preserved.',
      ),
      { status: 409 },
    )
}
