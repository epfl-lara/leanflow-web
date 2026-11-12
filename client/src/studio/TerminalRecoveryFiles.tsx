import { useEffect, useState } from 'react'
import { api, ApiError, errorText } from './api'

interface RecoveryFiles {
  files: { path: string; size: number; downloadable: boolean }[]
  fileByteLimit: number
}

const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${bytes.toLocaleString()} bytes`

export function TerminalRecoveryFiles({
  projectId,
  runId,
}: {
  projectId: string
  runId: string
}) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/terminal-recoveries/${encodeURIComponent(runId)}`
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<RecoveryFiles | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<{
    message: string
    retryable: boolean
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!open || listing) return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void api<RecoveryFiles>(`${base}/files`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    })
      .then((value) => {
        if (controller.signal.aborted) return
        setListing(value)
        setLoading(false)
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        setError({
          message: errorText(error),
          retryable: !(error instanceof ApiError && error.status === 413),
        })
        setLoading(false)
      })
    return () => controller.abort()
  }, [base, open, listing, attempt])
  return (
    <details
      className="terminal-recovery-files"
      aria-busy={loading}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Choose individual files</summary>
      {loading && <p role="status">Loading recovery files…</p>}
      {error && (
        <div>
          <p className="error-message" role="alert">
            {error.message}
          </p>
          {error.retryable && (
            <button
              type="button"
              className="button small secondary"
              disabled={loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry recovery files
            </button>
          )}
        </div>
      )}
      {listing && (
        <>
          <p>
            Download individual files when the ZIP is too large. Each file can
            be up to {fileSize(listing.fileByteLimit)}.
          </p>
          {listing.files.length ? (
            <ul aria-label="Individual recovery files">
              {listing.files.map((file) => (
                <li key={file.path}>
                  <div>
                    <span>{file.path}</span>
                    <span>{fileSize(file.size)}</span>
                  </div>
                  {file.downloadable ? (
                    <a
                      className="button small secondary"
                      href={`${base}/download?path=${encodeURIComponent(file.path)}`}
                      aria-label={`Download ${file.path}`}
                      download
                    >
                      Download file
                    </a>
                  ) : (
                    <span>
                      This file exceeds the {fileSize(listing.fileByteLimit)}{' '}
                      download limit. Ask the server administrator to recover
                      it.
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>No downloadable files were found in this private copy.</p>
          )}
        </>
      )}
    </details>
  )
}
