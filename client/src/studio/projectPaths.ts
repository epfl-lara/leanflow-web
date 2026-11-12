export function parentFolders(path: string): string[] {
  const parts = path.split('/')
  parts.pop()
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

export interface PathMove {
  from: string
  to: string
}

/** Window event announcing a committed rename/move in one project. */
export const FILES_MOVED_EVENT = 'lemex-files-moved'
export interface FilesMovedDetail extends PathMove {
  projectId: string
}

/**
 * Returns where `path` lives after `from` (a file or a folder) moved to `to`,
 * or null when the move does not affect it.
 */
export function remapMovedPath(
  path: string,
  from: string,
  to: string,
): string | null {
  if (path === from) return to
  return path.startsWith(from + '/') ? to + path.slice(from.length) : null
}

/** Validates the `moves` field of an untrusted live-collaboration message. */
export function pathMoves(value: unknown): PathMove[] {
  if (!Array.isArray(value) || value.length > 32) return []
  return value.filter(
    (move): move is PathMove =>
      !!move &&
      typeof move === 'object' &&
      typeof move.from === 'string' &&
      typeof move.to === 'string' &&
      !!move.from &&
      !!move.to &&
      move.from !== move.to &&
      !move.to.startsWith(move.from + '/'),
  )
}
