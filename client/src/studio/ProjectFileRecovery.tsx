import { useState } from 'react'
import { api, errorText, type Project } from './api'
import { downloadProject } from './downloads'
import { DraftDownloads } from './DraftDownloads'
import { Icon } from './Icons'

const recoveryError = (error: unknown) =>
  error instanceof DOMException && error.name === 'TimeoutError'
    ? 'The request took too long. Your drafts are kept. Wait briefly, then refresh project status before retrying recovery.'
    : errorText(error)

export function ProjectFileRecovery({
  project,
  drafts,
  onRecovered,
}: {
  project: Project
  drafts: readonly { path: string; content: string }[]
  onRecovered: (project: Project) => void
}) {
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const admin = !project.accessRole || project.accessRole === 'admin'

  async function retry() {
    if (busy || downloading || refreshing) return
    setBusy(true)
    setError('')
    try {
      const recovered = await api<Project>(
        `/api/projects/${encodeURIComponent(project.id)}/file-recovery/retry`,
        {
          method: 'POST',
          body: '{}',
          signal: AbortSignal.timeout(30000),
        },
      )
      onRecovered(recovered)
    } catch (error) {
      setError(recoveryError(error))
    } finally {
      setBusy(false)
    }
  }

  async function refresh() {
    if (busy || downloading || refreshing) return
    setRefreshing(true)
    setError('')
    try {
      onRecovered(
        await api<Project>(`/api/projects/${encodeURIComponent(project.id)}`, {
          signal: AbortSignal.timeout(15000),
        }),
      )
    } catch (error) {
      setError(recoveryError(error))
    } finally {
      setRefreshing(false)
    }
  }

  async function download() {
    if (busy || downloading || refreshing) return
    setDownloading(true)
    setError('')
    try {
      await downloadProject(project.id, project.name)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <section
      className="preparation-state project-file-recovery"
      aria-label="Project file recovery"
      aria-busy={busy || refreshing}
    >
      <h1>Project files need recovery</h1>
      <p>
        Editing and project jobs are paused after an interrupted file update.
        Your unsaved drafts remain in this tab. Download the available project
        files and keep a copy of your drafts before continuing.
      </p>
      <button
        className="button secondary"
        disabled={busy || downloading || refreshing}
        onClick={() => void download()}
      >
        {downloading ? 'Downloading project…' : 'Download project'}
      </button>
      <DraftDownloads files={drafts} />
      <button
        className="button secondary"
        disabled={busy || downloading || refreshing}
        onClick={() => void refresh()}
      >
        {refreshing ? 'Refreshing project status…' : 'Refresh project status'}
      </button>
      {admin ? (
        <>
          <p>
            Retry recovery after project work finishes. This keeps your drafts
            and leaves other projects running. If recovery still fails, ask the
            server administrator to check project storage.
          </p>
          <button
            className="button primary"
            disabled={busy || downloading || refreshing}
            onClick={() => void retry()}
          >
            {busy ? (
              <span className="spinner" />
            ) : (
              <Icon name="refresh" size={16} />
            )}
            {busy ? 'Recovering project files…' : 'Retry file recovery'}
          </button>
        </>
      ) : (
        <p>
          Ask a project Admin to retry file recovery. You can still download the
          available files.
        </p>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
