import { useEffect, useRef, useState } from 'react'
import { api, errorText, type ModelAccess as ModelAccessStatus } from './api'
import { ModelLibrary } from './ModelLibrary'

export function ModelAccess({
  revision,
  onUpdated,
}: {
  revision?: string | null
  onUpdated: (access: ModelAccessStatus) => void
}) {
  const [access, setAccess] = useState<ModelAccessStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const onUpdatedRef = useRef(onUpdated)
  useEffect(() => {
    onUpdatedRef.current = onUpdated
  }, [onUpdated])
  useEffect(() => {
    let cancelled = false
    setAccess(null)
    setError('')
    void api<ModelAccessStatus>('/api/models')
      .then((value) => {
        if (!cancelled) {
          setAccess(value)
          onUpdatedRef.current(value)
        }
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
      onUpdated(value)
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
          {access.savedModels.length} saved models · {access.models.length}{' '}
          available with your key. Default:{' '}
          {access.models.find((model) => model.id === access.defaultModel)
            ?.name ||
            access.defaultModel ||
            'No model available'}
          . Your saved models appear in Lemex → Options.
        </p>
      ) : (
        !error && <p className="field-help">Loading model access…</p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <div className="button-row">
        {access && (
          <button
            type="button"
            className="button secondary"
            disabled={busy || !access.models.length}
            onClick={() => setLibraryOpen(true)}
          >
            Edit saved models
          </button>
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
      </div>
      {access && libraryOpen && (
        <ModelLibrary
          models={access.models}
          savedModels={access.savedModels}
          onSaved={(value) => {
            setAccess(value)
            onUpdated(value)
          }}
          onClose={() => setLibraryOpen(false)}
        />
      )}
    </section>
  )
}
