import type { Run, RunFollowup, ReasoningBlock } from './api'

export type ConversationSegment =
  | { kind: 'assistant'; text: string; key: string }
  | { kind: 'followup'; followup: RunFollowup; key: string }
  | { kind: 'reasoning'; block: ReasoningBlock; key: string; active: boolean }

// Older servers expose accumulated text without its event positions.
export function runReasoningBlocks(run: Run): ReasoningBlock[] {
  if (run.reasoningBlocks?.length) return run.reasoningBlocks
  const reasoningLength = run.reasoning?.length || run.reasoningChars || 0
  const summaryLength =
    run.reasoningSummary?.length || run.reasoningSummaryChars || 0
  return reasoningLength || summaryLength
    ? [
        {
          id: 'reasoning-legacy',
          messageOffset: 0,
          reasoningOffset: run.reasoningBaseOffset || 0,
          reasoningLength,
          summaryOffset: run.reasoningSummaryBaseOffset || 0,
          summaryLength,
        },
      ]
    : []
}

/** Place durable user updates at the output offset captured when they were sent. */
export function conversationSegments(run: Run): ConversationSegment[] {
  const text = run.message || '',
    result: ConversationSegment[] = []
  const blocks = runReasoningBlocks(run)
  const insertions = [
    ...blocks.map((block) => ({
      kind: 'reasoning' as const,
      block,
      messageOffset: block.messageOffset,
      order: block.afterFollowups || 0,
    })),
    ...[...(run.followups || [])]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((followup, index) => ({
        kind: 'followup' as const,
        followup,
        messageOffset: followup.messageOffset,
        order: index + 0.5,
      })),
  ].sort((a, b) => a.messageOffset - b.messageOffset || a.order - b.order)
  const appendAssistant = (start: number, end: number) => {
    const body = text.slice(start, end).replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, '')
    if (body.trim())
      result.push({ kind: 'assistant', text: body, key: `message-${start}` })
  }
  let offset = 0
  for (const entry of insertions) {
    const position = Math.max(
      offset,
      Math.min(
        text.length,
        Number.isFinite(entry.messageOffset)
          ? entry.messageOffset - (run.messageBaseOffset || 0)
          : text.length,
      ),
    )
    if (position > offset) appendAssistant(offset, position)
    if (entry.kind === 'reasoning')
      result.push({
        kind: 'reasoning',
        block: entry.block,
        key: entry.block.id,
        active:
          entry.block.id === blocks.at(-1)?.id &&
          entry.messageOffset >= (run.messageBaseOffset || 0) + text.length,
      })
    else
      result.push({
        kind: 'followup',
        followup: entry.followup,
        key: `followup-${entry.followup.id}`,
      })
    offset = position
  }
  if (offset < text.length) appendAssistant(offset, text.length)
  return result
}

export function runStatusLabel(run: Run) {
  if (run.status === 'completed') {
    const verification = run.verification as
      | { complete?: boolean; kind?: string }
      | undefined
    if (verification?.complete === false)
      return 'Finished · checks need attention'
    if (['chat', 'search'].includes(verification?.kind || '')) return 'Finished'
    if (verification?.kind === 'workspace') return 'Ready to review'
    if (run.mode === 'search' && verification?.complete === undefined)
      return 'Finished'
    return verification?.complete ? 'Verified' : 'Finished · review checks'
  }
  return (
    (
      {
        queued: 'Queued',
        starting: 'Preparing',
        preparing: 'Preparing',
        running: 'Working',
        verifying: 'Checking with Lean',
        stopping: 'Stopping…',
        cancelled: 'Stopped',
        failed: 'Failed',
        interrupted: 'Interrupted',
        applied: 'Applied',
      } as Record<string, string>
    )[run.status] || run.status
  )
}

export function finalVerificationIssue(run: Run): string {
  const value = run.verification
  if (
    !value ||
    typeof value !== 'object' ||
    !('complete' in value) ||
    value.complete !== false
  )
    return ''
  if ('kind' in value && value.kind === 'search') return ''
  const errors =
    'errors' in value && Array.isArray(value.errors) ? value.errors : []
  return (
    errors.find(
      (error): error is string => typeof error === 'string' && !!error.trim(),
    ) || 'Open Details to review the final checks.'
  )
}

/** Full snapshots supersede counts supplied by compact history rows. */
export function runChangeCount(run: Run, live = false): number {
  const changes = live ? run.liveChanges : run.changes
  return Array.isArray(changes)
    ? changes.length
    : ((live ? run.liveChangeCount : run.changeCount) ??
        runChangePaths(run, live).length)
}

export function runChangePaths(run: Run, live = false): string[] {
  const paths = live ? run.liveChangePaths : run.changePaths
  if (Array.isArray(paths)) return paths
  return (
    (live ? run.liveChanges : run.changes)?.map((change) => change.path) || []
  )
}

export function liveEditStatus(run: Run): string {
  if (run.mode === 'search')
    return 'Review first · Requested edits need your approval'
  if (run.liveEdits === false)
    return 'Review first · Files update after you accept changes'
  if (!run.liveEdits) return ''
  if (run.liveEditConflict) return 'Live edits paused · Saved files changed'
  if (run.liveUndone) return 'Live edits undone'
  if (!run.liveRevision) return 'Live edits on · No saved edits yet'
  if (
    !Array.isArray(run.liveChanges) &&
    !Array.isArray(run.liveChangePaths) &&
    run.liveChangeCount === undefined
  )
    return 'Live edits on · Edits saved'
  const count = runChangeCount(run, true)
  return count
    ? `Live edits on · ${count} ${count === 1 ? 'file' : 'files'} updated`
    : 'Live edits on · No current file changes'
}
