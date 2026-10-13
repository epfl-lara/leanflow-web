export interface ReasoningBlock {
  id: string
  messageOffset: number
  afterFollowups?: number
  reasoningOffset: number
  reasoningLength: number
  summaryOffset: number
  summaryLength: number
}
export interface OutputOffsets {
  followups?: number
  message: number
  reasoning: number
  reasoningSummary: number
}
export function recordReasoningBlock(
  blocks: ReasoningBlock[],
  field: string,
  length: number,
  offsets: OutputOffsets,
  id: string,
): ReasoningBlock[]
export function retainedReasoningBlocks(
  blocks: ReasoningBlock[],
  offsets: Pick<OutputOffsets, 'reasoning' | 'reasoningSummary'>,
): ReasoningBlock[]
export function reasoningBlocksFromEvents(
  events: Iterable<{
    seq: number
    type: string
    data: Record<string, unknown>
  }>,
): ReasoningBlock[]
