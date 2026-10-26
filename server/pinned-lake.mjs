import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  dependencyBuildTargets,
  dependencyBuildCommand,
} from './project-libraries.mjs'
import { runSetupStep } from './setup-output.mjs'

async function pinnedText(filename, missing = false) {
  let handle
  try {
    handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (missing && ['ENOENT', 'ELOOP'].includes(error.code)) return null
    throw error
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new Error('Invalid pinned project configuration file.')
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

async function restorePinnedText(filename, content) {
  const temporary = path.join(path.dirname(filename), `.pin-${randomUUID()}`)
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, filename)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

function parsedManifest(content) {
  try {
    return JSON.parse(content)
  } catch {
    return null
  }
}

export function changedDependencyPin(original, current) {
  for (const dependency of Array.isArray(original?.packages)
    ? original.packages
    : []) {
    if (dependency?.type !== 'git' || !/^[a-f0-9]{40}$/.test(dependency.rev))
      continue
    const replacement = Array.isArray(current?.packages)
      ? current.packages.find((pkg) => pkg?.name === dependency.name)
      : null
    if (
      !replacement ||
      replacement.rev !== dependency.rev ||
      replacement.url !== dependency.url
    )
      return dependency.name || 'unnamed dependency'
  }
  return null
}

// Lake may select a dependency's newer Lean release while resolving packages.
// Every setup invocation must retain the user's release, including implicit updates.
export async function runPinnedLake(runtime, root, args, options = {}) {
  if (args[0] !== 'lake') return runtime.run(root, args, options)
  const filename = path.join(root, 'lean-toolchain')
  const original = await pinnedText(filename)
  const manifestFile = path.join(root, 'lake-manifest.json')
  const originalManifest = await pinnedText(manifestFile, true)
  try {
    const result = await runtime.run(
      root,
      Number(/^leanprover\/lean4:v4\.(\d+)\./.exec(original.trim())?.[1]) < 14
        ? args
        : ['lake', '--keep-toolchain', ...args.slice(1)],
      options,
    )
    if (
      result.code !== 0 &&
      /(?:unknown|unrecognized|invalid)[^\n]*keep-toolchain/i.test(
        result.stderr || result.stdout || '',
      )
    )
      throw Object.assign(
        new Error(
          'This pinned Lean release cannot preserve its toolchain during dependency setup. Use a compatible dependency lockfile or a supported Lean release.',
        ),
        { unsupportedEnvironment: true },
      )
    return result
  } finally {
    const messages = []
    const current = await pinnedText(filename, true)
    if (current !== original) {
      await restorePinnedText(filename, original)
      messages.push(
        'Lake changed the pinned Lean release. The original release was restored. Check that the dependencies support it, then retry setup.',
      )
    }
    const lock = parsedManifest(originalManifest)
    if (
      originalManifest !== null &&
      changedDependencyPin(
        lock,
        parsedManifest(await pinnedText(manifestFile, true)),
      )
    ) {
      await restorePinnedText(manifestFile, originalManifest)
      messages.push(
        'Lake changed a pinned dependency revision. The original lockfile was restored. Check the dependency configuration before retrying setup.',
      )
    }
    if (messages.length)
      throw Object.assign(new Error(messages.join('\n')), {
        unsupportedEnvironment: true,
        pinnedEnvironment: true,
      })
  }
}

export function dependencyCacheCommands(
  manifest,
  { dependencyOnly = false, toolchain } = {},
) {
  const names = new Set(manifest?.packages?.map((pkg) => pkg?.name) || [])
  if (!dependencyOnly && manifest?.name) names.add(manifest.name)
  const commands = names.has('mathlib')
    ? [{ args: ['lake', 'exe', 'cache', 'get'] }]
    : []
  const rootPhyslib =
    !dependencyOnly && ['Physlib', 'physlib'].includes(manifest?.name)
  const name = rootPhyslib
    ? manifest.name
    : names.has('Physlib')
      ? 'Physlib'
      : names.has('physlib')
        ? 'physlib'
        : null
  if (name) {
    if (!/^leanprover\/lean4:v4\.\d+\.\d+(?:-rc\d+)?$/.test(toolchain))
      throw new Error(
        'Physlib cache preparation requires the project’s pinned Lean release.',
      )
    const scope = `physlib-master/${toolchain.replaceAll('/', '-').replaceAll(':', '-')}/physlib`
    commands.push({
      args: ['lake', 'cache', 'get', `--package=${name}`, `--scope=${scope}`],
      optional: true,
      env: {
        LAKE_CONFIG: rootPhyslib
          ? '/workspace/lake-cache.toml'
          : `/workspace/.lake/packages/${name}/lake-cache.toml`,
      },
    })
  }
  return commands
}

export function setupFailureMessage(result) {
  return (
    infrastructureFailureMessage(result) || dependencyFailureMessage(result)
  )
}

function infrastructureFailureMessage(result) {
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n')
  if (result.timedOut)
    return 'The Lean build exceeded its time limit. Retry; if it happens again, ask the administrator to review the build limits.'
  if (result.cancelled)
    return 'The Lean worker stopped before the check finished. Retry when a worker is available.'
  if (
    result.code === 137 ||
    /(?:Lean|external command)[^\n]*\b(?:exit(?:ed)?(?: with)?(?: code)?|code)\s*[:=]?\s*137\b|\b(?:out of memory|std::bad_alloc|Cannot allocate memory)\b/i.test(
      output,
    )
  )
    return 'Lean stopped unexpectedly, often because the worker memory limit was reached. Use more memory or build one module at a time, then retry.'
  if (
    /(?:Could not resolve host|Failed to connect|Connection (?:refused|reset|timed out)|curl: \(\d+\)|HTTP\/\d(?:\.\d)?\s+(?:429|50[0-9])\b|requested URL returned error: (?:429|50[0-9])|rate limit|temporary failure in name resolution|fatal: could not read (?:Username|Password)|fatal: expected flush after ref listing|fatal: Authentication failed)/i.test(
      output,
    )
  )
    return 'Dependency access failed. Check the network and repository permissions, then retry setup.'
  return null
}

export function readOnlyDependencyFailure(result) {
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n')
  return /(?:read.only file system|EROFS|permission denied)[^\n]*(?:\n\s*)?[^\n]*\.lake\/packages|\.lake\/packages[^\n]*(?:read.only|EROFS|permission denied)/i.test(
    output,
  )
}

export function dependencyFailureMessage(result) {
  const output = [result.stderr, result.stdout].filter(Boolean).join('\n')
  if (readOnlyDependencyFailure(result))
    return 'A dependency needs build files that are missing from its read-only environment. Use Refresh setup to rebuild the pinned dependencies.'
  if (
    /\.lake\/packages\/[^\n]+:\d+:\d+:\s*error:|object file[^\n]*\.lake\/packages[^\n]*does not exist|failed to fetch[^\n]*(?:release|prebuilt)|(?:release|prebuilt)[^\n]*(?:fetch|download)[^\n]*failed/i.test(
      output,
    )
  )
    return 'A project dependency could not be prepared. Use Refresh setup, then inspect Setup output if it still fails.'
  return null
}

export async function certifyDependencyBuilds(
  runtime,
  root,
  manifest,
  options = {},
) {
  const { rebuild, ...runOptions } = options
  const targets = dependencyBuildTargets(manifest, {
    includeInherited: true,
    includeMathlib: true,
  })
  const check = async () => {
    for (const target of targets) {
      const result = await runSetupStep(
        `Verifying dependency build ${target.replace(/^@/, '')}`,
        () =>
          runPinnedLake(runtime, root, dependencyBuildCommand(target), {
            ...runOptions,
            network: 'none',
            readOnlyWorkspace: true,
            writeLakeCache: true,
            timeoutMs: 5400000,
          }),
        runOptions,
      )
      options.signal?.throwIfAborted()
      if (result.code !== 0) return result
    }
    return null
  }
  let failure = await check()
  if (
    failure &&
    rebuild &&
    !setupInfrastructureFailure(failure) &&
    readOnlyDependencyFailure(failure)
  ) {
    options.onOutput?.(
      'Preparing additional dependency build files before checking the read-only environment again.\n',
    )
    await rebuild()
    options.signal?.throwIfAborted()
    // A writable rebuild may invalidate a previously checked target. Certify
    // the entire graph again, with no further rebuild attempts.
    failure = await check()
  }
  if (failure)
    throw Object.assign(
      new Error(
        setupFailureMessage(failure) ||
          `Dependency build replay failed: ${(failure.stderr || failure.stdout || '').slice(-2000)}`,
      ),
      {
        setupEnvironment: true,
        infrastructure: setupInfrastructureFailure(failure),
      },
    )
}

export function setupInfrastructureFailure(result) {
  return infrastructureFailureMessage(result) !== null
}

// Prebuilt Physlib artifacts are an optimization. Older revisions/releases can
// compile from source when their cache configuration or published files are absent.
export async function runDependencyCache(runtime, root, command, options = {}) {
  if (command.optional) {
    const filename = path.join(
      root,
      command.env.LAKE_CONFIG.slice('/workspace/'.length),
    )
    try {
      if (!(await fs.lstat(filename)).isFile())
        throw Object.assign(new Error('Cache configuration unavailable'), {
          code: 'ENOENT',
        })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      options.onOutput?.(
        'Physlib prebuilt cache is unavailable. Building the missing files from source.\n',
      )
      return
    }
  }
  const label =
    command.args.includes('cache') && command.args.includes('exe')
      ? 'Fetching compiled Mathlib files'
      : 'Fetching compiled Physlib files'
  const result = await runSetupStep(
    label,
    () =>
      runPinnedLake(runtime, root, command.args, {
        ...options,
        env: { ...options.env, ...command.env },
      }),
    options,
  )
  options.signal?.throwIfAborted()
  if (result.code === 0) return result
  if (command.optional) {
    options.onOutput?.(
      'Physlib prebuilt cache could not be fetched. Building the missing files from source.\n',
    )
    return result
  }
  throw Object.assign(
    new Error(
      [
        setupFailureMessage(result),
        `Dependency cache failed: ${(result.stderr || result.stdout || '').slice(-2000)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    { infrastructure: setupInfrastructureFailure(result) },
  )
}
