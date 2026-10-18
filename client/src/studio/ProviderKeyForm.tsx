import { useState, type FormEvent } from 'react'
import { api, errorText, type ProviderStatus } from './api'

export function ProviderKeyForm({
  initial,
  onSaved,
}: {
  initial: ProviderStatus
  onSaved: (status: ProviderStatus) => void
}) {
  const [status, setStatus] = useState(initial)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setSaved(false)
    try {
      const result = await api<ProviderStatus>('/api/provider', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: key.trim() }),
      })
      setStatus(result)
      setKey('')
      setSaved(true)
      onSaved(result)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <label className="field-label" htmlFor="lemex-api-key">
        Your Lemex API key
      </label>
      <p className="field-help">
        {status.configured
          ? 'A key is saved for your account. Enter a new key to replace it.'
          : 'Add your own key to use Lemex. Each account uses its own provider quota.'}{' '}
        Your key is encrypted on the server and stays saved between visits.
      </p>
      <p className="field-help">
        <a
          href="https://portal.rcp.epfl.ch/aiaas/keys"
          target="_blank"
          rel="noopener noreferrer"
        >
          Find or create your API key in the EPFL RCP portal
        </a>{' '}
        (opens in a new tab).
      </p>
      <input
        id="lemex-api-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(event) => setKey(event.target.value)}
        disabled={busy}
        placeholder={status.configured ? 'New API key' : 'Paste your API key'}
        required
        maxLength={4096}
      />
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="field-help" role="status">
          API key saved. New Lemex requests will use this key.
        </p>
      )}
      <div className="dialog-actions">
        <button className="button primary" disabled={busy || !key.trim()}>
          {busy
            ? 'Checking key…'
            : status.configured
              ? 'Update API key'
              : 'Save API key'}
        </button>
      </div>
    </form>
  )
}
