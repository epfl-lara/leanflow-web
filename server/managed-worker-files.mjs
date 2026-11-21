import fs from 'node:fs'

const directoryFlags =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW

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

function openDirectory(filename, create = false) {
  if (create) {
    try {
      fs.mkdirSync(filename, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  return fs.openSync(filename, directoryFlags)
}

function withDirectory(filename, action, create = false) {
  const fd = openDirectory(filename, create)
  try {
    return action(`/proc/self/fd/${fd}`)
  } finally {
    fs.closeSync(fd)
  }
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
    let parent = openDirectory(base)
    directories.push(parent)
    for (const segment of segments) {
      parent = openDirectory(`/proc/self/fd/${parent}/${segment}`, create)
      directories.push(parent)
    }
    return action(`/proc/self/fd/${parent}`)
  } finally {
    for (const directory of directories.reverse()) fs.closeSync(directory)
  }
}

// Worker homes are writable by project code. Validate the opened inode before
// reading or truncating a managed file; a FIFO must never block the server.
export function managedWorkerFile(home, relative, options) {
  const segments = segmentsFor(relative)
  const name = segments.pop()
  return managedWorkerDirectory(home, segments.join('/'), (parent) =>
    managedWorkerFileAt(`${parent}/${name}`, options),
  )
}

function managedWorkerFileAt(
  filename,
  { content, maxBytes = 4 * 1024 * 1024, encoding = 'utf8' } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('Invalid managed worker file limit')
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
  const visit = (sourceDirectory, targetDirectory, depth) => {
    for (const entry of fs.readdirSync(sourceDirectory, {
      withFileTypes: true,
    })) {
      if (++entries > 12000)
        throw new Error('Managed worker cache has too many entries')
      segmentsFor(entry.name)
      const from = `${sourceDirectory}/${entry.name}`,
        to = `${targetDirectory}/${entry.name}`
      if (entry.isDirectory()) {
        if (depth === 32)
          throw new Error('Managed worker cache nesting exceeds its limit')
        withDirectory(from, (childSource) =>
          withDirectory(
            to,
            (childTarget) => visit(childSource, childTarget, depth + 1),
            true,
          ),
        )
      } else if (entry.isFile()) {
        const content = managedWorkerFileAt(from, {
          maxBytes: Math.min(4 * 1024 * 1024, maxBytes - bytes),
          encoding: null,
        })
        if (content === null)
          throw new Error('Managed worker cache changed during copying')
        bytes += content.length
        managedWorkerFileAt(to, { content })
      } else
        throw new Error(
          'Managed worker cache must contain only regular files and directories',
        )
    }
  }
  managedWorkerDirectory(sourceBase, sourceRelative, (source) =>
    managedWorkerDirectory(
      targetBase,
      targetRelative,
      (target) => visit(source, target, 0),
      { create: true },
    ),
  )
}
