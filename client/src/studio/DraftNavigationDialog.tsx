import { Dialog } from './Dialog'
import { DraftDownloads } from './DraftDownloads'
import { Icon } from './Icons'

export function DraftNavigationDialog({
  files,
  destination,
  closingFile,
  error,
  saving,
  onClose,
  onDiscard,
  onSave,
}: {
  files: readonly {
    path: string
    content: string
    readOnly?: boolean
    unavailable?: boolean
  }[]
  destination: string
  closingFile?: string | null
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
        {files.some((file) => file.unavailable)
          ? 'This file was deleted or moved. Download its draft before closing it, or discard its edits.'
          : readOnly
            ? 'Your access has changed. Download your drafts before continuing, or discard these edits.'
            : closingFile
              ? `Save your changes before closing ${closingFile}, or discard only this file’s edits. Other drafts will be kept.`
              : destination
                ? `Save all changed files before opening ${destination}, or discard these edits.`
                : 'Save all changed files before continuing, or discard these edits.'}
      </p>
      <DraftDownloads files={files} />
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
          {closingFile ? 'Discard this file' : 'Discard edits'}
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
