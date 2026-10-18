import fs from 'node:fs'

function segmentsFor(relative, { directory = false } = {}) {
  if (directory && relative === '') return []
  if (
    typeof relative !== 'string' ||
    relative.includes('\0') ||
    relative.includes('\\')
  )
    throw new Error('Invalid managed worker file path')
  const segments = relative.split('/')
  if (segments.some((part) => !part || part === '.' || part === '..'))
    throw new Error('Invalid managed worker file path')
  return segments
}

// The base is a server-selected home/runtime root. A descriptor pins every
// child before creating or opening descendants, even while worker code renames it.
export function managedWorkerDirectory(
  base,
  relative,
  action,
  { create = false } = {},
) {
  const segments = segmentsFor(relative, { directory: true })
  const directories = []
  try {
    const flags =
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    let parent = fs.openSync(base, flags)
    directories.push(parent)
    for (const segment of segments) {
      const filename = `/proc/self/fd/${parent}/${segment}`
      if (create) {
        try {
          fs.mkdirSync(filename, { mode: 0o700 })
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
      parent = fs.openSync(filename, flags)
      directories.push(parent)
    }
    return action(`/proc/self/fd/${parent}`)
  } finally {
    for (const directory of directories.reverse()) fs.closeSync(directory)
  }
}

// Worker homes are writable by project code. Validate the opened inode before
// reading or truncating a managed file; a FIFO must never block the server.
export function managedWorkerFile(
  home,
  relative,
  { content, maxBytes = 4 * 1024 * 1024, encoding = 'utf8' } = {},
) {
  const segments = segmentsFor(relative)
  const name = segments.pop()
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('Invalid managed worker file limit')
  return managedWorkerDirectory(home, segments.join('/'), (parent) => {
    const filename = `${parent}/${name}`
    const writing = content !== undefined
    const flags =
      (writing ? fs.constants.O_WRONLY : fs.constants.O_RDONLY) |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK
    let fd
    try {
      try {
        fd = fs.openSync(filename, flags)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        if (!writing) return null
        fd = fs.openSync(
          filename,
          flags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        )
      }
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error(
          'A managed worker file must be a regular file without hardlinks',
        )
      if (writing) {
        if (Buffer.byteLength(content) > maxBytes)
          throw new Error('Managed worker file is too large')
        fs.ftruncateSync(fd, 0)
        fs.writeFileSync(fd, content)
        return content
      }
      if (stat.size > maxBytes)
        throw new Error('Managed worker file is too large')
      // Allocate for the opened file, not the maximum for each tiny map.
      // One extra byte detects growth without an unbounded synchronous read.
      const buffer = Buffer.alloc(stat.size + 1)
      let size = 0
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, null)
        if (!count) break
        size += count
      }
      const after = fs.fstatSync(fd)
      if (
        size !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error('Managed worker file changed during reading')
      return encoding === null
        ? buffer.subarray(0, size)
        : buffer.toString(encoding, 0, size)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  })
}

// Mutable Lake lookup maps are small regular files, not the artifact archives.
// Copy exact bytes through independently pinned roots, never through project links.
export function copyManagedWorkerTree(
  sourceBase,
  sourceRelative,
  targetBase,
  targetRelative,
) {
  let entries = 0,
    bytes = 0
  const maxBytes = 32 * 1024 * 1024
  const visit = (source, target, depth) => {
    if (depth > 32)
      throw new Error('Managed worker cache nesting exceeds its limit')
    managedWorkerDirectory(sourceBase, source, (sourceDirectory) => {
      managedWorkerDirectory(targetBase, target, () => {}, { create: true })
      for (const entry of fs.readdirSync(sourceDirectory, {
        withFileTypes: true,
      })) {
        if (++entries > 12000)
          throw new Error('Managed worker cache has too many entries')
        const from = `${source}/${entry.name}`,
          to = `${target}/${entry.name}`
        if (entry.isDirectory()) visit(from, to, depth + 1)
        else if (entry.isFile()) {
          const content = managedWorkerFile(sourceBase, from, {
            maxBytes: Math.min(4 * 1024 * 1024, maxBytes - bytes),
            encoding: null,
          })
          if (content === null)
            throw new Error('Managed worker cache changed during copying')
          bytes += content.length
          managedWorkerFile(targetBase, to, { content })
        } else
          throw new Error(
            'Managed worker cache must contain only regular files and directories',
          )
      }
    })
  }
  visit(sourceRelative, targetRelative, 0)
}
