import type { Run, RunFollowup } from './api'

export type ConversationSegment =
  | { kind: 'assistant'; text: string; key: string }
  | { kind: 'followup'; followup: RunFollowup; key: string }

/** Place durable user updates at the output offset captured when they were sent. */
export function conversationSegments(run: Run): ConversationSegment[] {
  const text = run.message || '',
    result: ConversationSegment[] = []
  const followups = [...(run.followups || [])].sort(
    (a, b) =>
      a.messageOffset - b.messageOffset ||
      a.createdAt.localeCompare(b.createdAt),
  )
  let offset = 0
  for (const entry of followups) {
    const position = Math.max(
      offset,
      Math.min(
        text.length,
        Number.isFinite(entry.messageOffset)
          ? entry.messageOffset - (run.messageBaseOffset || 0)
          : text.length,
      ),
    )
    if (position > offset)
      result.push({
        kind: 'assistant',
        text: text.slice(offset, position),
        key: `message-${offset}`,
      })
    result.push({
      kind: 'followup',
      followup: entry,
      key: `followup-${entry.id}`,
    })
    offset = position
  }
  if (offset < text.length)
    result.push({
      kind: 'assistant',
      text: text.slice(offset),
      key: `message-${offset}`,
    })
  return result
}

export function runStatusLabel(run: Run) {
  if (run.status === 'completed') {
    const verification = run.verification as
      | { complete?: boolean; kind?: string }
      | undefined
    return verification?.kind === 'search' || run.mode === 'search'
      ? 'Search finished'
      : verification?.complete
        ? 'Verified'
        : 'Finished · review checks'
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

/** Full snapshots supersede counts supplied by compact history rows. */
export function runChangeCount(run: Run, live = false): number {
  const changes = live ? run.liveChanges : run.changes
  return Array.isArray(changes)
    ? changes.length
    : (live ? run.liveChangeCount : run.changeCount) || 0
}
