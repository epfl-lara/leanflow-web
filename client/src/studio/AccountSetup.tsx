import { ProviderKeyForm } from './ProviderKeyForm'
import { type Session, post } from './api'
import { Brand } from './Brand'

export function AccountSetup({
  session,
  onSaved,
  onLogout,
}: {
  session: Session
  onSaved: () => void
  onLogout: () => void
}) {
  return (
    <main className="login-screen account-setup">
      <div className="login-card">
        <Brand />
        <h1>Welcome, {session.user.name}.</h1>
        <p>
          Connect your account to Lemex to open your workspace. You can update
          your key later in Assistant settings.
        </p>
        <ProviderKeyForm initial={{ configured: false }} onSaved={onSaved} />
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            void post('/api/logout', {}).then(onLogout)
          }}
        >
          Sign out
        </button>
      </div>
    </main>
  )
}
