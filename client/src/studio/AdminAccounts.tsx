import { useEffect, useState, type FormEvent } from 'react'
import { api, errorText, type Account, type ProviderStatus } from './api'

type ManagedAccount = Account & { lemex: ProviderStatus }

export function AdminAccounts({
  user,
  onBusyChange,
  disabled = false,
}: {
  user: Account
  onBusyChange?: (busy: boolean) => void
  disabled?: boolean
}) {
  const [users, setUsers] = useState<ManagedAccount[]>([])
  const [name, setName] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api<ManagedAccount[]>('/api/admin/users')
      .then(setUsers)
      .catch((error) => setError(errorText(error)))
  }, [])
  const locked = busy || disabled
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked) return
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    setToken('')
    try {
      const result = await api<{ user: Account; token: string }>(
        '/api/admin/users',
        { method: 'POST', body: JSON.stringify({ name, role }) },
      )
      setUsers((previous) => [
        ...previous,
        { ...result.user, lemex: { configured: false } },
      ])
      setToken(result.token)
      setName('')
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }
  return (
    <section>
      <h3>Accounts</h3>
      <p className="field-help">
        Administrators can invite users. The owner can also appoint
        administrators. API keys are private to each account.
      </p>
      <ul>
        {users.map((account) => (
          <li key={account.id}>
            {account.name} · {account.role}
            {account.role === 'owner' ? ' / admin' : ''} ·{' '}
            {account.lemex.configured ? 'API key saved' : 'API key needed'}
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="account-name">
          New account name
        </label>
        <input
          id="account-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          required
          disabled={locked}
        />
        {user.role === 'owner' && (
          <>
            <label className="field-label" htmlFor="account-role">
              Role
            </label>
            <select
              id="account-role"
              value={role}
              onChange={(event) =>
                setRole(event.target.value === 'admin' ? 'admin' : 'user')
              }
              disabled={locked}
            >
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="button secondary"
            disabled={locked || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create account and token'}
          </button>
        </div>
      </form>
      {token && (
        <div role="status">
          <p className="field-help">
            Copy this token now and share it privately. It is shown only here
            and cannot be retrieved later.
          </p>
          <label className="field-label" htmlFor="new-account-token">
            New sign-in token
          </label>
          <input
            id="new-account-token"
            value={token}
            readOnly
            onFocus={(event) => event.target.select()}
            autoComplete="off"
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => setToken('')}
          >
            Hide token
          </button>
        </div>
      )}
    </section>
  )
}
