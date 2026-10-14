import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Dialog } from './Dialog'
import { errorText, post, type Project } from './api'

export function RenameWorkspaceDialog({
  project,
  onClose,
  onRenamed,
}: {
  project: Project
  onClose: () => void
  onRenamed: (project: Project) => void
}) {
  const [name, setName] = useState(project.name)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.setSelectionRange(
      0,
      project.name.endsWith('.lean')
        ? project.name.length - 5
        : project.name.length,
    )
  }, [project.name])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const updated = await post<Project>(
        `/api/projects/${encodeURIComponent(project.id)}/rename`,
        { name: name.trim() },
      )
      onRenamed(updated)
    } catch (error) {
      setError(errorText(error))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title="Rename playground"
      subtitle="Choose a name that helps you find this proof."
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="playground-name">
          Name
        </label>
        <input
          id="playground-name"
          ref={input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          required
          disabled={busy}
        />
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? 'Renaming…' : 'Save name'}
          </button>
        </footer>
      </form>
    </Dialog>
  )
}
