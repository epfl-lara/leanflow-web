import { useEffect, useState, type FormEvent } from 'react'
import { api, errorText } from './api'
import { Dialog } from './Dialog'
import { Icon } from './Icons'

interface Settings {
  extraInstructions: string
  tools: { lean: boolean; lean_explore: boolean; exa: boolean }
  basePrompt?: string
}

export function SettingsModal({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api<Settings>('/api/settings')
      .then((value) => {
        if (!cancelled) setSettings(value)
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    setBusy(true)
    setError('')
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          extraInstructions: settings.extraInstructions,
          tools: settings.tools,
        }),
      })
      onSaved()
      onClose()
    } catch (error) {
      setError(errorText(error))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Assistant settings"
      subtitle="Your instructions and tool choices apply to new Lemex runs."
      onClose={onClose}
      busy={busy}
    >
      {!settings && !error && (
        <p className="field-help">
          <span className="spinner" /> Loading settings…
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {settings && (
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="extra-instructions">
            Additional instructions
          </label>
          <textarea
            id="extra-instructions"
            rows={5}
            placeholder="Preferred proof style, naming conventions, mathematical context…"
            value={settings.extraInstructions || ''}
            onChange={(event) =>
              setSettings({
                ...settings,
                extraInstructions: event.target.value,
              })
            }
            disabled={busy}
          />
          <p className="field-help">
            Added to the workspace proof guidance. Verification requirements
            still apply.
          </p>
          <span className="field-label">Available tools</span>
          <div className="tool-checkboxes">
            {[
              {
                id: 'lean' as const,
                title: 'Lean tools',
                description:
                  'Inspect goals, diagnostics, and try proofs in the project.',
              },
              {
                id: 'lean_explore' as const,
                title: 'LeanExplore',
                description:
                  'Search for declarations using mathematical descriptions.',
              },
              {
                id: 'exa' as const,
                title: 'Web search',
                description:
                  'Find mathematical references and relevant source material.',
              },
            ].map((tool) => (
              <label key={tool.id}>
                <input
                  type="checkbox"
                  checked={settings.tools?.[tool.id] ?? false}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      tools: {
                        ...settings.tools,
                        [tool.id]: event.target.checked,
                      },
                    })
                  }
                  disabled={busy}
                />
                <span>
                  <strong>{tool.title}</strong>
                  <span>{tool.description}</span>
                </span>
              </label>
            ))}
          </div>
          {settings.basePrompt && (
            <details className="base-guidance">
              <summary>Built-in proof guidance</summary>
              <pre>{settings.basePrompt}</pre>
            </details>
          )}
          <footer className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? (
                <span className="spinner" />
              ) : (
                <Icon name="save" size={15} />
              )}
              Save settings
            </button>
          </footer>
        </form>
      )}
    </Dialog>
  )
}
