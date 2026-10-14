import { runIsActive, type Run, type RunEvent } from './api'
import { runReasoningBlocks, runChangePaths } from './chatTimeline'
import {
  recordReasoningBlock,
  retainedReasoningBlocks,
} from '../../../shared/reasoning-timeline.mjs'

const OUTPUT_LIMIT = 250_000
const cursor = (run: Run) => Number(run.eventCursor) || 0

function mergeVerification(previous: unknown, value: unknown): unknown {
  if (value === undefined) return previous
  if (
    previous &&
    value &&
    typeof previous === 'object' &&
    typeof value === 'object' &&
    !Array.isArray(previous) &&
    !Array.isArray(value)
  )
    return { ...previous, ...value }
  return value
}

// A delayed poll must never replace newer streamed output or revive a finished
// run after the stream and polling have already been stopped.
export function mergeRunSnapshot(previous: Run | null, value: Run): Run {
  if (!previous || previous.id !== value.id) return value
  if (cursor(value) < cursor(previous)) return previous
  if (!runIsActive(previous) && runIsActive(value)) return previous
  const next = {
    ...previous,
    ...value,
    verification: mergeVerification(previous.verification, value.verification),
  }
  const revisionChanged =
    (value.liveRevision !== undefined &&
      value.liveRevision !== previous.liveRevision) ||
    (value.liveUndone !== undefined && value.liveUndone !== previous.liveUndone)
  for (const [field, pathsField] of [
    ['changes', 'changePaths'],
    ['liveChanges', 'liveChangePaths'],
  ] as const) {
    const changes = value[field]
    if (Array.isArray(changes))
      next[pathsField] = changes.map((change) => change.path)
    else if (
      revisionChanged ||
      (value[pathsField] !== undefined &&
        JSON.stringify(value[pathsField]) !==
          JSON.stringify(runChangePaths(previous, field === 'liveChanges')))
    )
      delete next[field]
  }
  return next
}

export function appendRunEvents(previous: Run, events: RunEvent[]): Run {
  let next = previous
  for (const event of events) {
    if (event.seq <= cursor(next)) continue
    if (next === previous) next = { ...previous }
    next.eventCursor = event.seq
    const data = event.data
    const text = typeof data?.text === 'string' ? data.text : ''
    const field = {
      message: 'message',
      reasoning: 'reasoning',
      'reasoning-summary': 'reasoningSummary',
      activity: 'log',
    }[event.type]
    if (field) {
      const blocks = recordReasoningBlock(
        runReasoningBlocks(next),
        field,
        text.length,
        {
          message: (next.messageBaseOffset || 0) + (next.message?.length || 0),
          followups: next.followups?.length || 0,
          reasoning:
            (next.reasoningBaseOffset || 0) +
            (next.reasoning?.length || next.reasoningChars || 0),
          reasoningSummary:
            (next.reasoningSummaryBaseOffset || 0) +
            (next.reasoningSummary?.length || next.reasoningSummaryChars || 0),
        },
        `reasoning-${event.seq}`,
      )
      const combined = String(next[field] || '') + text
      next[field] = combined.slice(-OUTPUT_LIMIT)
      if (field === 'reasoning' || field === 'reasoningSummary') {
        const baseField =
          field === 'reasoning'
            ? 'reasoningBaseOffset'
            : 'reasoningSummaryBaseOffset'
        next[baseField] =
          Number.isSafeInteger(data.baseOffset) && Number(data.baseOffset) >= 0
            ? Number(data.baseOffset)
            : (next[baseField] || 0) +
              Math.max(0, combined.length - OUTPUT_LIMIT)
      }
      next.reasoningBlocks = retainedReasoningBlocks(blocks, {
        reasoning: next.reasoningBaseOffset || 0,
        reasoningSummary: next.reasoningSummaryBaseOffset || 0,
      })
      if (field === 'message') {
        next.messageBaseOffset =
          Number.isSafeInteger(data.baseOffset) && Number(data.baseOffset) >= 0
            ? Number(data.baseOffset)
            : (next.messageBaseOffset || 0) +
              Math.max(0, combined.length - OUTPUT_LIMIT)
        next.messageTruncated =
          data.truncated === true ||
          next.messageTruncated === true ||
          next.messageBaseOffset > 0
      }
      if (field === 'reasoning')
        next.reasoningTruncated =
          data.truncated === true ||
          next.reasoningTruncated === true ||
          combined.length > OUTPUT_LIMIT
    }
    if (event.type === 'status' && typeof data?.status === 'string') {
      const updated = { ...next, status: data.status }
      if (runIsActive(next) || !runIsActive(updated)) next.status = data.status
    }
    if (event.type === 'error' && typeof data?.message === 'string')
      next.error = data.message
    if (event.type === 'verification')
      next.verification = mergeVerification(next.verification, data)
    if (event.type === 'optimization') next.optimization = data
    if (event.type === 'progress' && typeof data?.label === 'string')
      next.progress = data as Run['progress']
    if (event.type === 'followup' && typeof data?.id === 'string') {
      const entry = data as unknown as NonNullable<Run['followups']>[number]
      next.followups = [
        ...(next.followups || []).filter((item) => item.id !== entry.id),
        entry,
      ].sort(
        (a, b) =>
          a.messageOffset - b.messageOffset ||
          a.createdAt.localeCompare(b.createdAt),
      )
    }
    if (event.type === 'changes' && Array.isArray(data?.changes)) {
      next.changes = data.changes as Run['changes']
      next.changePaths = next.changes?.map((change) => change.path)
    }
    if (event.type === 'files-updated') {
      // Saved edits have advanced before their metadata refresh arrives. The
      // previous proof preview must not be shown as the current saved source.
      delete next.liveChanges
      delete next.changes
    }
    if (event.type === 'usage') next.usage = data
  }
  return next
}
