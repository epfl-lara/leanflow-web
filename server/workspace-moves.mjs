import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'

const MAX_TREE_ENTRIES = 20000
const MAX_TREE_DEPTH = 64

// Workspace snapshots report file contents rather than rename operations. Only follow
// a one-to-one, byte-identical deletion/addition; duplicate contents and replaced
// destinations cannot identify which file a local draft belongs to.
export function unchangedFileMoves(changes) {
  const removed = new Map()
  const added = new Map()
  for (const change of changes) {
    let group, content
    if (typeof change.before === 'string' && change.after === null) {
      group = removed
      content = change.before
    } else if (change.before === null && typeof change.after === 'string') {
      group = added
      content = change.after
    } else continue
    const hash = createHash('sha256').update(content).digest('hex')
    const entries = group.get(hash) || []
    entries.push(change)
    group.set(hash, entries)
  }
  const moves = []
  for (const [hash, sources] of removed) {
    const targets = added.get(hash)
    if (
      sources.length === 1 &&
      targets?.length === 1 &&
      sources[0].before === targets[0].after
    )
      moves.push({ from: sources[0].path, to: targets[0].path })
  }
  return moves
}

export class MoveError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'MoveError'
    this.status = this.statusCode = status
  }
}

/** Validates the shape of a move request. Path syntax is checked by the caller. */
export function parseMoveRequest(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !['from', 'to', 'updateReferences'].includes(key),
    ) ||
    typeof input.from !== 'string' ||
    typeof input.to !== 'string' ||
    (input.updateReferences !== undefined &&
      typeof input.updateReferences !== 'boolean')
  )
    throw new MoveError(
      'Choose the file or folder to move and its new path (from and to).',
    )
  return {
    from: input.from,
    to: input.to,
    ...(input.updateReferences === undefined
      ? {}
      : { updateReferences: input.updateReferences }),
  }
}

/** Rejects no-op and self-containing moves for already normalized paths. */
export function assertMovePaths(from, to) {
  if (from === to)
    throw new MoveError('The new path is the same as the current path.')
  if (to.startsWith(from + '/'))
    throw new MoveError('A folder cannot be moved into itself.')
}

/**
 * Checks that a folder can move as one unit: only regular files and folders,
 * no protected data, and bounded size. Descriptor-anchored like trash checks.
 */
export async function assertMovableTree(directory, { isSecret }) {
  let count = 0
  const visit = async (current, depth) => {
    if (depth > MAX_TREE_DEPTH)
      throw new MoveError('Folder nesting exceeds 64 levels.', 413)
    const handle = await fs.open(
      current,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    try {
      if ((await fs.realpath(`/proc/self/fd/${handle.fd}`)) !== current)
        throw new MoveError(
          'Folder changed during the move. Refresh the file tree and try again.',
          409,
        )
      for (const entry of await fs.readdir(`/proc/self/fd/${handle.fd}`, {
        withFileTypes: true,
      })) {
        if (++count > MAX_TREE_ENTRIES)
          throw new MoveError(
            'This folder has too many items to move at once. Move its subfolders separately.',
            413,
          )
        if (
          isSecret(entry.name) ||
          ['.lake', 'node_modules'].includes(entry.name)
        )
          throw new MoveError(
            `This folder contains protected project data (${entry.name}) and cannot be moved here.`,
            403,
          )
        if (entry.isSymbolicLink())
          throw new MoveError(
            'Folders containing symbolic links cannot be moved through the file browser.',
            403,
          )
        if (entry.isDirectory())
          await visit(path.join(current, entry.name), depth + 1)
        else if (!entry.isFile())
          throw new MoveError(
            'Only regular files and folders can be moved.',
            403,
          )
      }
    } finally {
      await handle.close()
    }
  }
  await visit(directory, 0)
}

// Node's rename replaces an existing destination. Use Linux's atomic
// RENAME_NOREPLACE for both files and folders, keeping the verified parent
// descriptors open until it finishes. Filenames travel over stdin, never a
// shell. The isolated Python helper inherits only those two directory handles.
const moveRunner = `import base64, ctypes, errno, json, sys
data = json.load(sys.stdin)
libc = ctypes.CDLL(None, use_errno=True)
try:
    rename = libc.renameat2
except AttributeError:
    print('ENOSYS')
    sys.exit(1)
rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
rename.restype = ctypes.c_int
source = base64.b64decode(data['from'], validate=True)
target = base64.b64decode(data['to'], validate=True)
if rename(3, source, 4, target, 1) != 0:
    print(errno.errorcode.get(ctypes.get_errno(), 'EIO'))
    sys.exit(1)
`

function moveFailure(code) {
  if (['EEXIST', 'ENOTEMPTY'].includes(code))
    return new MoveError(
      'A file or folder with this name already exists at the destination. Choose another name or location.',
      409,
    )
  if (code === 'ENOENT')
    return new MoveError(
      'The file or destination folder no longer exists. Refresh the file list and try again.',
      404,
    )
  if (['ENOTDIR', 'EISDIR', 'ELOOP'].includes(code))
    return new MoveError(
      'A file or folder changed during the move. Refresh the file list and try again.',
      409,
    )
  if (code === 'EXDEV')
    return new MoveError(
      'These folders use different storage. Choose another destination folder.',
    )
  if (['EACCES', 'EPERM'].includes(code))
    return new MoveError(
      'The server cannot change this file or folder. Ask its administrator to check the file permissions.',
      403,
    )
  if (['ENOSPC', 'EDQUOT'].includes(code))
    return new MoveError(
      'Free storage on the server, then retry the move.',
      507,
    )
  if (['ENOSYS', 'EINVAL', 'EOPNOTSUPP', 'ENOTSUP'].includes(code))
    return new MoveError(
      'Safe file moves are unavailable on this server. Ask its administrator for help.',
      503,
    )
  return new MoveError(
    'The move could not be completed. Refresh the file list and try again.',
    503,
  )
}

function moveProcessFailure(error) {
  if (
    error?.name === 'AbortError' ||
    ['ABORT_ERR', 'ETIMEDOUT'].includes(error?.code)
  )
    return new MoveError(
      'The move took too long. Refresh the file list to check its location before retrying.',
      504,
    )
  if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error?.code))
    return moveFailure('ENOSYS')
  return new MoveError(
    'The server could not start the move. Try again shortly.',
    503,
  )
}

export async function moveWithoutReplacing(
  { handle: fromHandle, name: fromName },
  { handle: toHandle, name: toName },
  kind,
) {
  if (!['file', 'folder'].includes(kind))
    throw new MoveError('Choose a project file or folder to move.')
  const source = `/proc/self/fd/${fromHandle.fd}/${fromName}`
  const destination = `/proc/self/fd/${toHandle.fd}/${toName}`
  const read = async (filename) => {
    try {
      return await fs.lstat(filename)
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw moveFailure(error.code)
    }
  }
  const before = await read(source)
  if (!before) throw moveFailure('ENOENT')
  let result
  try {
    result = await new Promise((resolve) => {
      const child = childProcess.spawn('python3', ['-I', '-c', moveRunner], {
        env: { PATH: process.env.PATH, LC_ALL: 'C' },
        stdio: ['pipe', 'pipe', 'ignore', fromHandle.fd, toHandle.fd],
        signal: AbortSignal.timeout(10_000),
      })
      let output = ''
      let processError
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        if (output.length < 128) output += chunk
      })
      // Wait for close even on abort: inherited handles must remain open until
      // the helper has stopped, and a completed rename can still be recognized.
      child.once('error', (error) => {
        processError = error
      })
      child.once('close', (code) =>
        resolve({ code, errno: output.trim(), processError }),
      )
      child.stdin.on('error', () => {})
      child.stdin.end(
        JSON.stringify({
          from: Buffer.from(fromName).toString('base64'),
          to: Buffer.from(toName).toString('base64'),
        }),
      )
    })
  } catch (error) {
    throw moveProcessFailure(error)
  }
  if (result.code === 0) return
  const [remaining, moved] = await Promise.all([
    read(source),
    read(destination),
  ])
  if (!remaining && moved?.dev === before.dev && moved.ino === before.ino)
    return
  if (result.processError) throw moveProcessFailure(result.processError)
  throw moveFailure(result.errno)
}
