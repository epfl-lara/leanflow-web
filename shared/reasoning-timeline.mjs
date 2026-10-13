const MAX_BLOCKS = 1024
const fields = new Set(['reasoning', 'reasoningSummary'])

// Store positions, not another copy of potentially large reasoning bodies.
export function recordReasoningBlock(blocks, field, length, offsets, id) {
  if (!fields.has(field) || !length) return blocks
  const previous = blocks.at(-1)
  const block =
    previous?.messageOffset === offsets.message &&
    (previous.afterFollowups || 0) === (offsets.followups || 0)
      ? { ...previous }
      : {
          id,
          messageOffset: offsets.message,
          afterFollowups: offsets.followups || 0,
          reasoningOffset: offsets.reasoning,
          reasoningLength: 0,
          summaryOffset: offsets.reasoningSummary,
          summaryLength: 0,
        }
  block[field === 'reasoning' ? 'reasoningLength' : 'summaryLength'] += length
  return [
    ...(block.id === previous?.id ? blocks.slice(0, -1) : blocks),
    block,
  ].slice(-MAX_BLOCKS)
}

export function retainedReasoningBlocks(blocks, offsets) {
  return blocks.filter(
    (block) =>
      (block.reasoningLength > 0 &&
        block.reasoningOffset + block.reasoningLength > offsets.reasoning) ||
      (block.summaryLength > 0 &&
        block.summaryOffset + block.summaryLength > offsets.reasoningSummary),
  )
}

export function reasoningBlocksFromEvents(events) {
  const offsets = {
    message: 0,
    reasoning: 0,
    reasoningSummary: 0,
    followups: 0,
  }
  const followups = new Set()
  let blocks = []
  for (const event of events) {
    if (
      event.type === 'followup' &&
      typeof event.data?.id === 'string' &&
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
    if (!field || typeof event.data?.text !== 'string') continue
    blocks = recordReasoningBlock(
      blocks,
      field,
      event.data.text.length,
      offsets,
      `reasoning-${event.seq}`,
    )
    offsets[field] += event.data.text.length
  }
  return blocks
}
