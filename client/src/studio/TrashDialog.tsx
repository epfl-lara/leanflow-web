import { useState } from 'react'
import { errorText, type TrashDeleteResult, type TrashItem } from './api'
import { Dialog } from './Dialog'
import { Icon } from './Icons'

const itemName = (item: TrashItem) =>
  item.name || item.path || item.projectName || 'Deleted project'
const itemKind = (item: TrashItem) =>
  item.kind === 'project' && item.workspaceKind === 'single-file'
    ? 'playground'
    : item.kind
const itemSize = (item: TrashItem) =>
  item.sizeBytes == null
    ? 'Size unavailable'
    : `${(item.sizeBytes / 1_000_000).toFixed(2)} MB`

export function TrashDialog({
  items,
  error,
  restoring,
  onRestore,
  onDeleteForever,
  onDeleteAll,
  onClose,
}: {
  items: TrashItem[]
  error: string
  restoring: string | null
  onRestore: (item: TrashItem) => Promise<void>
  onDeleteForever: (item: TrashItem) => Promise<void>
  onDeleteAll: (items: TrashItem[]) => Promise<TrashDeleteResult>
  onClose: () => void
}) {
  const [selected, setSelected] = useState<TrashItem | null>(null)
  const [selectedAll, setSelectedAll] = useState<TrashItem[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const busy = !!restoring || deleting
  const confirming = !!selected || !!selectedAll
  const archivedProjects = new Set(
    selectedAll
      ?.filter((item) => item.kind === 'project')
      .map((item) => item.projectId),
  )
  const sizedItems =
    selectedAll?.filter(
      (item) =>
        item.kind === 'project' ||
        item.kind === 'chat' ||
        !archivedProjects.has(item.projectId),
    ) || []
  const totalBytes = sizedItems.reduce(
    (sum, item) => sum + (item.sizeBytes || 0),
    0,
  )
  const unknownSizes = sizedItems.filter(
    (item) => item.sizeBytes == null,
  ).length

  async function deleteForever() {
    if (!confirming || busy) return
    setDeleting(true)
    setDeleteError('')
    try {
      if (selected) {
        await onDeleteForever(selected)
        setSelected(null)
      } else if (selectedAll) {
        const result = await onDeleteAll(selectedAll)
        if (result.failures.length) {
          const remaining = new Set(
            result.failures.map((failure) => failure.trashId),
          )
          setSelectedAll(
            selectedAll.filter((item) => remaining.has(item.trashId)),
          )
          setDeleteError(
            result.failures
              .map((failure) => `${failure.name}: ${failure.error}`)
              .join('\n'),
          )
        } else setSelectedAll(null)
      }
    } catch (error) {
      setDeleteError(errorText(error))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog
      title={
        selectedAll
          ? 'Delete all trash?'
          : selected
            ? 'Permanently delete item?'
            : 'Trash'
      }
      subtitle={
        confirming
          ? 'Permanent deletion cannot be undone.'
          : 'Restore deleted files, folders, projects, or chats, or delete them forever.'
      }
      busy={busy}
      onClose={onClose}
    >
      {confirming ? (
        <>
          <div className="delete-confirmation">
            {selected && (
              <>
                <p>
                  Permanently delete <strong>{itemName(selected)}</strong>?
                </p>
                <dl className="trash-details">
                  <dt>Type</dt>
                  <dd>{itemKind(selected)}</dd>
                  <dt>Project</dt>
                  <dd>{selected.projectName || selected.projectId}</dd>
                  {selected.path && (
                    <>
                      <dt>Path</dt>
                      <dd>{selected.path}</dd>
                    </>
                  )}
                  <dt>
                    {selected.kind === 'chat' ? 'Stored size' : 'Size on disk'}
                  </dt>
                  <dd>{itemSize(selected)}</dd>
                  <dt>Deleted</dt>
                  <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                </dl>
                {selected.kind === 'project' && (
                  <p>This also deletes the project's saved chats and runs.</p>
                )}
              </>
            )}
            {selectedAll && (
              <>
                <p>
                  Permanently delete{' '}
                  <strong>
                    {selectedAll.length}{' '}
                    {selectedAll.length === 1 ? 'item' : 'items'}
                  </strong>{' '}
                  from Trash?
                </p>
                <dl className="trash-details">
                  <dt>{unknownSizes ? 'Known size' : 'Total size'}</dt>
                  <dd>{(totalBytes / 1_000_000).toFixed(2)} MB</dd>
                </dl>
                {unknownSizes > 0 && (
                  <p>
                    Size is unavailable for {unknownSizes}{' '}
                    {unknownSizes === 1 ? 'item' : 'items'}.
                  </p>
                )}
                <p>
                  This includes saved chats and runs for trashed projects. It
                  cannot be undone.
                </p>
              </>
            )}
            {deleteError && (
              <p
                className="error-message"
                role="alert"
                style={{ whiteSpace: 'pre-line' }}
              >
                {deleteError}
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setSelected(null)
                setSelectedAll(null)
              }}
            >
              Do Nothing
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() => void deleteForever()}
            >
              {deleting ? 'Deleting…' : 'Delete Forever'}
            </button>
          </footer>
        </>
      ) : (
        <>
          <div className="trash-list">
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            {!items.length && !error && (
              <p className="field-help">Trash is empty.</p>
            )}
            {items.map((item) => (
              <div className="trash-item" key={item.trashId}>
                <button
                  className="button small secondary"
                  disabled={busy || item.recoverable === false}
                  onClick={() => void onRestore(item)}
                >
                  {restoring === item.trashId ? 'Restoring…' : 'Restore'}
                </button>
                <Icon
                  name={
                    item.kind === 'file' || item.workspaceKind === 'single-file'
                      ? 'file'
                      : item.kind === 'chat'
                        ? 'bot'
                        : 'folder'
                  }
                  size={18}
                />
                <div>
                  <strong>{itemName(item)}</strong>
                  <span>
                    {itemKind(item)} · {item.projectName || item.projectId} ·{' '}
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
                <span
                  className="trash-size"
                  title={
                    item.kind === 'chat' ? 'Stored chat size' : 'Size on disk'
                  }
                >
                  {itemSize(item)}
                </span>
                <button
                  className="icon-button trash-delete-forever"
                  aria-label={`Permanently delete ${itemName(item)}`}
                  title={`Permanently delete ${itemName(item)}`}
                  disabled={busy}
                  onClick={() => {
                    setDeleteError('')
                    setSelected(item)
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
          <footer className="dialog-actions">
            <button
              className="button danger"
              disabled={busy || !items.length || !!error}
              onClick={() => {
                setDeleteError('')
                setSelectedAll([...items])
              }}
            >
              <Icon name="trash" size={16} />
              Delete All
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={onClose}
            >
              Close
            </button>
          </footer>
        </>
      )}
    </Dialog>
  )
}
