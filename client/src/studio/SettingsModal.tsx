import { useEffect, useState, type FormEvent } from 'react'
import { api, errorText, type Account, type ProviderStatus } from './api'
import { ProviderKeyForm } from './ProviderKeyForm'
import { AdminAccounts } from './AdminAccounts'
import { Dialog } from './Dialog'
import { Icon } from './Icons'

interface Settings {
  extraInstructions: string
  showReasoning: boolean
  tools: {
    lean: boolean
    lean_probe?: boolean
    lean_explore: boolean
    exa: boolean
  }
  basePrompt?: string
}

export function SettingsModal({
  onClose,
  onSaved,
  user,
  onProviderSaved,
}: {
  onClose: () => void
  onSaved: () => void
  user: Account
  onProviderSaved: () => void
}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [provider, setProvider] = useState<ProviderStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    void api<ProviderStatus>('/api/provider')
      .then((value) => {
        if (!cancelled) setProvider(value)
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
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
          showReasoning: settings.showReasoning,
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
      <h3>
        {user.name} · {user.role === 'owner' ? 'Owner / admin' : user.role}
      </h3>
      {provider && (
        <ProviderKeyForm
          initial={provider}
          onSaved={(value) => {
            setProvider(value)
            onProviderSaved()
          }}
        />
      )}
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
          <div className="tool-checkboxes reasoning-setting">
            <label>
              <input
                type="checkbox"
                checked={settings.showReasoning ?? true}
                onChange={(event) =>
                  setSettings({
                    ...settings,
                    showReasoning: event.target.checked,
                  })
                }
                disabled={busy}
              />
              <span>
                <strong>Reasoning traces</strong>
                <span>
                  Capture the reasoning that the selected model exposes during
                  new runs.
                </span>
              </span>
            </label>
          </div>
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
                id: 'lean_probe' as const,
                title: 'LeanProbe',
                description:
                  'Fast proof feedback and declaration checks in the current project.',
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
                  checked={
                    settings.tools?.[tool.id] ?? tool.id === 'lean_probe'
                  }
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
      {['owner', 'admin'].includes(user.role) && <AdminAccounts user={user} />}
    </Dialog>
  )
}
