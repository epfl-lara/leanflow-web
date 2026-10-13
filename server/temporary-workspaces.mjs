import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { processIdentity } from './lease.mjs'

const key = (root) => createHash('sha256').update(root).digest('hex')

export async function removeDisposableTree(root) {
  async function thaw(directory) {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    await fs.chmod(directory, 0o700)
    for (const entry of await fs.readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await thaw(path.join(directory, entry.name))
  }
  try {
    await thaw(root)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await fs.rm(root, { recursive: true, force: true })
}

// Ownership records live outside worker mounts. Unknown legacy directories are
// never swept, and PID start times protect other helpers and reused PIDs.
export class TemporaryWorkspaces {
  constructor({ directory, allowedRoots, cleanup }) {
    Object.assign(this, { directory, allowedRoots, cleanup })
  }
  allowed(root) {
    return (
      typeof root === 'string' &&
      path.resolve(root) === root &&
      this.allowedRoots.some((base) => root.startsWith(base + path.sep))
    )
  }
  async claim(root) {
    if (!this.allowed(root) || (await fs.realpath(root)) !== root)
      throw new Error('Invalid temporary workspace path')
    const owner = processIdentity()
    if (!owner) throw new Error('Cannot identify the temporary workspace owner')
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    await fs.writeFile(
      path.join(this.directory, key(root) + '.json'),
      JSON.stringify({ root, owner }),
      { mode: 0o600, flag: 'wx' },
    )
  }
  async release(root) {
    if (!this.allowed(root)) throw new Error('Invalid temporary workspace path')
    if (!(await this.cleanup(root))) return
    await fs.rm(path.join(this.directory, key(root) + '.json'), { force: true })
  }
  async sweep(mountedRoots) {
    let names
    try {
      names = await fs.readdir(this.directory)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const name of names) {
      try {
        const filename = path.join(this.directory, name)
        const stat = await fs.lstat(filename)
        if (!stat.isFile() || stat.isSymbolicLink()) continue
        let claim
        try {
          claim = JSON.parse(await fs.readFile(filename, 'utf8'))
        } catch {
          continue
        }
        if (!this.allowed(claim.root) || name !== key(claim.root) + '.json')
          continue
        const identity = processIdentity(claim.owner?.pid)
        if (
          identity &&
          identity.bootId === claim.owner.bootId &&
          identity.startTime === claim.owner.startTime
        )
          continue
        if (
          mountedRoots.some(
            (mount) =>
              mount === claim.root || mount.startsWith(claim.root + path.sep),
          )
        )
          continue
        // A replaced ancestor must never direct cleanup outside the managed area.
        try {
          if ((await fs.realpath(claim.root)) !== claim.root) continue
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        await this.release(claim.root)
      } catch (error) {
        if (error.code !== 'ENOENT')
          console.warn('Deferred temporary workspace cleanup:', error.message)
      }
    }
  }
}
