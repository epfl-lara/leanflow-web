import { memo, useState } from 'react'
import type { RunProofTarget, ToolStep } from './api'
import { Icon } from './Icons'
import { CodeBlock } from './CodeBlock'

const icons = {
  read: 'file',
  search: 'search',
  check: 'fileCheck',
  edit: 'edit',
  command: 'terminal',
  tool: 'settings',
} as const
function duration(milliseconds?: number) {
  if (milliseconds === undefined) return ''
  const seconds = Math.round(milliseconds / 1000)
  return milliseconds < 1000
    ? '<1s'
    : seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const resultIcons = {
  success: 'check',
  warning: 'warning',
  failed: 'close',
  neutral: 'minusCircle',
} as const

function stepResult(
  step: ToolStep,
  active: boolean,
): {
  state: keyof typeof resultIcons | 'running'
  label: string
} {
  if (step.status === 'running') {
    return active
      ? { state: 'running', label: 'Running' }
      : { state: 'neutral', label: 'No result recorded' }
  }
  if (step.status === 'failed')
    return { state: 'failed', label: 'Attempt failed' }
  if (step.status === 'declined') return { state: 'neutral', label: 'Declined' }
  if (step.checkResult === 'issues')
    return { state: 'warning', label: 'Check found issues' }
  if (step.checkResult === 'passed')
    return { state: 'success', label: 'Check passed' }
  if (step.status === 'completed') return { state: 'success', label: 'Done' }
  return { state: 'neutral', label: 'Finished' }
}

const ActivityStep = memo(function ActivityStep({
  step,
  active,
  onInspect,
  onOpenTarget,
}: {
  step: ToolStep
  active: boolean
  onInspect: () => Promise<void>
  onOpenTarget?: (target: RunProofTarget) => void
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { state, label } = stepResult(step, active)
  const running = state === 'running'
  const inspect = () => {
    setError('')
    setLoading(true)
    void onInspect()
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not load this step.',
        ),
      )
      .finally(() => setLoading(false))
  }
  return (
    <details
      className={running ? 'tool-step is-running' : 'tool-step'}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        if (
          event.currentTarget.open &&
          !step.input &&
          !step.output &&
          !step.detailsOmitted
        )
          inspect()
      }}
    >
      <summary>
        <span className="tool-step-icon">
          <Icon name={icons[step.kind]} size={15} />
        </span>
        <span className="tool-step-text">
          <strong>{step.label}</strong>
          {step.detail && (
            <span>{step.detail.replace(/^\/workspace\//, '')}</span>
          )}
        </span>
        <span className="tool-step-meta">
          <span className="tool-step-mark" data-state={state}>
            {state === 'running' ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <Icon name={resultIcons[state]} size={13} />
            )}
            <span>{label}</span>
          </span>
          {step.durationMs !== undefined && (
            <small>{duration(step.durationMs)}</small>
          )}
        </span>
        <Icon name="chevron" size={12} />
      </summary>
      {open && (
        <div className="tool-step-body">
          {step.status === 'failed' && (
            <p className="field-help">
              This tool attempt failed. Lemex can try another approach; no
              approval is requested.
            </p>
          )}
          {step.tool && <p className="tool-identity">{step.tool}</p>}
          {step.checkResult && (
            <p className="field-help">
              This is an intermediate tool check. Final server verification
              appears below the reply.
            </p>
          )}
          {loading && <p className="field-help">Loading step…</p>}
          {error && (
            <p className="error-message">
              {error}{' '}
              <button type="button" className="turn-action" onClick={inspect}>
                Retry
              </button>
            </p>
          )}
          {step.path && onOpenTarget && (
            <button
              type="button"
              className="turn-action"
              onClick={() =>
                onOpenTarget({
                  path: step.path!,
                  startLine: step.line || 1,
                  endLine: step.line || 1,
                })
              }
            >
              <Icon name="file" size={13} />
              Open {step.path}
            </button>
          )}
          {step.input && (
            <>
              <h4>{step.inputLabel || 'Input'}</h4>
              <CodeBlock
                text={step.input}
                language={step.inputLanguage || 'text'}
              />
            </>
          )}
          {step.output && (
            <>
              <h4>Result</h4>
              <CodeBlock text={step.output} language="text" />
            </>
          )}
          {step.exitCode !== undefined && (
            <p className="field-help">Exit code {step.exitCode}</p>
          )}
          {step.detailsOmitted && (
            <p className="field-help">
              This older step keeps its summary; its output preview is no longer
              retained.
            </p>
          )}
          {!loading && !error && !step.output && !step.detailsOmitted && (
            <p className="field-help">
              {running
                ? 'Waiting for the tool result…'
                : step.kind === 'edit' && step.status === 'completed'
                  ? 'The edit was made in Lemex’s working copy. Saved project files and reviewable changes are listed below.'
                  : 'No text output was recorded for this step.'}
            </p>
          )}
        </div>
      )}
    </details>
  )
})

export function ToolActivity({
  steps,
  active,
  onInspect,
  onOpenTarget,
}: {
  steps: ToolStep[]
  active: boolean
  onInspect: () => Promise<void>
  onOpenTarget?: (target: RunProofTarget) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const latestIssue = steps.findLast(
    (step) =>
      step.status === 'failed' ||
      step.status === 'declined' ||
      step.checkResult === 'issues',
  )
  const visible = showAll
    ? steps
    : steps.filter(
        (step, index) =>
          index >= steps.length - 3 ||
          (active && step.status === 'running') ||
          step.id === latestIssue?.id,
      )
  const hidden = steps.length - visible.length
  return (
    <section className="tool-activity" aria-label="Tool activity">
      <div className="tool-activity-heading">
        <Icon name="log" size={13} />
        <span>Work steps</span>
        <span>{steps.length}</span>
        {(hidden > 0 || showAll) && (
          <button
            type="button"
            className="turn-action"
            aria-expanded={showAll}
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll ? 'Show recent' : `Show ${hidden} earlier`}
          </button>
        )}
      </div>
      {visible.map((step) => (
        <ActivityStep
          key={step.id}
          step={step}
          active={active}
          onInspect={onInspect}
          onOpenTarget={onOpenTarget}
        />
      ))}
    </section>
  )
}
