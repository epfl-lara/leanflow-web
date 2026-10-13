import { useLayoutEffect, useRef, useState } from 'react'
import { runIsActive, type Run } from './api'
import { OutputText } from './AssistantText'

export function ReasoningTrace({
  run,
  onInspect,
}: {
  run: Run
  onInspect: (id: string) => Promise<void>
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
      run.reasoning ||
      run.reasoningSummary ||
      run.reasoningChars ||
      run.reasoningSummaryChars
    )
  )
    return null
  const active = runIsActive(run)
  return (
    <details
      className="reasoning-trace inline-reasoning"
      open={open}
      onToggle={(event) => {
        const expanded = event.currentTarget.open
        setOpen(expanded)
        if (expanded && !run.reasoning && !run.reasoningSummary) {
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
        Reasoning trace{' '}
        {active && (
          <span className="reasoning-live">
            <span className="spinner" />
            Live
          </span>
        )}
        <span className="reasoning-toggle-label">{open ? 'Hide' : 'Show'}</span>
      </summary>
      {open && (
        <>
          <p className="field-help">
            Reasoning exposed for this turn by the selected model.
          </p>
          {loading && <p className="field-help">Loading reasoning…</p>}
          {error && <p className="error-message">{error}</p>}
          {run.reasoningTruncated && (
            <p className="field-help">Earlier reasoning output was trimmed.</p>
          )}
          {run.reasoningSummary && (
            <div className="markdown-body reasoning-summary">
              <OutputText text={run.reasoningSummary} streaming={active} />
            </div>
          )}
          {run.reasoning && (
            <div className="markdown-body reasoning-content">
              <OutputText text={run.reasoning} streaming={active} />
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
