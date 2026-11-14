import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { moveWithoutReplacing } from './workspace-moves.mjs'
import {
  compactTerminalFiles,
  exchangeTerminalFiles,
} from './terminal-file-operations.mjs'
import { isBinaryAssetFile } from '../shared/file-previews.mjs'
import {
  MAX_PROJECT_FILES,
  MAX_SOURCE_UPLOAD_BYTES,
  sourceFileByteLimit,
} from '../shared/source-limits.mjs'

export const TERMINAL_RECOVERY_DIRECTORY = '.terminal-sync-recovery'
const BACKUP_DIRECTORY = 'terminal-pull-backups'
const MAX_PULL_MS = 5000
const BACKUP_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_BACKUP_METADATA_BYTES = 8 * 1024
const hash = (value) => createHash('sha256').update(value).digest('hex')
const contains = (parent, child) =>
  parent === child || child.startsWith(parent + '/')
const conflict = (filename) =>
  Object.assign(
    new Error(
      `Terminal files changed while receiving project updates${filename ? `: ${filename}` : ''}. Your private files are preserved. Close this terminal and download its recovery copy before reopening it.`,
    ),
    { status: 409 },
  )
const pullCapacity = () =>
  Object.assign(
    new Error(
      'This terminal needs a fresh copy to receive this large set of project updates. Your private files are preserved. Close it, download its recovery copy if needed, and reopen it from the latest project.',
    ),
    { status: 413, code: 'TERMINAL_RECONCILIATION_LIMIT' },
  )
const changedTextBytes = (change) =>
  Buffer.byteLength(change.before ?? '') + Buffer.byteLength(change.after ?? '')
const invalidRecoveryMetadata = () =>
  Object.assign(
    new Error(
      'This private copy has invalid recovery metadata. Its files are preserved. Ask the server administrator to recover them before discarding this copy.',
    ),
    { status: 409 },
  )

function validBackupPath(filename) {
  return (
    typeof filename === 'string' &&
    filename.startsWith(BACKUP_DIRECTORY + '/') &&
    BACKUP_ID.test(filename.slice(BACKUP_DIRECTORY.length + 1))
  )
}

function validRecoveryPath(filename) {
  return (
    typeof filename === 'string' &&
    filename.length > 0 &&
    filename.length <= 1024 &&
    !filename.includes('\\') &&
    ![...filename].some((character) => character.charCodeAt(0) < 32) &&
    !path.posix.isAbsolute(filename) &&
    filename.split('/').length <= 64 &&
    filename
      .split('/')
      .every(
        (part) =>
          part &&
          part !== '.' &&
          part !== '..' &&
          Buffer.byteLength(part) <= 255,
      )
  )
}

function recoveryDestination(originalPath) {
  const directory = `${TERMINAL_RECOVERY_DIRECTORY}/${randomUUID()}`
  const destination = `${directory}/${originalPath}`
  // Original paths may already fill the workspace's length limit. Keep their
  // bytes downloadable even when the additional recovery prefix cannot fit.
  return destination.length <= 1024 && destination.split('/').length <= 64
    ? destination
    : `${directory}/${path.posix.basename(originalPath)}`
}

async function writeBackupMetadata(context, filename, originalPath) {
  if (!validBackupPath(filename) || !validRecoveryPath(originalPath))
    throw invalidRecoveryMetadata()
  const parent = await context.openParent(
    context.container,
    filename + '.json',
    { durable: true },
  )
  try {
    await parentCurrent(parent, context.container, filename + '.json')
    const handle = await fs.open(
      `${parent.anchor}/${parent.name}`,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.writeFile(
        JSON.stringify({ version: 1, path: originalPath, filename }),
      )
      await handle.sync()
    } finally {
      await handle.close()
    }
    await parent.handle.sync()
  } finally {
    await parent.handle.close()
  }
}

async function removeBackupMetadata(context, filename) {
  let parent
  try {
    parent = await context.openParent(context.container, filename + '.json', {
      create: false,
    })
    await parentCurrent(parent, context.container, filename + '.json')
    await fs.unlink(`${parent.anchor}/${parent.name}`)
    await parent.handle.sync()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  } finally {
    await parent?.handle.close()
  }
}

async function readBackupMetadata(context, filename) {
  let parent, handle
  try {
    parent = await context.openParent(context.container, filename + '.json', {
      create: false,
    })
    await parentCurrent(parent, context.container, filename + '.json')
    handle = await fs.open(
      `${parent.anchor}/${parent.name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.size > MAX_BACKUP_METADATA_BYTES ||
      (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !==
        path.join(context.container, filename + '.json')
    )
      throw invalidRecoveryMetadata()
    const bytes = Buffer.alloc(MAX_BACKUP_METADATA_BYTES + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_BACKUP_METADATA_BYTES) throw invalidRecoveryMetadata()
    let metadata
    try {
      metadata = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, bytesRead),
        ),
      )
    } catch {
      throw invalidRecoveryMetadata()
    }
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.keys(metadata).length !== 3 ||
      metadata.version !== 1 ||
      metadata.filename !== filename ||
      !validBackupPath(metadata.filename) ||
      !validRecoveryPath(metadata.path)
    )
      throw invalidRecoveryMetadata()
    return metadata
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close()
    await parent?.handle.close()
  }
}

/** Caller holds the per-copy lock and has proved its worker has stopped. */
export async function recoverTerminalBackups(context) {
  let parent
  try {
    parent = await context.openParent(
      context.container,
      `${BACKUP_DIRECTORY}/.terminal-sync-recover`,
      { create: false },
    )
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  let entries
  try {
    await parentCurrent(
      parent,
      context.container,
      `${BACKUP_DIRECTORY}/.terminal-sync-recover`,
    )
    entries = await fs.readdir(parent.anchor, { withFileTypes: true })
  } finally {
    await parent.handle.close()
  }
  if (entries.length > MAX_PROJECT_FILES) throw invalidRecoveryMetadata()
  const preserved = []
  for (const entry of entries) {
    const isMetadata = entry.name.endsWith('.json')
    const id = isMetadata ? entry.name.slice(0, -5) : entry.name
    if (!BACKUP_ID.test(id) || !entry.isFile()) throw invalidRecoveryMetadata()
    const filename = `${BACKUP_DIRECTORY}/${id}`
    if (isMetadata) {
      if (!(await fileKind(context.container, filename, context.openParent)))
        await removeBackupMetadata(context, filename)
      continue
    }
    const metadata = await readBackupMetadata(context, filename)
    const originalPath = metadata?.path ?? `unmapped-${id}.bin`
    const destination = recoveryDestination(originalPath)
    try {
      await move(
        context.container,
        filename,
        context.manifest.root,
        destination,
        context.openParent,
        'file',
      )
    } catch (error) {
      if (await fileKind(context.container, filename, context.openParent))
        throw error
      continue
    }
    await removeBackupMetadata(context, filename)
    if (context.state) {
      const backup = context.state.backups.find(
        (item) => item.filename === filename,
      )
      context.state.backups = context.state.backups.filter(
        (item) => item !== backup,
      )
      context.state.backupBytes -= backup?.size ?? 0
      context.state.ignoredPaths.add(TERMINAL_RECOVERY_DIRECTORY)
    }
    preserved.push(destination)
  }
  return preserved
}

export function createTerminalReconciliation() {
  return {
    pendingEvents: [],
    queuedEntries: 0,
    backups: [],
    backupBytes: 0,
    ignoredPaths: new Set(),
    ignoredHashes: new Map(),
    ignoredStamps: new Map(),
    identityPaths: new Set(),
    deletedPaths: new Set(),
    previousChanges: undefined,
    overflow: false,
  }
}

export function queueTerminalChanges(state, event) {
  if (event.kind !== 'files') return
  const entries =
    event.paths.length +
    event.removedPaths.length +
    (event.moves?.length || 0) * 2
  if (
    state.queuedEntries + entries > MAX_PROJECT_FILES ||
    state.pendingEvents.length >= MAX_PROJECT_FILES
  ) {
    state.overflow = true
    return
  }
  state.queuedEntries += entries
  state.pendingEvents.push({
    own: event.own === true,
    paths: [...event.paths],
    removedPaths: [...event.removedPaths],
    moves: (event.moves || []).map(({ from, to }) => ({ from, to })),
  })
}

async function parentCurrent(parent, root, filename) {
  if (
    (await fs.realpath(parent.anchor)) !==
    path.dirname(path.join(root, filename))
  )
    throw conflict(filename)
}

// Read through a pinned parent and file descriptor. A private shell may replace
// any writable ancestor while reconciliation is waiting for filesystem I/O.
async function fileState(root, filename, openParent) {
  let parent, handle
  try {
    parent = await openParent(root, filename, { create: false })
    await parentCurrent(parent, root, filename)
    handle = await fs.open(
      `${parent.anchor}/${parent.name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    if (
      (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !==
      path.join(root, filename)
    )
      throw conflict(filename)
    const before = await handle.stat()
    if (before.isDirectory()) return { directory: true }
    if (!before.isFile() || before.size > MAX_SOURCE_UPLOAD_BYTES)
      throw conflict(filename)
    const chunks = []
    let size = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MAX_SOURCE_UPLOAD_BYTES + 1 - size),
      )
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > MAX_SOURCE_UPLOAD_BYTES) throw conflict(filename)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    if (
      size !== before.size ||
      after.size !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw conflict(filename)
    await parentCurrent(parent, root, filename)
    const content = Buffer.concat(chunks, size)
    let text = null
    if (
      !isBinaryAssetFile(filename) &&
      !content.includes(0) &&
      size <= sourceFileByteLimit(filename)
    ) {
      try {
        text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(content)
      } catch {
        /* Binary and incomplete UTF-8 remain private. */
      }
    }
    return {
      hash: hash(content),
      content,
      text,
      size,
      mode: before.mode & 0o777,
      dev: before.dev,
      ino: before.ino,
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close()
    await parent?.handle.close()
  }
}

async function fileKind(root, filename, openParent) {
  let parent
  try {
    parent = await openParent(root, filename, { create: false })
    await parentCurrent(parent, root, filename)
    const stat = await fs.lstat(`${parent.anchor}/${parent.name}`)
    await parentCurrent(parent, root, filename)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw conflict(filename)
    return { directory: stat.isDirectory() }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally {
    await parent?.handle.close()
  }
}

async function fileStamp(root, filename, openParent) {
  let parent, handle
  try {
    parent = await openParent(root, filename, { create: false })
    await parentCurrent(parent, root, filename)
    handle = await fs.open(
      `${parent.anchor}/${parent.name}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    if (
      (await fs.realpath(`/proc/self/fd/${handle.fd}`)) !==
      path.join(root, filename)
    )
      throw conflict(filename)
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) throw conflict(filename)
    await parentCurrent(parent, root, filename)
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally {
    await handle?.close()
    await parent?.handle.close()
  }
}

async function ignoredFileState(state, context, filename) {
  const stamp = await fileStamp(
    context.manifest.root,
    filename,
    context.openParent,
  )
  if (stamp === null) {
    state.ignoredStamps.delete(filename)
    return null
  }
  const cached = state.ignoredStamps.get(filename)
  if (cached?.stamp === stamp) return cached
  const current = await fileState(
    context.manifest.root,
    filename,
    context.openParent,
  )
  if (
    (await fileStamp(context.manifest.root, filename, context.openParent)) !==
    stamp
  )
    throw conflict(filename)
  const accepted = { stamp, hash: current?.hash ?? null }
  state.ignoredStamps.set(filename, accepted)
  return accepted
}

async function move(root, from, targetRoot, to, openParent, kind) {
  let source, target
  try {
    source = await openParent(root, from, { create: false })
    target = await openParent(targetRoot, to)
    await parentCurrent(source, root, from)
    await parentCurrent(target, targetRoot, to)
    await moveWithoutReplacing(source, target, kind)
    await source.handle.sync()
    await target.handle.sync()
    await parentCurrent(source, root, from)
    await parentCurrent(target, targetRoot, to)
  } finally {
    await target?.handle.close()
    await source?.handle.close()
  }
}

async function treeFiles(
  root,
  filename,
  openParent,
  result = [],
  depth = 0,
  check = () => {},
) {
  check()
  if (depth > 64 || result.length >= MAX_PROJECT_FILES) throw conflict(filename)
  const state = await fileKind(root, filename, openParent)
  if (!state) return result
  if (!state.directory) {
    result.push(filename)
    return result
  }
  const parent = await openParent(root, `${filename}/.terminal-sync-list`, {
    create: false,
  })
  try {
    for (const entry of await fs.readdir(parent.anchor, {
      withFileTypes: true,
    })) {
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw conflict(filename)
      await treeFiles(
        root,
        `${filename}/${entry.name}`,
        openParent,
        result,
        depth + 1,
        check,
      )
    }
  } finally {
    await parent.handle.close()
  }
  return result
}

async function removeEmptyFolder(root, filename, openParent) {
  let parent
  try {
    parent = await openParent(root, filename, { create: false })
    await parentCurrent(parent, root, filename)
    await fs.rmdir(`${parent.anchor}/${parent.name}`)
    await parent.handle.sync()
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error.code))
      throw error
  } finally {
    await parent?.handle.close()
  }
}

async function followCompleteFolderMoves(
  event,
  expected,
  context,
  touched,
  checkBudget,
) {
  const mapping = new Map(event.moves.map(({ from, to }) => [from, to]))
  const candidates = new Map()
  for (const { from, to } of event.moves) {
    checkBudget()
    const source = from.split('/')
    const target = to.split('/')
    let suffix = 0
    while (
      suffix < Math.min(source.length, target.length) - 1 &&
      source.at(-suffix - 1) === target.at(-suffix - 1)
    ) {
      suffix++
      const fromFolder = source.slice(0, -suffix).join('/')
      const toFolder = target.slice(0, -suffix).join('/')
      if (fromFolder !== toFolder && candidates.size < MAX_PROJECT_FILES)
        candidates.set(`${fromFolder}\0${toFolder}`, {
          from: fromFolder,
          to: toFolder,
        })
    }
  }
  for (const { from, to } of [...candidates.values()].sort(
    (a, b) => a.from.split('/').length - b.from.split('/').length,
  )) {
    checkBudget()
    const files = [...expected.keys()].filter((filename) =>
      contains(from, filename),
    )
    if (
      !files.length ||
      !files.every(
        (filename) =>
          mapping.get(filename) === to + filename.slice(from.length),
      )
    )
      continue
    const source = await fileKind(
      context.manifest.root,
      from,
      context.openParent,
    )
    if (
      !source?.directory ||
      (await fileKind(context.sharedRoot, from, context.openParent))
    )
      continue
    if (await fileKind(context.manifest.root, to, context.openParent)) {
      const targets = new Set(files.map((filename) => mapping.get(filename)))
      const destinationFiles = await treeFiles(
        context.sharedRoot,
        to,
        context.openParent,
        [],
        0,
        checkBudget,
      )
      // A preexisting shared destination can legitimately receive a file
      // merge. Only a pure relocation has exactly the mapped destination files.
      if (
        destinationFiles.length !== targets.size ||
        destinationFiles.some((filename) => !targets.has(filename))
      )
        continue
      throw Object.assign(
        new Error(
          `The project moved ${from} to ${to}, but that destination already exists in this terminal's private copy. Your files and current folder are preserved. Close this terminal and recover its private copy before reopening it.`,
        ),
        { status: 409 },
      )
    }
    context.authorize()
    await move(
      context.manifest.root,
      from,
      context.manifest.root,
      to,
      context.openParent,
      'folder',
    )
    if (!event.own) context.state.deletedPaths.add(from)
    context.state.deletedPaths.delete(to)
    touched.add(from)
    touched.add(to)
  }
}

async function exposeBackup(state, backup, context) {
  const destination = recoveryDestination(backup.path)
  await move(
    context.container,
    backup.filename,
    context.manifest.root,
    destination,
    context.openParent,
    'file',
  )
  await removeBackupMetadata(context, backup.filename)
  state.backups = state.backups.filter((item) => item !== backup)
  state.backupBytes -= backup.size
  throw conflict(
    `${backup.path}; its interrupted write is saved in ${destination}`,
  )
}

/** Finalization also runs after a mirror paused, when late descriptors may write. */
export async function preserveTerminalBackups(context) {
  const { state, manifest, container, openParent } = context
  const preserved = []
  for (const backup of [...state.backups]) {
    let current
    try {
      current = await fileState(container, backup.filename, openParent)
    } catch {
      /* Preserve unreadable/growing inodes too. */
    }
    if (current?.hash === backup.hash) continue
    if (
      !current &&
      !(await fs.lstat(path.join(container, backup.filename)).catch(() => null))
    ) {
      await removeBackupMetadata(context, backup.filename)
      state.backups = state.backups.filter((item) => item !== backup)
      state.backupBytes -= backup.size
      continue
    }
    const destination = recoveryDestination(backup.path)
    await move(
      container,
      backup.filename,
      manifest.root,
      destination,
      openParent,
      'file',
    )
    await removeBackupMetadata(context, backup.filename)
    state.backups = state.backups.filter((item) => item !== backup)
    state.backupBytes -= backup.size
    state.ignoredPaths.add(TERMINAL_RECOVERY_DIRECTORY)
    preserved.push(destination)
  }
  return preserved
}

async function checkBackups(state, context) {
  if (!state.backups.length) return
  let parent
  try {
    parent = await context.openParent(
      context.container,
      `${BACKUP_DIRECTORY}/.terminal-sync-compact`,
      { create: false },
    )
    const result = await compactTerminalFiles(
      parent,
      state.backups.map((backup) => ({
        name: path.posix.basename(backup.filename),
        hash: backup.hash,
      })),
      MAX_SOURCE_UPLOAD_BYTES,
    )
    for (const backup of state.backups)
      if (result[path.posix.basename(backup.filename)] === 'removed')
        await removeBackupMetadata(context, backup.filename)
    state.backups = state.backups.filter((backup) => {
      if (result[path.posix.basename(backup.filename)] !== 'removed')
        return true
      state.backupBytes -= backup.size
      return false
    })
  } catch {
    /* Unavailable leases/compaction must retain all private inodes. */
  } finally {
    await parent?.handle.close()
  }
  for (const backup of [...state.backups]) {
    let current
    try {
      current = await fileState(
        context.container,
        backup.filename,
        context.openParent,
      )
    } catch {
      return exposeBackup(state, backup, context)
    }
    // A helper can time out after safely compacting only part of its batch.
    if (!current) {
      await removeBackupMetadata(context, backup.filename)
      state.backups = state.backups.filter((item) => item !== backup)
      state.backupBytes -= backup.size
      continue
    }
    if (current.hash !== backup.hash)
      return exposeBackup(state, backup, context)
  }
}

async function replacePrivate(state, filename, before, after, context) {
  const { manifest, container, openParent, authorize } = context
  if (
    state.backups.length >= 1000 ||
    state.backupBytes + (before?.size || 0) > MAX_SOURCE_UPLOAD_BYTES
  )
    throw Object.assign(
      new Error(
        'This terminal is keeping too many earlier file versions for active commands. Close it, download its recovery copy if needed, and reopen it to continue receiving project updates.',
      ),
      { status: 409 },
    )
  authorize()
  const staged = `${BACKUP_DIRECTORY}/${randomUUID()}`
  await writeBackupMetadata(context, staged, filename)
  if (after) {
    const parent = await openParent(container, staged)
    try {
      const handle = await fs.open(
        `${parent.anchor}/${parent.name}`,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        after.mode,
      )
      try {
        await handle.writeFile(after.content)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } finally {
      await parent.handle.close()
    }
  }
  const backup = before
    ? { filename: staged, path: filename, hash: before.hash, size: before.size }
    : null
  // Register before an ambiguous syscall outcome: every displaced private inode
  // remains attributable even if fsync or the helper acknowledgement fails.
  if (backup) {
    state.backups.push(backup)
    state.backupBytes += backup.size
  }
  authorize()
  if (before && after) {
    let source, target
    try {
      source = await openParent(container, staged, { create: false })
      target = await openParent(manifest.root, filename, { create: false })
      await parentCurrent(source, container, staged)
      await parentCurrent(target, manifest.root, filename)
      await exchangeTerminalFiles(source, target)
      await source.handle.sync()
      await target.handle.sync()
      await parentCurrent(source, container, staged)
      await parentCurrent(target, manifest.root, filename)
      if (
        (await fileState(container, staged, openParent))?.hash !== before.hash
      ) {
        // The worker edited/replaced the file after the clean check. Exchange
        // it back without discarding whatever now occupies the visible name.
        await exchangeTerminalFiles(source, target)
        state.backupBytes += after.size - backup.size
        backup.size = after.size
        backup.hash = after.hash
        await checkBackups(state, context)
        throw conflict(filename)
      }
    } finally {
      await target?.handle.close()
      await source?.handle.close()
    }
  } else if (before) {
    await move(manifest.root, filename, container, staged, openParent, 'file')
    if (
      (await fileState(container, staged, openParent))?.hash !== before.hash
    ) {
      try {
        await move(
          container,
          staged,
          manifest.root,
          filename,
          openParent,
          'file',
        )
        state.backups = state.backups.filter((item) => item !== backup)
        state.backupBytes -= backup.size
        await removeBackupMetadata(context, staged)
      } catch {
        await exposeBackup(state, backup, context)
      }
      throw conflict(filename)
    }
  } else {
    await move(container, staged, manifest.root, filename, openParent, 'file')
    await removeBackupMetadata(context, staged)
  }
}

/** Called serially per private copy while holding the project's short write queue. */
export async function reconcileTerminal(context) {
  const {
    state,
    manifest,
    container,
    previousChanges = [],
    sharedRoot,
    openParent,
    authorize,
    now = performance.now.bind(performance),
  } = context
  const deadline = now() + MAX_PULL_MS
  const checkBudget = () => {
    if (now() > deadline) throw pullCapacity()
  }
  authorize()
  await checkBackups(state, context)
  // Unsupported files still belong to the private copy. Once their move was
  // accepted, a later private edit must cause recovery rather than disappear
  // behind the editable-file scanner's exclusions.
  for (const [filename, expectedHash] of state.ignoredHashes) {
    checkBudget()
    const local = await ignoredFileState(state, context, filename)
    if ((local?.hash ?? null) !== expectedHash) throw conflict(filename)
  }
  if (state.overflow) throw conflict()
  const base = new Map(manifest.files.map((file) => [file.path, file.hash]))
  const accepted = new Map(
    (state.previousChanges ?? previousChanges).map((change) => [
      change.path,
      change,
    ]),
  )
  let acceptedBytes = [...accepted.values()].reduce(
    (total, change) => total + changedTextBytes(change),
    0,
  )
  if (acceptedBytes > MAX_SOURCE_UPLOAD_BYTES * 2) throw pullCapacity()
  const expected = new Map(base)
  for (const change of accepted.values()) {
    if (change.after === null) expected.delete(change.path)
    else expected.set(change.path, hash(change.after))
  }
  for (const [filename, fileHash] of state.ignoredHashes) {
    if (fileHash === null) expected.delete(filename)
    else expected.set(filename, fileHash)
  }
  const saveAccepted = () => {
    state.previousChanges = [...accepted.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    )
  }
  const setAccepted = async (filename, text, fileHash = null) => {
    checkBudget()
    const identityChanged = (expected.get(filename) ?? null) !== fileHash
    let before = accepted.get(filename)?.before
    if (before === undefined) {
      const original = base.has(filename)
        ? await fileState(
            path.join(container, 'baseline'),
            filename,
            openParent,
          )
        : null
      if (original && original.hash !== base.get(filename))
        throw conflict(filename)
      if (original && original.text === null) {
        if (identityChanged) state.identityPaths.add(filename)
        state.ignoredPaths.add(filename)
        state.ignoredHashes.set(filename, fileHash)
        if (fileHash === null) expected.delete(filename)
        else expected.set(filename, fileHash)
        return
      }
      before = original?.text ?? null
    }
    const next =
      text === before
        ? null
        : {
            path: filename,
            before,
            beforeHash: base.get(filename) ?? null,
            after: text,
          }
    const bytes =
      acceptedBytes -
      (accepted.has(filename) ? changedTextBytes(accepted.get(filename)) : 0) +
      (next ? changedTextBytes(next) : 0)
    if (bytes > MAX_SOURCE_UPLOAD_BYTES * 2) throw pullCapacity()
    acceptedBytes = bytes
    if (identityChanged) state.identityPaths.add(filename)
    if (next) accepted.set(filename, next)
    else accepted.delete(filename)
    if (fileHash === null) expected.delete(filename)
    else expected.set(filename, fileHash)
    saveAccepted()
  }
  const pending = state.pendingEvents.splice(0)
  state.queuedEntries = 0
  const touched = new Set()
  for (const event of pending) {
    checkBudget()
    authorize()
    for (const filename of event.paths) touched.add(filename)
    await followCompleteFolderMoves(
      event,
      expected,
      context,
      touched,
      checkBudget,
    )
    for (const { from, to } of event.moves) {
      const sources = [...expected.keys()].filter((filename) =>
        contains(from, filename),
      )
      const source = await fileKind(manifest.root, from, openParent)
      const destination = await fileKind(manifest.root, to, openParent)
      // A terminal's own published move, or a move already included in its
      // initial capture, must not move a subsequently created old-path file.
      if (source && (sources.length || !destination)) {
        authorize()
        await move(
          manifest.root,
          from,
          manifest.root,
          to,
          openParent,
          source.directory ? 'folder' : 'file',
        )
      }
      for (const filename of sources) {
        checkBudget()
        const target = to + filename.slice(from.length)
        const existing = accepted.get(filename)
        const original = existing
          ? null
          : await fileState(
              path.join(container, 'baseline'),
              filename,
              openParent,
            )
        const text = existing ? existing.after : original?.text
        if (text === null || text === undefined) {
          state.identityPaths.add(filename)
          state.identityPaths.add(target)
          state.ignoredPaths.add(filename)
          state.ignoredPaths.add(target)
          state.ignoredHashes.set(filename, null)
          state.ignoredHashes.set(target, expected.get(filename))
          expected.set(target, expected.get(filename))
          expected.delete(filename)
        } else {
          await setAccepted(target, text, expected.get(filename))
          await setAccepted(filename, null)
        }
        touched.add(filename)
        touched.add(target)
        if (!event.own) state.deletedPaths.add(filename)
      }
      if (!event.own) state.deletedPaths.add(from)
      state.deletedPaths.delete(to)
      touched.add(from)
      touched.add(to)
    }
    if (!event.own)
      for (const removed of event.removedPaths) state.deletedPaths.add(removed)
  }
  // Replay all move identities before reading the final shared paths. A -> B
  // -> C may be queued between polls; reading missing B between the two moves
  // would otherwise delete the live private inode before its second rename.
  for (const filename of [...touched]) {
    checkBudget()
    for (const known of [...base.keys(), ...accepted.keys()])
      if (contains(filename, known)) touched.add(known)
    for (const current of await treeFiles(
      sharedRoot,
      filename,
      openParent,
      [],
      0,
      checkBudget,
    ))
      touched.add(current)
  }
  const removedFolders = new Set()
  const removed = (filename) => {
    for (
      let candidate = filename;
      candidate !== '.';
      candidate = path.posix.dirname(candidate)
    )
      if (state.deletedPaths.has(candidate)) return true
    return false
  }
  for (const filename of [...touched].sort()) {
    checkBudget()
    authorize()
    const shared = await fileState(sharedRoot, filename, openParent)
    if (shared?.directory) continue
    const local = await fileState(manifest.root, filename, openParent)
    if (local?.directory) {
      if (!shared && removed(filename)) removedFolders.add(filename)
      continue
    }
    const expectedHash = expected.get(filename) ?? null
    const sharedHash = shared?.hash ?? null
    const localHash = local?.hash ?? null
    if (sharedHash !== expectedHash && localHash !== sharedHash) {
      if (localHash !== expectedHash) {
        if (
          state.ignoredPaths.has(filename) ||
          (local && local.text === null) ||
          (shared && shared.text === null)
        )
          throw conflict(filename)
        continue // Existing CAS publication reports a retained conflict.
      }
      await replacePrivate(state, filename, local, shared, context)
    }
    if (
      state.ignoredPaths.has(filename) &&
      localHash !== sharedHash &&
      localHash !== expectedHash
    )
      throw conflict(filename)
    if (sharedHash === localHash || localHash === expectedHash) {
      if (shared && shared.text === null) {
        if ((expected.get(filename) ?? null) !== sharedHash)
          state.identityPaths.add(filename)
        state.ignoredPaths.add(filename)
        state.ignoredHashes.set(filename, sharedHash)
        expected.set(filename, sharedHash)
      } else await setAccepted(filename, shared?.text ?? null, sharedHash)
      if (shared) {
        state.deletedPaths.delete(filename)
      }
    }
  }
  // Children must finish receiving their deletions before an empty parent is
  // removed. Include only ancestors of touched paths under a shared removal;
  // private-only files and folders continue to keep their parents nonempty.
  for (const filename of touched) {
    checkBudget()
    for (
      let folder = path.posix.dirname(filename);
      folder !== '.';
      folder = path.posix.dirname(folder)
    )
      if (removed(folder)) removedFolders.add(folder)
  }
  for (const folder of [...removedFolders].sort(
    (a, b) => b.split('/').length - a.split('/').length,
  )) {
    checkBudget()
    authorize()
    if (!(await fileKind(sharedRoot, folder, openParent)))
      await removeEmptyFolder(manifest.root, folder, openParent)
  }
  saveAccepted()
  for (const [filename, expectedHash] of state.ignoredHashes) {
    checkBudget()
    const local = await ignoredFileState(state, context, filename)
    if ((local?.hash ?? null) !== expectedHash) throw conflict(filename)
  }
  authorize()
  return state.previousChanges
}
