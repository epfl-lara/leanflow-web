import { removeDisposableTree } from './temporary-workspaces.mjs'
import { runSetupStep, setupCommandLabel } from './setup-output.mjs'
import {
  runPinnedLake,
  dependencyCacheCommands,
  runDependencyCache,
  setupInfrastructureFailure,
  setupFailureMessage,
  certifyDependencyBuilds,
} from './pinned-lake.mjs'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  environmentSmokeProof,
  projectEnvironmentImports,
  dependencyBuildTargets,
} from './project-libraries.mjs'

const configFiles = [
  'lean-toolchain',
  'lake-manifest.json',
  'lakefile.lean',
  'lakefile.toml',
]
// Version 4 also replays builds with the final read-only dependency mounts.
// Earlier import-only entries remain immutable for projects already using them.
export const sharedDependencyCacheSchema = 4
const cacheSchema = sharedDependencyCacheSchema
const digest = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => JSON.stringify(sort(value))
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    )
  return value
}

// Package names and root targets do not change dependency builds. Preserve all
// options, including require options and library-specific settings, in the key.
function tomlSettings(content) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'python3',
      [
        '-c',
        `import json, sys, tomllib
config = tomllib.loads(sys.stdin.read())
for key in ('name', 'version', 'defaultTargets'):
    config.pop(key, None)
for key in ('lean_lib', 'lean_exe'):
    for target in config.get(key, []):
        target.pop('name', None)
print(json.dumps(config))`,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.once('error', reject)
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error)
    })
    child.once('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(output))
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.end(content)
  })
}

export function readDependencyConfiguration(root) {
  const config = {}
  for (const name of configFiles) {
    let fd
    try {
      fd = fs.openSync(
        path.join(root, name),
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      )
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
        throw new Error('Invalid dependency configuration file')
      if (fs.realpathSync(`/proc/self/fd/${fd}`) !== path.join(root, name))
        throw new Error('Dependency configuration path changed')
      config[name] = fs.readFileSync(fd, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  return config
}

export const configurationDigest = (config) => digest(canonical(config))

export async function sharedDependencySpec({
  owner,
  toolchain,
  image,
  configuration,
}) {
  if (
    !configuration ||
    Object.entries(configuration).some(
      ([name, content]) =>
        !configFiles.includes(name) ||
        typeof content !== 'string' ||
        Buffer.byteLength(content) > 2 * 1024 * 1024,
    )
  )
    return null
  if (!owner || !image || configuration['lean-toolchain']?.trim() !== toolchain)
    return null
  let manifest
  try {
    manifest = JSON.parse(configuration['lake-manifest.json'])
  } catch {
    return null
  }
  if (
    !Array.isArray(manifest?.packages) ||
    !manifest.packages.some((pkg) => pkg?.name === 'mathlib') ||
    manifest.packages.length > 100
  )
    return null
  if (
    manifest.packagesDir !== '.lake/packages' ||
    (manifest.lakeDir && manifest.lakeDir !== '.lake')
  )
    return null
  const names = new Set()
  for (const pkg of manifest.packages) {
    if (
      !pkg ||
      pkg.type !== 'git' ||
      !/^[A-Za-z][A-Za-z0-9_-]*$/.test(pkg.name) ||
      names.has(pkg.name) ||
      !/^[a-f0-9]{40}$/.test(pkg.rev) ||
      pkg.subDir ||
      !['lakefile.lean', 'lakefile.toml'].includes(pkg.configFile) ||
      (pkg.manifestFile && pkg.manifestFile !== 'lake-manifest.json')
    )
      return null
    names.add(pkg.name)
    try {
      const url = new URL(pkg.url)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return null
    } catch {
      return null
    }
  }
  let settings
  if (configuration['lakefile.lean'])
    settings = {
      lean: configuration['lakefile.lean'],
      toml: configuration['lakefile.toml'] || null,
    }
  else if (configuration['lakefile.toml']) {
    settings = await tomlSettings(configuration['lakefile.toml'])
    if (
      !settings ||
      (settings.packagesDir && settings.packagesDir !== '.lake/packages') ||
      (settings.buildDir && settings.buildDir !== '.lake/build')
    )
      return null
  } else return null
  const { name: _name, ...environment } = manifest
  environment.packages = [...manifest.packages].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const key = digest(
    canonical({
      schema: cacheSchema,
      owner,
      toolchain,
      image,
      environment,
      settings,
    }),
  )
  return {
    key,
    manifest,
    configuration,
    toolchain,
  }
}

async function inspectPackages(
  directory,
  { freeze = false, boundary = directory } = {},
) {
  if ((await fsp.realpath(directory)) !== directory)
    throw new Error('Shared dependency paths must not follow symbolic links')
  const stat = await fsp.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Shared dependency directories must be real directories')
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory())
      await inspectPackages(filename, { freeze, boundary })
    else if (entry.isFile()) {
      const file = await fsp.lstat(filename)
      if (file.nlink !== 1)
        throw new Error(
          'Shared dependencies must not contain writable hardlink aliases',
        )
      if (freeze) await fsp.chmod(filename, file.mode & 0o111 ? 0o500 : 0o400)
    } else if (entry.isSymbolicLink()) {
      const link = await fsp.readlink(filename)
      const target = path.resolve(directory, link)
      if (
        path.isAbsolute(link) ||
        (target !== boundary && !target.startsWith(boundary + path.sep))
      )
        throw new Error(
          'Shared dependency symbolic links must stay inside the dependency tree',
        )
      const resolved = await fsp.realpath(filename)
      if (resolved !== boundary && !resolved.startsWith(boundary + path.sep))
        throw new Error(
          'Shared dependency symbolic links must stay inside the dependency tree',
        )
    } else throw new Error('Shared dependencies must not contain special files')
  }
  if (freeze) await fsp.chmod(directory, 0o500)
}

export class SharedDependencyCache {
  constructor(runtime, directory) {
    this.runtime = runtime
    this.directory = directory
    this.building = new Map()
    this.outputs = new Map()
  }

  async prepare(options) {
    options.signal?.throwIfAborted()
    const spec = await sharedDependencySpec({
      ...options,
      image: this.runtime.imageId,
    })
    if (!spec) return null
    // Validate public repository boundaries before executing any Lake config.
    for (const pkg of spec.manifest.packages)
      await options.validateRepository(pkg.url)
    options.signal?.throwIfAborted()
    const base = this.directory('shared-dependencies')
    const root = path.join(base, spec.key)
    const ready = () => {
      try {
        const stat = fs.lstatSync(root)
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Shared dependency entry is not a real directory')
        const marker = fs.lstatSync(path.join(root, '.ready.json'))
        if (!marker.isFile() || marker.isSymbolicLink())
          throw new Error('Invalid shared dependency marker')
        const metadata = JSON.parse(
          fs.readFileSync(path.join(root, '.ready.json'), 'utf8'),
        )
        if (metadata.key !== spec.key)
          throw new Error(
            'Shared dependency entry does not match the pinned environment',
          )
        return true
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    }
    if (ready()) return { root, reused: true }
    let outputs = this.outputs.get(spec.key)
    if (!outputs) this.outputs.set(spec.key, (outputs = new Set()))
    if (options.onOutput) outputs.add(options.onOutput)
    let build = this.building.get(spec.key)
    if (!build) {
      // The shared builder has no caller's cancellation signal. Cancelling one
      // wait cannot destroy a cache another preparing project is waiting for.
      build = this.build(spec, root, (message) => {
        for (const output of outputs) output(message)
      }).finally(() => {
        this.building.delete(spec.key)
        this.outputs.delete(spec.key)
      })
      this.building.set(spec.key, build)
    }
    let abort
    try {
      await Promise.race([
        build,
        new Promise((_, reject) => {
          abort = () => reject(options.signal.reason)
          options.signal?.addEventListener('abort', abort, { once: true })
          if (options.signal?.aborted) abort()
        }),
      ])
      if (!ready())
        throw new Error(
          'Shared dependency preparation did not publish a verified entry',
        )
      return { root, reused: false }
    } finally {
      options.signal?.removeEventListener('abort', abort)
      if (options.onOutput) outputs.delete(options.onOutput)
    }
  }

  async build(spec, root, onOutput) {
    const stage = this.directory(
      path.join('shared-dependency-stages', randomUUID()),
    )
    const home = path.join(this.runtime.runtimeDir, 'homes', digest(stage))
    const run = async (args, options = {}) => {
      const result = await runSetupStep(
        setupCommandLabel(args),
        () =>
          runPinnedLake(this.runtime, stage, args, {
            network: 'none',
            timeoutMs: 1800000,
            onOutput: args[0] === 'git' ? undefined : onOutput,
            cleanHome: true,
            ...options,
          }),
        { onOutput },
      )
      if (result.code !== 0)
        throw Object.assign(
          new Error(
            [
              setupFailureMessage(result),
              `Shared dependency check failed: ${(result.stderr || result.stdout || '').slice(-2000)}`,
            ]
              .filter(Boolean)
              .join('\n'),
          ),
          { infrastructure: setupInfrastructureFailure(result) },
        )
      return result
    }
    try {
      await this.runtime.claimTemporaryWorkspace?.(stage)
      for (const [name, content] of Object.entries(spec.configuration))
        await fsp.writeFile(path.join(stage, name), content, {
          mode: 0o600,
          flag: 'wx',
        })
      const original = configurationDigest(spec.configuration)
      await run(['lake', 'env', 'lean', '--version'], { network: 'bridge' })
      for (const command of dependencyCacheCommands(spec.manifest, {
        dependencyOnly: true,
        toolchain: spec.toolchain,
      }))
        await runDependencyCache(this.runtime, stage, command, {
          network: 'bridge',
          timeoutMs: 5400000,
          onOutput,
          cleanHome: true,
        })
      // Cache downloads provide oleans, but Lake can still need to replay
      // dependency traces (for example ProofWidgets' package-lock hash).
      // Finish that work while the stage is writable before sharing it.
      await run(['lake', 'build', '@mathlib'], {
        network: 'bridge',
        timeoutMs: 5400000,
      })
      const targets = dependencyBuildTargets(spec.manifest, {
        includeInherited: true,
      })
      for (const target of targets)
        await run(['lake', 'build', target], { network: 'bridge' })
      if (configurationDigest(readDependencyConfiguration(stage)) !== original)
        throw new Error('Lake changed the pinned dependency configuration')
      const packages = path.join(stage, '.lake/packages')
      await inspectPackages(packages)
      for (const pkg of spec.manifest.packages) {
        const checkout = path.join(packages, pkg.name)
        const head = await run([
          'git',
          '-C',
          `/workspace/.lake/packages/${pkg.name}`,
          'rev-parse',
          'HEAD',
        ])
        if (head.stdout.trim() !== pkg.rev)
          throw new Error(
            'Downloaded dependency revision does not match the lockfile',
          )
        onOutput?.(`Verified dependency revision ${pkg.name}: ${pkg.rev}\n`)
        const status = await run([
          'git',
          '-C',
          `/workspace/.lake/packages/${pkg.name}`,
          'status',
          '--porcelain',
          '--untracked-files=no',
        ])
        if (status.stdout.trim())
          throw new Error(
            'Downloaded dependency sources were modified during preparation',
          )
        if (!(await fsp.lstat(checkout)).isDirectory())
          throw new Error('Missing pinned dependency checkout')
      }
      await this.runtime.inheritDependencies(stage, stage)
      // A successful writable build alone does not prove that replay has every
      // hash it will need. Certify the same mounts used by editors and checks.
      await certifyDependencyBuilds(this.runtime, stage, spec.manifest, {
        onOutput,
        cleanHome: true,
      })
      await run(['lake', 'env', 'lean', '--stdin'], {
        readOnlyWorkspace: true,
        writeLakeCache: true,
        input: environmentSmokeProof(
          projectEnvironmentImports({}, { ...spec.manifest, name: '' }),
        ),
      })
      if (configurationDigest(readDependencyConfiguration(stage)) !== original)
        throw new Error('Lake changed the pinned dependency configuration')
      await inspectPackages(packages, { freeze: true })
      const lakeCache = path.join(home, '.cache/lake')
      if (fs.existsSync(lakeCache)) {
        await inspectPackages(lakeCache)
        await fsp.rename(lakeCache, path.join(stage, '.dependency-lake-cache'))
        await inspectPackages(path.join(stage, '.dependency-lake-cache'), {
          freeze: true,
        })
      }
      await fsp.writeFile(
        path.join(stage, '.ready.json'),
        JSON.stringify({
          key: spec.key,
          schema: cacheSchema,
          verifiedAt: new Date().toISOString(),
          check: 'read-only lake build @mathlib; import Mathlib',
        }) + '\n',
        { mode: 0o400, flag: 'wx' },
      )
      await this.runtime.clearInheritedDependencies(stage)
      for (const name of Object.keys(spec.configuration))
        await fsp.chmod(path.join(stage, name), 0o400)
      // Publication is atomic. A second process may have published the same
      // immutable environment; it keeps its entry and we discard our stage.
      try {
        await fsp.rename(stage, root)
        await fsp.chmod(root, 0o500)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      }
    } finally {
      if (fs.existsSync(stage))
        await this.runtime.clearInheritedDependencies(stage)
      try {
        if (this.runtime.releaseTemporaryWorkspace)
          await this.runtime.releaseTemporaryWorkspace(stage)
        else {
          await removeDisposableTree(stage)
          await removeDisposableTree(home)
        }
      } catch (error) {
        console.warn('Deferred dependency stage cleanup:', error.message)
      }
    }
  }
}
