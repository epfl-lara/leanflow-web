import { MyersDiffAlgorithm } from 'vscode/vscode/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm'
import { DateTimeout } from 'vscode/vscode/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm'

const DEFAULT_DIFF_BUDGET = Object.freeze({
  maxComputationTimeMs: 200,
  maxOperations: 2_000_000,
  maxTokens: 300_000,
})

function diffLimit() {
  return Object.assign(
    new Error(
      'This edit is too complex to merge live. Your draft is preserved; use a smaller edit or reload the saved file.',
    ),
    { code: 'DOCUMENT_DIFF_LIMIT', status: 409 },
  )
}

function computationBudget(options) {
  const limits = { ...DEFAULT_DIFF_BUDGET, ...options }
  if (
    !Number.isFinite(limits.maxComputationTimeMs) ||
    limits.maxComputationTimeMs <= 0 ||
    !Number.isSafeInteger(limits.maxOperations) ||
    limits.maxOperations < 0 ||
    !Number.isSafeInteger(limits.maxTokens) ||
    limits.maxTokens < 0
  )
    throw diffLimit()
  const timer = new DateTimeout(limits.maxComputationTimeMs)
  let operations = 0
  return {
    maxTokens: limits.maxTokens,
    spend(count = 1) {
      operations += count
      if (
        operations > limits.maxOperations ||
        (operations % 1024 === 0 && !timer.isValid())
      )
        throw diffLimit()
    },
    check() {
      if (operations >= limits.maxOperations || !timer.isValid())
        throw diffLimit()
    },
    timeout: timer,
  }
}

// Keep Unicode surrogate pairs together and preserve unchanged source identities.
// This single-range helper is retained for editor selection transformations.
export function documentTextEdit(before, value) {
  if (before === value) return null
  let start = 0
  while (
    start < before.length &&
    start < value.length &&
    before[start] === value[start]
  )
    start++
  if (start && /[\uD800-\uDBFF]/.test(before[start - 1])) start--
  let end = 0
  while (
    end < before.length - start &&
    end < value.length - start &&
    before[before.length - 1 - end] === value[value.length - 1 - end]
  )
    end++
  if (end && /[\uDC00-\uDFFF]/.test(before[before.length - end])) end--
  return {
    start,
    deleteCount: before.length - start - end,
    insert: value.slice(start, value.length - end),
  }
}
export function documentOffsetAfterEdit(offset, edit) {
  if (offset < edit.start) return offset
  if (offset >= edit.start + edit.deleteCount)
    return offset + edit.insert.length - edit.deleteCount
  return edit.start + edit.insert.length
}

function lineSequence(value, budget) {
  const tokens = [],
    offsets = [0]
  let offset = 0
  while (offset < value.length) {
    if (tokens.length >= budget.maxTokens) throw diffLimit()
    budget.spend()
    const newline = value.indexOf('\n', offset)
    const end = newline < 0 ? value.length : newline + 1
    tokens.push(value.slice(offset, end))
    offsets.push(end)
    offset = end
  }
  budget.check()
  return { tokens, offsets }
}

function characterSequence(value, budget) {
  // Bound allocation before creating one token per Unicode code point. A very
  // long changed line must be split into smaller edits, never coarsely replaced.
  if (value.length > budget.maxTokens * 2) throw diffLimit()
  const tokens = [],
    offsets = [0]
  let offset = 0
  while (offset < value.length) {
    if (tokens.length >= budget.maxTokens) throw diffLimit()
    budget.spend()
    const length = value.codePointAt(offset) > 0xffff ? 2 : 1
    tokens.push(value.slice(offset, offset + length))
    offset += length
    offsets.push(offset)
  }
  budget.check()
  return { tokens, offsets }
}

function sequenceDiff(before, after, budget) {
  const sequence = (tokens) => ({
    length: tokens.length,
    getElement(offset) {
      budget.spend()
      return tokens[offset]
    },
  })
  const result = new MyersDiffAlgorithm().compute(
    sequence(before.tokens),
    sequence(after.tokens),
    budget.timeout,
  )
  if (result.hitTimeout) throw diffLimit()
  budget.check()
  return result.diffs
}

// Compute every hunk before touching Y.Text. Replacing the entire middle range
// would discard CRDT identities for unchanged lines and undo concurrent edits.
export function documentTextEdits(before, value, options = {}) {
  const outer = documentTextEdit(before, value)
  if (!outer) return []
  const budget = computationBudget(options)
  budget.check()
  if (!outer.deleteCount || !outer.insert) return [outer]
  const original = before.slice(outer.start, outer.start + outer.deleteCount)
  const modified = outer.insert
  const oldLines = lineSequence(original, budget)
  const newLines = lineSequence(modified, budget)
  const edits = []
  for (const hunk of sequenceDiff(oldLines, newLines, budget)) {
    const start = oldLines.offsets[hunk.seq1Range.start]
    const end = oldLines.offsets[hunk.seq1Range.endExclusive]
    const nextStart = newLines.offsets[hunk.seq2Range.start]
    const nextEnd = newLines.offsets[hunk.seq2Range.endExclusive]
    const oldText = original.slice(start, end)
    const newText = modified.slice(nextStart, nextEnd)
    if (!oldText || !newText) {
      edits.push({
        start: outer.start + start,
        deleteCount: end - start,
        insert: newText,
      })
      continue
    }
    const oldChars = characterSequence(oldText, budget)
    const newChars = characterSequence(newText, budget)
    for (const change of sequenceDiff(oldChars, newChars, budget)) {
      const from = oldChars.offsets[change.seq1Range.start]
      const to = oldChars.offsets[change.seq1Range.endExclusive]
      edits.push({
        start: outer.start + start + from,
        deleteCount: to - from,
        insert: newText.slice(
          newChars.offsets[change.seq2Range.start],
          newChars.offsets[change.seq2Range.endExclusive],
        ),
      })
    }
  }
  budget.check()
  return edits
}

export function replaceDocumentText(text, value, origin, options) {
  const edits = documentTextEdits(text.toString(), value, options)
  if (!edits.length) return
  text.doc.transact(() => {
    for (let index = edits.length - 1; index >= 0; index--) {
      const edit = edits[index]
      if (edit.deleteCount) text.delete(edit.start, edit.deleteCount)
      if (edit.insert) text.insert(edit.start, edit.insert)
    }
  }, origin)
}
