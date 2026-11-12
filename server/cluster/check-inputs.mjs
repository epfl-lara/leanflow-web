import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { captureTree } from './blobs.mjs'
import { sourceFingerprint } from '../source-fingerprint.mjs'
import { clusterError } from './state.mjs'
import { captureDependencies } from './dependencies.mjs'

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
    /[\u007f-\uffff]/g,
    (value) => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'),
  )
  return createHash('sha256').update(text).digest('hex')
}

export class CheckInputs {
  constructor({ blobs, runtime }) {
    this.blobs = blobs
    this.runtime = runtime
    this.assets = new Map()
  }

  async #asset(root, kind, signal) {
    if ((await fs.realpath(root)) !== root) return null
    const stat = await fs.stat(root, { bigint: true })
    const key = `${kind}:${root}:${stat.dev}:${stat.ino}:${stat.mtimeNs}`
    // Only server-managed, immutable toolchains and shared dependencies reach
    // this cache. Mutable project trees are captured afresh for every check.
    if (!this.assets.has(key)) {
      const task =
        kind === 'dependencies'
          ? captureDependencies(this.blobs, path.dirname(path.dirname(root)), {
              signal,
            })
          : captureTree(this.blobs, root, { kind, signal })
      this.assets.set(key, task)
      task.catch(() => {
        if (this.assets.get(key) === task) this.assets.delete(key)
      })
    }
    return this.assets.get(key)
  }

  async capture(root, { signal, fingerprint } = {}) {
    signal?.throwIfAborted()
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
    if (
      !/^leanprover\/lean4:v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/.test(
        version,
      )
    )
      return null
    const toolchainRoot = this.runtime.toolchains?.get(version)
    if (!toolchainRoot) return null
    const dependenciesRoot = await this.runtime.dependencyRoot(root)
    let dependencies = null
    if (dependenciesRoot) {
      // Personal or legacy mutable .lake trees are not shared as public assets.
      if (
        path.dirname(dependenciesRoot) !==
          path.join(this.runtime.runtimeDir, 'shared-dependencies') ||
        this.runtime.dependencyPreparationReason(root)
      )
        return null
      const prepared = await this.#asset(
        path.join(dependenciesRoot, '.lake/packages'),
        'dependencies',
        signal,
      )
      if (!prepared) return null
      dependencies = prepared.hash
    }
    const toolchain = await this.#asset(toolchainRoot, 'toolchain', signal)
    if (!toolchain) return null
    signal?.throwIfAborted()
    return {
      sourceManifest: source.hash,
      dependencies,
      toolchain: { version, manifest: toolchain.hash },
    }
  }
}
