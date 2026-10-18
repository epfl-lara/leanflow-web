import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export const toolchainName = (value) =>
  value.replaceAll('/', '--').replaceAll(':', '---')

export const PROJECT_CHECK_COMMAND = Object.freeze([
  'python3',
  '-I',
  '/opt/leanflow-project-check/run.py',
])

// Cache capabilities, never proof verdicts. A changed installation or worker
// image must be probed again, including release candidates with backports.
export class LeanCheckSupport {
  constructor(runtime) {
    this.runtime = runtime
    this.cache = new Map()
  }
  async supported(root, options = {}) {
    options.signal?.throwIfAborted()
    const file = await fs.open(
      path.join(root, 'lean-toolchain'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    let version
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > 256)
        throw new Error('Invalid pinned Lean release.')
      version = (await file.readFile('utf8')).trim()
    } finally {
      await file.close()
    }
    const installation = this.runtime.toolchains.get(version)
    if (!installation)
      throw new Error(
        'Prepare the pinned Lean environment before checking this project.',
      )
    const binary = path.join(installation, 'bin/lake')
    const stat = await fs.stat(binary, { bigint: true })
    const key = [
      this.runtime.imageId,
      version,
      await fs.realpath(binary),
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ].join('\0')
    let task = this.cache.get(key)
    if (!task) {
      task = this.runtime
        .run(
          root,
          [`/opt/lean-toolchains/${toolchainName(version)}/bin/lake`, '--help'],
          {
            network: 'none',
            readOnlyWorkspace: true,
            freshHome: true,
            cleanHome: true,
            timeoutMs: 15000,
            signal: options.signal,
          },
        )
        .then((result) => {
          if (result.code !== 0 || result.truncated)
            throw new Error(
              'Could not identify the pinned Lean checker. Retry when a worker is available.',
            )
          return /^\s*check\s+\S/m.test(result.stdout)
        })
        .catch((error) => {
          if (this.cache.get(key) === task) this.cache.delete(key)
          throw error
        })
      this.cache.set(key, task)
      while (this.cache.size > 16)
        this.cache.delete(this.cache.keys().next().value)
    }
    const supported = await task
    options.signal?.throwIfAborted()
    return supported
  }
}
