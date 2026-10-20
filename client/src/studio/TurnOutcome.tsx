import type { Run } from './api'
import { finalVerificationIssue } from './chatTimeline'
import { Icon } from './Icons'

export function TurnOutcome({
  run,
  onDetails,
}: {
  run: Run
  onDetails: () => void
}) {
  const value = run.verification
  if (!value || typeof value !== 'object' || !('complete' in value)) return null
  const kind = 'kind' in value ? value.kind : undefined
  if (kind === 'chat' || kind === 'search') return null
  const lean = kind !== 'workspace'
  const passed = lean && value.complete === true
  const issue = finalVerificationIssue(run)
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
              ? 'Final checks need attention'
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
        <button type="button" className="turn-action" onClick={onDetails}>
          {passed ? 'Check details' : 'Review checks'}
        </button>
      </div>
    </div>
  )
}
