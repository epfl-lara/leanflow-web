import { memo, useState } from 'react'
import { runIsActive, type Run, type RunProofTarget } from './api'
import { Icon } from './Icons'
import { OutputText } from './AssistantText'
import { Verification } from './RunReview'
import { OptimizationSummary } from './OptimizationSummary'
import {
  conversationSegments,
  runChangeCount,
  runStatusLabel,
} from './chatTimeline'
import { modeName } from './chatModes'
import { ReasoningTrace } from './ReasoningTrace'
import { UsageSummary } from './UsageSummary'

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
  const changeCount = runChangeCount(run)
  const liveCount = runChangeCount(run, true)
  const [activityOpen, setActivityOpen] = useState(false)
  return (
    <article className="conversation-turn" data-run-id={run.id}>
      {run.prompt && (
        <div className="user-message">
          <span className="message-label">You</span>
          <p>{run.prompt}</p>
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
      <ReasoningTrace run={run} onInspect={onInspect} />
      {conversationSegments(run).map((segment) =>
        segment.kind === 'assistant' ? (
          <div key={segment.key} className="assistant-message">
            <span className="message-label">
              <Icon name="bot" size={14} />
              Lemex
            </span>
            <div className="message-body markdown-body">
              <OutputText text={segment.text} streaming={active} />
            </div>
          </div>
        ) : (
          <div
            key={segment.key}
            className="user-message followup-message"
            data-followup-id={segment.followup.id}
          >
            <span className="message-label">You · update</span>
            <p>{segment.followup.text}</p>
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
                  ? 'Accepted by Lemex for its next decision boundary.'
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
      {run.liveEditConflict && (
        <p className="error-message">{run.liveEditConflict}</p>
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
        <summary>
          Details <span>{modeName(run.mode)}</span>
        </summary>
        {expanded && (
          <>
            {loading && <p className="field-help">Loading details…</p>}
            {detailsError && <p className="error-message">{detailsError}</p>}
            <Verification value={run.verification} />
            <OptimizationSummary value={run.optimization} active={active} />
            {run.liveEdits && (
              <p className="field-help">
                {run.liveUndone
                  ? 'The run’s saved edits were restored.'
                  : 'Edits are saved live; final Lean verification is independent.'}
              </p>
            )}
            {!!run.log && (
              <details
                className="activity-log"
                open={activityOpen}
                onToggle={(event) => setActivityOpen(event.currentTarget.open)}
              >
                <summary>Activity</summary>
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
