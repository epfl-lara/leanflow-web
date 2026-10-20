import { memo, useState } from 'react'
import type { RunProofTarget, ToolStep } from './api'
import { Icon } from './Icons'
import { CodeBlock } from './CodeBlock'

const icons = {
  read: 'file',
  search: 'search',
  check: 'check',
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
  const running = active && step.status === 'running'
  const status = running
    ? 'Running'
    : step.status === 'running'
      ? 'No result recorded'
      : step.status === 'failed'
        ? 'Needs attention'
        : step.status === 'declined'
          ? 'Declined'
          : step.checkResult === 'issues'
            ? 'Check found issues'
            : step.checkResult === 'passed'
              ? 'Check passed'
              : step.status === 'completed'
                ? 'Done'
                : 'Finished'
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
      className={`tool-step ${running ? 'is-running' : ''} ${step.status === 'failed' || step.checkResult === 'issues' ? 'has-error' : ''}`}
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
          {running ? (
            <span className="spinner" />
          ) : (
            <Icon name={icons[step.kind]} size={15} />
          )}
        </span>
        <span className="tool-step-text">
          <strong>{step.label}</strong>
          {step.detail && (
            <span>{step.detail.replace(/^\/workspace\//, '')}</span>
          )}
        </span>
        <span className="tool-step-meta">
          <span>{status}</span>
          {step.durationMs !== undefined && (
            <small>{duration(step.durationMs)}</small>
          )}
        </span>
        <Icon name="chevron" size={12} />
      </summary>
      {open && (
        <div className="tool-step-body">
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
