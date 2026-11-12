import type { OpenFile } from './api'
import { DraftDownloads } from './DraftDownloads'

export function DetachedDraftNotice({
  files,
  canRecover,
  onRecover,
}: {
  files: readonly OpenFile[]
  canRecover: boolean
  onRecover: (path: string) => void
}) {
  if (!files.length) return null
  const drafts = files.filter((file) => file.content !== file.savedContent)
  return (
    <div className="workspace-alert draft-protection-alert" role="status">
      <span>
        {drafts.length
          ? 'Some files were deleted or moved. Their unsaved drafts are kept here. Other files can still save.'
          : `${files[0].path} was deleted or moved. Choose a saved file from the file list.`}
      </span>
      <DraftDownloads files={drafts} />
      {canRecover &&
        drafts.map((file) => (
          <button
            key={file.path}
            className="button small secondary"
            onClick={() => onRecover(file.path)}
          >
            Save a copy: {file.path}
          </button>
        ))}
    </div>
  )
}
