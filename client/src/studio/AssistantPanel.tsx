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
  type FileEntry,
} from './api'
import { Icon } from './Icons'
import { Dialog } from './Dialog'
import { ChatPicker, type ChatChoice } from './ChatPicker'
import { FileContextPicker } from './FileContextPicker'
import { OptimizationSummary } from './OptimizationSummary'

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

type Mode = 'repair' | 'prove' | 'formalize' | 'optimize' | 'search'
const modes: {
  id: Mode
  name: string
  hint: string
  placeholder: string
  suggestions: { label: string; prompt: string }[]
}[] = [
  {
    id: 'repair',
    name: 'Repair',
    hint: 'Fix a broken proof while preserving its statement.',
    placeholder:
      'Fix the failing proof in this file. Preserve the theorem statement.',
    suggestions: [
      {
        label: 'Fix Lean errors',
        prompt:
          'Fix the failing proof in this file. Preserve the theorem statement and verify the result.',
      },
      {
        label: 'Fill in missing proofs',
        prompt:
          'Replace the unfinished proofs in this file with complete Lean proofs. Preserve the statements.',
      },
    ],
  },
  {
    id: 'prove',
    name: 'Prove',
    hint: 'Find and verify a proof of the selected theorem.',
    placeholder: 'Prove the theorem with a complete Lean proof.',
    suggestions: [
      {
        label: 'Prove this theorem',
        prompt:
          'Find and verify a complete proof of the selected theorem. Preserve its statement.',
      },
      {
        label: 'Try another approach',
        prompt:
          'Find a different proof approach for the selected theorem using relevant library lemmas. Preserve its statement and verify the proof.',
      },
    ],
  },
  {
    id: 'formalize',
    name: 'Formalize',
    hint: 'Translate a mathematical idea into Lean. Review the resulting statement.',
    placeholder:
      'Describe the statement and mathematical argument you want to formalize…',
    suggestions: [
      {
        label: 'Formalize a statement',
        prompt: 'Formalize the following mathematical statement in Lean:\n\n',
      },
      {
        label: 'Formalize an argument',
        prompt:
          'Formalize this statement and proof outline in Lean:\n\nStatement:\n\nProof outline:\n',
      },
    ],
  },
  {
    id: 'optimize',
    name: 'Optimize',
    hint: 'Improve a valid proof while preserving its statement. Compare measured proof tokens and elaboration heartbeats.',
    placeholder:
      'Optimize this proof using existing lemmas and focused steps. Preserve the exact statement.',
    suggestions: [
      {
        label: 'Shorten the proof',
        prompt:
          'Reduce the proof tokens using existing lemmas and simpler steps. Preserve the exact statement, verify the proof, and compare tokens and heartbeats.',
      },
      {
        label: 'Reduce heartbeats',
        prompt:
          'Reduce elaboration heartbeats using focused tactics and existing lemmas. Preserve the exact statement, verify the proof, and compare heartbeats and tokens.',
      },
    ],
  },
  {
    id: 'search',
    name: 'Search',
    hint: 'Find useful declarations or explain a proof and its goals.',
    placeholder: 'Find a theorem, explain this proof, or explore an approach…',
    suggestions: [
      {
        label: 'Find useful lemmas',
        prompt:
          'Find library lemmas relevant to the selected theorem or goal. Explain how they could help without editing files.',
      },
      {
        label: 'Explain this proof',
        prompt:
          'Explain the selected proof and its main steps. Do not edit files.',
      },
    ],
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
  if (v.kind === 'search')
    return (
      <div className="verification-card verified">
        <strong>
          <Icon name="search" size={16} />
          Search complete
        </strong>
        <p>{String(v.reason || 'No project files changed.')}</p>
      </div>
    )
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
  files,
  onDeleteChat,
  session,
  beforeRun,
  beforeApply,
  onDiscard,
  onApplied,
  onFilesUpdated,
  dirty,
  readOnly,
}: {
  projectId: string
  file?: string
  files: FileEntry[]
  onDeleteChat: (chat: { id: string; title: string }) => void
  session: Session
  beforeRun: () => Promise<void>
  beforeApply: () => Promise<void>
  onDiscard: () => Promise<void>
  onApplied: () => Promise<void>
  onFilesUpdated: (paths: string[]) => Promise<void>
  dirty: boolean
  readOnly?: boolean
}) {
  const [mode, setMode] = useState<Mode>('repair')
  const [proofMode, setProofMode] = useState<'repair' | 'prove'>('repair')
  const [chats, setChats] = useState<ChatChoice[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [chatBusy, setChatBusy] = useState(false)
  const [contextFiles, setContextFiles] = useState<string[]>([])
  const [projectRuns, setProjectRuns] = useState<Run[]>([])
  const chatIdRef = useRef<string | null>(null)
  const chatRequest = useRef(0)
  const [model, setModel] = useState(
    session.defaultModel || session.models[0]?.id || '',
  )
  const [prompt, setPrompt] = useState('')
  const [seconds, setSeconds] = useState('unlimited')
  const [liveEdits, setLiveEdits] = useState(true)
  const [undoing, setUndoing] = useState(false)
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
  const onFilesUpdatedRef = useRef(onFilesUpdated)
  onFilesUpdatedRef.current = onFilesUpdated
  const liveRevision = useRef<string | null>(null)
  const foreignRevisions = useRef(new Map<string, number>())
  const runRef = useRef(run)
  runRef.current = run
  const active = runIsActive(run)
  const otherActive = projectRuns.find(
    (item) => item.id !== selectedId && runIsActive(item),
  )
  const hasActive = active || !!otherActive
  const currentSection = mode === 'repair' || mode === 'prove' ? 'proofs' : mode
  const currentMode = modes.find((item) => item.id === mode)!
  useEffect(() => {
    if (readOnly) setMode('search')
  }, [readOnly])

  const loadChats = useCallback(async () => {
    const values = await api<ChatChoice[]>(
      `/api/projects/${encodeURIComponent(projectId)}/chats`,
    )
    setChats(values)
    return values
  }, [projectId])
  const loadRuns = useCallback(async () => {
    const selectedChat = chatIdRef.current
    const [all, history] = await Promise.all([
      api<Run[]>(`/api/projects/${encodeURIComponent(projectId)}/runs`),
      selectedChat
        ? api<{ chat: ChatChoice; runs: Run[] }>(
            `/api/chats/${encodeURIComponent(selectedChat)}`,
          )
        : Promise.resolve({ runs: [] as Run[] }),
    ])
    setProjectRuns(all)
    for (const job of all) {
      if (
        job.id === runRef.current?.id ||
        !job.liveEdits ||
        (!runIsActive(job) && !foreignRevisions.current.has(job.id))
      )
        continue
      const revision = job.liveRevision || 0
      if (foreignRevisions.current.get(job.id) === revision) continue
      foreignRevisions.current.set(job.id, revision)
      if (revision)
        void onFilesUpdatedRef
          .current((job.liveChanges || []).map((change) => change.path))
          .catch((error) => setError(errorText(error)))
    }
    const result = [...history.runs].sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || ''),
    )
    if (chatIdRef.current === selectedChat) setRuns(result)
    return result
  }, [projectId])
  const openChat = useCallback(
    async (id: string | null) => {
      const request = ++chatRequest.current
      chatIdRef.current = id
      setChatId(id)
      setRun(null)
      setRuns([])
      setSelectedId(null)
      setError('')
      setShowDiff(false)
      liveRevision.current = null
      setChatBusy(true)
      try {
        const history = id
          ? await api<{ chat: ChatChoice; runs: Run[] }>(
              `/api/chats/${encodeURIComponent(id)}`,
            )
          : { runs: [] as Run[] }
        if (request !== chatRequest.current) return
        const values = [...history.runs].sort((a, b) =>
          (b.createdAt || '').localeCompare(a.createdAt || ''),
        )
        setRuns(values)
        setSelectedId(values[0]?.id || null)
        setContextFiles(
          Array.isArray(values[0]?.files) ? (values[0].files as string[]) : [],
        )
        if (id) localStorage.setItem(`lemex-chat-${projectId}`, id)
        else localStorage.removeItem(`lemex-chat-${projectId}`)
        const all = await api<Run[]>(
          `/api/projects/${encodeURIComponent(projectId)}/runs`,
        )
        if (request === chatRequest.current) setProjectRuns(all)
      } catch (error) {
        if (request === chatRequest.current) setError(errorText(error))
      } finally {
        if (request === chatRequest.current) setChatBusy(false)
      }
    },
    [projectId],
  )
  const createChat = async () => {
    const created = await post<ChatChoice>(
      `/api/projects/${encodeURIComponent(projectId)}/chats`,
    )
    setChats((previous) => [
      created,
      ...previous.filter((chat) => chat.id !== created.id),
    ])
    await openChat(created.id)
    return created
  }
  const newChat = async () => {
    setChatBusy(true)
    setError('')
    try {
      await createChat()
      setPrompt('')
      setContextFiles([])
    } catch (error) {
      setError(errorText(error))
      setChatBusy(false)
    }
  }
  useEffect(() => {
    let cancelled = false
    void loadChats()
      .then((values) => {
        if (cancelled) return
        const saved = localStorage.getItem(`lemex-chat-${projectId}`)
        return openChat(
          values.some((chat) => chat.id === saved)
            ? saved
            : values[0]?.id || null,
        )
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
      ++chatRequest.current
    }
  }, [projectId, loadChats, openChat])
  useEffect(() => {
    const refresh = () => {
      void loadChats()
        .then((values) => {
          const selected = chatIdRef.current
          if (selected && !values.some((chat) => chat.id === selected))
            void openChat(values[0]?.id || null)
        })
        .catch((error) => setError(errorText(error)))
    }
    window.addEventListener('lemex-chats-changed', refresh)
    return () => window.removeEventListener('lemex-chats-changed', refresh)
  }, [loadChats, openChat])
  useEffect(() => {
    if (!projectRuns.some(runIsActive)) return
    const timer = setInterval(() => {
      void loadRuns().catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [projectRuns, loadRuns])

  useEffect(() => {
    if (!selectedId) {
      setRun(null)
      return
    }
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
        const revision = `${value.id}:${value.liveRevision || 0}:${!!value.liveUndone}`
        if (value.liveEdits && revision !== liveRevision.current) {
          liveRevision.current = revision
          void onFilesUpdatedRef
            .current((value.liveChanges || []).map((change) => change.path))
            .catch((error) => setError(errorText(error)))
        }
        if (!runIsActive(value)) {
          stream?.close()
          if (poll) clearInterval(poll)
          setConnection('')
          void loadRuns().catch(() => undefined)
          void loadChats().catch(() => undefined)
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
            if (
              event.type === 'files-updated' &&
              Array.isArray(event.data?.paths)
            )
              void onFilesUpdatedRef
                .current(event.data.paths as string[])
                .catch((error) => setError(errorText(error)))
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
  }, [selectedId, loadRuns, loadChats])

  const events = run ? normalizedEvents(run) : []
  const text = events
    .filter((event) => event.type === 'message')
    .map(eventText)
    .join('')
  const reasoning =
    events
      .filter((event) => event.type === 'reasoning')
      .map(eventText)
      .join('') ||
    run?.reasoning ||
    ''
  const reasoningSummary =
    events
      .filter((event) => event.type === 'reasoning-summary')
      .map(eventText)
      .join('') ||
    run?.reasoningSummary ||
    ''
  const activities = events.filter((event) =>
    ['activity', 'error'].includes(event.type),
  )
  useEffect(() => {
    if (active)
      messagesEnd.current?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      })
  }, [text.length, reasoning.length, reasoningSummary.length, active])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!prompt.trim() || hasActive || busy) return
    setBusy(true)
    setError('')
    try {
      await beforeRun()
      const selectedChat = chatIdRef.current || (await createChat()).id
      const created = await post<Run>(
        `/api/chats/${encodeURIComponent(selectedChat)}/runs`,
        {
          mode,
          prompt: prompt.trim(),
          file,
          model: model || undefined,
          maxSeconds: seconds === 'unlimited' ? null : Number(seconds),
          liveEdits,
          files: contextFiles,
        },
      )
      setRuns((previous) => [
        created,
        ...previous.filter((item) => item.id !== created.id),
      ])
      setContextFiles((created.files as string[]) || contextFiles)
      setProjectRuns((previous) => [
        created,
        ...previous.filter((item) => item.id !== created.id),
      ])
      void loadChats().catch(() => undefined)
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

  async function undoLiveEdits() {
    if (!run || undoing) return
    setUndoing(true)
    setError('')
    try {
      await beforeApply()
      const value = await post<Run>(
        `/api/runs/${encodeURIComponent(run.id)}/undo`,
      )
      setRun(value)
      await onFilesUpdatedRef.current(
        (value.liveChanges || []).map((change) => change.path),
      )
      await loadRuns()
    } catch (error) {
      setError(errorText(error))
    } finally {
      setUndoing(false)
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
    run?.liveEdits !== true &&
    run?.status === 'completed' &&
    !!run.changes?.length &&
    verification?.complete === true
  return (
    <div className="assistant-panel">
      <ChatPicker
        chats={chats}
        selectedId={chatId}
        onSelect={(id) => void openChat(id)}
        onNew={() => void newChat()}
        onDelete={onDeleteChat}
        disabled={busy || chatBusy}
        loading={chatBusy}
      />
      <div className="assistant-settings">
        <div className="mode-tabs" aria-label="Assistant mode">
          {[
            { id: 'proofs', name: 'Proofs' },
            { id: 'formalize', name: 'Formalize' },
            { id: 'optimize', name: 'Optimize' },
            { id: 'search', name: 'Search' },
          ].map((item) => (
            <button
              key={item.id}
              className={currentSection === item.id ? 'selected' : ''}
              aria-pressed={currentSection === item.id}
              disabled={active || (readOnly && item.id !== 'search')}
              onClick={() =>
                setMode(item.id === 'proofs' ? proofMode : (item.id as Mode))
              }
            >
              {item.name}
            </button>
          ))}
        </div>
        {currentSection === 'proofs' && (
          <div className="proof-task-tabs" aria-label="Proof task">
            {(['repair', 'prove'] as const).map((task) => (
              <button
                key={task}
                className={mode === task ? 'selected' : ''}
                aria-pressed={mode === task}
                disabled={active || readOnly}
                onClick={() => {
                  setProofMode(task)
                  setMode(task)
                }}
              >
                {task === 'repair' ? 'Repair a proof' : 'Find a proof'}
              </button>
            ))}
          </div>
        )}
        <p className="mode-hint">{currentMode.hint}</p>
        <div className="assistant-options">
          <label>
            Model
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={active}
            >
              {session.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Time limit (optional)
            <select
              value={seconds}
              onChange={(event) => setSeconds(event.target.value)}
              disabled={active}
            >
              <option value="unlimited">Until done</option>
              <option value="120">2 minutes</option>
              <option value="300">5 minutes</option>
              <option value="900">15 minutes</option>
              <option value="1800">30 minutes</option>
            </select>
          </label>
        </div>
      </div>
      <label className="live-edit-choice">
        <input
          type="checkbox"
          checked={liveEdits}
          disabled={active}
          onChange={(event) => setLiveEdits(event.target.checked)}
        />
        <span>
          <strong>Edit files live</strong>
          <span>
            {liveEdits
              ? 'Changes appear in your project as Lemex works.'
              : 'Keep edits separate until you review and apply them.'}
          </span>
        </span>
      </label>
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
          <button
            onClick={() =>
              typeof otherActive.chatId === 'string'
                ? void openChat(otherActive.chatId)
                : setSelectedId(otherActive.id)
            }
          >
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
            {runs
              .filter(
                (item) =>
                  item.id !== run.id &&
                  (item.createdAt || '') < (run.createdAt || ''),
              )
              .reverse()
              .map((item) => (
                <div className="chat-previous-turn" key={item.id}>
                  <div className="user-message">
                    <span className="message-label">You · {item.mode}</span>
                    <p>{item.prompt}</p>
                  </div>
                  {item.message && (
                    <div className="assistant-message">
                      <span className="message-label">
                        <Icon name="bot" size={14} />
                        Lemex
                      </span>
                      <div className="markdown-body">
                        <ReactMarkdown skipHtml components={markdownComponents}>
                          {item.message}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                  <button
                    className="button small subtle"
                    onClick={() => setSelectedId(item.id)}
                  >
                    Inspect this turn
                  </button>
                </div>
              ))}
            {run.prompt && (
              <div className="user-message">
                <span className="message-label">You · {run.mode}</span>
                <p>{run.prompt}</p>
              </div>
            )}
            {(reasoning || reasoningSummary) && (
              <details className="reasoning-trace" open={active}>
                <summary>
                  <Icon name="bot" size={14} />
                  Reasoning trace{active && <span className="spinner" />}
                </summary>
                <p className="field-help">Exposed by the selected model.</p>
                {reasoningSummary && (
                  <div className="markdown-body reasoning-summary">
                    <ReactMarkdown skipHtml components={markdownComponents}>
                      {reasoningSummary}
                    </ReactMarkdown>
                  </div>
                )}
                {reasoning && (
                  <div className="markdown-body reasoning-content">
                    <ReactMarkdown skipHtml components={markdownComponents}>
                      {reasoning}
                    </ReactMarkdown>
                  </div>
                )}
              </details>
            )}
            {run.liveEdits && (
              <div className="live-edit-status">
                <strong>
                  {run.liveUndone
                    ? 'Live edits undone'
                    : 'Editing project files live'}
                </strong>
                <p>
                  {run.liveUndone
                    ? 'The original saved files were restored.'
                    : 'Edits are saved as the agent works. Lean verifies the final result; you can undo the run when it stops.'}
                </p>
                {run.liveEditConflict && (
                  <p className="error-message">{run.liveEditConflict}</p>
                )}
                {!active && !run.liveUndone && !!run.liveChanges?.length && (
                  <button
                    className="button small secondary"
                    disabled={undoing || dirty || hasActive}
                    onClick={() => void undoLiveEdits()}
                  >
                    {undoing ? 'Undoing…' : 'Undo agent edits'}
                  </button>
                )}
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
            <OptimizationSummary value={run.optimization} active={active} />
            {!!run.changes?.length && (
              <div className="candidate-card">
                <strong>
                  {run.changes.length} changed{' '}
                  {run.changes.length === 1 ? 'file' : 'files'}
                </strong>
                <p>
                  {run.liveEdits
                    ? run.liveUndone
                      ? 'These edits have been undone.'
                      : 'Agent edits were saved live. You can inspect the diff.'
                    : run.status === 'applied'
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
                  {run.liveEdits ? 'View edits' : 'Review changes'}
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
          <div
            className="assistant-starters"
            role="group"
            aria-label={`${currentMode.name} suggestions`}
          >
            {currentMode.suggestions.map((suggestion) => (
              <button
                key={suggestion.label}
                type="button"
                disabled={busy || chatBusy}
                onClick={() => {
                  setPrompt(suggestion.prompt)
                  document.getElementById('assistant-prompt')?.focus()
                }}
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <FileContextPicker
        files={files}
        selected={contextFiles}
        onChange={setContextFiles}
        disabled={active || busy}
      />
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
          disabled={active || busy}
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
              chatBusy ||
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
            {!run.liveEdits && (
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
            )}
          </footer>
        </Dialog>
      )}
    </div>
  )
}
