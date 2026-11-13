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
        ? connection.repository
          ? `Uses your saved token for ${connection.repository}.`
          : `Uses your saved connection to ${connection.host}.`
        : 'Save a token once in Git connections to use it for imports, pulls, pushes, terminals and agents.'}{' '}
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
