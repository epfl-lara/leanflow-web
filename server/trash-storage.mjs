import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'

function unsafe(message, status = 403) {
  throw Object.assign(new Error(message), { status, statusCode: status })
}

async function directoryHandle(directory) {
  let handle
  try {
    handle = await fs.open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== directory)
      unsafe(
        'The stored trash directory changed. Refresh Trash and try again.',
        409,
      )
    return handle
  } catch (error) {
    await handle?.close()
    if (['ENOTDIR', 'ELOOP'].includes(error.code))
      unsafe('The stored trash directory is unsafe. Contact the administrator.')
    throw error
  }
}

async function statIfPresent(filename) {
  try {
    return await fs.lstat(filename)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Count allocated blocks once per inode, including links but never their targets. */
export async function storedDiskBytes(locations) {
  const seen = new Set()
  async function visit(filename, depth = 0) {
    if (depth > 512)
      unsafe('Stored folder nesting is too deep to measure.', 413)
    const stat = await statIfPresent(filename)
    if (!stat) return 0
    const identity = `${stat.dev}:${stat.ino}`
    if (seen.has(identity)) return 0
    seen.add(identity)
    let bytes = stat.blocks * 512
    if (!stat.isDirectory() || stat.isSymbolicLink()) return bytes
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const current = await handle.stat()
      if (current.dev !== stat.dev || current.ino !== stat.ino)
        unsafe('Stored data changed while measuring its size. Try again.', 409)
      const anchor = `/proc/self/fd/${handle.fd}`
      for (const name of await fs.readdir(anchor))
        bytes += await visit(`${anchor}/${name}`, depth + 1)
    } finally {
      await handle.close()
    }
    return bytes
  }
  let bytes = 0
  for (const { directory, name } of locations) {
    const parent = await directoryHandle(directory)
    try {
      bytes += await visit(`/proc/self/fd/${parent.fd}/${name}`)
    } finally {
      await parent.close()
    }
  }
  return bytes
}

/** Read a server-owned manifest without following replaced directories or links. */
export async function storedManifest(
  directory,
  name,
  filename = 'manifest.json',
) {
  const parent = await directoryHandle(directory)
  let container, file
  try {
    container = await fs.open(
      `/proc/self/fd/${parent.fd}/${name}`,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    file = await fs.open(
      `/proc/self/fd/${container.fd}/${filename}`,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) return null
    return JSON.parse(await file.readFile('utf8'))
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code) ||
      error instanceof SyntaxError
    )
      return null
    throw error
  } finally {
    await file?.close()
    await container?.close()
    await parent.close()
  }
}

/** Remove only children of the pinned managed directory; nested links are unlinked. */
export async function removeStoredTree(directory, name) {
  const parent = await directoryHandle(directory)
  async function removeAt(anchor, childName, depth = 0) {
    if (depth > 512) unsafe('Stored folder nesting is too deep to delete.', 413)
    const filename = `${anchor}/${childName}`
    const stat = await statIfPresent(filename)
    if (!stat) return
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await fs.unlink(filename)
      return
    }
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      const current = await handle.stat()
      if (current.dev !== stat.dev || current.ino !== stat.ino)
        unsafe(
          'Stored data changed during deletion. Refresh Trash and try again.',
          409,
        )
      await handle.chmod(0o700)
      const childAnchor = `/proc/self/fd/${handle.fd}`
      for (const child of await fs.readdir(childAnchor))
        await removeAt(childAnchor, child, depth + 1)
      const remaining = await statIfPresent(filename)
      if (
        !remaining ||
        remaining.dev !== stat.dev ||
        remaining.ino !== stat.ino
      )
        unsafe(
          'Stored data changed during deletion. Refresh Trash and try again.',
          409,
        )
      await fs.rmdir(filename)
    } finally {
      await handle.close()
    }
  }
  try {
    const anchor = `/proc/self/fd/${parent.fd}`
    const stat = await statIfPresent(`${anchor}/${name}`)
    if (stat?.isSymbolicLink())
      unsafe('The stored trash directory is unsafe. Contact the administrator.')
    await removeAt(anchor, name)
  } finally {
    await parent.close()
  }
}
