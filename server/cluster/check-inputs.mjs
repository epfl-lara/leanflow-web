import { waitFor } from '../shared-source-read.mjs'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { captureTree } from './blobs.mjs'
import { sourceFingerprint } from '../source-fingerprint.mjs'
import { clusterError, sha256 } from './state.mjs'
import {
  captureDependencies,
  capturePresetEditorSource,
  protectedPresetRoot,
} from './dependencies.mjs'
import {
  publicPresetDefinition,
  publicPresetLakefile,
} from '../public-preset.mjs'
import { PROJECT_CONFIGURATION_FILES } from '../../shared/project-configuration.mjs'

const TOOLCHAIN =
  /^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/
// Arriving checks do not reschedule a failed capture of the same tree for this
// long, so a full store or an unprotected tree cannot loop a large scan.
const ASSET_RETRY_MS = 5 * 60_000

function configurationHashes(manifest) {
  return PROJECT_CONFIGURATION_FILES.map((name) => {
    const entry = manifest.entries.find((item) => item.path === name)
    return !entry ? null : entry.type === 'file' ? entry.hash : 'unsupported'
  })
}

// Existing remote lean.file workers elaborate with lake env lean. Admit simple
// headers importing only ready public modules. Any unrecognized syntax or local
// import uses the dependency-aware lake lean command on the coordinator.
function publicFileImports(source) {
  const dotted = new Set()
  let depth = 0
  for (const line of source.split('\n')) {
    let code = ''
    for (let i = 0; i < line.length; i++) {
      if (line.startsWith('/-', i)) {
        depth++
        i++
        code += ' '
      } else if (depth && line.startsWith('-/', i)) {
        depth--
        i++
      } else if (!depth && line.startsWith('--', i)) break
      else if (!depth) code += line[i]
    }
    const text = code.trim()
    if (!text) continue
    if (/^import[ \t]/.test(text)) {
      const imports = text.split(/[ \t]+/).slice(1)
      for (const name of imports) {
        if (
          !/^(?:Init|Lean|Std|Mathlib)(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(
            name,
          )
        )
          return null
        if (name.includes('.')) dotted.add(name)
      }
      continue
    }
    if (
      !/^(?:theorem|lemma|example|def|namespace|section|open|variable|universe)\b/.test(
        text,
      )
    )
      return null
    break
  }
  return dotted
}

// Match source-fingerprint.mjs's Python JSON encoding and Unicode ordering.
// Comparing this digest with the canonical source catches a mixed capture even
// when files changed and changed back while they were being read.
export function manifestFingerprint(manifest) {
  const files = manifest.entries
    .filter(
      (entry) =>
        !entry.path
          .split('/')
          .some((part) => ['.lake', '.git'].includes(part)) &&
        entry.type !== 'directory',
    )
    .map((entry) =>
      entry.type === 'symlink'
        ? [entry.path, 'link', entry.target]
        : [entry.path, entry.hash],
    )
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])),
    )
  const text = JSON.stringify(files).replace(
    /[\u007f-￿]/g,
    (value) => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'),
  )
  return createHash('sha256').update(text).digest('hex')
}

export class CheckInputs {
  constructor({ blobs, runtime }) {
    this.blobs = blobs
    this.runtime = runtime
    this.assets = new Map()
    this.fileSources = new WeakMap()
    this.publicModuleIndexes = new WeakMap()
    this.readyAssets = new Set()
    this.assetFailures = new Map()
    // Immutable toolchain and dependency captures belong to the service. They
    // run one at a time, outside request capture slots, until close().
    this.assetAbort = new AbortController()
    this.assetLane = Promise.resolve()
  }

  async #assetKey(root, kind) {
    if ((await fs.realpath(root)) !== root) return null
    const stat = await fs.stat(root, { bigint: true })
    return `${kind}:${root}:${stat.dev}:${stat.ino}:${stat.mtimeNs}`
  }

  // Only server-managed, immutable toolchains and shared dependencies reach
  // this cache. Mutable project trees are captured afresh for every check.
  captureAsset(root, kind, signal) {
    return kind === 'dependencies'
      ? captureDependencies(this.blobs, path.dirname(path.dirname(root)), {
          signal,
          requireReferences:
            path.dirname(path.dirname(path.dirname(root))) ===
            path.join(this.runtime.runtimeDir, 'templates'),
        })
      : captureTree(this.blobs, root, { kind, signal })
  }

  #schedule(key, root, kind) {
    const existing = this.assets.get(key)
    if (existing) return existing
    const { signal } = this.assetAbort
    signal.throwIfAborted()
    const task = this.assetLane
      .then(() => {
        signal.throwIfAborted()
        return this.captureAsset(root, kind, signal)
      })
      .then((result) => {
        this.readyAssets.add(key)
        this.assetFailures.delete(key)
        return result
      })
    this.assets.set(key, task)
    this.assetLane = task.catch(() => {
      if (this.assets.get(key) === task) this.assets.delete(key)
      if (signal.aborted) return
      this.assetFailures.set(key, Date.now())
      console.warn(
        '[LeanFlow cluster] A shared runtime environment could not be captured. Remote work that needs it stays local; inspect the protected runtime assets and object-store budgets.',
      )
    })
    return task
  }

  // Starts or joins one service-owned capture for a caller that waits for it.
  async #asset(root, kind) {
    const key = await this.#assetKey(root, kind)
    return key && this.#schedule(key, root, kind)
  }

  // Returns a completed capture, or null. An ordinary check then runs locally
  // while its capture is scheduled; editors keep warm-up as the only producer.
  async #ready(root, kind, schedule) {
    const key = await this.#assetKey(root, kind)
    if (!key) return null
    if (this.readyAssets.has(key)) return this.assets.get(key)
    const failed = this.assetFailures.get(key)
    if (
      schedule &&
      !this.assetAbort.signal.aborted &&
      !(failed && Date.now() - failed < ASSET_RETRY_MS)
    )
      this.#schedule(key, root, kind)
    return null
  }

  // Waits for the service-owned captures scheduled so far.
  async settleAssets() {
    await this.assetLane
  }

  // Stops service-owned captures and waits until each capture has settled.
  async close() {
    this.assetAbort.abort(
      clusterError(
        'Coordinator asset capture stopped.',
        'cluster_stopping',
        503,
      ),
    )
    await this.assetLane
  }

  async prepareEditorAssets({
    signal,
    preset = 'mathlib',
    root = this.runtime.templateRoot?.(preset),
  } = {}) {
    const dataDir =
      this.runtime.dataDir || path.dirname(this.runtime.runtimeDir)
    const definition = root && publicPresetDefinition(dataDir, root)
    if (
      !root ||
      definition?.id !== preset ||
      this.runtime.transferableDependencyRoot?.(root) !== root
    )
      return null
    const version = definition.toolchain
    if (root !== protectedPresetRoot(dataDir, preset, version)) return null
    const toolchainRoot = this.runtime.toolchains?.get(version)
    if (!toolchainRoot) return null
    // Start this service-owned task before accepting browser requests. A
    // stopped wait never cancels the shared first capture after a restart.
    const toolchain = await waitFor(
      this.#asset(toolchainRoot, 'toolchain'),
      signal,
    )
    const dependencies = await waitFor(
      this.#asset(path.join(root, '.lake/packages'), 'dependencies'),
      signal,
    )
    if (toolchain && dependencies) {
      const editorSource = await capturePresetEditorSource(this.blobs, {
        dataDir,
        preset,
        version,
        signal,
      })
      const preparedSource = await this.blobs.manifest(
        editorSource.hash,
        'source',
      )
      this.publicConfiguration = configurationHashes(preparedSource)
      this.publicFileOptions =
        preparedSource.entries.some(
          (entry) =>
            entry.path === 'lakefile.toml' &&
            entry.hash === sha256(publicPresetLakefile(definition)),
        ) &&
        !preparedSource.entries.some((entry) => entry.path === 'lakefile.lean')
      this.editorEnvironment = {
        toolchain: { version, manifest: toolchain.hash },
        dependencies: dependencies.hash,
        editorSource: editorSource.hash,
      }
      return this.editorEnvironment
    }
    return null
  }

  // Reads the live pin without following links. It only decides whether a
  // snapshot is worth making; the frozen copy is validated again.
  async #livePin(root) {
    let file
    try {
      file = await fs.open(
        path.join(root, 'lean-toolchain'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const stat = await file.stat()
      return stat.isFile() && stat.size <= 1024
        ? (await file.readFile('utf8')).trim()
        : null
    } catch {
      return null
    } finally {
      await file?.close()
    }
  }

  // Resolves a pinned environment to completed immutable captures, or null to
  // keep this request local.
  async #environment(root, version, editor) {
    if (typeof version !== 'string' || !TOOLCHAIN.test(version)) return null
    const toolchainRoot = this.runtime.toolchains?.get(version)
    if (!toolchainRoot) return null
    const dependenciesRoot = await this.runtime.dependencyRoot(root)
    const templateBound =
      dependenciesRoot &&
      path.dirname(dependenciesRoot) !==
        path.join(this.runtime.runtimeDir, 'shared-dependencies')
    // A public template is transferable only after the service warmed that
    // exact protected binding. An ordinary check never starts that asset scan.
    if (
      dependenciesRoot &&
      ((templateBound &&
        ((!editor && !this.editorEnvironment) ||
          this.runtime.transferableDependencyRoot?.(root) !==
            dependenciesRoot)) ||
        this.runtime.dependencyPreparationReason(root))
    )
      return null
    const schedule = !editor && !templateBound
    const toolchain = await this.#ready(toolchainRoot, 'toolchain', schedule)
    const dependencies =
      dependenciesRoot &&
      (await this.#ready(
        path.join(dependenciesRoot, '.lake/packages'),
        'dependencies',
        schedule,
      ))
    if (!toolchain || (dependenciesRoot && !dependencies)) return null
    if (
      (editor || templateBound) &&
      dependencies &&
      (this.editorEnvironment?.toolchain.version !== version ||
        this.editorEnvironment?.toolchain.manifest !== toolchain.hash ||
        this.editorEnvironment?.dependencies !== dependencies.hash)
    )
      return null
    return { toolchain, dependencies: dependencies || null, templateBound }
  }

  async capture(root, { signal, fingerprint, editor = false } = {}) {
    signal?.throwIfAborted()
    // Live configuration only avoids snapshots that cannot be sent now. The
    // frozen copy below still decides every input that is transferred.
    if (!(await this.#environment(root, await this.#livePin(root), editor)))
      return null
    const before = fingerprint || (await sourceFingerprint(root, { signal }))
    const source = await captureTree(this.blobs, root, {
      ignoreLake: true,
      signal,
    })
    const after = await sourceFingerprint(root, { signal })
    if (before !== after)
      throw clusterError(
        'Project files changed while preparing the check. Save your files and retry.',
        'source_changed',
        409,
      )
    // Private files and unsupported snapshot inputs stay on the coordinator.
    if (manifestFingerprint(source.manifest) !== before) return null
    const pin = source.manifest.entries.find(
      (entry) => entry.path === 'lean-toolchain',
    )
    if (pin?.type !== 'file' || pin.size > 1024) return null
    const version = (await this.blobs.read(pin.hash, 1024))
      .toString('utf8')
      .trim()
    const environment = await this.#environment(root, version, editor)
    if (!environment) return null
    signal?.throwIfAborted()
    const { toolchain, dependencies } = environment
    const prepared = this.editorEnvironment
    const exactPublicConfiguration =
      !!prepared &&
      !!this.publicConfiguration &&
      toolchain.hash === prepared.toolchain.manifest &&
      version === prepared.toolchain.version &&
      dependencies?.hash === prepared.dependencies &&
      configurationHashes(source.manifest).every(
        (value, index) => value === this.publicConfiguration[index],
      )
    if (!editor && environment.templateBound && !exactPublicConfiguration)
      return null
    const input = {
      sourceManifest: source.hash,
      dependencies: dependencies?.hash ?? null,
      toolchain: { version, manifest: toolchain.hash },
      ...(editor && dependencies
        ? { editorSource: this.editorEnvironment.editorSource }
        : {}),
    }
    if (!editor && exactPublicConfiguration && this.publicFileOptions)
      this.fileSources.set(input, source.manifest)
    return input
  }

  async mayCheckFile(root) {
    if (!this.editorEnvironment || !this.publicFileOptions) return false
    const environment = await this.#environment(
      root,
      await this.#livePin(root),
      true,
    )
    return (
      environment?.dependencies?.hash === this.editorEnvironment.dependencies
    )
  }

  // Only index compiled modules from the pinned standard libraries and Mathlib's
  // package output. Other package layouts and source-only imports need Lake.
  async #indexPublicModules(environment) {
    const modules = new Set()
    for (const [hash, kind, prefix] of [
      [environment.toolchain.manifest, 'toolchain', 'lib/lean/'],
      [
        environment.dependencies,
        'dependencies',
        '.lake/packages/mathlib/.lake/build/lib/lean/',
      ],
    ]) {
      const manifest = await this.blobs.manifest(hash, kind)
      for (const entry of manifest.entries) {
        if (
          entry.type !== 'file' ||
          !entry.path.startsWith(prefix) ||
          !entry.path.endsWith('.olean')
        )
          continue
        const name = entry.path.slice(prefix.length, -'.olean'.length)
        if (/^(?:Init|Lean|Std|Mathlib)\//.test(name))
          modules.add(name.replaceAll('/', '.'))
      }
    }
    return modules
  }

  async canCheckFile(input, filename) {
    const manifest = this.fileSources.get(input)
    if (!manifest) return false
    const entry = manifest.entries.find(
      (item) => item.path === filename && item.type === 'file',
    )
    if (!entry || entry.size > 1024 * 1024) return false
    // A local module or prebuilt artifact must never shadow a public import.
    if (
      manifest.entries.some(
        (item) =>
          item.type === 'symlink' ||
          /^(?:Init|Lean|Std|Mathlib)(?:[/.]|$)/.test(item.path) ||
          /\.(?:olean|ilean|so|dll|dylib)$/.test(item.path),
      )
    )
      return false
    const imports = publicFileImports(
      (await this.blobs.read(entry.hash, 1024 * 1024)).toString('utf8'),
    )
    if (!imports) return false
    if (!imports.size) return true
    const environment = this.editorEnvironment
    if (
      environment?.dependencies !== input.dependencies ||
      environment?.toolchain.manifest !== input.toolchain.manifest
    )
      return false
    let index = this.publicModuleIndexes.get(environment)
    if (!index) {
      index = this.#indexPublicModules(environment)
      this.publicModuleIndexes.set(environment, index)
      index.catch(() => this.publicModuleIndexes.delete(environment))
    }
    const available = await index
    return [...imports].every((name) => available.has(name))
  }
}
