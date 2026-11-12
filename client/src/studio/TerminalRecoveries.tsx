import { useEffect, useRef, useState } from 'react'
import { api, errorText } from './api'
import { TerminalRecoveryFiles } from './TerminalRecoveryFiles'
import './terminal.css'

interface TerminalRecovery {
  projectId: string
  projectName?: string
  runId: string
  createdAt: string
  message: string
  status: 'ready' | 'interrupted'
}

export function TerminalRecoveries({
  projectId,
  refreshKey,
  active,
}: {
  projectId?: string
  refreshKey: string
  active: boolean
}) {
  const [recoveries, setRecoveries] = useState<TerminalRecovery[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [discard, setDiscard] = useState<string | null>(null)
  const [discarding, setDiscarding] = useState(false)
  const [discardError, setDiscardError] = useState('')
  const mutation = useRef(0)
  const discardButtons = useRef(new Map<string, HTMLButtonElement>())
  const confirmButton = useRef<HTMLButtonElement>(null)
  const previousDiscard = useRef<string | null>(null)
  useEffect(() => {
    if (discard) confirmButton.current?.focus()
    else if (previousDiscard.current)
      discardButtons.current.get(previousDiscard.current)?.focus()
    previousDiscard.current = discard
  }, [discard])
  async function discardRecovery(recovery: TerminalRecovery) {
    const { runId, projectId: recoveryProjectId } = recovery
    setDiscarding(true)
    setDiscardError('')
    try {
      await api(
        `/api/projects/${encodeURIComponent(recoveryProjectId)}/terminal-recoveries/${encodeURIComponent(runId)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(15000),
        },
      )
      mutation.current++
      setRecoveries((previous) =>
        previous.filter((copy) => copy.runId !== runId),
      )
      setDiscard(null)
    } catch (error) {
      setDiscardError(errorText(error))
    } finally {
      setDiscarding(false)
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    const refresh = async () => {
      const revision = mutation.current
      try {
        const value = await api<TerminalRecovery[]>(
          projectId
            ? `/api/projects/${encodeURIComponent(projectId)}/terminal-recoveries`
            : '/api/terminal-recoveries',
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          },
        )
        if (!controller.signal.aborted && mutation.current === revision) {
          setRecoveries(
            value.map((recovery) => ({
              ...recovery,
              projectId: recovery.projectId || projectId || '',
            })),
          )
          setError('')
          setLoaded(true)
        }
      } catch (error) {
        if (!controller.signal.aborted && mutation.current === revision)
          setError(errorText(error))
      }
    }
    void refresh()
    // Closing a disconnected shell can finish just after its socket closes.
    const timer = setTimeout(() => void refresh(), 1000)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, refreshKey, active, attempt])

  if (active) return null
  if (error)
    return (
      <div className="terminal-recovery-notice">
        <span>Terminal recovery files could not load. {error}</span>
        <button
          className="button small subtle"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry terminal recoveries
        </button>
      </div>
    )
  if (!recoveries.length)
    return projectId ? null : (
      <p className="field-help">
        {loaded
          ? 'No private terminal copies to recover.'
          : 'Loading private terminal copies…'}
      </p>
    )
  const contents = (
    <>
      <p>
        These closed or interrupted private working copies are available for
        recovery. Download a ZIP and copy the files you need back into the
        project. Terminal Git history stays private; use Source control to
        publish project history. Download anything you need before discarding a
        copy. Up to eight private copies can be retained per account.
      </p>
      {discardError && (
        <p className="error-message" role="alert">
          {discardError}
        </p>
      )}
      <ul>
        {recoveries.map((recovery) => (
          <li key={recovery.runId}>
            <div>
              {recovery.projectName && <strong>{recovery.projectName}</strong>}
              <strong>{new Date(recovery.createdAt).toLocaleString()}</strong>
              {recovery.status === 'interrupted' && (
                <span>Terminal interrupted</span>
              )}
              <span>{recovery.message}</span>
            </div>
            <a
              className="button small secondary"
              href={`/api/projects/${encodeURIComponent(recovery.projectId)}/terminal-recoveries/${encodeURIComponent(recovery.runId)}/download`}
              download
            >
              Download terminal files
            </a>
            {discard === recovery.runId ? (
              <span className="terminal-recovery-confirmation">
                <span>Delete this recovery copy permanently?</span>
                <button
                  ref={confirmButton}
                  className="button small danger"
                  disabled={discarding}
                  onClick={() => void discardRecovery(recovery)}
                >
                  {discarding ? 'Discarding…' : 'Confirm discard'}
                </button>
                <button
                  className="button small subtle"
                  disabled={discarding}
                  onClick={() => {
                    setDiscard(null)
                  }}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                ref={(button) => {
                  if (button) discardButtons.current.set(recovery.runId, button)
                  else discardButtons.current.delete(recovery.runId)
                }}
                className="button small subtle"
                disabled={discarding}
                onClick={() => {
                  setDiscardError('')
                  setDiscard(recovery.runId)
                }}
              >
                Discard recovery copy
              </button>
            )}
            <TerminalRecoveryFiles
              projectId={recovery.projectId}
              runId={recovery.runId}
            />
          </li>
        ))}
      </ul>
    </>
  )
  return projectId ? (
    <details className="terminal-recoveries" open>
      <summary>
        Recover terminal files <span className="tag">{recoveries.length}</span>
      </summary>
      {contents}
    </details>
  ) : (
    <div className="terminal-recoveries terminal-recoveries-account">
      {contents}
    </div>
  )
}
