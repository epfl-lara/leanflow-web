import { memo, useCallback, useRef, useState } from 'react'
import { runIsActive, type Run, type RunProofTarget } from './api'
import { Icon } from './Icons'
import { OutputText } from './AssistantText'
import { Verification } from './RunReview'
import { OptimizationSummary } from './OptimizationSummary'
import {
  conversationSegments,
  runChangeCount,
  runChangePaths,
  runStatusLabel,
} from './chatTimeline'
import { modeName } from './chatModes'
import { ReasoningTrace } from './ReasoningTrace'
import { UsageSummary } from './UsageSummary'
import { ToolActivity } from './ToolActivity'
import { TurnOutcome } from './TurnOutcome'
import { CopyButton } from './CopyButton'
import { chatFileLink } from './chatFileLink'

function TargetLabel({
  target,
  onOpen,
}: {
  target: RunProofTarget
  onOpen?: (target: RunProofTarget) => void
}) {
  return (
    <button
      type="button"
      className="message-proof-target"
      onClick={() => onOpen?.(target)}
      disabled={!onOpen}
      title={`Open ${target.path}:${target.startLine}`}
    >
      <Icon name="file" size={12} />
      <span>
        {target.name ? `${target.name} · ` : ''}
        {target.path}:{target.startLine}
        {target.endLine !== target.startLine ? `–${target.endLine}` : ''}
      </span>
    </button>
  )
}

export const ConversationTurn = memo(function ConversationTurn({
  run,
  onReview,
  onUndo,
  onInspect,
  canUndo,
  undoing,
  onOpenTarget,
}: {
  run: Run
  onReview: (id: string) => void
  onUndo: (id: string) => void
  onInspect: (id: string) => Promise<void>
  canUndo: boolean
  undoing: boolean
  onOpenTarget?: (target: RunProofTarget) => void
}) {
  const active = runIsActive(run)
  const status = runStatusLabel(run)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detailsError, setDetailsError] = useState('')
  const [linkError, setLinkError] = useState('')
  const openLocalLink = useCallback(
    (href: string) => {
      const target = chatFileLink(href)
      if (!target || !onOpenTarget) {
        setLinkError('This link does not point to a project file.')
        return
      }
      setLinkError('')
      onOpenTarget(target)
    },
    [onOpenTarget],
  )
  const changeCount = runChangeCount(run, !!run.liveEdits)
  const liveCount = runChangeCount(run, true)
  const [activityOpen, setActivityOpen] = useState(false)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const segments = conversationSegments(run)
  return (
    <article className="conversation-turn" data-run-id={run.id}>
      {run.prompt && (
        <div className="user-message">
          <span className="message-label">You</span>
          <div className="markdown-body">
            <OutputText text={run.prompt} />
          </div>
          {run.proofTarget && (
            <TargetLabel target={run.proofTarget} onOpen={onOpenTarget} />
          )}
        </div>
      )}
      {run.messageTruncated && (
        <p className="field-help">
          Earlier assistant output was trimmed; the latest response is shown.
        </p>
      )}
      {run.toolActivityTruncated && (
        <p className="field-help">
          Showing the latest recorded work steps. Earlier step summaries were
          trimmed.
        </p>
      )}
      {segments.map((segment) =>
        segment.kind === 'reasoning' ? (
          <ReasoningTrace
            key={segment.key}
            run={run}
            onInspect={onInspect}
            block={segment.block}
            streaming={segment.active}
          />
        ) : segment.kind === 'activity' ? (
          <ToolActivity
            key={segment.key}
            steps={segment.steps}
            active={active}
            onInspect={() => onInspect(run.id)}
            onOpenTarget={onOpenTarget}
          />
        ) : segment.kind === 'assistant' ? (
          <div key={segment.key} className="assistant-message">
            <span className="message-label">
              <span className="message-author">
                <Icon name="bot" size={14} />
                Lemex <small>· {modeName(run.mode)}</small>
              </span>
              <CopyButton text={segment.text} label="Copy reply" />
            </span>
            <div className="message-body markdown-body">
              <OutputText
                text={segment.text}
                streaming={active && segment.key === segments.at(-1)?.key}
                onOpenLocalLink={openLocalLink}
              />
            </div>
          </div>
        ) : (
          <div
            key={segment.key}
            className="user-message followup-message"
            data-followup-id={segment.followup.id}
          >
            <span className="message-label">You · update</span>
            <div className="markdown-body">
              <OutputText text={segment.followup.text} />
            </div>
            {segment.followup.proofTarget && (
              <TargetLabel
                target={segment.followup.proofTarget}
                onOpen={onOpenTarget}
              />
            )}
            <span
              className={`followup-receipt ${segment.followup.status}`}
              data-followup-status={segment.followup.status}
              title={
                segment.followup.status === 'accepted'
                  ? 'Lemex will use this update on its next step.'
                  : undefined
              }
            >
              {segment.followup.status === 'pending'
                ? 'Queued update'
                : segment.followup.status === 'accepted'
                  ? 'Update accepted'
                  : 'Update failed'}
            </span>
            {segment.followup.error && (
              <p className="error-message">{segment.followup.error}</p>
            )}
          </div>
        ),
      )}
      {run.error && (
        <p className="error-message" role="alert">
          {run.error}
        </p>
      )}
      {linkError && (
        <p className="error-message" role="alert">
          {linkError}
        </p>
      )}
      {run.liveEditConflict && (
        <p className="error-message">{run.liveEditConflict}</p>
      )}
      {!active && (
        <TurnOutcome
          run={run}
          onDetails={() => {
            setExpanded(true)
            detailsRef.current?.querySelector('summary')?.focus()
          }}
        />
      )}
      {!active && (
        <OptimizationSummary value={run.optimization} active={false} />
      )}
      {active &&
        run.liveEdits &&
        !run.liveRevision &&
        !run.liveEditConflict && (
          <p className="field-help">
            No project files changed yet. Scratch checks do not update the
            editor.
          </p>
        )}
      {run.liveEdits && !run.liveUndone && liveCount > 0 && (
        <div className="turn-saved-edits">
          <span>Saved to project:</span>
          {runChangePaths(run, true).map((path) => (
            <button
              key={path}
              type="button"
              className="turn-action"
              disabled={!onOpenTarget}
              onClick={() => onOpenTarget?.({ path, startLine: 1, endLine: 1 })}
            >
              {path}
            </button>
          ))}
          {active && (
            <span className="turn-status">Final Lean check pending</span>
          )}
        </div>
      )}
      <div className="turn-footer">
        <span
          className={`turn-status ${run.status === 'failed' ? 'danger' : ''}`}
        >
          {active && <span className="spinner" />}
          {status}
        </span>
        {changeCount > 0 && (
          <button
            type="button"
            className="turn-action"
            onClick={() => onReview(run.id)}
          >
            {run.liveEdits ? 'View edits' : 'Review changes'}{' '}
            <span>{changeCount}</span>
          </button>
        )}
        {run.liveEdits && !run.liveUndone && liveCount > 0 && !active && (
          <button
            type="button"
            className="turn-action"
            disabled={!canUndo || undoing}
            onClick={() => onUndo(run.id)}
          >
            {undoing ? 'Undoing…' : 'Undo agent edits'}
          </button>
        )}
        {run.liveUndone && <span className="turn-status">Edits undone</span>}
      </div>
      <details
        ref={detailsRef}
        className="turn-details"
        open={expanded}
        onToggle={(event) => {
          const open = event.currentTarget.open
          setExpanded(open)
          if (open) {
            setLoading(true)
            setDetailsError('')
            void onInspect(run.id)
              .catch((error) =>
                setDetailsError(
                  error instanceof Error ? error.message : String(error),
                ),
              )
              .finally(() => setLoading(false))
          }
        }}
      >
        <summary>Checks & run details</summary>
        {expanded && (
          <>
            {loading && <p className="field-help">Loading details…</p>}
            {detailsError && <p className="error-message">{detailsError}</p>}
            <Verification value={run.verification} />
            {active && <OptimizationSummary value={run.optimization} active />}
            {!!run.log && (
              <details
                className="activity-log"
                open={activityOpen}
                onToggle={(event) => setActivityOpen(event.currentTarget.open)}
              >
                <summary>
                  Technical log
                  {run.toolActivity?.length ? '' : ' · earlier run'}
                </summary>
                {activityOpen && <pre>{run.log}</pre>}
              </details>
            )}
          </>
        )}
        {expanded && <UsageSummary value={run.usage} />}
      </details>
    </article>
  )
})
