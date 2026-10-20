import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, type Run, type ReasoningBlock, type ReasoningPage } from './api'
import { OutputText } from './AssistantText'

export function ReasoningTrace({
  run,
  onInspect,
  block,
  streaming = true,
}: {
  run: Run
  onInspect: (id: string) => Promise<void>
  block?: ReasoningBlock
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState<ReasoningPage | null>(null)
  const summary = useRef<HTMLElement>(null)
  const restoreFocus = useRef(false)
  const historyRequest = useRef<AbortController | null>(null)
  useEffect(() => () => historyRequest.current?.abort(), [])
  useLayoutEffect(() => {
    if (open || !restoreFocus.current) return
    restoreFocus.current = false
    const toggle = summary.current
    if (!toggle) return
    toggle.focus({ preventScroll: true })
    const viewport = toggle.closest('.assistant-conversation')
    if (!viewport) return
    const bounds = viewport.getBoundingClientRect()
    const position = toggle.getBoundingClientRect()
    if (position.top < bounds.top)
      viewport.scrollTop += position.top - bounds.top
    else if (position.bottom > bounds.bottom)
      viewport.scrollTop += position.bottom - bounds.bottom
  }, [open])
  if (
    !(
      block ||
      run.reasoning ||
      run.reasoningSummary ||
      run.reasoningChars ||
      run.reasoningSummaryChars
    )
  )
    return null
  const active = streaming && run.status === 'running'
  const retainedReasoning = block
    ? (run.reasoning || '').slice(
        Math.max(0, block.reasoningOffset - (run.reasoningBaseOffset || 0)),
        Math.max(
          0,
          block.reasoningOffset +
            block.reasoningLength -
            (run.reasoningBaseOffset || 0),
        ),
      )
    : run.reasoning
  const retainedSummary = block
    ? (run.reasoningSummary || '').slice(
        Math.max(
          0,
          block.summaryOffset - (run.reasoningSummaryBaseOffset || 0),
        ),
        Math.max(
          0,
          block.summaryOffset +
            block.summaryLength -
            (run.reasoningSummaryBaseOffset || 0),
        ),
      )
    : run.reasoningSummary
  // A saved prefix can meet the live retained tail without duplicating deltas.
  // Keep a gap collapsed until the user requests the next history page.
  const withLiveTail = (
    field: 'reasoning' | 'reasoningSummary',
    blockOffset: number,
    baseOffset: number,
    retained: string | undefined,
  ) => {
    if (!saved) return retained
    const prefix = saved[field]
    const tailOffset = baseOffset - blockOffset
    return (
      prefix +
      (tailOffset <= prefix.length
        ? (retained || '').slice(
            Math.max(0, prefix.length - Math.max(0, tailOffset)),
          )
        : '')
    )
  }
  const reasoning = withLiveTail(
    'reasoning',
    block?.reasoningOffset || 0,
    run.reasoningBaseOffset || 0,
    retainedReasoning,
  )
  const reasoningSummary = withLiveTail(
    'reasoningSummary',
    block?.summaryOffset || 0,
    run.reasoningSummaryBaseOffset || 0,
    retainedSummary,
  )
  const nextOffset =
    saved?.nextOffset ??
    (saved &&
    block &&
    (block.reasoningLength > (reasoning?.length || 0) ||
      block.summaryLength > (reasoningSummary?.length || 0))
      ? 0
      : null)
  async function loadPage(offset = 0) {
    if (!block || historyRequest.current) return
    const controller = new AbortController()
    historyRequest.current = controller
    setLoading(true)
    setError('')
    try {
      const page = await api<ReasoningPage>(
        `/api/runs/${encodeURIComponent(run.id)}/reasoning/${encodeURIComponent(block.id)}?offset=${offset}`,
        { signal: controller.signal },
      )
      if (controller.signal.aborted) return
      setSaved((previous) => ({
        reasoning: (offset ? previous?.reasoning || '' : '') + page.reasoning,
        reasoningSummary:
          (offset ? previous?.reasoningSummary || '' : '') +
          page.reasoningSummary,
        nextOffset: page.nextOffset,
      }))
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (historyRequest.current === controller) {
        historyRequest.current = null
        if (!controller.signal.aborted) setLoading(false)
      }
    }
  }
  return (
    <details
      className="reasoning-trace inline-reasoning"
      data-reasoning-id={block?.id}
      open={open}
      onToggle={(event) => {
        const expanded = event.currentTarget.open
        setOpen(expanded)
        if (!expanded) {
          historyRequest.current?.abort()
          historyRequest.current = null
          setLoading(false)
          return
        }
        if (expanded && block && run.reasoningHistoryAvailable) {
          if (!saved && !loading) void loadPage()
          return
        }
        if (
          expanded &&
          ((!run.reasoning && !run.reasoningSummary) ||
            (block?.id === 'reasoning-legacy' &&
              run.reasoningHistoryCursor === undefined))
        ) {
          setLoading(true)
          setError('')
          void onInspect(run.id)
            .catch((error) =>
              setError(error instanceof Error ? error.message : String(error)),
            )
            .finally(() => setLoading(false))
        }
      }}
    >
      <summary
        ref={summary}
        onClick={() => {
          if (open) restoreFocus.current = true
        }}
      >
        Reasoning{' '}
        {active && (
          <span className="reasoning-live">
            <span className="spinner" />
            In progress
          </span>
        )}
        <span className="reasoning-toggle-label">{open ? 'Hide' : 'Show'}</span>
      </summary>
      {open && (
        <>
          <section
            className="reasoning-body"
            aria-label="Reasoning trace"
            tabIndex={0}
          >
            {loading && <p className="field-help">Loading reasoning…</p>}
            {error && <p className="error-message">{error}</p>}
            {!run.reasoningHistoryAvailable &&
              run.reasoningTruncated &&
              (!block ||
                block.reasoningOffset < (run.reasoningBaseOffset || 0)) && (
                <p className="field-help">
                  Earlier reasoning output was trimmed.
                </p>
              )}
            {reasoningSummary && (
              <div className="markdown-body reasoning-summary">
                <OutputText text={reasoningSummary} streaming={active} />
              </div>
            )}
            {reasoning && (
              <div className="markdown-body reasoning-content">
                <OutputText text={reasoning} streaming={active} />
              </div>
            )}
            {nextOffset != null && (
              <button
                type="button"
                className="turn-action"
                disabled={loading}
                onClick={() => void loadPage(nextOffset)}
              >
                Load more reasoning
              </button>
            )}
          </section>
          <button
            type="button"
            className="turn-action reasoning-collapse"
            onClick={() => {
              restoreFocus.current = true
              setOpen(false)
            }}
          >
            Hide reasoning trace
          </button>
        </>
      )}
    </details>
  )
}
