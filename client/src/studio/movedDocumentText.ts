import {
  documentTextEdits,
  type DocumentTextEdit,
} from '../../../shared/document-text.mjs'

function sameEdit(left: DocumentTextEdit, right: DocumentTextEdit) {
  return (
    left.start === right.start &&
    left.deleteCount === right.deleteCount &&
    left.insert === right.insert
  )
}

function editsConflict(left: DocumentTextEdit, right: DocumentTextEdit) {
  const leftEnd = left.start + left.deleteCount
  const rightEnd = right.start + right.deleteCount
  // An insertion on a replacement boundary is ambiguous: either author may
  // have intended those characters to belong to the replaced reference.
  if (!left.deleteCount)
    return right.start <= left.start && left.start <= rightEnd
  if (!right.deleteCount)
    return left.start <= right.start && right.start <= leftEnd
  return left.start < rightEnd && right.start < leftEnd
}

/** Replays a moved draft only when its edits do not conflict with saved edits. */
export function mergeMovedDocumentText(
  baseline: string,
  local: string,
  remote: string,
): string | null {
  if (local === baseline) return remote
  if (remote === baseline || local === remote) return local

  // These exact multi-hunk diffs share the editor's Unicode and computation
  // limits. A diff-limit error propagates before any document can be changed.
  const localEdits = documentTextEdits(baseline, local)
  const remoteEdits = documentTextEdits(baseline, remote)
  const edits: DocumentTextEdit[] = []
  let localIndex = 0
  let remoteIndex = 0
  while (localIndex < localEdits.length && remoteIndex < remoteEdits.length) {
    const left = localEdits[localIndex]
    const right = remoteEdits[remoteIndex]
    if (sameEdit(left, right)) {
      edits.push(left)
      localIndex++
      remoteIndex++
    } else if (editsConflict(left, right)) return null
    else if (left.start < right.start) {
      edits.push(left)
      localIndex++
    } else {
      edits.push(right)
      remoteIndex++
    }
  }
  for (; localIndex < localEdits.length; localIndex++)
    edits.push(localEdits[localIndex])
  for (; remoteIndex < remoteEdits.length; remoteIndex++)
    edits.push(remoteEdits[remoteIndex])

  // Read baseline coordinates backwards without repeatedly copying the full
  // document for each reference. Every accepted hunk is applied once.
  const chunks: string[] = []
  let end = baseline.length
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]
    chunks.push(baseline.slice(edit.start + edit.deleteCount, end), edit.insert)
    end = edit.start
  }
  chunks.push(baseline.slice(0, end))
  return chunks.reverse().join('')
}
