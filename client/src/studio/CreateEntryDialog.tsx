import { useEffect, useState, type FormEvent } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { errorText, SESSION_RESTORED_EVENT } from './api'
import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'

export type EntryKind = 'file' | 'folder'

export function CreateEntryDialog({
  kind,
  projectName,
  presetProject,
  folders,
  onCreate,
  onClose,
}: {
  kind: EntryKind
  projectName: string
  presetProject: boolean
  folders: string[]
  onCreate: (path: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const entryName =
    kind === 'folder' ? name.trim().replace(/\/+$/, '') : name.trim()
  const path = parent ? `${parent}/${entryName}` : entryName

  useEffect(() => {
    const restored = () => setError('')
    window.addEventListener(SESSION_RESTORED_EVENT, restored)
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, restored)
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !entryName) return
    if (entryName.startsWith('/')) {
      setError(
        'Enter a name or a path inside this project, without a leading /.',
      )
      return
    }
    if (
      PROJECT_CONFIGURATION_FILES.includes(path.split('/')[0]) &&
      (kind === 'folder' || path.includes('/'))
    ) {
      setError(
        'Project setup files cannot be used as folders. Choose another location.',
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      await onCreate(path)
      onClose()
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={`Create a ${kind}`}
      subtitle={`Choose a location inside ${projectName}.`}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="new-entry-name">
          {kind === 'file' ? 'File name' : 'Folder name'}
        </label>
        <input
          id="new-entry-name"
          autoFocus
          placeholder={kind === 'file' ? 'Extra.lean' : 'Proofs'}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-describedby="new-entry-help new-entry-preview"
          required
          disabled={busy}
        />
        <label className="field-label" htmlFor="new-entry-parent">
          Create in
        </label>
        <select
          id="new-entry-parent"
          value={parent}
          onChange={(event) => setParent(event.target.value)}
          disabled={busy}
        >
          <option value="">Project root — {projectName}</option>
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}/
            </option>
          ))}
        </select>
        <p className="field-help" id="new-entry-help">
          Project root is the top level of your project.
          {folders.includes('Main') && (
            <> Main is a folder inside it; Main.lean is a separate file.</>
          )}
          {kind === 'file' && (
            <> Include the extension, such as .lean or .md.</>
          )}
          {kind === 'file' && presetProject && (
            <>
              {' '}
              Put Lean modules in the Main folder. Create that folder first if
              needed.
            </>
          )}
          <> Use / in the name to create subfolders.</>
        </p>
        <p className="field-help entry-path-preview" id="new-entry-preview">
          Will create:{' '}
          <strong>
            {projectName} / {path || '…'}
          </strong>
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
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy || !entryName}>
            {busy ? (
              <span className="spinner" />
            ) : (
              <Icon name="plus" size={15} />
            )}
            Create {kind}
          </button>
        </footer>
      </form>
    </Dialog>
  )
}
