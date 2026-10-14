import { useState, type FormEvent } from 'react'
import { Dialog } from './Dialog'
import { errorText } from './api'
import { GitConnectionStatus } from './GitConnectionStatus'
import { repositoryHost, useGitConnections } from './gitConnections'
import {
  RepositoryCredentialsFields,
  type RepositoryCredentials,
} from './RepositoryCredentialsFields'

export function RepositoryCredentialsDialog({
  repository,
  onClose,
  onSubmit,
  onOpenConnections,
}: {
  repository?: string
  onClose: () => void
  onSubmit: (credentials: RepositoryCredentials) => Promise<void>
  onOpenConnections?: () => void
}) {
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { data } = useGitConnections()
  const connection = data?.connections.find(
    (entry) => entry.host === repositoryHost(repository),
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || (!token.trim() && !connection)) return
    if (!token.trim() && username.trim()) {
      setError(
        'Enter a token for this username, or clear the username to use your connection.',
      )
      return
    }
    setBusy(true)
    setError('')
    const credential = token.trim()
    const login = username.trim()
    setToken('')
    setUsername('')
    try {
      await onSubmit({
        ...(credential ? { repositoryToken: credential } : {}),
        ...(login ? { repositoryUsername: login } : {}),
      })
      setToken('')
      setUsername('')
      onClose()
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Repository access"
      subtitle="Use a saved connection or a token to retry importing this repository."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit} autoComplete="off">
        {repository && <p className="field-help">{repository}</p>}
        <GitConnectionStatus
          connection={connection}
          onOpenConnections={onOpenConnections}
          disabled={busy}
        />
        <details className="repository-access-options" open={!connection}>
          <summary>
            {connection ? 'Use a different token once' : 'Repository token'}
          </summary>
          <RepositoryCredentialsFields
            idPrefix="retry-repository"
            token={token}
            username={username}
            onTokenChange={setToken}
            onUsernameChange={setUsername}
            disabled={busy}
            required={!connection}
            autoFocus
          />
        </details>
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <footer className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || (!token.trim() && !connection)}
          >
            {busy ? <span className="spinner" /> : null}
            Retry setup
          </button>
        </footer>
      </form>
    </Dialog>
  )
}
