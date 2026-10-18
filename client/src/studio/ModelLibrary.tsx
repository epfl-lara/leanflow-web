import { useId, useState } from 'react'
import { api, errorText, type ModelAccess, type Session } from './api'
import { Dialog } from './Dialog'

export function ModelLibrary({
  models,
  savedModels,
  onSaved,
  onClose,
}: {
  models: Session['models']
  savedModels: string[]
  onSaved: (access: ModelAccess) => void
  onClose: () => void
}) {
  const [chosen, setChosen] = useState(savedModels)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const searchId = useId()
  const available = new Set(models.map((model) => model.id))
  const inventory = [
    ...savedModels
      .filter((id) => !available.has(id))
      .map((id) => ({ id, name: id })),
    ...models,
  ]
  const matching = inventory.filter((model) =>
    `${model.id} ${model.name}`
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  )
  async function save() {
    setBusy(true)
    setError('')
    try {
      const access = await api<ModelAccess>('/api/models/preferences', {
        method: 'PUT',
        body: JSON.stringify({ savedModels: chosen }),
      })
      onSaved(access)
      onClose()
    } catch (error) {
      setError(errorText(error))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Your models"
      subtitle="Choose a few models for everyday use. This list is saved to your account."
      busy={busy}
      onClose={onClose}
    >
      <div className="model-library">
        <label className="field-label" htmlFor={searchId}>
          Search all available models
        </label>
        <input
          id={searchId}
          type="search"
          placeholder="Model name or ID…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={busy}
        />
        <output className="field-help">
          {chosen.length} selected · {models.length} available with your key
        </output>
        <div className="model-library-list" aria-label="Available models">
          {matching.map((model) => (
            <label key={model.id} className="model-library-choice">
              <input
                type="checkbox"
                checked={chosen.includes(model.id)}
                onChange={(event) =>
                  setChosen((previous) =>
                    event.target.checked
                      ? [...previous, model.id]
                      : previous.filter((id) => id !== model.id),
                  )
                }
                disabled={busy}
              />
              <span>
                <strong>{model.name || model.id}</strong>
                <small>{model.id}</small>
                {!available.has(model.id) && (
                  <small>Unavailable with this key</small>
                )}
              </span>
            </label>
          ))}
          {!matching.length && (
            <p className="field-help">No matching models.</p>
          )}
        </div>
        <p className="field-help">
          Adding or removing models keeps your current model, reasoning effort,
          and default.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving models…' : 'Save models'}
          </button>
        </footer>
      </div>
    </Dialog>
  )
}
