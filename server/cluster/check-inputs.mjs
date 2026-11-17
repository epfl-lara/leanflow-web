import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { captureTree } from './blobs.mjs'
import { sourceFingerprint } from '../source-fingerprint.mjs'
import { clusterError } from './state.mjs'
import {
  captureDependencies,
  capturePresetEditorSource,
  protectedPresetRoot,
} from './dependencies.mjs'
import { publicPresetDefinition } from '../public-preset.mjs'

const TOOLCHAIN =
  /^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/
// Arriving checks do not reschedule a failed capture of the same tree for this
// long, so a full store or an unprotected tree cannot loop a large scan.
const ASSET_RETRY_MS = 5 * 60_000

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

// Stops one caller's wait. The shared task keeps running for other callers.
function waitFor(task, signal) {
  if (!signal) return task
  let abort
  return Promise.race([
    task,
    new Promise((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    }),
  ]).finally(() => signal.removeEventListener('abort', abort))
}

export class CheckInputs {
  constructor({ blobs, runtime }) {
    this.blobs = blobs
    this.runtime = runtime
    this.assets = new Map()
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
    // Personal or legacy mutable .lake trees are not shared as public assets.
    if (
      dependenciesRoot &&
      ((path.dirname(dependenciesRoot) !==
        path.join(this.runtime.runtimeDir, 'shared-dependencies') &&
        !(
          editor &&
          this.runtime.transferableDependencyRoot?.(root) === dependenciesRoot
        )) ||
        this.runtime.dependencyPreparationReason(root))
    )
      return null
    const toolchain = await this.#ready(toolchainRoot, 'toolchain', !editor)
    const dependencies =
      dependenciesRoot &&
      (await this.#ready(
        path.join(dependenciesRoot, '.lake/packages'),
        'dependencies',
        !editor,
      ))
    if (!toolchain || (dependenciesRoot && !dependencies)) return null
    if (
      editor &&
      dependencies &&
      (this.editorEnvironment?.toolchain.version !== version ||
        this.editorEnvironment?.toolchain.manifest !== toolchain.hash ||
        this.editorEnvironment?.dependencies !== dependencies.hash)
    )
      return null
    return { toolchain, dependencies: dependencies || null }
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
    return {
      sourceManifest: source.hash,
      dependencies: dependencies?.hash ?? null,
      toolchain: { version, manifest: toolchain.hash },
      ...(editor && dependencies
        ? { editorSource: this.editorEnvironment.editorSource }
        : {}),
    }
  }
}
