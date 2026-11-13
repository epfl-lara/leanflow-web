import { useEffect, useState, type FormEvent } from 'react'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { errorText, SESSION_RESTORED_EVENT } from './api'
import { moveProblem, type MoveMode, type MoveSubject } from './moveEntryPaths'

const CHOOSE = '\u0000choose'

function baseName(path: string) {
  return path.split('/').at(-1) ?? path
}
function parentOf(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

export function MoveEntryDialog({
  mode,
  subject,
  projectName,
  folders,
  existing,
  onSubmit,
  onClose,
}: {
  mode: MoveMode
  subject: MoveSubject
  projectName: string
  folders: string[]
  existing: ReadonlySet<string>
  onSubmit: (to: string, updateReferences: boolean) => Promise<void>
  onClose: () => void
}) {
  const currentName = baseName(subject.path)
  const currentParent = parentOf(subject.path)
  const [name, setName] = useState(currentName)
  const [parent, setParent] = useState(CHOOSE)
  const [updateReferences, setUpdateReferences] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const destinations = folders.filter(
    (folder) =>
      folder !== currentParent &&
      folder !== subject.path &&
      !folder.startsWith(subject.path + '/'),
  )
  const canChooseRoot = currentParent !== ''
  const trimmed = name.trim()
  const targetParent = mode === 'rename' ? currentParent : parent
  const target =
    !trimmed || targetParent === CHOOSE
      ? ''
      : targetParent
        ? `${targetParent}/${trimmed}`
        : trimmed
  const problem = trimmed.includes('/')
    ? mode === 'rename'
      ? 'A name cannot contain /. Use Move to choose another folder.'
      : 'A name cannot contain /. Choose the destination folder above.'
    : target
      ? moveProblem(subject, target, existing)
      : ''
  const unchanged = mode === 'rename' ? trimmed === currentName : false

  useEffect(() => {
    const restored = () => setError('')
    window.addEventListener(SESSION_RESTORED_EVENT, restored)
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, restored)
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !target) return
    if (unchanged) {
      onClose()
      return
    }
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSubmit(target, updateReferences)
      onClose()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }

  const label = `${mode === 'rename' ? 'Rename' : 'Move'} ${subject.kind}`
  return (
    <Dialog
      title={label}
      subtitle={`${projectName} / ${subject.path}`}
      onClose={onClose}
      busy={busy}
    >
      <form onSubmit={submit}>
        {mode === 'move' && (
          <>
            <label className="field-label" htmlFor="move-entry-parent">
              Destination folder
            </label>
            <select
              id="move-entry-parent"
              autoFocus
              value={parent}
              onChange={(event) => {
                setParent(event.target.value)
                setError('')
              }}
              aria-describedby="move-entry-parent-help move-entry-preview"
              disabled={busy}
            >
              <option value={CHOOSE} disabled>
                Choose a folder…
              </option>
              {canChooseRoot && (
                <option value="">Project root — {projectName}</option>
              )}
              {destinations.map((folder) => (
                <option key={folder} value={folder}>
                  {folder}/
                </option>
              ))}
            </select>
            <p className="field-help" id="move-entry-parent-help">
              {subject.kind === 'folder'
                ? 'Moves this folder and all its contents inside the destination folder.'
                : 'Moves this file inside the destination folder.'}
            </p>
            {!canChooseRoot && !destinations.length && (
              <p className="field-help">
                There is no other folder to move this into. Create a folder
                first.
              </p>
            )}
          </>
        )}
        <label className="field-label" htmlFor="move-entry-name">
          {mode === 'rename' ? 'New name' : 'Name'}
        </label>
        <input
          id="move-entry-name"
          autoFocus={mode === 'rename'}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError('')
          }}
          onFocus={(event) => {
            const dot = event.currentTarget.value.lastIndexOf('.')
            if (subject.kind === 'file' && dot > 0)
              event.currentTarget.setSelectionRange(0, dot)
            else event.currentTarget.select()
          }}
          aria-describedby="move-entry-help move-entry-preview"
          aria-invalid={!!problem}
          required
          disabled={busy}
        />
        <p className="field-help" id="move-entry-help">
          Unsaved edits are saved first. Existing files are never overwritten.
        </p>
        <label className="setup-repair-choice">
          <input
            type="checkbox"
            checked={updateReferences}
            onChange={(event) => setUpdateReferences(event.target.checked)}
            aria-describedby="move-entry-references-help"
            disabled={busy}
          />
          Update imports and file links
        </label>
        <p className="field-help" id="move-entry-references-help">
          Updates Lean imports, Markdown links and images, and common TeX file
          paths. Other references may need a manual update.
        </p>
        <p className="field-help entry-path-preview" id="move-entry-preview">
          New path: <strong>{target || '…'}</strong>
        </p>
        {(error || (problem && !unchanged && trimmed !== '')) && (
          <p className="error-message" role="alert">
            {error || problem}
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
          <button
            className="button primary"
            disabled={busy || !target || (!!problem && !unchanged)}
          >
            {busy ? (
              <span className="spinner" />
            ) : (
              <Icon name="folder" size={15} />
            )}
            {label}
          </button>
        </footer>
      </form>
    </Dialog>
  )
}
