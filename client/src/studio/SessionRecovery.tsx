import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, errorText, markSessionRestored, post, type Session } from './api'

/** Keep the workspace mounted so unsaved editor text and chat drafts survive. */
export function SessionRecovery({ user }: { user: Session['user'] }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const active = useRef(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    active.current = true
    const dialog = dialogRef.current
    const previous = document.activeElement as HTMLElement | null
    dialog?.showModal()
    return () => {
      active.current = false
      dialog?.close()
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await post('/api/login', { token: token.trim(), expectedUserId: user.id })
      const renewed = await api<Session>('/api/session')
      if (renewed.user.id !== user.id)
        throw new Error('Use the access token for this workspace account.')
      setToken('')
      markSessionRestored()
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="studio-dialog session-recovery"
      aria-labelledby="session-recovery-title"
      aria-describedby="session-recovery-help"
      onCancel={(event) => event.preventDefault()}
      onClose={() => {
        // Browsers can force-close a modal after repeated Escape presses.
        // Keep recovery available until sign-in succeeds without a reload.
        if (active.current) dialogRef.current?.showModal()
      }}
    >
      <header className="dialog-header">
        <h2 id="session-recovery-title">Sign in to continue</h2>
      </header>
      <p id="session-recovery-help">
        Your session expired. Your unsaved edits and chat draft are still here.
        Sign in as {user.name} to continue.
      </p>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="recovery-access-token">
          Access token
        </label>
        <input
          id="recovery-access-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Enter your collaborator token"
          autoComplete="current-password"
          required
          autoFocus
          disabled={busy}
        />
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <p className="field-help">
          After signing in, retry the action you were taking. Nothing is sent
          again automatically.
        </p>
        <footer className="dialog-actions">
          <button className="button primary" disabled={busy || !token.trim()}>
            {busy && <span className="spinner" />}
            {busy ? 'Signing in…' : 'Continue in workspace'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
