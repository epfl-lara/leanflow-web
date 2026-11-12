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
  onSubmit: (to: string) => Promise<void>
  onClose: () => void
}) {
  const currentName = baseName(subject.path)
  const currentParent = parentOf(subject.path)
  const [name, setName] = useState(currentName)
  const [parent, setParent] = useState(CHOOSE)
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
  const target =
    mode === 'rename'
      ? !trimmed
        ? ''
        : currentParent
          ? `${currentParent}/${trimmed}`
          : trimmed
      : parent === CHOOSE
        ? ''
        : parent
          ? `${parent}/${currentName}`
          : currentName
  const problem =
    mode === 'rename' && trimmed.includes('/')
      ? 'A name cannot contain /. Use Move to choose another folder.'
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
      await onSubmit(target)
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
        {mode === 'rename' ? (
          <>
            <label className="field-label" htmlFor="move-entry-name">
              New name
            </label>
            <input
              id="move-entry-name"
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError('')
              }}
              onFocus={(event) => {
                const dot = currentName.lastIndexOf('.')
                if (subject.kind === 'file' && dot > 0)
                  event.currentTarget.setSelectionRange(0, dot)
                else event.currentTarget.select()
              }}
              aria-describedby="move-entry-help move-entry-preview"
              aria-invalid={!!problem}
              required
              disabled={busy}
            />
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="move-entry-parent">
              Move to
            </label>
            <select
              id="move-entry-parent"
              autoFocus
              value={parent}
              onChange={(event) => {
                setParent(event.target.value)
                setError('')
              }}
              aria-describedby="move-entry-help move-entry-preview"
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
            {!canChooseRoot && !destinations.length && (
              <p className="field-help">
                There is no other folder to move this into. Create a folder
                first.
              </p>
            )}
          </>
        )}
        <p className="field-help" id="move-entry-help">
          {mode === 'rename'
            ? 'Contents are kept. Lean imports that use the old name are not updated; fix them after renaming.'
            : 'Contents are kept. Lean imports that use the old location are not updated; fix them after moving.'}{' '}
          Unsaved edits are saved first. Existing files are never overwritten.
        </p>
        <p className="field-help entry-path-preview" id="move-entry-preview">
          New path:{' '}
          <strong>
            {projectName} / {target || '…'}
          </strong>
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
