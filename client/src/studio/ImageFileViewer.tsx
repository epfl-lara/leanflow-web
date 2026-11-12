import { useState } from 'react'
import { useFilePreview } from './useFilePreview'
import { errorText } from './api'
import { downloadWorkspaceFile } from './downloads'

export function ImageFileViewer({
  projectId,
  path,
  revision,
}: {
  projectId: string
  path: string
  revision?: string | number
}) {
  const {
    content: url,
    error,
    retry,
  } = useFilePreview(
    `/api/projects/${encodeURIComponent(projectId)}/file-preview?path=${encodeURIComponent(path)}`,
    'image',
    revision,
    projectId,
  )
  const [actualSize, setActualSize] = useState(false)
  const [dimensions, setDimensions] = useState('')
  const [decodeError, setDecodeError] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const reload = () => {
    setDecodeError(false)
    setDimensions('')
    retry()
  }
  return (
    <section className="image-file-viewer" aria-label="Image preview">
      <div className="media-file-actions">
        <button className="button small secondary" onClick={reload}>
          Reload image
        </button>
        {url && !decodeError && (
          <>
            <button
              className="button small subtle"
              aria-pressed={actualSize}
              onClick={() => setActualSize((current) => !current)}
            >
              {actualSize ? 'Fit image' : 'Actual size'}
            </button>
            <button
              className="button small subtle"
              disabled={downloading}
              onClick={() => {
                setDownloading(true)
                setDownloadError('')
                void downloadWorkspaceFile(projectId, path)
                  .catch((error) => setDownloadError(errorText(error)))
                  .finally(() => setDownloading(false))
              }}
            >
              {downloading ? 'Downloading…' : 'Download image'}
            </button>
            {dimensions && <span className="field-help">{dimensions}</span>}
          </>
        )}
      </div>
      {downloadError && (
        <p className="error-message" role="alert">
          {downloadError}
        </p>
      )}
      {error || decodeError ? (
        <div className="file-preview-error">
          <p className="error-message" role="alert">
            {error ||
              'Your browser could not display this image. Check the file or try another image format.'}
          </p>
          <button className="button secondary" onClick={reload}>
            Retry image
          </button>
        </div>
      ) : url ? (
        <div className={`image-file-canvas ${actualSize ? 'actual-size' : ''}`}>
          <img
            src={url}
            alt={path.split('/').at(-1) || path}
            onError={() => setDecodeError(true)}
            onLoad={(event) =>
              setDimensions(
                `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`,
              )
            }
          />
        </div>
      ) : (
        <output className="file-preview-loading">Loading image…</output>
      )}
    </section>
  )
}
