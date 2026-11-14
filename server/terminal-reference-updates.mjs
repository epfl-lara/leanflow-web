import { createHash } from 'node:crypto'
import { MAX_PROJECT_FILES } from '../shared/source-limits.mjs'
import { unchangedFileMoves } from './workspace-moves.mjs'
import { prepareReferenceUpdates } from './workspace-reference-scan.mjs'

const hash = (content) => createHash('sha256').update(content).digest('hex')

// Callers supply the existing guarded project access. Birth time distinguishes
// a renamed inode from a deleted file whose inode number has been recycled.
export async function captureTerminalIdentities(files, readIdentity) {
  const identities = new Map()
  for (const file of files) {
    const filename = typeof file === 'string' ? file : file.path
    try {
      const stat = await readIdentity(filename)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        typeof stat.birthtimeNs !== 'bigint' ||
        stat.birthtimeNs <= 0n
      )
        continue
      identities.set(filename, `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`)
    } catch {
      // Missing or changing metadata cannot prove a rename. Publishing ordinary
      // text changes remains available; automatic reference edits are optional.
    }
  }
  return identities
}

export function matchTerminalMoves(transition, previous, current) {
  if (!(previous instanceof Map) || !(current instanceof Map)) return []
  const unique = (identities) => {
    const counts = new Map()
    for (const identity of identities.values())
      counts.set(identity, (counts.get(identity) || 0) + 1)
    return counts
  }
  const oldCounts = unique(previous)
  const newCounts = unique(current)
  return unchangedFileMoves(transition).filter(({ from, to }) => {
    const identity = previous.get(from)
    return (
      identity !== undefined &&
      identity === current.get(to) &&
      oldCounts.get(identity) === 1 &&
      newCounts.get(identity) === 1
    )
  })
}

// Discover against the prospective terminal publication, in the old namespace.
// A same-poll terminal edit is read from its after-content and later checked
// against that exact hash after the ordinary source transaction has committed.
export async function prepareTerminalReferenceUpdates({
  transition,
  moves,
  files,
  readFile,
  signal,
  isProtected,
}) {
  if (!moves.length) return { updates: [], skippedFiles: 0 }
  const changed = new Map(transition.map((change) => [change.path, change]))
  const sources = new Map(moves.map((move) => [move.from, move.to]))
  const destinations = new Set(moves.map((move) => move.to))
  const projected = new Map(files.map((file) => [file.path, file]))
  for (const change of transition) {
    if (sources.has(change.path) || destinations.has(change.path)) continue
    if (change.after === null) projected.delete(change.path)
    else if (typeof change.after === 'string')
      projected.set(change.path, {
        path: change.path,
        size: Buffer.byteLength(change.after),
      })
  }
  for (const [from, to] of sources) {
    const content = changed.get(to)?.after
    if (typeof content === 'string')
      projected.set(from, { path: from, size: Buffer.byteLength(content) })
  }
  const allFiles = [...projected.values()]
  const plan = await prepareReferenceUpdates({
    moves,
    files: allFiles.slice(0, MAX_PROJECT_FILES),
    readFile: async (filename) => {
      const terminal = changed.get(sources.get(filename) || filename)
      if (typeof terminal?.after === 'string')
        return { content: terminal.after, hash: hash(terminal.after) }
      return readFile(filename)
    },
    signal,
    isProtected,
  })
  if (allFiles.length > MAX_PROJECT_FILES) plan.skippedFiles++
  return plan
}
