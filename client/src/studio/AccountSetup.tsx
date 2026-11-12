import { useState } from 'react'
import { ProviderKeyForm } from './ProviderKeyForm'
import { ProfileForm } from './ProfileForm'
import { type Account, type Session, errorText } from './api'
import { Brand } from './Brand'

export function AccountSetup({
  session,
  onSaved,
  onProfileSaved,
  onLogout,
  refreshError,
  refreshing,
  onRetry,
}: {
  session: Session
  onSaved: () => void
  onProfileSaved: (user: Account) => void
  onLogout: () => Promise<void>
  refreshError: string
  refreshing: boolean
  onRetry: () => void
}) {
  const [providerBusy, setProviderBusy] = useState(false)
  const [profileBusy, setProfileBusy] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  async function logout() {
    if (providerBusy || profileBusy || refreshing || loggingOut) return
    setLoggingOut(true)
    setLogoutError('')
    try {
      await onLogout()
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
        {session.user.profileComplete === false ? (
          <>
            <p>Confirm your display name to get started.</p>
            <ProfileForm
              user={session.user}
              firstLogin
              onSaved={onProfileSaved}
              onBusyChange={setProfileBusy}
              disabled={loggingOut || refreshing}
            />
          </>
        ) : (
          <>
            <p>
              Connect your account to Lemex to open your workspace. Click your
              account in the sidebar to update your profile, API key, or
              settings.
            </p>
            <ProviderKeyForm
              initial={{ configured: false }}
              onSaved={onSaved}
              onBusyChange={setProviderBusy}
              disabled={loggingOut || refreshing}
            />
          </>
        )}
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
        <footer className="account-setup-footer">
          <button
            type="button"
            className="button subtle"
            disabled={providerBusy || profileBusy || refreshing || loggingOut}
            onClick={() => void logout()}
          >
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
          {logoutError && (
            <p className="error-message" role="alert">
              {logoutError}
            </p>
          )}
        </footer>
      </div>
    </main>
  )
}
