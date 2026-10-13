import { useLayoutEffect, useRef, useState } from 'react'
import { type Run, type ReasoningBlock } from './api'
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
    [error, setError] = useState('')
  const summary = useRef<HTMLElement>(null)
  const restoreFocus = useRef(false)
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
  const reasoning = block
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
  const reasoningSummary = block
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
  return (
    <details
      className="reasoning-trace inline-reasoning"
      data-reasoning-id={block?.id}
      open={open}
      onToggle={(event) => {
        const expanded = event.currentTarget.open
        setOpen(expanded)
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
          {loading && <p className="field-help">Loading reasoning…</p>}
          {error && <p className="error-message">{error}</p>}
          {run.reasoningTruncated &&
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
