import { saveAs } from 'file-saver'

export function DraftDownloads({
  files,
}: {
  files: readonly { path: string; content: string }[]
}) {
  if (!files.length) return null
  return (
    <div className="draft-downloads">
      {files.map((file) => (
        <button
          type="button"
          className="button small secondary"
          key={file.path}
          onClick={() =>
            saveAs(
              new Blob([file.content], { type: 'text/plain;charset=utf-8' }),
              file.path.split('/').at(-1) || 'draft.txt',
            )
          }
        >
          Download draft: {file.path}
        </button>
      ))}
    </div>
  )
}
