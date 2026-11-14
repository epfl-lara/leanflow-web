import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  MAX_SOURCE_UPLOAD_BYTES,
  sourceFileByteLimit,
} from '../shared/source-limits.mjs'
import {
  createReferenceRewriter,
  createReferencePathMapper,
  isReferenceFile,
} from './workspace-references.mjs'

// Scans use the normal project boundary (no dependencies, protected data or links).
// Keep this work outside the file-write queue; only matching edits enter the
// existing checked transaction after the rename commits.
export async function prepareReferenceUpdates({
  from,
  to,
  moves,
  files,
  readFile,
  signal,
  isProtected = () => false,
}) {
  const rewrite = createReferenceRewriter({
    from,
    to,
    moves,
    files: files.map((file) => file.path),
  })
  const moved = createReferencePathMapper({
    from,
    to,
    moves,
    files: files.map((file) => file.path),
  })
  const updates = []
  let scannedBytes = 0
  let changedBytes = 0
  let skippedFiles = 0
  for (const file of files) {
    if (!isReferenceFile(file.path) || isProtected(file.path)) continue
    if (signal?.aborted || scannedBytes + file.size > MAX_SOURCE_UPLOAD_BYTES) {
      skippedFiles++
      continue
    }
    scannedBytes += file.size
    let source
    try {
      source = await readFile(file.path)
    } catch {
      // A changing, oversized or non-UTF-8 file must not prevent the move.
      // It is counted explicitly so the result never promises a complete scan.
      skippedFiles++
      continue
    }
    scannedBytes += Buffer.byteLength(source.content) - file.size
    if (signal?.aborted || scannedBytes > MAX_SOURCE_UPLOAD_BYTES) {
      skippedFiles++
      continue
    }
    let result
    try {
      result = rewrite(source.content, file.path)
    } catch {
      skippedFiles++
      await yieldToEventLoop()
      continue
    }
    if (result.skipped) {
      skippedFiles++
      await yieldToEventLoop()
      continue
    }
    if (result.count) {
      const size = Math.max(
        Buffer.byteLength(source.content),
        Buffer.byteLength(result.content),
      )
      if (
        changedBytes + size > MAX_SOURCE_UPLOAD_BYTES ||
        Buffer.byteLength(result.content) > sourceFileByteLimit(file.path) ||
        updates.length >= 1000
      ) {
        skippedFiles++
        continue
      }
      changedBytes += size
      updates.push({
        path: moved(file.path),
        beforeHash: source.hash,
        after: result.content,
        count: result.count,
      })
    }
    // Rewriting is synchronous, but a project full of small files must still
    // leave sockets, cancellation and other projects responsive.
    await yieldToEventLoop()
  }
  return { updates, skippedFiles }
}

export async function applyReferenceUpdates(plan, { readFile, apply }) {
  const result = {
    updatedFiles: 0,
    updatedReferences: 0,
    updatedPaths: [],
    skippedFiles: plan.skippedFiles,
  }
  const current = []
  for (const update of plan.updates) {
    try {
      if ((await readFile(update.path)).hash === update.beforeHash) {
        current.push(update)
        continue
      }
    } catch {
      // A deleted or inaccessible reference must not undo a committed move.
    }
    result.skippedFiles++
  }
  try {
    if (current.length) {
      await apply(
        current.map(({ path, beforeHash, after }) => ({
          path,
          beforeHash,
          after,
        })),
      )
      result.updatedFiles = current.length
      result.updatedReferences = current.reduce(
        (count, update) => count + update.count,
        0,
      )
      result.updatedPaths = current.map((update) => update.path)
    }
  } catch (error) {
    result.skippedFiles += current.length
    return {
      ...result,
      warning: error.projectRecovery
        ? 'The move completed, but file references need recovery. Retry file recovery, then review imports and links that use the old path.'
        : 'The move completed, but file references could not be updated. Review imports and links that use the old path.',
    }
  }
  return result.skippedFiles
    ? {
        ...result,
        warning:
          'The move completed. Some files changed or could not be scanned, so their references were left unchanged. Review imports and links that use the old path.',
      }
    : result
}
