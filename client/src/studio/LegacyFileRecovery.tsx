import { useEffect, useRef, useState } from 'react'
import { saveAs } from 'file-saver'
import { api, apiDownload, errorText, type Project } from './api'

interface RecoveryReview {
  id: string
  revision: string | null
  createdAt?: string
  canRestore: boolean
  error: string | null
  fileCount: number
  fileOffset: number
  nextFileOffset: number | null
  files: {
    path: string
    originalHash: string | null
    originalAvailable: boolean
    originalDownloadAvailable: boolean
    alreadyOriginal: boolean
    changedAfterUpdate: boolean
  }[]
}

interface RecoveryPage {
  reviews: RecoveryReview[]
  nextCursor: string | null
  totalRecords: number
  scanDeferred?: boolean
}

const issue = (error: unknown) =>
  error instanceof DOMException && error.name === 'TimeoutError'
    ? 'The recovery review took too long. Your files are kept. Try again, or ask the server administrator to check recovery storage.'
    : errorText(error)

export function LegacyFileRecovery({
  project,
  onRecovered,
}: {
  project: Project
  onRecovered: (project: Project) => void
}) {
  const [page, setPage] = useState<RecoveryPage>({
    reviews: [],
    nextCursor: null,
    totalRecords: 0,
  })
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<{
    id: string
    decision: 'restore' | 'keep-current'
  } | null>(null)
  const request = useRef<AbortController | null>(null)
  const base = `/api/projects/${encodeURIComponent(project.id)}/file-recovery/legacy`

  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    void api<RecoveryPage>(base, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    })
      .then((value) => {
        if (request.current === controller) setPage(value)
      })
      .catch((error) => {
        if (request.current === controller && !controller.signal.aborted)
          setError(issue(error))
      })
      .finally(() => {
        if (request.current === controller) {
          request.current = null
          setLoading(false)
        }
      })
    return () => {
      controller.abort()
      request.current?.abort()
      request.current = null
    }
  }, [base])

  async function perform(operation: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError('')
    try {
      await operation(
        AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      )
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted)
        setError(issue(error))
    } finally {
      if (request.current === controller) {
        request.current = null
        setBusy(false)
      }
    }
  }

  async function refresh(cursor?: string) {
    await perform(async (signal) => {
      const query = cursor ? `?${new URLSearchParams({ cursor })}` : ''
      const updated = await api<RecoveryPage>(base + query, { signal })
      if (signal.aborted) return
      setPage(updated)
      setConfirmation(null)
    })
  }

  async function filePage(review: RecoveryReview, fileOffset: number) {
    await perform(async (signal) => {
      const query = new URLSearchParams({
        recordId: review.id,
        fileOffset: String(fileOffset),
      })
      const updated = await api<RecoveryPage>(`${base}?${query}`, { signal })
      if (signal.aborted) return
      const record = updated.reviews.find((item) => item.id === review.id)
      if (!record)
        throw new Error(
          'This update has already been reviewed. Refresh project status above.',
        )
      setPage((current) => ({
        ...current,
        totalRecords: updated.totalRecords,
        reviews: current.reviews.map((item) =>
          item.id === record.id ? record : item,
        ),
      }))
      setConfirmation(null)
    })
  }

  async function download(review: RecoveryReview, filename: string) {
    await perform(async (signal) => {
      const result = await apiDownload(
        `${base}/${encodeURIComponent(review.id)}/original?${new URLSearchParams({ path: filename })}`,
        { signal },
      )
      if (!signal.aborted)
        saveAs(result.blob, `original-${filename.split('/').at(-1) || 'file'}`)
    })
  }

  async function resolve(
    review: RecoveryReview,
    decision: 'restore' | 'keep-current',
  ) {
    await perform(async (signal) => {
      const recovered = await api<Project>(
        `${base}/${encodeURIComponent(review.id)}`,
        {
          method: 'POST',
          body: JSON.stringify({ revision: review.revision, decision }),
          signal,
        },
      )
      if (signal.aborted) return
      onRecovered(recovered)
      setPage((current) => ({
        ...current,
        totalRecords: Math.max(0, current.totalRecords - 1),
        reviews: current.reviews.filter((item) => item.id !== review.id),
      }))
      setConfirmation(null)
    })
  }

  return (
    <section aria-label="Review older file updates" aria-busy={busy || loading}>
      <h2>Review older interrupted updates</h2>
      <p>
        These updates were made by an older version. Download the current
        project and your drafts above. Review the retained originals before
        choosing what to keep. Other projects stay available.
      </p>
      <button
        className="button secondary"
        disabled={busy || loading}
        onClick={() => void refresh()}
      >
        Refresh recovery review
      </button>
      {loading && <p>Checking retained files…</p>}
      {!loading &&
        !error &&
        !page.reviews.length &&
        !page.totalRecords &&
        !page.scanDeferred && (
          <p>
            No older updates remain. Refresh projects to update their status.
          </p>
        )}
      {page.scanDeferred && (
        <p>
          Some older history has not been checked. Refresh the review to
          continue checking. Your current files are kept.
        </p>
      )}
      {!loading && page.totalRecords > 0 && (
        <p>
          {page.totalRecords} interrupted update
          {page.totalRecords === 1 ? '' : 's'} still need review. Up to five are
          shown at a time.
        </p>
      )}
      {page.reviews.map((review) => (
        <div key={review.id} className="legacy-recovery-record">
          <h3>
            Interrupted file update
            {review.createdAt
              ? ` · ${new Date(review.createdAt).toLocaleString()}`
              : ''}
          </h3>
          {review.error && <p role="alert">{review.error}</p>}
          <p>
            {review.fileCount} affected file{review.fileCount === 1 ? '' : 's'}
            {review.files.length
              ? ` · Showing ${review.fileOffset + 1}–${review.fileOffset + review.files.length}`
              : ''}
          </p>
          <ul
            style={{
              maxHeight: '36vh',
              overflow: 'auto',
              overflowWrap: 'anywhere',
              paddingInlineStart: '20px',
            }}
          >
            {review.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                {' · '}
                {file.alreadyOriginal
                  ? 'Original is already saved'
                  : file.changedAfterUpdate
                    ? 'Changed since this update; automatic restore is unavailable'
                    : file.originalHash === null
                      ? 'Created by this update; restoring removes this file'
                      : file.originalAvailable
                        ? 'Original available'
                        : 'Original unavailable'}{' '}
                {file.originalHash && file.originalDownloadAvailable && (
                  <button
                    className="button secondary"
                    aria-label={`Download original ${file.path}`}
                    disabled={busy}
                    onClick={() => void download(review, file.path)}
                  >
                    Download original
                  </button>
                )}
              </li>
            ))}
          </ul>
          {(review.fileOffset > 0 || review.nextFileOffset !== null) && (
            <div className="button-row" aria-label="Recovery file pages">
              <button
                className="button secondary"
                disabled={busy || review.fileOffset === 0}
                onClick={() =>
                  void filePage(review, Math.max(0, review.fileOffset - 100))
                }
              >
                Previous files
              </button>
              <button
                className="button secondary"
                disabled={busy || review.nextFileOffset === null}
                onClick={() => {
                  if (review.nextFileOffset !== null)
                    void filePage(review, review.nextFileOffset)
                }}
              >
                Next files
              </button>
            </div>
          )}
          {confirmation?.id === review.id ? (
            <fieldset
              aria-label="Confirm recovery choice"
              style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
            >
              <p>
                {confirmation.decision === 'restore'
                  ? `Restoring affects all ${review.fileCount} files in this update, including files on other pages. It replaces them with their retained originals and removes files created by this update. Current files are backed up in history. Later unexpected edits are never overwritten.`
                  : 'Keeping the current files leaves this update unchanged and marks it reviewed. Editing resumes after every interrupted update is reviewed. An incomplete update may remain. The retained originals stay in history.'}
              </p>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void resolve(review, confirmation.decision)}
              >
                {busy
                  ? 'Saving recovery choice…'
                  : confirmation.decision === 'restore'
                    ? 'Confirm restore originals'
                    : 'Confirm keep current files'}
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
            </fieldset>
          ) : (
            <div className="button-row">
              <button
                className="button secondary"
                disabled={busy || !review.canRestore || !review.revision}
                onClick={() =>
                  setConfirmation({ id: review.id, decision: 'restore' })
                }
              >
                Restore originals
              </button>
              <button
                className="button secondary"
                disabled={busy || !review.revision}
                onClick={() =>
                  setConfirmation({ id: review.id, decision: 'keep-current' })
                }
              >
                Keep current files
              </button>
            </div>
          )}
        </div>
      ))}
      {page.nextCursor && (
        <button
          className="button secondary"
          disabled={busy || loading}
          onClick={() => void refresh(page.nextCursor || undefined)}
        >
          Next interrupted updates
        </button>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
