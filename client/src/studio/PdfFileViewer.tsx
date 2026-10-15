import { useEffect, useState } from 'react'
import { apiPdf, errorText, SESSION_RESTORED_EVENT } from './api'

export function PdfFileViewer({
  projectId,
  path,
  previewUrl,
  revision,
}: {
  projectId: string
  path: string
  previewUrl?: string
  revision?: string
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const previewPath =
    previewUrl ||
    `/api/projects/${encodeURIComponent(projectId)}/file-preview?path=${encodeURIComponent(path)}`

  useEffect(() => {
    const retry = () => setAttempt((current) => current + 1)
    window.addEventListener(SESSION_RESTORED_EVENT, retry)
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, retry)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    setUrl('')
    setError('')
    void apiPdf(previewPath, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(errorText(error))
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [previewPath, revision, attempt])

  return (
    <section className="pdf-file-viewer" aria-label="PDF document">
      {url ? (
        <>
          <div className="pdf-file-actions">
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
          <iframe title="PDF preview" src={url} />
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
