import { sessionBoundUrl } from './api'
import { useFilePreview } from './useFilePreview'

export function PdfFileViewer({
  projectId,
  path,
  previewUrl,
  revision,
  showActions = true,
  fitWidth = false,
}: {
  projectId: string
  path: string
  previewUrl?: string
  revision?: string
  showActions?: boolean
  fitWidth?: boolean
}) {
  const previewPath =
    previewUrl ||
    `/api/projects/${encodeURIComponent(projectId)}/file-preview?path=${encodeURIComponent(path)}`
  const {
    content: url,
    error,
    retry,
  } = useFilePreview(previewPath, 'pdf', revision, projectId)

  return (
    <section className="pdf-file-viewer" aria-label="PDF document">
      {url ? (
        <>
          <div className="pdf-file-actions" hidden={!showActions}>
            <button className="button small secondary" onClick={retry}>
              Reload PDF
            </button>
            <a
              className="button small secondary"
              href={url}
              download={path.split('/').at(-1)}
            >
              Download PDF
            </a>
            <a
              className="button small subtle"
              href={sessionBoundUrl(previewPath)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open PDF in new tab
            </a>
          </div>
          <iframe
            title="PDF preview"
            src={fitWidth ? `${url}#view=FitH&navpanes=0` : url}
          />
        </>
      ) : error ? (
        <div className="file-preview-error">
          <p className="error-message" role="alert">
            {error}
          </p>
          <button className="button secondary" onClick={retry}>
            Retry PDF
          </button>
        </div>
      ) : (
        <output className="file-preview-loading">Loading PDF…</output>
      )}
    </section>
  )
}
