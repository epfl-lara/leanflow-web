import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  configurationDigest,
  readDependencyConfiguration,
} from './shared-dependencies.mjs'
import { environmentSmokeProof } from './project-libraries.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')

// Certificates belong to the server. Workers see prepared libraries read only.
// Revalidate once when the pins, configuration, toolchain or worker image change.
export class PreparedPresetCache {
  constructor(runtime, directory) {
    this.runtime = runtime
    this.directory = directory
    this.preparing = new Map()
    this.failures = new Set()
  }

  spec(id) {
    const definition = this.runtime.presetDefinition(id)
    const root = this.runtime.templateRoot(id)
    if (!definition || !root || !this.runtime.ready || !this.runtime.imageId)
      return null
    if (fs.realpathSync(root) !== root)
      throw new Error('Prepared library directory cannot be a symbolic link.')
    const markerPath = path.join(root, '.ready.json')
    const markerStat = fs.lstatSync(markerPath)
    if (!markerStat.isFile() || markerStat.isSymbolicLink())
      throw new Error('Prepared library certificate must be a regular file.')
    const markerText = fs.readFileSync(markerPath, 'utf8')
    const marker = JSON.parse(markerText)
    if (marker.code !== 0)
      throw new Error('The prepared library has not passed its Lean check.')
    const configuration = readDependencyConfiguration(root)
    if (configuration['lean-toolchain']?.trim() !== definition.toolchain)
      throw new Error(
        'The prepared library toolchain does not match its pinned version.',
      )
    if (definition.revision) {
      const manifest = JSON.parse(configuration['lake-manifest.json'] || '{}')
      const dependency = manifest.packages?.find(
        (pkg) => pkg.name === definition.package,
      )
      if (!dependency || dependency.rev !== definition.revision)
        throw new Error(
          'The prepared library does not match its pinned dependency revision.',
        )
    }
    const toolchainRoot = this.runtime.toolchains.get(definition.toolchain)
    if (!toolchainRoot) return null
    const binary = fs.statSync(path.join(toolchainRoot, 'bin/lean'))
    const configurationHash = configurationDigest(configuration)
    const key = digest(
      JSON.stringify({
        id,
        root,
        configuration: configurationHash,
        marker: digest(markerText),
        image: this.runtime.imageId,
        toolchain: {
          root: toolchainRoot,
          size: binary.size,
          modified: binary.mtimeMs,
        },
      }),
    )
    return {
      key,
      root,
      configuration: configurationHash,
      toolchain: definition.toolchain,
      imports: [...new Set(['Lean', definition.import])],
    }
  }

  get(id) {
    try {
      const spec = this.spec(id)
      if (!spec) return null
      const filename = path.join(this.directory(), spec.key + '.json')
      if (!fs.lstatSync(filename).isFile()) return null
      const certificate = JSON.parse(fs.readFileSync(filename, 'utf8'))
      return certificate.key === spec.key && certificate.code === 0
        ? spec
        : null
    } catch {
      return null
    }
  }

  state(id) {
    if (this.get(id)) return 'ready'
    if (this.preparing.has(id)) return 'verifying'
    if (this.failures.has(id) || this.runtime.templateRoot(id)) return 'failed'
    return 'unavailable'
  }

  prepare(id) {
    const cached = this.get(id)
    if (cached) return Promise.resolve(cached)
    const existing = this.preparing.get(id)
    if (existing) return existing
    const work = this.check(id)
      .then((prepared) => {
        this.failures.delete(id)
        return prepared
      })
      .catch((error) => {
        this.failures.add(id)
        throw error
      })
      .finally(() => this.preparing.delete(id))
    this.preparing.set(id, work)
    return work
  }

  async check(id) {
    const definition = this.runtime.presetDefinition(id)
    if (!definition || !this.runtime.templateRoot(id))
      throw new Error('The prepared library is unavailable.')
    await this.runtime.prepareToolchain(definition.toolchain)
    const cached = this.get(id)
    if (cached) return cached
    const spec = this.spec(id)
    if (!spec) throw new Error('The pinned Lean toolchain is unavailable.')
    return this.verify(id, spec)
  }

  async verify(id, spec) {
    const result = await this.runtime.run(
      spec.root,
      ['lake', 'env', 'lean', '--stdin'],
      {
        input: environmentSmokeProof(spec.imports),
        network: 'none',
        timeoutMs: 180000,
        readOnlyWorkspace: true,
        writeLakeCache: true,
      },
    )
    if (result.code !== 0)
      throw new Error(
        `Prepared library verification failed: ${(result.stderr || result.stdout || 'Lean import check failed').slice(-2000)}`,
      )
    if (this.spec(id)?.key !== spec.key)
      throw new Error(
        'The prepared library changed during verification. Prepare it again.',
      )
    const filename = path.join(this.directory(), spec.key + '.json')
    const temporary = filename + '.' + randomUUID() + '.tmp'
    try {
      await fsp.writeFile(
        temporary,
        JSON.stringify({
          key: spec.key,
          code: 0,
          verifiedAt: new Date().toISOString(),
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      )
      await fsp.rename(temporary, filename)
    } finally {
      await fsp.rm(temporary, { force: true })
    }
    return spec
  }
}
