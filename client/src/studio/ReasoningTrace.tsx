import { useState } from 'react'
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
      <summary>
        Reasoning trace{' '}
        {active && (
          <span className="reasoning-live">
            <span className="spinner" />
            Live
          </span>
        )}
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
        </>
      )}
    </details>
  )
}
