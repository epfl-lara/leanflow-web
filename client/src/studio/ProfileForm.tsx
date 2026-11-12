import { useId, useState, type FormEvent } from 'react'
import { api, errorText, type Account } from './api'
import { CopyButton } from './CopyButton'
import './profile.css'

export function ProfileForm({
  user,
  onSaved,
  onBusyChange,
  disabled = false,
  firstLogin = false,
}: {
  user: Account
  onSaved: (user: Account) => void
  onBusyChange?: (busy: boolean) => void
  disabled?: boolean
  firstLogin?: boolean
}) {
  const nameId = useId()
  const accountId = useId()
  const [name, setName] = useState(user.name)
  const [savedName, setSavedName] = useState(user.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const locked = busy || disabled

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked || !name.trim()) return
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    setSaved(false)
    try {
      const result = await api<{ user: Account }>('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: name.trim() }),
      })
      setName(result.user.name)
      setSavedName(result.user.name)
      setSaved(true)
      onSaved(result.user)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  return (
    <form onSubmit={submit} aria-label="Profile">
      <label className="field-label" htmlFor={nameId}>
        Display name
      </label>
      <input
        id={nameId}
        autoComplete="name"
        value={name}
        onChange={(event) => {
          setName(event.target.value)
          setSaved(false)
          setError('')
        }}
        maxLength={80}
        required
        disabled={locked}
      />
      <p className="field-help">
        Choose the name people will recognize. You can change it later in your
        account settings.
      </p>
      {!firstLogin && (
        <>
          <label className="field-label" htmlFor={accountId}>
            Account ID
          </label>
          <div className="profile-identity">
            <input id={accountId} value={user.id} readOnly />
            <CopyButton text={user.id} label="Copy account ID" />
          </div>
          <p className="field-help">
            This unique ID identifies your account and stays the same when you
            change your name.
          </p>
        </>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <div className="field-help">
          <output>Profile saved.</output>
        </div>
      )}
      <div className="dialog-actions">
        <button
          className="button primary"
          disabled={
            locked || !name.trim() || (!firstLogin && name.trim() === savedName)
          }
        >
          {busy
            ? 'Saving profile…'
            : firstLogin
              ? 'Save profile and continue'
              : 'Save profile'}
        </button>
      </div>
    </form>
  )
}
