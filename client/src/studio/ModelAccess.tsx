import { useEffect, useState } from 'react'
import { api, errorText, type ModelAccess as ModelAccessStatus } from './api'

export function ModelAccess({
  revision,
  onUpdated,
}: {
  revision?: string | null
  onUpdated: () => void
}) {
  const [access, setAccess] = useState<ModelAccessStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    setAccess(null)
    setError('')
    void api<ModelAccessStatus>('/api/models')
      .then((value) => {
        if (!cancelled) setAccess(value)
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [revision])
  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const value = await api<ModelAccessStatus>('/api/models/refresh', {
        method: 'POST',
        body: '{}',
      })
      setAccess(value)
      onUpdated()
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="model-access" aria-label="Model access">
      <h3>Models available with your key</h3>
      {access ? (
        <p className="field-help">
          {access.models.length} models available. Default:{' '}
          {access.models.find((model) => model.id === access.defaultModel)
            ?.name ||
            access.defaultModel ||
            'No model available'}
          . Choose a model and reasoning effort in Lemex → Options.
        </p>
      ) : (
        !error && <p className="field-help">Loading model access…</p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={() => {
          void refresh()
        }}
      >
        {busy ? 'Refreshing models…' : 'Refresh models'}
      </button>
    </section>
  )
}
