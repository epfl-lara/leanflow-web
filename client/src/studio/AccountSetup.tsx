import { useState, type ReactNode } from 'react'
import { ProfileForm } from './ProfileForm'
import { type Account, type Session, errorText } from './api'
import { Brand } from './Brand'

export function AccountSetup({
  session,
  onProfileSaved,
  onSetUpProvider,
  onLogout,
  invitationNotice,
}: {
  session: Session
  onProfileSaved: (user: Account) => void
  onSetUpProvider: () => void
  onLogout: () => Promise<void>
  invitationNotice?: ReactNode
}) {
  const [profileBusy, setProfileBusy] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  async function logout() {
    if (profileBusy || loggingOut) return
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
        {invitationNotice}
        <p>Confirm your display name to get started.</p>
        <ProfileForm
          user={session.user}
          firstLogin
          onSaved={onProfileSaved}
          onSetUpProvider={
            session.lemex?.configured === false ? onSetUpProvider : undefined
          }
          onBusyChange={setProfileBusy}
          disabled={loggingOut}
        />
        <footer className="account-setup-footer">
          <button
            type="button"
            className="button subtle"
            disabled={profileBusy || loggingOut}
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
