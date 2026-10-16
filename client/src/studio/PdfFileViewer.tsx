import { useEffect, useState } from 'react'
import { apiPdf, errorText, SESSION_RESTORED_EVENT } from './api'

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
  const [loaded, setLoaded] = useState<{
    key: string
    url?: string
    error?: string
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const previewPath =
    previewUrl ||
    `/api/projects/${encodeURIComponent(projectId)}/file-preview?path=${encodeURIComponent(path)}`
  const requestKey = JSON.stringify([projectId, previewPath, revision, attempt])
  // Effects run after rendering. A new project or build must never render the
  // previous request's document while its replacement begins loading.
  const url = loaded?.key === requestKey ? loaded.url : undefined
  const error = loaded?.key === requestKey ? loaded.error : undefined

  useEffect(() => {
    const retry = () => setAttempt((current) => current + 1)
    window.addEventListener(SESSION_RESTORED_EVENT, retry)
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, retry)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setLoaded(null)
    void apiPdf(previewPath, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setLoaded({ key: requestKey, url: objectUrl })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({ key: requestKey, error: errorText(error) })
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [previewPath, requestKey])

  return (
    <section className="pdf-file-viewer" aria-label="PDF document">
      {url ? (
        <>
          <div className="pdf-file-actions" hidden={!showActions}>
            <button
              className="button small secondary"
              onClick={() => setAttempt((current) => current + 1)}
            >
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
              href={previewPath}
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
          <button
            className="button secondary"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Retry PDF
          </button>
        </div>
      ) : (
        <output className="file-preview-loading">Loading PDF…</output>
      )}
    </section>
  )
}
