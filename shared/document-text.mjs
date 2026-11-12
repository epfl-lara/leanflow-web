import { MyersDiffAlgorithm } from 'vscode/vscode/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm'
import {
  DateTimeout,
  SequenceDiff,
} from 'vscode/vscode/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm'
import { DefaultLinesDiffComputer } from 'vscode/vscode/vs/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer'
import { OffsetRange } from 'vscode/vscode/vs/editor/common/core/offsetRange'

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

function refinedLineEdits(before, after, budget) {
  // Monaco allocates UTF-16 character sequences before refining a line hunk.
  // Admit their size first, and count its algorithm's element reads against
  // the same operation/time budget as the outer line alignment.
  if (before.length > budget.maxTokens || after.length > budget.maxTokens)
    throw diffLimit()
  budget.spend(before.length + after.length)
  const computer = new DefaultLinesDiffComputer()
  for (const key of ['dynamicProgrammingDiffing', 'myersDiffingAlgorithm']) {
    const algorithm = computer[key]
    const sequence = (value) => ({
      length: value.length,
      getElement(offset) {
        budget.spend()
        return value.getElement(offset)
      },
    })
    computer[key] = {
      compute(original, modified, timeout, ...rest) {
        return algorithm.compute(
          sequence(original),
          sequence(modified),
          budget.timeout,
          ...rest,
        )
      },
    }
  }
  const lines = (value) => {
    const values = value.split('\n')
    const offsets = [0]
    for (const line of values) offsets.push(offsets.at(-1) + line.length + 1)
    return { values, offsets }
  }
  const original = lines(before),
    modified = lines(after)
  const result = computer.refineDiff(
    original.values,
    modified.values,
    new SequenceDiff(
      new OffsetRange(0, original.values.length),
      new OffsetRange(0, modified.values.length),
    ),
    budget.timeout,
    true,
  )
  if (result.hitTimeout) throw diffLimit()
  budget.check()
  const offset = (source, line, column) => source.offsets[line - 1] + column - 1
  const insidePair = (value, at) =>
    at > 0 &&
    at < value.length &&
    /[\uD800-\uDBFF]/.test(value[at - 1]) &&
    /[\uDC00-\uDFFF]/.test(value[at])
  const ranges = []
  for (const mapping of result.mappings) {
    budget.spend()
    const a = mapping.originalRange,
      b = mapping.modifiedRange
    const range = {
      from: offset(original, a.startLineNumber, a.startColumn),
      to: offset(original, a.endLineNumber, a.endColumn),
      nextFrom: offset(modified, b.startLineNumber, b.startColumn),
      nextTo: offset(modified, b.endLineNumber, b.endColumn),
    }
    // Monaco ranges use UTF-16 columns. Include a whole pair when its boundary
    // falls between surrogate halves, merging any ranges that now overlap.
    if (insidePair(before, range.from)) range.from--
    if (insidePair(before, range.to)) range.to++
    if (insidePair(after, range.nextFrom)) range.nextFrom--
    if (insidePair(after, range.nextTo)) range.nextTo++
    const previous = ranges.at(-1)
    if (
      previous &&
      (range.from <= previous.to || range.nextFrom <= previous.nextTo)
    ) {
      previous.to = Math.max(previous.to, range.to)
      previous.nextTo = Math.max(previous.nextTo, range.nextTo)
    } else ranges.push(range)
  }
  return ranges.map((range) => ({
    start: range.from,
    deleteCount: range.to - range.from,
    insert: after.slice(range.nextFrom, range.nextTo),
  }))
}

// Compute every hunk before touching Y.Text. Replacing the entire middle range
// would discard CRDT identities for unchanged lines and undo concurrent edits.
export function documentTextEdits(before, value, options = {}) {
  const outer = documentTextEdit(before, value)
  if (!outer) return []
  const budget = computationBudget(options)
  budget.check()
  // Character trimming can assign an existing comment prefix to a newly
  // inserted line. Anchor complete lines first so private Undo keeps the
  // original characters with their original line.
  const start =
    outer.start === 0 ? 0 : before.lastIndexOf('\n', outer.start - 1) + 1
  let originalEnd = outer.start + outer.deleteCount
  let modifiedEnd = outer.start + outer.insert.length
  const atLineStart = (text, offset) =>
    offset === 0 || text[offset - 1] === '\n'
  if (!atLineStart(before, originalEnd) || !atLineStart(value, modifiedEnd)) {
    const newline = before.indexOf('\n', originalEnd)
    const extension = (newline < 0 ? before.length : newline + 1) - originalEnd
    originalEnd += extension
    modifiedEnd += extension
  }
  const original = before.slice(start, originalEnd)
  const modified = value.slice(start, modifiedEnd)
  const oldLines = lineSequence(original, budget)
  const newLines = lineSequence(modified, budget)
  const edits = []
  for (const hunk of sequenceDiff(oldLines, newLines, budget)) {
    const fromLine = oldLines.offsets[hunk.seq1Range.start]
    const end = oldLines.offsets[hunk.seq1Range.endExclusive]
    const nextStart = newLines.offsets[hunk.seq2Range.start]
    const nextEnd = newLines.offsets[hunk.seq2Range.endExclusive]
    const oldText = original.slice(fromLine, end)
    const newText = modified.slice(nextStart, nextEnd)
    const offset = start + fromLine
    if (!oldText || !newText) {
      edits.push({
        start: offset,
        deleteCount: oldText.length,
        insert: newText,
      })
      continue
    }
    if (
      hunk.seq1Range.endExclusive - hunk.seq1Range.start > 1 ||
      hunk.seq2Range.endExclusive - hunk.seq2Range.start > 1 ||
      (oldText.length <= budget.maxTokens && newText.length <= budget.maxTokens)
    ) {
      for (const edit of refinedLineEdits(oldText, newText, budget))
        edits.push({ ...edit, start: offset + edit.start })
      continue
    }
    // A very long line cannot enter Monaco's character allocator. When the
    // whole original line is retained, native substring matching preserves
    // its identities without tokenizing it or reassigning a repeated prefix.
    const added = newText.length > oldText.length
    const retained = added ? newText.indexOf(oldText) : oldText.indexOf(newText)
    if (retained >= 0) {
      const prefix = added ? newText.slice(0, retained) : ''
      const retainedLength = added ? oldText.length : newText.length
      const suffixStart = retained + retainedLength
      if (retained)
        edits.push({
          start: offset,
          deleteCount: added ? 0 : retained,
          insert: prefix,
        })
      const suffix = added ? newText.slice(suffixStart) : ''
      const deletedSuffix = added ? 0 : oldText.length - suffixStart
      if (suffix || deletedSuffix)
        edits.push({
          start: offset + (added ? oldText.length : suffixStart),
          deleteCount: deletedSuffix,
          insert: suffix,
        })
      continue
    }
    // Trim inside a changed line hunk, after unchanged lines are anchored.
    // Tiny edits in very long lines must not allocate one token per character.
    const entireRange =
      fromLine === 0 &&
      end === original.length &&
      nextStart === 0 &&
      nextEnd === modified.length
    const inner = entireRange
      ? { ...outer, start: outer.start - start }
      : documentTextEdit(oldText, newText)
    if (!inner) continue
    // Oversized lines only admit scalar typing through this fast path.
    // A larger replacement needs Monaco's context-sensitive alignment; refuse
    // it before mutation when that context exceeds the allocation budget.
    if (inner.deleteCount > 2 || inner.insert.length > 2) throw diffLimit()
    if (!inner.deleteCount || !inner.insert) {
      edits.push({ ...inner, start: offset + inner.start })
      continue
    }
    const oldChars = characterSequence(
      oldText.slice(inner.start, inner.start + inner.deleteCount),
      budget,
    )
    const newChars = characterSequence(inner.insert, budget)
    for (const change of sequenceDiff(oldChars, newChars, budget)) {
      const from = oldChars.offsets[change.seq1Range.start]
      const to = oldChars.offsets[change.seq1Range.endExclusive]
      edits.push({
        start: offset + inner.start + from,
        deleteCount: to - from,
        insert: inner.insert.slice(
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
