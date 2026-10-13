import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Lake may select a dependency's newer Lean release while resolving packages.
// Every setup invocation must retain the user's release, including implicit updates.
export async function runPinnedLake(runtime, root, args, options = {}) {
  if (args[0] !== 'lake') return runtime.run(root, args, options)
  const filename = path.join(root, 'lean-toolchain')
  async function readPin() {
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      if (!(await handle.stat()).isFile())
        throw new Error('Invalid Lean toolchain file.')
      return await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  }
  const original = await readPin()
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
    let current
    try {
      current = await readPin()
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes(error.code)) throw error
    }
    if (current !== original) {
      const temporary = path.join(root, `.toolchain-${randomUUID()}`)
      try {
        await fs.writeFile(temporary, original, { mode: 0o600, flag: 'wx' })
        await fs.rename(temporary, filename)
      } finally {
        await fs.rm(temporary, { force: true })
      }
      throw Object.assign(
        new Error(
          'Lake changed the pinned Lean release. The original release was restored. Check that the dependencies support it, then retry setup.',
        ),
        { unsupportedEnvironment: true },
      )
    }
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

export function setupInfrastructureFailure(result) {
  return Boolean(
    result.timedOut ||
    result.cancelled ||
    /(?:Could not resolve host|Failed to connect|Connection (?:refused|reset|timed out)|curl: \(\d+\)|HTTP\/\d(?:\.\d)?\s+(?:429|50[0-9])\b|requested URL returned error: (?:429|50[0-9])|rate limit|temporary failure in name resolution)/i.test(
      result.stderr || result.stdout || '',
    ),
  )
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
  const result = await runPinnedLake(runtime, root, command.args, {
    ...options,
    env: { ...options.env, ...command.env },
  })
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
      `Dependency cache failed: ${(result.stderr || result.stdout || '').slice(-2000)}`,
    ),
    { infrastructure: setupInfrastructureFailure(result) },
  )
}
