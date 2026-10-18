import { useState } from 'react'
import { ProviderKeyForm } from './ProviderKeyForm'
import { type Session, errorText, post } from './api'
import { Brand } from './Brand'

export function AccountSetup({
  session,
  onSaved,
  onLogout,
  refreshError,
  refreshing,
  onRetry,
}: {
  session: Session
  onSaved: () => void
  onLogout: () => void
  refreshError: string
  refreshing: boolean
  onRetry: () => void
}) {
  const [providerBusy, setProviderBusy] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  async function logout() {
    if (providerBusy || refreshing || loggingOut) return
    setLoggingOut(true)
    setLogoutError('')
    try {
      await post('/api/logout', {})
      onLogout()
    } catch (error) {
      setLogoutError(errorText(error))
    } finally {
      setLoggingOut(false)
    }
  }
  return (
    <main className="login-screen account-setup">
      <div className="login-card">
        <Brand />
        <h1>Welcome, {session.user.name}.</h1>
        <p>
          Connect your account to Lemex to open your workspace. You can update
          your key later in Assistant settings.
        </p>
        <ProviderKeyForm
          initial={{ configured: false }}
          onSaved={onSaved}
          onBusyChange={setProviderBusy}
          disabled={loggingOut || refreshing}
        />
        {refreshError && (
          <div role="alert">
            <p className="error-message">
              Your connection was saved, but the workspace could not refresh.{' '}
              {refreshError}
            </p>
            <button
              type="button"
              className="button secondary"
              disabled={refreshing}
              onClick={onRetry}
            >
              {refreshing ? 'Opening workspace…' : 'Retry opening workspace'}
            </button>
          </div>
        )}
        {refreshing && (
          <div className="field-help">
            <output>Opening your workspace…</output>
          </div>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={providerBusy || refreshing || loggingOut}
          onClick={() => void logout()}
        >
          {loggingOut ? 'Signing out…' : 'Sign out'}
        </button>
        {logoutError && (
          <p className="error-message" role="alert">
            {logoutError}
          </p>
        )}
      </div>
    </main>
  )
}
