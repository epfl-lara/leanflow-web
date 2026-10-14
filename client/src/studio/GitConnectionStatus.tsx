import type { GitConnection } from './api'

export function GitConnectionStatus({
  connection,
  onOpenConnections,
  disabled = false,
}: {
  connection?: GitConnection
  onOpenConnections?: () => void
  disabled?: boolean
}) {
  return (
    <p className="field-help git-connection-status">
      {connection
        ? `Uses your saved connection to ${connection.host}.`
        : 'Connect an account to share Git access between projects and the terminal.'}{' '}
      {onOpenConnections && (
        <button
          type="button"
          className="git-text-button"
          disabled={disabled}
          onClick={onOpenConnections}
        >
          Git connections
        </button>
      )}
    </p>
  )
}
