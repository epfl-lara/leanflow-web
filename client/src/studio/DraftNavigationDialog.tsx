import { Dialog } from './Dialog'
import { DraftDownloads } from './DraftDownloads'
import { Icon } from './Icons'

export function DraftNavigationDialog({
  files,
  destination,
  error,
  saving,
  onClose,
  onDiscard,
  onSave,
}: {
  files: readonly { path: string; content: string; readOnly?: boolean }[]
  destination: string
  error: string
  saving: boolean
  onClose: () => void
  onDiscard: () => void
  onSave: () => void
}) {
  const readOnly = files.some((file) => file.readOnly)
  return (
    <Dialog
      title={readOnly ? 'Keep your unsaved drafts?' : 'Save your changes?'}
      subtitle={
        files.length > 1
          ? `${files.length} files have unsaved edits.`
          : `${files[0]?.path || 'This file'} has unsaved edits.`
      }
      onClose={onClose}
      busy={saving}
    >
      <p className="dialog-body">
        {readOnly
          ? 'Your access has changed. Download your drafts before continuing, or discard these edits.'
          : destination
            ? `Save all changed files before opening ${destination}, or discard these edits.`
            : 'Save all changed files before continuing, or discard these edits.'}
      </p>
      {readOnly && <DraftDownloads files={files} />}
      {error && (
        <p className="error-message" role="alert">
          {error} Your drafts are kept in this tab. Cancel to keep them.
        </p>
      )}
      <footer className="dialog-actions">
        <button
          className="button secondary"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          className="button secondary"
          onClick={onDiscard}
          disabled={saving}
        >
          Discard edits
        </button>
        {!readOnly && (
          <button className="button primary" onClick={onSave} disabled={saving}>
            {saving ? (
              <span className="spinner" />
            ) : (
              <Icon name="save" size={15} />
            )}
            Save &amp; continue
          </button>
        )}
      </footer>
    </Dialog>
  )
}
