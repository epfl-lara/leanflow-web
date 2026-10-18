import type { Run, RunEvent } from './api'
import { openRunEvents } from './runEventTransport'
import {
  recordReasoningBlock,
  retainedReasoningBlocks,
} from '../../../shared/reasoning-timeline.mjs'

function replayEvent(value: unknown): RunEvent | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('seq' in value) ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.seq !== 'number' ||
    !('type' in value) ||
    typeof value.type !== 'string' ||
    !('data' in value) ||
    !value.data ||
    typeof value.data !== 'object' ||
    Array.isArray(value.data)
  )
    return null
  return {
    seq: value.seq,
    type: value.type,
    data: Object.fromEntries(Object.entries(value.data)),
  }
}

// The running server may predate timeline metadata. Replay just the missing
// positions through its existing owned stream, without restarting active work.
export async function hydrateReasoningHistory(
  run: Run,
  previous?: Run | null,
  signal?: AbortSignal,
): Promise<Run> {
  if (run.reasoningBlocks !== undefined || !run.eventCursor) return run
  const prior =
    previous?.id === run.id && previous.reasoningHistoryCursor !== undefined
      ? previous
      : null
  const after = prior?.eventCursor || 0
  if (after >= run.eventCursor)
    return {
      ...run,
      reasoningBlocks: prior?.reasoningBlocks || [],
      reasoningHistoryCursor: after,
    }
  if (
    !run.reasoning &&
    !run.reasoningSummary &&
    !run.reasoningChars &&
    !run.reasoningSummaryChars
  )
    return { ...run, reasoningBlocks: [] }
  const offsets = {
    followups: prior?.followups?.length || 0,
    message: (prior?.messageBaseOffset || 0) + (prior?.message?.length || 0),
    reasoning:
      (prior?.reasoningBaseOffset || 0) +
      (prior?.reasoning?.length || prior?.reasoningChars || 0),
    reasoningSummary:
      (prior?.reasoningSummaryBaseOffset || 0) +
      (prior?.reasoningSummary?.length || prior?.reasoningSummaryChars || 0),
  }
  const followups = new Set((prior?.followups || []).map((entry) => entry.id))
  let blocks = prior?.reasoningBlocks || []
  let replayCursor = after
  await new Promise<void>((resolve, reject) => {
    const stream = openRunEvents(
      `/api/runs/${encodeURIComponent(run.id)}/events?after=${after}`,
    )
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      stream.close()
      if (error) reject(error)
      else resolve()
    }
    const abort = () =>
      finish(new Error('Reasoning history loading was cancelled.'))
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            'Could not load reasoning steps. Try opening the trace again.',
          ),
        ),
      20000,
    )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    stream.addEventListener('error', () =>
      finish(
        new Error(
          'Could not load reasoning steps. Try opening the trace again.',
        ),
      ),
    )
    stream.addEventListener('message', (raw) => {
      try {
        const event = replayEvent(
          JSON.parse((raw as MessageEvent<string>).data),
        )
        if (!event || event.seq <= replayCursor) return
        replayCursor = event.seq
        if (event.seq <= (run.eventCursor || 0)) {
          if (
            event.type === 'followup' &&
            typeof event.data.id === 'string' &&
            !followups.has(event.data.id)
          ) {
            followups.add(event.data.id)
            offsets.followups++
          }
          const field = {
            message: 'message',
            reasoning: 'reasoning',
            'reasoning-summary': 'reasoningSummary',
          }[event.type]
          if (field && typeof event.data.text === 'string') {
            blocks = recordReasoningBlock(
              blocks,
              field,
              event.data.text.length,
              offsets,
              `reasoning-${event.seq}`,
            )
            if (
              field === 'message' ||
              field === 'reasoning' ||
              field === 'reasoningSummary'
            )
              offsets[field] += event.data.text.length
          }
        }
        if (event.seq >= (run.eventCursor || 0)) finish()
      } catch {
        finish(
          new Error(
            'Could not read reasoning steps. Try opening the trace again.',
          ),
        )
      }
    })
  })
  blocks = retainedReasoningBlocks(blocks, {
    reasoning: run.reasoningBaseOffset || 0,
    reasoningSummary: run.reasoningSummaryBaseOffset || 0,
  })
  if (!prior && blocks.length)
    blocks = [{ ...blocks[0], id: 'reasoning-legacy' }, ...blocks.slice(1)]
  return {
    ...run,
    reasoningBlocks: blocks,
    reasoningHistoryCursor: run.eventCursor,
  }
}
