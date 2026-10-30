import type { Run } from './api'
import { finalVerificationIssue, runChangeCount } from './chatTimeline'
import { Icon } from './Icons'

export function TurnOutcome({
  run,
  onDetails,
}: {
  run: Run
  onDetails: () => void
}) {
  const value = run.verification
  if (run.liveUndone) return null
  if (!value || typeof value !== 'object' || !('complete' in value)) return null
  const kind = 'kind' in value ? value.kind : undefined
  if (kind === 'chat' || kind === 'search') return null
  const lean = kind !== 'workspace'
  const passed = lean && value.complete === true
  const issue = finalVerificationIssue(run)
  const saved =
    run.status === 'applied' ||
    (run.liveEdits && !run.liveUndone && runChangeCount(run, true) > 0)
  return (
    <div
      className={`turn-outcome ${passed ? 'passed' : issue ? 'attention' : ''}`}
    >
      <Icon name={passed ? 'check' : 'info'} size={18} />
      <div>
        <strong>
          {passed
            ? 'Final Lean check passed'
            : issue
              ? 'Final Lean check did not pass'
              : saved
                ? 'Project files saved'
                : 'Ready for file review'}
        </strong>
        <p>
          {passed
            ? run.mode === 'formalize'
              ? 'Lean checked the code. Review whether the statement and assumptions match your source.'
              : 'The server independently checked the candidate in this project’s Lean environment.'
            : issue ||
              ('reason' in value && typeof value.reason === 'string'
                ? value.reason
                : 'Review the proposed changes before applying them.')}
        </p>
        {issue && (
          <p>
            {saved
              ? 'The edits are already saved. You can ask Lemex to fix the checks or undo its edits.'
              : 'Lemex has finished this run. Ask it to fix the checks before applying these changes.'}
          </p>
        )}
        <button type="button" className="turn-action" onClick={onDetails}>
          {passed ? 'Check details' : 'View check details'}
        </button>
      </div>
    </div>
  )
}
