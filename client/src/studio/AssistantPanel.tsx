import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import {
  api,
  errorText,
  post,
  pretty,
  runIsActive,
  type Change,
  type Run,
  type RunEvent,
  type Session,
} from './api'
import { Icon } from './Icons'
import { Dialog } from './Dialog'

const markdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const external = /^(?:https?:)?\/\//i.test(href || '')
    return (
      <a
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    )
  },
  // Keep remote images as deliberate links rather than loading third-party
  // resources automatically while a model response is streamed.
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-image-link"
      >
        {alt ? `Image: ${alt}` : 'Open image'}
        <Icon name="external" size={12} />
      </a>
    ) : (
      <span>{alt ? `Image: ${alt}` : 'Image'}</span>
    ),
}

type Mode = 'repair' | 'prove' | 'formalize' | 'search'
const modes: { id: Mode; name: string; hint: string; placeholder: string }[] = [
  {
    id: 'repair',
    name: 'Repair',
    hint: 'Fix a broken proof while preserving its statement.',
    placeholder:
      'Fix the failing proof in this file. Preserve the theorem statement.',
  },
  {
    id: 'prove',
    name: 'Prove',
    hint: 'Find and verify a proof of the selected theorem.',
    placeholder: 'Prove the theorem with a complete Lean proof.',
  },
  {
    id: 'formalize',
    name: 'Formalize',
    hint: 'Translate a mathematical idea into Lean. Review the resulting statement.',
    placeholder:
      'Describe the statement and mathematical argument you want to formalize…',
  },
  {
    id: 'search',
    name: 'Search',
    hint: 'Find useful declarations or explain a proof and its goals.',
    placeholder: 'Find a theorem, explain this proof, or explore an approach…',
  },
]

function normalizedEvents(run: Run): RunEvent[] {
  return Array.isArray(run.events) ? run.events : []
}

function mergeRun(previous: Run | null, value: Run) {
  if (!previous || previous.id !== value.id) return value
  const events = new Map(
    normalizedEvents(previous).map((event) => [event.seq, event]),
  )
  for (const event of normalizedEvents(value)) events.set(event.seq, event)
  return {
    ...value,
    events: [...events.values()].sort((a, b) => a.seq - b.seq),
  }
}

function eventText(event: RunEvent) {
  const data = event.data
  return typeof data === 'string'
    ? data
    : typeof data?.text === 'string'
      ? data.text
      : typeof data?.message === 'string'
        ? data.message
        : ''
}

function Verification({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const hasDetails = (item: unknown) =>
    Array.isArray(item)
      ? item.length > 0
      : !!item && (typeof item !== 'object' || Object.keys(item).length > 0)
  return (
    <div
      className={`verification-card ${v.complete === true ? 'verified' : 'unverified'}`}
    >
      <strong>
        {v.complete === true ? (
          <>
            <Icon name="check" size={16} />
            Lean verification passed
          </>
        ) : v.compiled === true ? (
          'Compiles with unfinished proof obligations'
        ) : (
          'Lean verification has not passed'
        )}
      </strong>
      {!!v.reason && <p>{String(v.reason)}</p>}
      {hasDetails(v.errors) && (
        <details>
          <summary>Verification errors</summary>
          <pre>{pretty(v.errors)}</pre>
        </details>
      )}
      {hasDetails(v.warnings) && (
        <details>
          <summary>Warnings</summary>
          <pre>{pretty(v.warnings)}</pre>
        </details>
      )}
      {!!v.axioms && (
        <details>
          <summary>Axiom audit</summary>
          <pre>{pretty(v.axioms)}</pre>
        </details>
      )}
    </div>
  )
}

function ChangeDiff({ change }: { change: Change }) {
  const before = (change.before || '').split('\n')
  const after = (change.after || '').split('\n')
  let start = 0
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++
  const contextStart = Math.max(0, start - 3)
  const beforeEnd = before.length - end
  const afterEnd = after.length - end
  return (
    <div className="change-diff">
      <div className="change-file">
        <Icon name="file" size={15} />
        <strong>{change.path}</strong>
        <span className="diff-count removed-text">−{beforeEnd - start}</span>
        <span className="diff-count added-text">+{afterEnd - start}</span>
      </div>
      <div className="diff-lines">
        {contextStart > 0 && (
          <div className="diff-context">… {contextStart} unchanged lines</div>
        )}
        {before.slice(contextStart, start).map((line, i) => (
          <div key={`context-${i}`} className="diff-line">
            <span className="line-number">{contextStart + i + 1}</span>
            <span className="line-sign"> </span>
            <code>{line || ' '}</code>
          </div>
        ))}
        {before.slice(start, beforeEnd).map((line, i) => (
          <div key={`before-${i}`} className="diff-line removed">
            <span className="line-number">{start + i + 1}</span>
            <span className="line-sign">−</span>
            <code>{line || ' '}</code>
          </div>
        ))}
        {after.slice(start, afterEnd).map((line, i) => (
          <div key={`after-${i}`} className="diff-line added">
            <span className="line-number">{start + i + 1}</span>
            <span className="line-sign">+</span>
            <code>{line || ' '}</code>
          </div>
        ))}
        {after.slice(afterEnd, afterEnd + 3).map((line, i) => (
          <div key={`suffix-${i}`} className="diff-line">
            <span className="line-number">{afterEnd + i + 1}</span>
            <span className="line-sign"> </span>
            <code>{line || ' '}</code>
          </div>
        ))}
        {end > 3 && (
          <div className="diff-context">… {end - 3} unchanged lines</div>
        )}
      </div>
    </div>
  )
}

export function AssistantPanel({
  projectId,
  file,
  session,
  beforeRun,
  beforeApply,
  onDiscard,
  onApplied,
  dirty,
  readOnly,
}: {
  projectId: string
  file?: string
  session: Session
  beforeRun: () => Promise<void>
  beforeApply: () => Promise<void>
  onDiscard: () => Promise<void>
  onApplied: () => Promise<void>
  dirty: boolean
  readOnly?: boolean
}) {
  const [mode, setMode] = useState<Mode>('repair')
  const [model, setModel] = useState(
    session.defaultModel || session.models[0]?.id || '',
  )
  const [prompt, setPrompt] = useState('')
  const [seconds, setSeconds] = useState('300')
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [connection, setConnection] = useState('')
  const [applying, setApplying] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const messagesEnd = useRef<HTMLDivElement>(null)
  const runRef = useRef(run)
  runRef.current = run
  const active = runIsActive(run)
  const otherActive = runs.find(
    (item) => item.id !== selectedId && runIsActive(item),
  )
  const hasActive = active || !!otherActive
  const currentMode = modes.find((item) => item.id === mode)!
  useEffect(() => {
    if (readOnly) setMode('search')
  }, [readOnly])

  const loadRuns = useCallback(async () => {
    const result = await api<Run[]>(
      `/api/projects/${encodeURIComponent(projectId)}/runs`,
    )
    setRuns(result)
    return result
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    setRun(null)
    setRuns([])
    setSelectedId(null)
    setError('')
    setShowDiff(false)
    void api<Run[]>(`/api/projects/${encodeURIComponent(projectId)}/runs`)
      .then((result) => {
        if (!cancelled) {
          setRuns(result)
          setSelectedId(result[0]?.id || null)
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    let stream: EventSource | undefined
    let poll: ReturnType<typeof setInterval> | undefined
    const refresh = async () => {
      try {
        const value = await api<Run>(
          `/api/runs/${encodeURIComponent(selectedId)}`,
        )
        if (cancelled) return
        setRun((previous) => mergeRun(previous, value))
        if (!runIsActive(value)) {
          stream?.close()
          if (poll) clearInterval(poll)
          setConnection('')
          void loadRuns().catch(() => undefined)
        }
      } catch (error) {
        if (!cancelled) setError(errorText(error))
      }
    }
    setError('')
    setRun(null)
    void api<Run>(`/api/runs/${encodeURIComponent(selectedId)}`)
      .then((value) => {
        if (cancelled) return
        setRun(value)
        if (!runIsActive(value)) return
        stream = new EventSource(
          `/api/runs/${encodeURIComponent(selectedId)}/events`,
        )
        stream.addEventListener('open', () => {
          if (!cancelled) setConnection('Live')
        })
        stream.addEventListener('message', (raw) => {
          if (cancelled) return
          try {
            const event = JSON.parse((raw as MessageEvent).data) as RunEvent
            if (!event || typeof event.type !== 'string') return
            setRun((previous) => {
              if (!previous || previous.id !== selectedId) return previous
              const events = normalizedEvents(previous)
              if (events.some((item) => item.seq === event.seq)) return previous
              const next = {
                ...previous,
                events: [...events, event].sort((a, b) => a.seq - b.seq),
              }
              if (
                event.type === 'status' &&
                typeof event.data?.status === 'string'
              )
                next.status = event.data.status
              if (event.type === 'verification') next.verification = event.data
              if (
                event.type === 'changes' &&
                Array.isArray(event.data?.changes)
              )
                next.changes = event.data.changes as Change[]
              if (event.type === 'usage') next.usage = event.data
              return next
            })
            if (event.type === 'status') void refresh()
          } catch {
            void refresh()
          }
        })
        stream.addEventListener('error', () => {
          if (!cancelled) setConnection('Reconnecting…')
          void refresh()
        })
        poll = setInterval(() => {
          void refresh()
        }, 4000)
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
      stream?.close()
      if (poll) clearInterval(poll)
    }
  }, [selectedId, loadRuns])

  const events = run ? normalizedEvents(run) : []
  const text = events
    .filter((event) => event.type === 'message')
    .map(eventText)
    .join('')
  const activities = events.filter((event) =>
    ['activity', 'error'].includes(event.type),
  )
  useEffect(() => {
    if (active)
      messagesEnd.current?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      })
  }, [text.length, active])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!prompt.trim() || hasActive || busy) return
    setBusy(true)
    setError('')
    try {
      await beforeRun()
      const created = await post<Run>(
        `/api/projects/${encodeURIComponent(projectId)}/runs`,
        {
          mode,
          prompt: prompt.trim(),
          file,
          model: model || undefined,
          maxSeconds: Number(seconds),
        },
      )
      setRuns((previous) => [
        created,
        ...previous.filter((item) => item.id !== created.id),
      ])
      setRun(created)
      setSelectedId(created.id)
      setPrompt('')
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (!run) return
    try {
      const value = await post<Run>(
        `/api/runs/${encodeURIComponent(run.id)}/stop`,
      )
      setRun(value)
    } catch (error) {
      setError(errorText(error))
    }
  }

  async function apply() {
    if (!run || applying) return
    if (dirty) {
      setError(
        'Discard the unsaved editor changes before applying this candidate, or keep your edits and start a new run.',
      )
      return
    }
    setApplying(true)
    setError('')
    try {
      // Applying must preserve the saved baseline. Saving a dirty buffer here
      // would invalidate the candidate before the server can check its snapshot.
      await beforeApply()
      const value = await post<Run>(
        `/api/runs/${encodeURIComponent(run.id)}/apply`,
      )
      setRun(value)
      await onApplied()
      await loadRuns()
      // Keep the native modal active until the editor reload has finished, so
      // the user cannot type into a buffer that is about to be replaced.
      setShowDiff(false)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setApplying(false)
    }
  }

  async function discardUnsavedEdits() {
    setDiscarding(true)
    setError('')
    try {
      await onDiscard()
      setConfirmDiscard(false)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setDiscarding(false)
    }
  }

  const verification = run?.verification as
    | { complete?: boolean; compiled?: boolean }
    | undefined
  const canApply =
    run?.status === 'completed' &&
    !!run.changes?.length &&
    verification?.complete === true
  return (
    <div className="assistant-panel">
      <div className="assistant-settings">
        <div className="mode-tabs" aria-label="Assistant mode">
          {modes.map((item) => (
            <button
              key={item.id}
              className={mode === item.id ? 'selected' : ''}
              aria-pressed={mode === item.id}
              onClick={() => setMode(item.id)}
              disabled={hasActive || (readOnly && item.id !== 'search')}
            >
              {item.name}
            </button>
          ))}
        </div>
        <p className="mode-hint">{currentMode.hint}</p>
        <div className="assistant-options">
          <label>
            Model
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={hasActive}
            >
              {session.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Time limit
            <select
              value={seconds}
              onChange={(event) => setSeconds(event.target.value)}
              disabled={hasActive}
            >
              <option value="120">2 minutes</option>
              <option value="300">5 minutes</option>
              <option value="900">15 minutes</option>
              <option value="1800">30 minutes</option>
            </select>
          </label>
        </div>
      </div>
      {runs.length > 0 && (
        <div className="run-history">
          <Icon name="log" size={15} />
          <label className="sr-only" htmlFor="run-history">
            Assistant history
          </label>
          <select
            id="run-history"
            value={selectedId || ''}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.mode || 'Task'} ·{' '}
                {String(item.prompt || item.id).slice(0, 48)} · {item.status}
              </option>
            ))}
          </select>
        </div>
      )}
      {otherActive && (
        <div className="other-active-run">
          <span className="spinner" />
          <span>A task is running in this project.</span>
          <button onClick={() => setSelectedId(otherActive.id)}>
            View task
          </button>
        </div>
      )}
      <div
        className="assistant-conversation"
        aria-live="polite"
        aria-atomic="false"
      >
        {run ? (
          <>
            <div className="run-status">
              <span
                className={`tag ${run.status === 'completed' || run.status === 'applied' ? 'success' : run.status === 'failed' ? 'danger' : ''}`}
              >
                {active && <span className="spinner" />}
                {run.status}
              </span>
              {connection && <span className="field-help">{connection}</span>}
              {active && (
                <button
                  className="button small secondary"
                  onClick={stop}
                  disabled={run.status === 'stopping'}
                >
                  <Icon name="stop" size={13} />
                  Stop
                </button>
              )}
            </div>
            {run.prompt && (
              <div className="user-message">
                <span className="message-label">You · {run.mode}</span>
                <p>{run.prompt}</p>
              </div>
            )}
            {(text || run.message) && (
              <div className="assistant-message">
                <span className="message-label">
                  <Icon name="bot" size={14} />
                  Lemex
                </span>
                <div className="message-body markdown-body">
                  <ReactMarkdown skipHtml components={markdownComponents}>
                    {text || run.message || ''}
                  </ReactMarkdown>
                </div>
              </div>
            )}
            {activities.length > 0 && (
              <details className="activity-log" open={active}>
                <summary>
                  {active ? 'Working' : 'Activity'} · {activities.length} events
                </summary>
                <div>
                  {activities.map((event, index) => (
                    <div
                      key={`${event.seq}-${index}`}
                      className={event.type === 'error' ? 'error-activity' : ''}
                    >
                      <span className="activity-bullet" />
                      {eventText(event) || pretty(event.data)}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {active && !text && !activities.length && (
              <p className="working-message">
                <span className="spinner" />
                Lemex is preparing the project context…
              </p>
            )}
            {run.error && (
              <p className="error-message" role="alert">
                {run.error}
              </p>
            )}
            <Verification value={run.verification} />
            {!!run.changes?.length && (
              <div className="candidate-card">
                <strong>
                  {run.changes.length} changed{' '}
                  {run.changes.length === 1 ? 'file' : 'files'}
                </strong>
                <p>
                  {run.status === 'applied'
                    ? 'These changes have been applied to the project.'
                    : 'Review the candidate before applying it to your files.'}
                </p>
                <button
                  className="button secondary"
                  onClick={() => {
                    setConfirmDiscard(false)
                    setShowDiff(true)
                  }}
                >
                  <Icon name="file" size={15} />
                  Review changes
                </button>
              </div>
            )}
            {run.usage != null && (
              <details className="usage-details">
                <summary>Usage</summary>
                <pre>{pretty(run.usage)}</pre>
              </details>
            )}
            <div ref={messagesEnd} />
          </>
        ) : (
          <div className="assistant-empty">
            <div className="assistant-emblem">
              <Icon name="bot" size={28} />
            </div>
            <h2>A proof partner in your workspace</h2>
            <p>
              Lemex reads your project, tries Lean tools, and returns a
              candidate you can inspect.
            </p>
            <div className="suggestions">
              {[
                'Repair the failing proof in this file.',
                'Explain the theorem and suggest useful lemmas.',
                'Find a complete proof without changing the statement.',
              ].map((suggestion, index) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setMode(
                      index === 1 ? 'search' : index === 2 ? 'prove' : 'repair',
                    )
                    setPrompt(suggestion)
                  }}
                >
                  {suggestion}
                  <Icon name="arrow" size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <form className="assistant-composer" onSubmit={submit}>
        <div className="composer-context">
          <Icon name="file" size={13} />
          <span title={file}>{file || 'Project context'}</span>
          {dirty && <span className="tag">Saves before running</span>}
        </div>
        <label className="sr-only" htmlFor="assistant-prompt">
          Instructions for Lemex
        </label>
        <textarea
          id="assistant-prompt"
          placeholder={currentMode.placeholder}
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={hasActive || busy}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="composer-footer">
          <span>
            {!file && mode !== 'search'
              ? 'Open a Lean file to begin.'
              : readOnly
                ? 'Read-only library context'
                : 'Ctrl / ⌘ + Enter to run'}
          </span>
          <button
            type="submit"
            className="button primary"
            disabled={
              !prompt.trim() ||
              hasActive ||
              busy ||
              ((!file || readOnly) && mode !== 'search') ||
              !model
            }
          >
            {busy ? (
              <span className="spinner" />
            ) : (
              <Icon name="play" size={14} />
            )}
            {busy ? 'Starting…' : 'Run Lemex'}
          </button>
        </div>
      </form>
      {showDiff && run && (
        <Dialog
          title="Review candidate changes"
          subtitle="Lean checks the candidate. Applying also checks for changes to your original files."
          onClose={() => setShowDiff(false)}
          busy={applying || discarding}
        >
          <div className="diff-review">
            <Verification value={run.verification} />
            {run.mode === 'formalize' && (
              <p className="review-note">
                Check that the formalized statements express your intended
                mathematics.
              </p>
            )}
            {dirty && run.status === 'completed' && (
              <div className="unsaved-candidate" role="status">
                <strong>Apply is paused for your unsaved edits</strong>
                <p>
                  <code>{file || 'The current file'}</code> has unsaved changes.
                  Close this review to keep editing and start a new run, or
                  discard these edits before accepting the candidate.
                </p>
                {confirmDiscard ? (
                  <>
                    <p>
                      Discard the unsaved changes in this file and restore its
                      saved contents?
                    </p>
                    <div className="unsaved-candidate-actions">
                      <button
                        className="button small secondary"
                        disabled={discarding}
                        onClick={() => setConfirmDiscard(false)}
                      >
                        Keep edits
                      </button>
                      <button
                        className="button small secondary"
                        disabled={discarding}
                        onClick={() => void discardUnsavedEdits()}
                      >
                        {discarding && <span className="spinner" />}Discard
                        unsaved edits
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    className="button small secondary"
                    onClick={() => setConfirmDiscard(true)}
                  >
                    Discard unsaved edits…
                  </button>
                )}
              </div>
            )}
            {run.changes?.map((change) => (
              <ChangeDiff key={change.path} change={change} />
            ))}
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setShowDiff(false)}
              disabled={applying || discarding}
            >
              Close
            </button>
            <button
              className="button primary"
              disabled={!canApply || applying || dirty || discarding}
              onClick={apply}
            >
              {applying ? (
                <span className="spinner" />
              ) : (
                <Icon name="check" size={15} />
              )}
              {run.status === 'applied'
                ? 'Already applied'
                : applying
                  ? 'Applying…'
                  : 'Apply changes'}
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  )
}
