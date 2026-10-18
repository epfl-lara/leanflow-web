import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  api,
  errorText,
  post,
  runIsActive,
  type Run,
  type RunReceipt,
  type Session,
  type ModelAccess,
  type FileEntry,
  type RunProofTarget,
} from './api'
import { Icon } from './Icons'
import { HelpTip } from './HelpTip'
import { Dialog } from './Dialog'
import { ChatPicker, type ChatChoice } from './ChatPicker'
import { FileContextPicker } from './FileContextPicker'
import { FileMentionTextarea } from './FileMentionTextarea'
import { ChatFocusPicker } from './ChatFocusPicker'
import { ChatOptions } from './ChatOptions'
import type { BookChatRequest } from './BooksPanel'
import { ConversationTurn } from './ConversationTurn'
import { ChangeDiff, Verification } from './RunReview'
import { mergeRunSnapshot } from './runStream'
import { hydrateReasoningHistory } from './reasoningHistory'
import { useConversationScroll } from './useConversationScroll'
import { useRunStream } from './useRunStream'
import { chatDraftKey, useChatDraft, type DraftSubmission } from './chatDrafts'
import { chatModes } from './chatModes'
import {
  runStatusLabel,
  liveEditStatus,
  runChangePaths,
  runChangeCount,
} from './chatTimeline'
import type {
  EditorProofState,
  ProofEditorRequest,
  ProofFocusRequest,
} from './proofTarget'
import './chat-workbench.css'
import { texLanguage } from './texBuilds'
import { messageId } from './messageId'
import {
  reasoningPreferenceKey,
  selectedReasoningEffort,
} from '../../../shared/mode-reasoning.mjs'

const chronological = (values: Run[]) =>
  [...values].sort((a, b) =>
    (a.createdAt || '').localeCompare(b.createdAt || ''),
  )
const mergeRun = (values: Run[], value: Run) =>
  chronological([
    ...values.filter((item) => item.id !== value.id),
    mergeRunSnapshot(
      values.find((item) => item.id === value.id) || null,
      value,
    ),
  ])

export function AssistantPanel({
  projectId,
  file,
  currentFile = file,
  files,
  onDeleteChat,
  session,
  onModelsUpdated,
  beforeRun,
  beforeApply,
  onDiscard,
  onApplied,
  onFilesUpdated,
  dirty,
  dirtyFileCount = 1,
  readOnly,
  focusRequest,
  bookRequest,
  onBookHandled,
  onOpenTarget,
  onFocusHandled,
  editorProof,
  onFocusEditor,
}: {
  projectId: string
  file?: string
  currentFile?: string
  files: FileEntry[]
  onDeleteChat: (chat: { id: string; title: string }) => void
  session: Session
  onModelsUpdated: (access: ModelAccess) => void
  beforeRun: () => Promise<void>
  beforeApply: () => Promise<void>
  onDiscard: () => Promise<void>
  onApplied: () => Promise<void>
  onFilesUpdated: (paths: string[]) => Promise<void>
  dirty: boolean
  dirtyFileCount?: number
  readOnly?: boolean
  focusRequest?: ProofFocusRequest | null
  bookRequest?: BookChatRequest | null
  onBookHandled?: (id: number) => void
  onOpenTarget?: (target: RunProofTarget) => void
  onFocusHandled?: (id: number) => void
  editorProof?: EditorProofState
  onFocusEditor?: (request: Omit<ProofEditorRequest, 'id'>) => void
}) {
  const [chats, setChats] = useState<ChatChoice[]>([]),
    [chatId, setChatId] = useState<string | null>(null)
  const [runs, setRuns] = useState<Run[]>([]),
    [projectRuns, setProjectRuns] = useState<Run[]>([])
  const [chatBusy, setChatBusy] = useState(false),
    [busy, setBusy] = useState(false)
  const [model, setModel] = useState(
    session.defaultModel || session.models[0]?.id || '',
  )
  const [efforts, setEfforts] = useState<Record<string, string | null>>({}),
    [liveEdits, setLiveEdits] = useState(true),
    [searchLiveEdits, setSearchLiveEdits] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({}),
    [streamError, setStreamError] = useState('')
  const [backgroundErrors, setBackgroundErrors] = useState<
    Record<string, string>
  >({})
  const backgroundRequests = useRef(new Map<string, number>())
  const backgroundErrorsRef = useRef(backgroundErrors)
  backgroundErrorsRef.current = backgroundErrors
  const [dialogId, setDialogId] = useState<string | null>(null),
    [actionError, setActionError] = useState('')
  const [applying, setApplying] = useState(false),
    [undoingId, setUndoingId] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false),
    [discarding, setDiscarding] = useState(false)
  const [stoppingIds, setStoppingIds] = useState<string[]>([]),
    [now, setNow] = useState(Date.now())
  const mounted = useRef(true),
    navigation = useRef(0),
    chatNamesRevision = useRef(0),
    chatRef = useRef(chatId),
    runsRef = useRef(runs)
  chatRef.current = chatId
  runsRef.current = runs
  const draft = useChatDraft(session.user.id, projectId, chatId)
  const draftRef = useRef(draft),
    receipts = useRef(
      new Map<string, DraftSubmission & { currentFile: string | null }>(),
    )
  const handledFocus = useRef<number | null>(null)
  const handledBook = useRef<number | null>(null)
  draftRef.current = draft
  const liveSeen = useRef(new Map<string, string>()),
    livePending = useRef(new Set<string>())
  const projectLoaded = useRef(false),
    inspections = useRef(new Map<string, Promise<void>>())
  const filesUpdatedRef = useRef(onFilesUpdated)
  filesUpdatedRef.current = onFilesUpdated
  const mode = draft.value.mode,
    prompt = draft.value.text,
    contextFiles = draft.value.files,
    proofTarget = draft.value.proofTarget
  const currentMode = chatModes.find((item) => item.id === mode)!
  const currentLiveEdits = mode === 'search' ? searchLiveEdits : liveEdits
  const chatSelectionKey = `lemex-chat:${session.user.id}:${projectId}`
  const preferenceKey = `lemex-chat-options:${session.user.id}:${projectId}`
  const [preferencesLoaded, setPreferencesLoaded] = useState<string | null>(
    null,
  )
  const conversationScroll = useConversationScroll(chatId)
  const activeRun = projectRuns.find(runIsActive)
  const statusRun =
    activeRun || projectRuns.find((item) => stoppingIds.includes(item.id))
  const activeHere = !!activeRun && activeRun.chatId === chatId
  const acceptingUpdate =
    activeHere &&
    ['queued', 'starting', 'preparing', 'running'].includes(
      activeRun!.status,
    ) &&
    !stoppingIds.includes(activeRun!.id)
  const hasActive = !!activeRun || stoppingIds.length > 0
  const selectedModel = session.models.find((item) => item.id === model)
  const providerScope =
    typeof session.lemex?.baseUrl === 'string' ? session.lemex.baseUrl : 'rcp'
  const effort =
    selectedReasoningEffort(efforts, providerScope, selectedModel, mode) || ''
  const effortAvailable =
    !effort ||
    selectedModel?.reasoningEfforts?.some((level) => level.id === effort)
  const target =
    proofTarget?.path ||
    (!readOnly && file?.endsWith('.lean')
      ? file
      : contextFiles.find(
          (path) =>
            path.endsWith('.lean') &&
            !path.startsWith('.lake/') &&
            !files.find((item) => item.path === path)?.readOnly,
        ))
  const requiresLeanTarget = mode === 'proofs' || mode === 'optimize'
  const formalizingDocument =
    mode === 'formalize' &&
    [currentFile, ...contextFiles].some(
      (path) => path && !path.endsWith('.lean'),
    )
  useEffect(() => {
    if (
      !focusRequest ||
      focusRequest.projectId !== projectId ||
      handledFocus.current === focusRequest.id
    )
      return
    handledFocus.current = focusRequest.id
    // Attaching a proof is an explicit choice of this visible draft. An old
    // startup request must not replace it with the last saved conversation.
    ++navigation.current
    setChatBusy(false)
    try {
      localStorage.setItem(chatSelectionKey, chatRef.current || 'new')
    } catch {
      /* The focused draft remains available without browser storage. */
    }
    draftRef.current.focusTarget(focusRequest.target, focusRequest.mode)
    document.getElementById('assistant-prompt')?.focus()
    onFocusHandled?.(focusRequest.id)
  }, [focusRequest, projectId, onFocusHandled, chatSelectionKey])
  useEffect(() => {
    if (
      !bookRequest ||
      bookRequest.projectId !== projectId ||
      handledBook.current === bookRequest.id
    )
      return
    handledBook.current = bookRequest.id
    ++navigation.current
    setChatBusy(false)
    try {
      localStorage.setItem(chatSelectionKey, chatRef.current || 'new')
    } catch {
      /* Keep the visible draft when storage is unavailable. */
    }
    const existing = draftRef.current.value.text
    draftRef.current.setText(
      existing ? `${existing}\n\n${bookRequest.text}` : bookRequest.text,
    )
    document.getElementById('assistant-prompt')?.focus()
    onBookHandled?.(bookRequest.id)
  }, [bookRequest, projectId, onBookHandled, chatSelectionKey])
  const dialogRun = [...runs, ...projectRuns].find(
    (item) => item.id === dialogId,
  )
  const error =
    errors[draft.key] ||
    streamError ||
    Object.entries(backgroundErrors).find(
      ([source, message]) =>
        message &&
        (!source.startsWith('history:') || source === `history:${chatId}`),
    )?.[1]
  const backgroundError = useCallback((source: string, error?: unknown) => {
    if (!mounted.current) return
    const message = error === undefined ? '' : errorText(error)
    setBackgroundErrors((previous) =>
      previous[source] === message
        ? previous
        : { ...previous, [source]: message },
    )
  }, [])
  const recoverBackground = useCallback(
    async <T,>(source: string, request: () => Promise<T>) => {
      const revision = (backgroundRequests.current.get(source) || 0) + 1
      backgroundRequests.current.set(source, revision)
      try {
        const value = await request()
        if (backgroundRequests.current.get(source) === revision)
          backgroundError(source)
        return value
      } catch (error) {
        if (backgroundRequests.current.get(source) === revision)
          backgroundError(source, error)
        throw error
      }
    },
    [backgroundError],
  )
  const reconcileFollowups = useCallback((value: Run) => {
    for (const receipt of value.followups || []) {
      const submission = receipts.current.get(receipt.id)
      if (!submission) continue
      if (receipt.status === 'failed') {
        draftRef.current.restoreSubmitted(submission)
        setErrors((previous) => ({
          ...previous,
          [submission.key]:
            receipt.error ||
            'The update could not be delivered. Your draft has been kept.',
        }))
        receipts.current.delete(receipt.id)
      } else if (receipt.status === 'accepted') {
        draftRef.current.clearSubmitted(submission, true)
        receipts.current.delete(receipt.id)
      }
    }
  }, [])
  const updateRun = useCallback(
    (value: Run) => {
      if (!mounted.current) return
      reconcileFollowups(value)
      setProjectRuns((previous) => mergeRun(previous, value))
      if (value.chatId === chatRef.current)
        setRuns((previous) => mergeRun(previous, value))
    },
    [reconcileFollowups],
  )
  const loadChats = useCallback(async () => {
    const revision = chatNamesRevision.current
    const values = await recoverBackground('chats', () =>
      api<ChatChoice[]>(`/api/projects/${encodeURIComponent(projectId)}/chats`),
    )
    if (mounted.current && revision === chatNamesRevision.current)
      setChats(values)
    return values
  }, [projectId, recoverBackground])
  const loadHistory = useCallback(
    async (id: string | null) => {
      if (!id) return [] as Run[]
      const history = await recoverBackground(`history:${id}`, () =>
        api<{ runs: Run[] }>(`/api/chats/${encodeURIComponent(id)}`),
      )
      if (mounted.current) history.runs.forEach(reconcileFollowups)
      if (mounted.current && chatRef.current === id)
        setRuns((previous) =>
          chronological(
            history.runs
              .map((value) =>
                mergeRunSnapshot(
                  previous.find((item) => item.id === value.id) || null,
                  value,
                ),
              )
              .concat(
                previous.filter(
                  (item) => !history.runs.some((value) => value.id === item.id),
                ),
              ),
          ),
        )
      return history.runs
    },
    [reconcileFollowups, recoverBackground],
  )
  const loadProject = useCallback(async () => {
    const values = await recoverBackground('project', () =>
      api<Run[]>(
        `/api/projects/${encodeURIComponent(projectId)}/runs?summary=1`,
      ),
    )
    if (!mounted.current) return values
    const firstLoad = !projectLoaded.current
    projectLoaded.current = true
    for (const metadata of values) {
      const revision = `${metadata.liveRevision || 0}:${!!metadata.liveUndone}`
      if (firstLoad && !runIsActive(metadata)) {
        liveSeen.current.set(metadata.id, revision)
        continue
      }
      if (
        !metadata.liveEdits ||
        !metadata.liveRevision ||
        (liveSeen.current.get(metadata.id) === revision &&
          !backgroundErrorsRef.current[`files:${metadata.id}`]) ||
        livePending.current.has(metadata.id)
      )
        continue
      livePending.current.add(metadata.id)
      void recoverBackground(`files:${metadata.id}`, () =>
        api<RunReceipt>(
          `/api/runs/${encodeURIComponent(metadata.id)}?view=metadata`,
        ).then(async (value) => {
          if (!mounted.current) return
          updateRun(value)
          await filesUpdatedRef.current(runChangePaths(value, true))
          liveSeen.current.set(
            value.id,
            `${value.liveRevision || 0}:${!!value.liveUndone}`,
          )
        }),
      )
        .catch(() => undefined)
        .finally(() => livePending.current.delete(metadata.id))
    }
    setProjectRuns((previous) =>
      chronological(
        values
          .map((value) => {
            const existing = previous.find((item) => item.id === value.id)
            // Metadata must retain transcripts fetched by the active stream or history.
            return existing ? mergeRunSnapshot(existing, value) : value
          })
          .concat(
            previous.filter(
              (item) =>
                !values.some((value) => value.id === item.id) &&
                runIsActive(item),
            ),
          ),
      ),
    )
    return values
  }, [projectId, updateRun, recoverBackground])
  const openChat = useCallback(
    async (id: string | null) => {
      const request = ++navigation.current
      chatRef.current = id
      setChatId(id)
      setRuns([])
      setDialogId(null)
      setStreamError('')
      setChatBusy(true)
      try {
        if (id) localStorage.setItem(chatSelectionKey, id)
        else localStorage.setItem(chatSelectionKey, 'new')
      } catch {
        /* Chat selection remains available when browser storage is unavailable. */
      }
      try {
        await loadHistory(id)
      } catch {
        // loadHistory owns its recoverable, chat-specific error.
      } finally {
        if (mounted.current && navigation.current === request)
          setChatBusy(false)
      }
    },
    [loadHistory, chatSelectionKey],
  )
  const addChat = (created: ChatChoice) => {
    ++chatNamesRevision.current
    if (mounted.current)
      setChats((previous) => [
        created,
        ...previous.filter((item) => item.id !== created.id),
      ])
  }
  function newChat() {
    // Keep one unsent draft; create the persisted chat only on its first send.
    if (chatRef.current === null) {
      // Repeated clicks during the first send do not abandon its pending chat.
      // Otherwise this is an explicit choice that supersedes startup recovery.
      if (!busy) ++navigation.current
      try {
        localStorage.setItem(chatSelectionKey, 'new')
      } catch {
        /* The in-memory selection still works without browser storage. */
      }
    } else void openChat(null)
    document.getElementById('assistant-prompt')?.focus()
  }
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const request = navigation.current
    const initialDraft = draftRef.current.capture()
    // On the first render the focus effect runs before this effect. Preserve
    // that choice too, even though initialDraft already contains its target.
    const initialFocus = handledFocus.current !== null
    const restoreSelection = async () => {
      try {
        const values = await loadChats()
        if (cancelled || navigation.current !== request) return
        if (initialFocus) return
        // Typing into the visible new draft while chats reconnect is already a
        // choice. Do not replace that draft with a previously saved selection.
        if (draftRef.current.value.revision !== initialDraft.revision) {
          await openChat(null)
          return
        }
        let saved: string | null = null
        try {
          saved = localStorage.getItem(chatSelectionKey)
        } catch {
          /* Use the newest chat when selection storage is unavailable. */
        }
        await openChat(
          saved === 'new'
            ? null
            : values.some((item) => item.id === saved)
              ? saved
              : values[0]?.id || null,
        )
      } catch {
        if (!cancelled && navigation.current === request)
          retry = setTimeout(() => void restoreSelection(), 4000)
      }
    }
    // Project activity and chat selection recover independently. A failed
    // activity request must not prevent restoring the selected conversation.
    void loadProject().catch(() => undefined)
    void restoreSelection()
    return () => {
      cancelled = true
      clearTimeout(retry)
      mounted.current = false
      ++navigation.current
    }
  }, [loadChats, loadProject, openChat, chatSelectionKey])
  useEffect(() => {
    // Each project opens at the server model and workflow effort defaults.
    // Deliberate choices last while this assistant is open; old browser-stored
    // per-model defaults cannot be distinguished from explicit choices.
    setModel(session.defaultModel || session.models[0]?.id || '')
    setEfforts({})
    setLiveEdits(true)
    setSearchLiveEdits(false)
    try {
      const preferences = JSON.parse(
        localStorage.getItem(preferenceKey) || 'null',
      )
      if (preferences) {
        if (typeof preferences.liveEdits === 'boolean')
          setLiveEdits(preferences.liveEdits)
        if (typeof preferences.searchLiveEdits === 'boolean')
          setSearchLiveEdits(preferences.searchLiveEdits)
      }
    } catch {
      /* Default options remain usable if browser storage is unavailable. */
    }
    setPreferencesLoaded(preferenceKey)
  }, [preferenceKey])
  useEffect(() => {
    // Discovery can fill an initially empty picker. Keep explicit choices
    // across refreshes and report lost access instead of changing a run option.
    setModel(
      (current) =>
        current || session.defaultModel || session.models[0]?.id || '',
    )
  }, [session.models, session.defaultModel])
  useEffect(() => {
    if (preferencesLoaded !== preferenceKey) return
    try {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({ liveEdits, searchLiveEdits }),
      )
    } catch {
      /* Options remain in memory. */
    }
  }, [preferenceKey, liveEdits, searchLiveEdits, preferencesLoaded])
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) return
      void loadProject()
        .then((values) => {
          const selected = chatRef.current
          if (
            selected &&
            (backgroundErrorsRef.current[`history:${selected}`] ||
              values.some(
                (value) =>
                  value.chatId === selected &&
                  (!runsRef.current.some((run) => run.id === value.id) ||
                    (value.eventCursor || 0) >
                      (runsRef.current.find((run) => run.id === value.id)
                        ?.eventCursor || 0) ||
                    value.status !==
                      runsRef.current.find((run) => run.id === value.id)
                        ?.status),
              ))
          )
            return loadHistory(selected)
        })
        .catch(() => undefined)
      void loadChats().catch(() => undefined)
    }
    const timer = setInterval(refresh, 4000)
    document.addEventListener('visibilitychange', refresh)
    const chatsChanged = () => {
      void loadChats()
        .then((values) => {
          const selected = chatRef.current
          if (selected && !values.some((item) => item.id === selected))
            void openChat(values[0]?.id || null)
        })
        .catch(() => undefined)
    }
    window.addEventListener('lemex-chats-changed', chatsChanged)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('lemex-chats-changed', chatsChanged)
    }
  }, [loadProject, loadHistory, loadChats, openChat])
  useEffect(() => {
    if (!statusRun?.id) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [statusRun?.id])
  const connection = useRunStream(activeRun?.id || null, {
    onRun: updateRun,
    onFilesUpdated: (paths, runId) =>
      recoverBackground(`files:${runId}`, () => onFilesUpdated(paths)),
    onTerminal: () => {
      void loadProject().catch(() => undefined)
      void loadHistory(chatRef.current).catch(() => undefined)
      void loadChats().catch(() => undefined)
    },
    onError: (error) => backgroundError('stream:snapshot', error),
    onRecovered: () => backgroundError('stream:snapshot'),
  })
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!prompt.trim() || busy || (hasActive && !acceptingUpdate)) return
    // Sending is an explicit choice of this visible conversation. Startup
    // restoration must not redirect it while its first chat is being created.
    ++navigation.current
    const captured = draft.capture(),
      selected = chatRef.current,
      request = navigation.current
    const settings = {
      model,
      effort: effort || null,
      liveEdits: currentLiveEdits,
      file: mode === 'search' ? file : target,
      currentFile: currentFile || null,
      mode,
      files: [...captured.files],
      ...(captured.proofTarget ? { proofTarget: captured.proofTarget } : {}),
    }
    const steering = acceptingUpdate ? activeRun : null
    setBusy(true)
    setErrors((previous) => ({ ...previous, [captured.key]: '' }))
    setStreamError('')
    let submission = captured
    let visibleRequest = request
    let destination = selected
    try {
      if (steering) {
        if (captured.proofTarget && dirty)
          throw new Error(
            'Stop the run or discard your unsaved edits before sending a focused update.',
          )
        const previousSubmission = [...receipts.current.entries()].find(
          ([, value]) =>
            value.key === captured.key &&
            value.revision === captured.revision &&
            value.text === captured.text,
        )
        const clientId = previousSubmission?.[0] || messageId()
        const currentFile = previousSubmission
          ? previousSubmission[1].currentFile
          : settings.currentFile
        receipts.current.set(clientId, { ...captured, currentFile })
        const value = await post<RunReceipt>(
          `/api/runs/${encodeURIComponent(steering.id)}/messages`,
          {
            id: clientId,
            text: captured.text.trim(),
            currentFile,
            files: captured.files,
            ...(captured.proofTarget
              ? { proofTarget: captured.proofTarget }
              : {}),
          },
        )
        updateRun(value)
        const receipt = value.followups?.find((item) => item.id === clientId)
        if (!receipt || receipt.status === 'failed')
          throw new Error(
            receipt?.error ||
              'Lemex did not accept this update. Your draft has been kept.',
          )
        draft.clearSubmitted(submission, true)
      } else {
        await beforeRun()
        if (!destination) {
          const created = await post<ChatChoice>(
            `/api/projects/${encodeURIComponent(projectId)}/chats`,
          )
          addChat(created)
          destination = created.id
          if (
            mounted.current &&
            navigation.current === request &&
            chatRef.current === null
          ) {
            const newKey = chatDraftKey(session.user.id, projectId, destination)
            draft.move(captured.key, newKey)
            submission = { ...captured, key: newKey }
            const opening = openChat(destination)
            visibleRequest = navigation.current
            await opening
          }
        }
        const created = await post<Run>(
          `/api/chats/${encodeURIComponent(destination)}/runs`,
          { ...settings, prompt: captured.text.trim(), maxSeconds: null },
        )
        updateRun(created)
        draft.clearSubmitted(submission)
        if (mounted.current) void loadChats().catch(() => undefined)
      }
      if (
        mounted.current &&
        navigation.current === visibleRequest &&
        chatRef.current === destination
      )
        conversationScroll.jumpToLatest()
    } catch (error) {
      if (mounted.current)
        setErrors((previous) => ({
          ...previous,
          [submission.key]: errorText(error),
        }))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function stop() {
    if (!activeRun || stoppingIds.includes(activeRun.id)) return
    const id = activeRun.id
    setStoppingIds((previous) => [...previous, id])
    setStreamError('')
    try {
      const value = await post<Run>(`/api/runs/${encodeURIComponent(id)}/stop`)
      updateRun(value)
      if (value.liveEdits)
        await onFilesUpdated(
          (value.liveChanges || []).map((change) => change.path),
        )
      await loadProject()
    } catch (error) {
      if (mounted.current) setStreamError(errorText(error))
    } finally {
      if (mounted.current)
        setStoppingIds((previous) => previous.filter((value) => value !== id))
    }
  }
  async function review(id: string) {
    setActionError('')
    setConfirmDiscard(false)
    try {
      const value = await api<Run>(`/api/runs/${encodeURIComponent(id)}`)
      updateRun(value)
      if (mounted.current) setDialogId(id)
    } catch (error) {
      setStreamError(errorText(error))
    }
  }
  const inspect = useCallback(
    (id: string) => {
      const pending = inspections.current.get(id)
      if (pending) return pending
      const task = api<Run>(`/api/runs/${encodeURIComponent(id)}`)
        .then((value) =>
          hydrateReasoningHistory(
            value,
            runsRef.current.find((run) => run.id === id),
          ),
        )
        .then((value) => updateRun(value))
        .finally(() => inspections.current.delete(id))
      inspections.current.set(id, task)
      return task
    },
    [updateRun],
  )
  async function apply() {
    if (!dialogRun || applying || dirty) return
    setApplying(true)
    setActionError('')
    try {
      await beforeApply()
      const value = await post<Run>(
        `/api/runs/${encodeURIComponent(dialogRun.id)}/apply`,
      )
      updateRun(value)
      await onApplied()
      await loadHistory(chatRef.current)
      if (mounted.current) setDialogId(null)
    } catch (error) {
      if (mounted.current) setActionError(errorText(error))
    } finally {
      if (mounted.current) setApplying(false)
    }
  }
  async function undo(id: string) {
    if (undoingId || dirty || hasActive) return
    setUndoingId(id)
    setStreamError('')
    try {
      await beforeApply()
      const value = await post<Run>(`/api/runs/${encodeURIComponent(id)}/undo`)
      updateRun(value)
      await onFilesUpdated(runChangePaths(value, true))
      await loadProject()
    } catch (error) {
      if (mounted.current) setStreamError(errorText(error))
    } finally {
      if (mounted.current) setUndoingId(null)
    }
  }
  async function discard() {
    setDiscarding(true)
    setActionError('')
    try {
      await onDiscard()
      setConfirmDiscard(false)
    } catch (error) {
      setActionError(errorText(error))
    } finally {
      setDiscarding(false)
    }
  }
  const elapsedSeconds = statusRun?.createdAt
    ? Math.max(0, Math.floor((now - Date.parse(statusRun.createdAt)) / 1000))
    : 0
  const elapsed = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`
  const stopping =
    !!statusRun &&
    (statusRun.status === 'stopping' || stoppingIds.includes(statusRun.id))
  const canApply =
    !!dialogRun &&
    !dialogRun.liveEdits &&
    dialogRun.status === 'completed' &&
    !!dialogRun.changes?.length &&
    (dialogRun.verification as { complete?: boolean } | undefined)?.complete ===
      true &&
    !hasActive
  return (
    <div className="assistant-panel chat-workbench">
      <ChatPicker
        chats={chats}
        selectedId={chatId}
        onSelect={(id) => void openChat(id)}
        onNew={() => void newChat()}
        onDelete={onDeleteChat}
        onRenamed={(renamed) => {
          if (!mounted.current) return
          ++chatNamesRevision.current
          setChats((previous) =>
            previous.map((chat) =>
              chat.id === renamed.id ? { ...chat, ...renamed } : chat,
            ),
          )
        }}
        disabled={applying || discarding}
        deleteDisabled={activeHere}
        loading={chatBusy}
      />
      <div className="assistant-mode-picker">
        <div className="mode-tabs" aria-label="Assistant mode">
          {chatModes.map((item) => (
            <button
              type="button"
              key={item.id}
              className={mode === item.id ? 'selected' : ''}
              aria-pressed={mode === item.id}
              onClick={() => draft.setMode(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
        <HelpTip label="Assistant modes">
          {chatModes.map((item) => (
            <span key={item.id}>
              <b>{item.name}:</b> {item.hint}
            </span>
          ))}
        </HelpTip>
      </div>
      {(texLanguage(currentFile) || formalizingDocument) && (
        <div className="assistant-tex-note">
          {formalizingDocument ? (
            'Use your source document to formalize mathematics in Lean.'
          ) : mode === 'search' ? (
            'Lemex can read, edit, and compile your LaTeX document here.'
          ) : (
            <button type="button" onClick={() => draft.setMode('search')}>
              Use Ask &amp; Search for LaTeX editing and compilation
            </button>
          )}
        </div>
      )}
      <ChatOptions
        models={session.models}
        savedModels={session.savedModels}
        onModelsUpdated={onModelsUpdated}
        model={model}
        onModel={setModel}
        effort={effort}
        onEffort={(value) =>
          setEfforts((previous) => ({
            ...previous,
            [reasoningPreferenceKey(providerScope, model, mode)]: value || null,
          }))
        }
        liveEdits={currentLiveEdits}
        onLiveEdits={mode === 'search' ? setSearchLiveEdits : setLiveEdits}
        active={hasActive}
      />
      {!session.models.length && (
        <p className="error-message" role="alert">
          {session.lemex?.modelError || 'No model is available with your key.'}{' '}
          Open Assistant settings to refresh models or update your API key.
        </p>
      )}
      {!!session.models.length && (!selectedModel || !effortAvailable) && (
        <p className="error-message" role="alert">
          {!selectedModel
            ? 'Your selected model is no longer available with this key. Choose an available model in Options.'
            : 'Your selected reasoning effort is no longer available for this model. Choose a supported level in Options.'}
        </p>
      )}
      {statusRun && (
        <div className="chat-current-work" role="status" aria-live="polite">
          <div>
            <span className="spinner" />
            <strong>
              {stopping
                ? 'Stopping…'
                : statusRun.progress?.label || runStatusLabel(statusRun)}
            </strong>
            <span className="chat-elapsed">{elapsed}</span>
          </div>
          {statusRun.progress?.detail &&
            !stopping &&
            !['Working', 'Running command', 'Using tool'].includes(
              statusRun.progress.label,
            ) && (
              <p title={statusRun.progress.detail}>
                {statusRun.progress.detail}
              </p>
            )}
          {!stopping && (liveEditStatus(statusRun) || connection) && (
            <p className="chat-work-meta">
              <span
                className="chat-edit-status"
                title={
                  statusRun.liveEditConflict ||
                  (statusRun.liveEdits
                    ? 'Only changes written to project files appear in the editor. Scratch checks do not change those files. Final Lean verification runs at completion.'
                    : liveEditStatus(statusRun))
                }
              >
                {liveEditStatus(statusRun)}
              </span>
              {connection && (
                <span className="chat-connection">
                  {connection === 'Live' ? 'Connected' : connection}
                </span>
              )}
            </p>
          )}
          {!activeHere && activeRun?.chatId && (
            <button
              type="button"
              className="turn-action"
              onClick={() => void openChat(activeRun.chatId!)}
            >
              Open active chat
            </button>
          )}
          <button
            type="button"
            className="button small secondary chat-stop"
            onClick={() => void stop()}
            disabled={stopping}
          >
            <Icon name="stop" size={13} />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      )}
      <div className="assistant-output">
        <div
          className="assistant-conversation"
          ref={conversationScroll.viewport}
          role="region"
          aria-label="Conversation"
          tabIndex={0}
          onScroll={conversationScroll.onScroll}
          onWheel={(event) => {
            if (event.deltaY < 0) conversationScroll.pause()
          }}
          onPointerDown={conversationScroll.pause}
          onKeyDown={(event) => {
            if (
              ['ArrowUp', 'PageUp', 'Home'].includes(event.key) ||
              (event.key === ' ' && event.shiftKey)
            )
              conversationScroll.pause()
          }}
        >
          <div ref={conversationScroll.content}>
            {runs.map((item) => (
              <ConversationTurn
                key={item.id}
                run={item}
                onReview={(id) => void review(id)}
                onUndo={(id) => void undo(id)}
                onInspect={inspect}
                canUndo={!dirty && !hasActive && !undoingId}
                undoing={undoingId === item.id}
                onOpenTarget={onOpenTarget}
              />
            ))}
            {!runs.length && !chatBusy && (
              <div className="chat-empty">
                <Icon name="bot" size={22} />
                <p>{currentMode.hint}</p>
                <div
                  className="assistant-starters"
                  role="group"
                  aria-label={`${currentMode.name} suggestions`}
                >
                  {currentMode.suggestions.map((item) => (
                    <button
                      type="button"
                      key={item.label}
                      onClick={() => {
                        draft.setText(item.prompt)
                        document.getElementById('assistant-prompt')?.focus()
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chatBusy && (
              <p className="working-message">
                <span className="spinner" />
                Loading conversation…
              </p>
            )}
          </div>
        </div>
        {!!runs.length && !conversationScroll.following && (
          <button
            className="jump-to-latest button small secondary"
            onClick={conversationScroll.jumpToLatest}
          >
            Jump to latest
          </button>
        )}
      </div>
      <form className="assistant-composer" onSubmit={submit}>
        {editorProof?.error && (
          <p className="error-message proof-focus-error" role="alert">
            {editorProof.error}
          </p>
        )}
        {proofTarget && (
          <div className="composer-proof-target" aria-label="Focused proof">
            <button
              type="button"
              className="proof-target-link"
              onClick={() => onOpenTarget?.(proofTarget)}
              disabled={!onOpenTarget}
              title={`Open ${proofTarget.path}:${proofTarget.startLine}`}
            >
              <Icon name="file" size={13} />
              <span>
                <span className="proof-target-caption">Focused on</span>
                <strong>{proofTarget.name || 'Selected proof'}</strong>
                <small>
                  {proofTarget.path}:{proofTarget.startLine}
                  {proofTarget.endLine !== proofTarget.startLine
                    ? `–${proofTarget.endLine}`
                    : ''}
                </small>
              </span>
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={draft.clearTarget}
              aria-label="Clear proof target"
              title="Clear proof target"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <div className="composer-context">
          <Icon name="file" size={13} />
          <span
            title={
              currentFile
                ? `${currentFile} is included automatically. You can add other files below.`
                : undefined
            }
            aria-label={
              currentFile
                ? `Current file included automatically: ${currentFile}`
                : undefined
            }
          >
            {currentFile
              ? `Current file: ${currentFile}`
              : target || 'Project context'}
          </span>
          {dirty && !hasActive && (
            <span className="tag">Saves before sending</span>
          )}
        </div>
        {mode === 'formalize' && (
          <div className="composer-context">
            <Icon name="file" size={13} />
            <span
              title={target}
              aria-label={`Lean output: ${target || 'new file'}`}
            >
              Lean output: {target || 'new file'}
            </span>
          </div>
        )}
        <label className="sr-only" htmlFor="assistant-prompt">
          Message Lemex
        </label>
        <FileMentionTextarea
          scope={draft.key}
          files={files}
          selected={contextFiles}
          onAddFile={(path) => {
            if (contextFiles.includes(path)) return true
            if (contextFiles.length >= 12) {
              setErrors((previous) => ({
                ...previous,
                [draft.key]:
                  'Attach up to 12 files. Remove one before adding another.',
              }))
              return false
            }
            draft.setFiles([...contextFiles, path])
            return true
          }}
          placeholder={
            acceptingUpdate
              ? 'Share an observation or change of direction…'
              : mode === 'search' && texLanguage(currentFile)
                ? 'Ask about this document, edit LaTeX, or compile and check its PDF…'
                : currentMode.placeholder
          }
          value={prompt}
          onChange={draft.setText}
        />
        <div className="composer-attachments">
          <FileContextPicker
            files={files}
            selected={contextFiles}
            onChange={draft.setFiles}
            disabled={false}
          />
          {onFocusEditor && (
            <ChatFocusPicker editor={editorProof} onFocus={onFocusEditor} />
          )}
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="composer-footer">
          <span>
            {hasActive
              ? acceptingUpdate
                ? 'Your update will be picked up after the current step.'
                : activeHere
                  ? 'Checking or stopping; your next draft is kept.'
                  : 'Open the active chat to send an update.'
              : requiresLeanTarget && !target
                ? 'Select a writable Lean file to begin.'
                : 'Ctrl / ⌘ + Enter to send'}
          </span>
          <button
            type="submit"
            className="button primary"
            disabled={
              chatBusy ||
              !prompt.trim() ||
              busy ||
              (hasActive
                ? !acceptingUpdate
                : (requiresLeanTarget && !target) ||
                  !selectedModel ||
                  !effortAvailable)
            }
          >
            {busy ? (
              <span className="spinner" />
            ) : (
              <Icon name="arrow" size={14} />
            )}
            {busy ? 'Sending…' : acceptingUpdate ? 'Send update' : 'Send'}
          </button>
        </div>
      </form>
      {dialogRun && (
        <Dialog
          title={
            dialogRun.liveEdits
              ? 'Review saved edits'
              : 'Review candidate changes'
          }
          subtitle="Review requested edits before applying. Lean edits also require proof verification."
          onClose={() => setDialogId(null)}
          busy={applying || discarding}
        >
          <div className="diff-review">
            {dialogRun.liveEdits && runIsActive(dialogRun) && (
              <p className="field-help">
                These edits are saved in the project. Final Lean verification is
                still pending.
              </p>
            )}
            <Verification value={dialogRun.verification} />
            {dialogRun.mode === 'formalize' && (
              <p className="review-note">
                Check that the statements express your intended mathematics.
              </p>
            )}
            {dirty &&
              !dialogRun.liveEdits &&
              dialogRun.status === 'completed' && (
                <div className="unsaved-candidate" role="status">
                  <strong>Apply is paused for your unsaved edits</strong>
                  <p>
                    Keep your edits and start a new run, or explicitly restore
                    the saved contents of all changed files.
                  </p>
                  {confirmDiscard ? (
                    <>
                      <p>
                        Discard unsaved changes in {dirtyFileCount}{' '}
                        {dirtyFileCount === 1 ? 'file' : 'files'}?
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
                          onClick={() => void discard()}
                        >
                          {discarding ? 'Discarding…' : 'Discard unsaved edits'}
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
            {(dialogRun.liveEdits
              ? dialogRun.liveChanges
              : dialogRun.changes) === undefined &&
              runChangeCount(dialogRun, !!dialogRun.liveEdits) > 0 && (
                <p className="field-help">
                  The edits changed.{' '}
                  <button
                    className="button small secondary"
                    onClick={() => void review(dialogRun.id)}
                  >
                    Refresh review
                  </button>
                </p>
              )}
            {(dialogRun.liveEdits
              ? dialogRun.liveChanges
              : dialogRun.changes
            )?.map((change) => (
              <ChangeDiff key={change.path} change={change} />
            ))}
            {actionError && (
              <p className="error-message" role="alert">
                {actionError}
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setDialogId(null)}
              disabled={applying || discarding}
            >
              Close
            </button>
            {!dialogRun.liveEdits && (
              <button
                className="button primary"
                disabled={!canApply || applying || dirty || discarding}
                onClick={() => void apply()}
              >
                {applying
                  ? 'Applying…'
                  : dialogRun.status === 'applied'
                    ? 'Already applied'
                    : 'Apply changes'}
              </button>
            )}
          </footer>
        </Dialog>
      )}
    </div>
  )
}
