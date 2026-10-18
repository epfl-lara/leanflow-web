import { useState, type FormEvent } from 'react'
import { api, errorText, type ProviderStatus } from './api'

export function ProviderKeyForm({
  initial,
  onSaved,
  onBusyChange,
  disabled = false,
}: {
  initial: ProviderStatus
  onSaved: (status: ProviderStatus) => void
  onBusyChange?: (busy: boolean) => void
  disabled?: boolean
}) {
  const [status, setStatus] = useState(initial)
  const [key, setKey] = useState('')
  const [provider, setProvider] = useState<'rcp' | 'custom'>(
    initial.provider || 'rcp',
  )
  const [baseUrl, setBaseUrl] = useState(
    initial.provider === 'custom' ? initial.baseUrl || '' : '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const locked = busy || disabled
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked) return
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    setSaved(false)
    try {
      const result = await api<ProviderStatus>('/api/provider', {
        method: 'PUT',
        body: JSON.stringify({
          apiKey: key.trim(),
          provider,
          ...(provider === 'custom' ? { baseUrl: baseUrl.trim() } : {}),
        }),
      })
      setStatus(result)
      setKey('')
      setSaved(true)
      onSaved(result)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }
  return (
    <form onSubmit={submit}>
      <label className="field-label" htmlFor="lemex-provider">
        Provider
      </label>
      <select
        id="lemex-provider"
        value={provider}
        disabled={locked}
        onChange={(event) => {
          setProvider(event.target.value === 'custom' ? 'custom' : 'rcp')
          setKey('')
          setSaved(false)
          setError('')
        }}
      >
        <option value="rcp">EPFL RCP (default)</option>
        <option value="custom">Another provider</option>
      </select>
      {provider === 'custom' && (
        <>
          <label className="field-label" htmlFor="lemex-base-url">
            API base URL
          </label>
          <input
            id="lemex-base-url"
            type="url"
            value={baseUrl}
            disabled={locked}
            onChange={(event) => {
              setBaseUrl(event.target.value)
              setKey('')
              setSaved(false)
            }}
            placeholder="https://api.example.com/v1"
            required
            maxLength={2048}
            autoComplete="off"
          />
          <p className="field-help">
            Use a public HTTPS endpoint that supports the Responses API and
            lists models for your key. Lemex discovers its models and advertised
            reasoning options.
          </p>
        </>
      )}
      <label className="field-label" htmlFor="lemex-api-key">
        Your Lemex API key
      </label>
      <p className="field-help">
        {status.configured
          ? 'A connection is saved for your account. Enter the key for the provider you want to use.'
          : 'Add your own key to use Lemex. Each account uses its own provider quota.'}{' '}
        Your key is encrypted on the server and stays saved between visits.
      </p>
      {provider === 'rcp' && (
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
      )}
      <input
        id="lemex-api-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={key}
        onChange={(event) => setKey(event.target.value)}
        disabled={locked}
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
          Provider and key saved. New Lemex requests will use this connection.
          Your models are refreshed automatically.
        </p>
      )}
      <div className="dialog-actions">
        <button className="button primary" disabled={locked || !key.trim()}>
          {busy
            ? 'Checking key…'
            : status.configured
              ? 'Update connection'
              : 'Save connection'}
        </button>
      </div>
    </form>
  )
}
