import { LeanMonaco } from 'lean4monaco'
import { CloseAction, ErrorAction } from 'vscode-languageclient/browser'
import { getService, IFileService, ITextFileService } from 'vscode/services'
import type { CancellationToken } from 'monaco-editor'
import type { WebSocketConfigOptionsUrl } from 'monaco-editor-wrapper'
import { FileUri } from 'lean4monaco/dist/vscode-lean4/vscode-lean4/src/utils/exturi'
import type { SourceRequest } from './LibrarySourceDialog'
import {
  CancellationTokenSource,
  KeyCode,
  Selection,
  Uri,
  editor as monacoEditor,
  languages,
} from 'monaco-editor'
import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { OpenFile, PaperLink } from './api'
import { sessionBoundUrl } from './api'
import { connectInfoviewTheme } from './infoviewTheme'
import { leanEditorTheme } from './leanEditorTheme'
import './leanEditorTheme.css'
import { ResizeHandle } from './ResizeHandle'
import { proofCheckMark, proofCheckMarks } from './proofCheckMarks'
import { DEFAULT_LAYOUT, useMediaQuery } from './layout'
import { isMarkdownPath } from './fileReading'
import { texLanguage } from './texBuilds'
import { RenameModels } from './renameModels'
import { initializeLeanEditor } from './leanEditorServices'
import { DefinitionPreviewFiles } from './definitionPreviewFiles'
import { WorkspaceEditor } from './workspaceEditor'
import { installLeanClientLifecycle } from './leanClientLifecycle'
import {
  leanConnectionCloseMessage,
  leanConnectionFailed,
  transientLeanStartupClose,
} from './leanConnectionIssue'
import { watchEditorIdle } from './editorIdle'
import {
  editorQueueNotice,
  REPOSITORY_TREE_CHANGED,
  type EditorQueueNotice,
} from '../../../shared/editor-queue.mjs'
import { installCollaborativeEditorUndo } from './collaborativeEditorUndo'
import { CollaboratorCursors } from './collaboratorCursors'
import { LeanCommentImagePreviews } from './leanCommentImagePreviews'
import type { ProjectPeer, ProjectSelection } from './projectPresence'
import { LeanModelCache } from './leanModelCache'
import {
  affectsLean,
  changedLeanFiles,
  type WorkspaceFileListing,
} from './leanFileRevisions'
import type { RenameSource } from './workspaceBuffers'
import { installLeanRenameMiddleware } from './leanRenameMiddleware'
import { LEAN_EDIT_DISABLED_MESSAGE } from '../../../shared/lean-edit-policy.mjs'
import {
  documentTextEdit,
  documentOffsetAfterEdit,
} from '../../../shared/document-text.mjs'
import type { ChatMode } from './chatModes'
import { ProofDiagnostics, proofCheckStatuses } from './proofDiagnostics'
import { MacroProofDeclarations } from './macroProofDeclarations'
import { decoratePaperLinks } from './paperLinkDecorations'
import {
  outlineCode,
  proofDeclarationsFromCode,
  proofTargetForSelection,
  type ProofDeclaration,
  type EditorProofState,
  type ProofEditorRequest,
  type EditorSelection,
  type ProofTarget,
} from './proofTarget'

class BrowserLeanMonaco extends LeanMonaco {
  readonly proofDiagnostics = new ProofDiagnostics()
  onDocumentOpened?: (uri: string) => void
  private readonly pendingConnections = new AbortController()
  private readonly disposedConnections = new AbortController()

  cancelPendingConnections() {
    this.pendingConnections.abort()
  }

  override dispose() {
    this.cancelPendingConnections()
    this.disposedConnections.abort()
    super.dispose()
  }

  closeHiddenDocuments: () => Promise<void> = async () => {}
  showVisibleDocument: () => Promise<boolean> = async () => false
  refreshVisibleDocument: () => Promise<boolean> = async () => false
  constructor(
    private readonly onSocketClosed: (
      code: number,
      reason: string,
      initialized: boolean,
    ) => void,
    private readonly onProcessingNotice: (
      message: string,
      uri?: string,
    ) => void,
    private readonly onRenameIssue: (message: string) => void,
    private readonly renameContext: () => {
      uri: string | null
      hiddenDirty: boolean
      retained?: (uri: string) => boolean
    },
    private readonly prepareRenameSources: (
      sources: RenameSource[],
      token: CancellationToken,
    ) => Promise<void>,
    private readonly onEditorQueue: (notice: EditorQueueNotice) => void,
  ) {
    super()
  }

  protected override getWebSocketOptions(
    options: Parameters<LeanMonaco['start']>[0],
  ): WebSocketConfigOptionsUrl & {
    leanflowProofDiagnostics: () => ReturnType<
      ProofDiagnostics['openConnection']
    >
    leanflowQueue: (params: unknown) => void
    leanflowSocketOpened: () => (
      code: number,
      reason: string,
      initialized: boolean,
    ) => void
    leanflowPendingSignal: AbortSignal
    leanflowDisposeSignal: AbortSignal
  } {
    const settings = super.getWebSocketOptions(options)
    let latestSocket = 0
    const onProcessingNotice = this.onProcessingNotice
    const onRenameIssue = this.onRenameIssue
    const onEditorQueue = this.onEditorQueue
    const setDocumentController = (
      controller: ReturnType<typeof installLeanRenameMiddleware>,
    ) => {
      this.closeHiddenDocuments = controller.closeHidden
      this.showVisibleDocument = controller.showVisible
      this.refreshVisibleDocument = controller.refreshVisible
    }
    const renameContext = this.renameContext
    const prepareRenameSources = this.prepareRenameSources
    return {
      ...settings,
      leanflowProofDiagnostics: () =>
        this.proofDiagnostics.openConnection(this.onDocumentOpened),
      leanflowPendingSignal: this.pendingConnections.signal,
      leanflowDisposeSignal: this.disposedConnections.signal,
      leanflowSocketOpened: () => {
        const socket = ++latestSocket
        return (code, reason, initialized) => {
          if (socket === latestSocket)
            this.onSocketClosed(code, reason, initialized)
        }
      },
      leanflowQueue(params: unknown) {
        const notice = editorQueueNotice(params)
        if (notice) onEditorQueue(notice)
      },
      startOptions: {
        ...settings.startOptions,
        onCall(client) {
          settings.startOptions?.onCall(client)
          client?.onNotification('$/leanflow/processing', (params: unknown) => {
            if (
              params &&
              typeof params === 'object' &&
              'message' in params &&
              typeof params.message === 'string'
            )
              onProcessingNotice(
                params.message,
                'uri' in params && typeof params.uri === 'string'
                  ? params.uri
                  : undefined,
              )
          })
          if (client)
            setDocumentController(
              installLeanRenameMiddleware(
                client,
                renameContext,
                onRenameIssue,
                prepareRenameSources,
              ),
            )
          const previous = client?.clientOptions.errorHandler
          if (!client || !previous) return
          let sourceTooLarge = false
          const stop = client.stop.bind(client)
          client.stop = async (...args) => {
            try {
              await stop(...args)
            } catch (error) {
              // The wrapper sends shutdown after socket closure. A size rejection
              // has already closed that transport, so its shutdown cannot reply.
              if (!sourceTooLarge) throw error
            }
          }
          // Keep the installed client's normal recovery policy. A rejected
          // document cannot recover through repeated automatic reconnections.
          client.clientOptions.errorHandler = {
            error(error, message, count) {
              if (
                error.name === '1009' ||
                /socket reconnect: code = 1009\b/.test(error.message)
              ) {
                sourceTooLarge = true
                return { action: ErrorAction.Continue, handled: true }
              }
              return previous.error(error, message, count)
            },
            closed() {
              return sourceTooLarge
                ? { action: CloseAction.DoNotRestart, handled: true }
                : previous.closed()
            },
          }
        },
      },
    }
  }

  protected override getExtensionManifest() {
    // LeanMonaco starts the Lean client, infoview, and abbreviation features
    // itself. Register the language/configuration contributions without trying
    // to activate the packaged desktop VS Code entry point in a browser host.
    return {
      ...super.getExtensionManifest(),
      main: undefined,
      browser: undefined,
      activationEvents: [],
      extensionDependencies: [],
    }
  }
}

// VS Code's services are global. Every lifecycle transition, including StrictMode
// cleanup, must finish before another instance can initialize them.
let lifecycle: Promise<unknown> = Promise.resolve()
function serialize(task: () => Promise<void> | void) {
  const next = lifecycle.then(task)
  lifecycle = next.catch(() => undefined)
  return next
}

interface Runtime {
  lean: BrowserLeanMonaco
  virtualFiles: Set<string>
  editor?: WorkspaceEditor
  subscription?: { dispose(): void }
  restoreOpenEditor?: () => void
  connectionSubscriptions?: { dispose(): void }[]
  outlineCleanup?: () => void
  visibleReadyPath?: string
  sourceTooLarge?: boolean
  retryStartupWhenVisible?: () => boolean
  renameModels?: RenameModels
  modelCache: LeanModelCache
  viewStates: Map<string, monacoEditor.ICodeEditorViewState>
  disabledRenameAction?: { dispose(): void }
  clientLifecycle?: ReturnType<typeof installLeanClientLifecycle>
  idle?: ReturnType<typeof watchEditorIdle>
  collaborativeUndo?: ReturnType<typeof installCollaborativeEditorUndo>
  collaboratorCursors?: CollaboratorCursors
  commentImages?: LeanCommentImagePreviews
  definitionPreviewFiles?: DefinitionPreviewFiles
}
interface ConnectionClient {
  isRunning(): boolean
  restarted(listener: () => void): { dispose(): void }
  restarting(listener: () => void): { dispose(): void }
  serverFailed(listener: () => void): { dispose(): void }
}

export function LeanWorkspace({
  projectId,
  queuedFileCheck,
  fileListing,
  file,
  buffers,
  retainedPaths,
  bufferDiscardVersion,
  bufferSaveVersion,
  editorImportsVersion,
  savedPaths,
  bufferRemoveVersion,
  removedPaths,
  onRenameSources,
  onCollaborativeUndo,
  onCollaborativeRedo,
  collaborators,
  onCollaborativeSelection,
  theme,
  onChange,
  onState,
  showInfoview,
  onOpenFile,
  onOpenLibrary,
  goalsSize,
  onGoalsSizeChange,
  onFocusProof,
  revealTarget,
  revealPosition,
  onProofStateChange,
  focusEditorRequest,
  onFocusEditorHandled,
  paperLinks,
  onOpenPaperLink,
  onShowPaperLinks,
  joining = false,
}: {
  projectId: string
  queuedFileCheck?: { submit: () => void; inProgress: boolean }
  fileListing: WorkspaceFileListing | null
  file: OpenFile | null
  buffers: ReadonlyMap<string, OpenFile>
  retainedPaths: readonly string[]
  bufferDiscardVersion: number
  bufferSaveVersion: number
  editorImportsVersion?: number
  savedPaths: readonly string[]
  bufferRemoveVersion: number
  removedPaths: readonly string[]
  onRenameSources: (sources: RenameSource[]) => void
  onCollaborativeUndo?: (path: string) => boolean
  onCollaborativeRedo?: (path: string) => boolean
  collaborators?: readonly ProjectPeer[]
  onCollaborativeSelection?: (selection: ProjectSelection | null) => void
  theme: 'light' | 'dark'
  onChange: (path: string, content: string) => void
  onState: (state: string, failureReason?: string) => void
  showInfoview: boolean
  onOpenFile: (path: string, line?: number, column?: number) => void
  onOpenLibrary: (request: SourceRequest) => void
  goalsSize: number
  onGoalsSizeChange: (value: number) => void
  onFocusProof?: (target: ProofTarget, mode?: ChatMode) => void
  onProofStateChange?: (state: EditorProofState | null) => void
  focusEditorRequest?: ProofEditorRequest | null
  onFocusEditorHandled?: (id: number) => void
  paperLinks?: readonly PaperLink[]
  onOpenPaperLink?: (
    location: PaperLink['source'] | PaperLink['target'],
  ) => void
  onShowPaperLinks?: () => void
  joining?: boolean
  revealTarget?: {
    id: number
    target: Pick<ProofTarget, 'path' | 'startLine' | 'endLine' | 'name'>
  } | null
  revealPosition?: {
    id: number
    path: string
    line: number
    column: number
  } | null
}) {
  const workspaceEl = useRef<HTMLDivElement>(null)
  const editorEl = useRef<HTMLDivElement>(null)
  const infoEl = useRef<HTMLDivElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const listedFiles = useRef<WorkspaceFileListing | null>(null)
  const fileRef = useRef(file)
  const paperLinkActions = useRef({ onOpenPaperLink, onShowPaperLinks })
  paperLinkActions.current = { onOpenPaperLink, onShowPaperLinks }
  const joiningRef = useRef(joining)
  joiningRef.current = joining
  const retainedPathsRef = useRef(retainedPaths)
  useLayoutEffect(() => {
    retainedPathsRef.current = retainedPaths
  }, [retainedPaths])
  const buffersRef = useRef(buffers)
  buffersRef.current = buffers
  const syncingContent = useRef(false)
  const collaborativeCommands = useRef({
    undo: onCollaborativeUndo,
    redo: onCollaborativeRedo,
  })
  const collaboratorsRef = useRef(collaborators)
  collaboratorsRef.current = collaborators
  const onCollaborativeSelectionRef = useRef(onCollaborativeSelection)
  onCollaborativeSelectionRef.current = onCollaborativeSelection
  collaborativeCommands.current = {
    undo: onCollaborativeUndo,
    redo: onCollaborativeRedo,
  }
  const onChangeRef = useRef(onChange)
  const onRenameSourcesRef = useRef(onRenameSources)
  const onStateRef = useRef(onState)
  const onOpenFileRef = useRef(onOpenFile)
  const onOpenLibraryRef = useRef(onOpenLibrary)
  const themeRef = useRef(theme)
  const onFocusProofRef = useRef(onFocusProof)
  const declarationsRef = useRef<ProofDeclaration[]>([])
  const [checkedDeclarations, setDeclarations] = useState<ProofDeclaration[]>(
    [],
  )
  const [outlineStatus, setOutlineStatus] = useState<
    'loading' | 'ready' | 'unavailable'
  >('loading')
  const [focus, setFocus] = useState<{
    target: ProofTarget | null
    hasSelection?: boolean
    error?: string
  }>({ target: null })
  const revealed = useRef<number | null>(null)
  const revealedPosition = useRef<number | null>(null)
  const focusedRequest = useRef<number | null>(null)
  const [failure, setFailure] = useState('')
  const [markdownIssue, setMarkdownIssue] = useState('')
  const [texIssue, setTexIssue] = useState('')
  const [connectionIssue, setConnectionIssue] = useState('')
  const [transportIssue, setTransportIssue] = useState('')
  const [retryingStartup, setRetryingStartup] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [sleeping, setSleeping] = useState(false)
  const [editorQueue, setEditorQueue] = useState<EditorQueueNotice | null>(null)
  const editorQueueRef = useRef<EditorQueueNotice | null>(null)
  const [restartIssue, setRestartIssue] = useState('')
  const [importsStale, setImportsStalePath] = useState<string | null>(null)
  const importsStaleRef = useRef<string | null>(null)
  const setImportsStale = useCallback((path: string | null) => {
    importsStaleRef.current = path
    setImportsStalePath(path)
  }, [])
  const [refreshingImports, setRefreshingImports] = useState(false)
  const importsRevision = useRef(0)
  const markOpenImportsStale = useCallback(
    (active: Runtime) => {
      const path = fileRef.current?.path
      if (
        path?.endsWith('.lean') &&
        active.lean.proofDiagnostics.hasOpenDocument(
          new FileUri('/workspace/' + path).toString(),
        )
      ) {
        importsRevision.current++
        setImportsStale(path)
      }
    },
    [setImportsStale],
  )
  const refreshVisibleImports = useCallback(
    async (active: Runtime) => {
      const file = fileRef.current
      if (
        !file?.path.endsWith('.lean') ||
        active.visibleReadyPath !== file.path
      )
        return
      const revision = importsRevision.current
      if (
        (await active.lean.refreshVisibleDocument()) &&
        runtime.current === active &&
        fileRef.current?.path === file.path &&
        fileRef.current.generation === file.generation &&
        importsRevision.current === revision
      ) {
        setImportsStale(null)
        await active.modelCache.retain(
          new FileUri('/workspace/' + file.path).toString(),
        )
      }
    },
    [setImportsStale],
  )
  const [requestIssue, setRequestIssue] = useState('')
  const [renameIssue, setRenameIssue] = useState('')
  const [loading, setLoading] = useState(true)
  const [visibleEditor, setVisibleEditor] =
    useState<monacoEditor.IStandaloneCodeEditor>()
  const proofChecksPaused = !!(
    sleeping ||
    restarting ||
    refreshingImports ||
    editorQueue ||
    connectionIssue ||
    transportIssue ||
    retryingStartup ||
    failure ||
    (file?.path && importsStale === file.path)
  )
  const declarations = useMemo(
    () =>
      proofChecksPaused
        ? checkedDeclarations.map((item) =>
            item.checkStatus
              ? { ...item, checkStatus: 'pending' as const }
              : item,
          )
        : checkedDeclarations,
    [proofChecksPaused, checkedDeclarations],
  )

  const stacked = useMediaQuery('(max-width: 1250px)')
  fileRef.current = file
  onChangeRef.current = onChange
  onStateRef.current = onState
  onOpenFileRef.current = onOpenFile
  onOpenLibraryRef.current = onOpenLibrary
  themeRef.current = theme
  onRenameSourcesRef.current = onRenameSources
  onFocusProofRef.current = onFocusProof

  const recoverVisibleConnection = useCallback((active: Runtime) => {
    if (active.retryStartupWhenVisible?.()) return
    const canRecover = () => {
      const path = fileRef.current?.path
      return (
        runtime.current === active &&
        !active.lean.disposed &&
        !active.sourceTooLarge &&
        !!path?.endsWith('.lean') &&
        active.visibleReadyPath === path
      )
    }
    // Do not block file switching or ordinary editing while a connection waits
    // for a worker. The new client opens the current model when it is ready.
    void active.clientLifecycle?.recover(canRecover).catch(() => {
      if (canRecover())
        setRestartIssue('Lean could not reconnect. Use Restart Lean to retry.')
    })
  }, [])

  useEffect(() => {
    if (!infoEl.current) return
    return connectInfoviewTheme(infoEl.current)
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    let own: Runtime | null = null
    let lastConnectionIssue = ''
    let startupIssue = ''
    let retryCount = 0
    let recentTreeRetries: number[] = []
    let retryDue = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const rootDocument = new FileUri('/workspace/__lemex_client__.lean')
    const clearStartupRetry = () => {
      clearTimeout(retryTimer)
      retryDue = false
      startupIssue = ''
      setRetryingStartup(false)
    }
    const reportConnectionFailure = (
      message = lastConnectionIssue || leanConnectionFailed,
    ) => {
      if (
        cancelled ||
        startupIssue ||
        own?.sourceTooLarge ||
        own?.clientLifecycle?.sleeping ||
        lastConnectionIssue === message
      )
        return
      lastConnectionIssue = message
      editorQueueRef.current = null
      setEditorQueue(null)
      setTransportIssue(message)
      onStateRef.current('Lean connection failed', message)
    }
    const canRetryStartup = () => {
      const path = fileRef.current?.path
      return !!(
        !cancelled &&
        startupIssue &&
        own?.clientLifecycle &&
        !own.clientLifecycle.sleeping &&
        !document.hidden &&
        !editorQueueRef.current &&
        path?.endsWith('.lean') &&
        own.visibleReadyPath === path
      )
    }
    const retryStartupWhenVisible = () => {
      if (!startupIssue) return false
      if (retryDue && canRetryStartup()) {
        retryDue = false
        const attempt = retryCount
        void own?.clientLifecycle
          ?.recover(canRetryStartup, rootDocument)
          .then(() => {
            // Eligibility is checked again after draining the previous start.
            // Keep a deferred attempt available when the tab was hidden meanwhile.
            if (startupIssue && attempt === retryCount) retryDue = true
          })
          .catch(() => {
            // Another socket close can already have scheduled the next attempt.
            if (cancelled || !startupIssue || attempt !== retryCount) return
            const message = startupIssue
            clearStartupRetry()
            reportConnectionFailure(message)
          })
      }
      return true
    }
    document.addEventListener('visibilitychange', retryStartupWhenVisible)
    setRetryingStartup(false)
    setFailure('')
    setMarkdownIssue('')
    setConnectionIssue('')
    setTransportIssue('')
    setRequestIssue('')
    setRestartIssue('')
    setImportsStale(null)
    setRestarting(false)
    setSleeping(false)
    setEditorQueue(null)
    editorQueueRef.current = null
    setRenameIssue('')
    setLoading(true)
    onStateRef.current('Connecting to Lean')
    void serialize(async () => {
      if (cancelled || !editorEl.current || !infoEl.current) return
      const lean = new BrowserLeanMonaco(
        (code, reason, initialized) => {
          if (cancelled || own?.clientLifecycle?.sleeping) return
          const message = leanConnectionCloseMessage(code, reason)
          if (!message) {
            clearStartupRetry()
            return
          }
          const treeChanged =
            code === 1012 && reason === REPOSITORY_TREE_CHANGED
          const now = performance.now()
          if (treeChanged)
            recentTreeRetries = recentTreeRetries.filter(
              (time) => now - time < 60_000,
            )
          if (
            (treeChanged
              ? recentTreeRetries.length < 2
              : !initialized && transientLeanStartupClose(code, reason)) &&
            retryCount < 2
          ) {
            // Repeated tree changes can follow successful initializations. Keep
            // this limit across reconnects so a bulk import cannot loop here.
            if (treeChanged) recentTreeRetries.push(now)
            startupIssue = message
            setRetryingStartup(true)
            setEditorQueue(null)
            editorQueueRef.current = null
            onStateRef.current('Reconnecting to Lean')
            clearTimeout(retryTimer)
            retryDue = false
            retryCount++
            retryTimer = setTimeout(
              () => {
                retryDue = true
                retryStartupWhenVisible()
              },
              retryCount === 1 ? 1500 : 4000,
            )
            return
          }
          clearStartupRetry()
          if (code === 1009) {
            setEditorQueue(null)
            editorQueueRef.current = null
            if (own) own.sourceTooLarge = true
            setConnectionIssue(message)
            onStateRef.current('Lean paused: source too large', message)
          } else reportConnectionFailure(message)
        },
        (message, uri) => {
          if (
            !cancelled &&
            (!uri ||
              uri ===
                new FileUri('/workspace/' + fileRef.current?.path).toString())
          )
            setRequestIssue(message)
        },
        (message) => {
          if (!cancelled) setRenameIssue(message)
        },
        () => {
          const path = fileRef.current?.path
          return {
            uri:
              path && own?.visibleReadyPath === path
                ? 'file:///workspace/' +
                  path.split('/').map(encodeURIComponent).join('/')
                : null,
            hiddenDirty: [...buffersRef.current.values()].some(
              (buffer) =>
                buffer.path !== path && buffer.content !== buffer.savedContent,
            ),
            retained: (uri) => own?.modelCache.has(uri) ?? false,
          }
        },
        async (sources, token) => {
          if (cancelled || !own?.renameModels)
            throw new Error('Rename cancelled.')
          for (const source of sources) own.virtualFiles.add(source.uri)
          await own.renameModels.prepare(sources, token)
        },
        (notice) => {
          if (cancelled) return
          const queued = notice.state === 'active' ? null : notice
          if (!queued && editorQueueRef.current) own?.idle?.resetDeadline()
          editorQueueRef.current = queued
          setEditorQueue(queued)
          if (notice.state === 'waiting') {
            onStateRef.current(`Waiting for Lean: position ${notice.position}`)
          } else onStateRef.current('Connecting to Lean')
        },
      )
      lean.onDocumentOpened = (uri) => {
        const stale = importsStaleRef.current
        // didOpen starts a fresh Lean worker, including during a file switch
        // or reconnect. A model rerender without didOpen keeps its old notice.
        if (
          !cancelled &&
          stale &&
          new FileUri('/workspace/' + stale).toString() === uri
        )
          setImportsStale(null)
      }
      own = {
        lean,
        retryStartupWhenVisible,
        virtualFiles: new Set(),
        viewStates: new Map(),
        modelCache: new LeanModelCache(() => {
          void serialize(async () => {
            if (!cancelled && runtime.current === own)
              await lean.closeHiddenDocuments()
          }).catch(() => undefined)
        }),
        renameModels: new RenameModels(
          () => own?.editor?.editor?.getModel() ?? null,
          (sources) => onRenameSourcesRef.current(sources),
          (path, content) => {
            if (!cancelled) onChangeRef.current(path, content)
          },
        ),
      }
      own.modelCache.reconcile(
        buffersRef.current,
        fileRef.current?.path ?? null,
      )
      runtime.current = own
      lean.setInfoviewElement(infoEl.current)
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      try {
        await initializeLeanEditor(
          document.getElementById('root') ?? editorEl.current ?? undefined,
        )
        own.definitionPreviewFiles = new DefinitionPreviewFiles(projectId)
        await lean.start({
          websocket: {
            url: sessionBoundUrl(
              `${protocol}//${location.host}/websocket/${encodeURIComponent(projectId)}`,
            ),
          },
          // Global VS Code UI services retain this element across projects.
          htmlElement: document.getElementById('root') ?? editorEl.current,
          vscode: {
            ...leanEditorTheme(themeRef.current),
            'editor.tabSize': 2,
            'editor.fontSize': 14,
            'editor.wordWrap': 'on',
            'editor.minimap.enabled': false,
            'lean4.input.eagerReplacementEnabled': true,
            'lean4.infoview.showGoalNames': true,
            'lean4.infoview.emphasizeFirstGoal': true,
          },
        })
        if (!cancelled) {
          onStateRef.current('Lean editor ready')
          own.connectionSubscriptions = []
          const provider = lean.clientProvider
          if (provider) {
            // Upstream's browser fallback uses each file's parent directory as
            // its project root. All paths here belong to one server workspace;
            // route them to one client so nested modules/dependencies share the
            // same root, document selector, and WebSocket connection.
            const ensureClient = provider.ensureClient.bind(provider)
            provider.ensureClient = (uri) =>
              ensureClient(uri.scheme === 'file' ? rootDocument : uri)
            own.clientLifecycle = installLeanClientLifecycle(
              provider,
              new FileUri('/workspace'),
              (error) => {
                // A handshake error may reject the factory just before the
                // browser delivers its close code. Give the socket handler
                // the first opportunity to classify that failure.
                setTimeout(() => {
                  if (
                    !cancelled &&
                    !provider.getClients().some((client) => client.isRunning())
                  )
                    reportConnectionFailure()
                }, 0)
                console.warn(
                  '[LeanFlow Web] Lean connection ended during startup or shutdown.',
                  error,
                )
              },
            )
            const active = own
            active.idle = watchEditorIdle(
              document,
              infoEl.current,
              () => {
                if (cancelled || runtime.current !== active) return
                clearStartupRetry()
                setSleeping(true)
                onStateRef.current('Lean editor sleeping')
                void active.clientLifecycle?.suspend().catch(() => {
                  if (!cancelled)
                    setRestartIssue(
                      'Lean could not pause. Use Restart Lean to reconnect.',
                    )
                })
              },
              () => {
                if (cancelled || runtime.current !== active) return
                setSleeping(false)
                onStateRef.current('Reconnecting to Lean')
                void active.clientLifecycle
                  ?.resume(
                    new FileUri('/workspace/__lemex_client__.lean'),
                    !!fileRef.current?.path.endsWith('.lean'),
                  )
                  .then(() => {
                    if (
                      !cancelled &&
                      runtime.current === active &&
                      !active.clientLifecycle?.sleeping
                    ) {
                      setRestartIssue('')
                      onStateRef.current(
                        provider
                          .getClients()
                          .some((client) => client.isRunning())
                          ? 'Lean connected'
                          : 'Lean editor ready',
                      )
                    }
                  })
                  .catch(() => {
                    if (!cancelled)
                      setRestartIssue(
                        'Lean could not reconnect. Use Restart Lean or reopen the project to retry.',
                      )
                  })
              },
              () => editorQueueRef.current === null,
            )
            own.connectionSubscriptions.push(
              provider.clientAdded((client: ConnectionClient) => {
                if (cancelled) return
                onStateRef.current(
                  startupIssue ? 'Reconnecting to Lean' : 'Connecting to Lean',
                )
                own?.connectionSubscriptions?.push(
                  client.restarted(() => {
                    if (!cancelled && !active.clientLifecycle?.sleeping) {
                      const connected = client.isRunning()
                      if (connected) {
                        clearStartupRetry()
                        retryCount = 0
                        lastConnectionIssue = ''
                        setTransportIssue('')
                        setRestartIssue('')
                        onStateRef.current('Lean connected')
                      } else reportConnectionFailure()
                    }
                  }),
                  client.restarting(() => {
                    if (!cancelled) {
                      lastConnectionIssue = ''
                      onStateRef.current(
                        startupIssue
                          ? 'Reconnecting to Lean'
                          : 'Restarting Lean',
                      )
                    }
                  }),
                  client.serverFailed(() => {
                    reportConnectionFailure()
                  }),
                )
              }),
              provider.clientStopped(() => {
                if (
                  !cancelled &&
                  !active.clientLifecycle?.sleeping &&
                  !active.sourceTooLarge &&
                  !startupIssue &&
                  !lastConnectionIssue
                )
                  onStateRef.current('Lean server stopped')
              }),
            )
          }
          try {
            const markdown =
              await import('@codingame/monaco-vscode-markdown-basics-default-extension')
            await markdown.whenReady()
          } catch (error) {
            if (!cancelled)
              setMarkdownIssue(
                'Markdown highlighting could not load. Your file is still editable. Reload the page to try again.',
              )
            console.warn(
              '[LeanFlow Web] Markdown highlighting could not load.',
              error,
            )
          }
          try {
            const latex =
              await import('@codingame/monaco-vscode-latex-default-extension')
            await latex.whenReady()
          } catch (error) {
            if (!cancelled)
              setTexIssue(
                'TeX highlighting could not load. Your file is still editable. Reload the page to try again.',
              )
            console.warn(
              '[LeanFlow Web] TeX highlighting could not load.',
              error,
            )
          }
        }
      } catch (error) {
        own.definitionPreviewFiles?.dispose()
        lean.dispose()
        if (!cancelled) {
          setFailure(
            error instanceof Error
              ? error.message
              : 'Could not start the Lean editor.',
          )
          setLoading(false)
          onStateRef.current('Lean connection failed')
        }
        throw error
      }
    }).catch(() => undefined)
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', retryStartupWhenVisible)
      own?.lean.cancelPendingConnections()
      own?.idle?.dispose()
      void serialize(async () => {
        own?.subscription?.dispose()
        own?.outlineCleanup?.()
        own?.connectionSubscriptions?.forEach((subscription) =>
          subscription.dispose(),
        )
        own?.restoreOpenEditor?.()
        own?.disabledRenameAction?.dispose()
        own?.collaborativeUndo?.dispose()
        own?.collaboratorCursors?.dispose()
        own?.commentImages?.dispose()
        const closingFile = own?.editor?.modelRef?.object
        if (closingFile) {
          // Virtual file changes can still be reloading this managed model.
          // Finish them before disposing its text model and reusing the URI.
          await closingFile.revert({ soft: true })
          const textFiles = await getService(ITextFileService)
          await textFiles.files.canDispose(closingFile)
        }
        const closingModel = own?.editor?.editor?.getModel()
        own?.editor?.dispose()
        own?.modelCache.dispose()
        await own?.renameModels?.dispose()
        if (closingModel && !closingModel.isDisposed()) closingModel.dispose()
        // The upstream provider calls stop() without awaiting it. Finish socket
        // shutdown before another project uses the shared /workspace model URIs.
        await own?.clientLifecycle?.close()
        own?.lean.dispose()
        if (own?.virtualFiles.size) {
          const textFiles = await getService(ITextFileService)
          // Finish managed model activity while its project reader is available.
          for (const uri of own.virtualFiles) {
            const model = textFiles.files.get(Uri.parse(uri))
            if (model) {
              await model.revert({ soft: true })
              await textFiles.files.canDispose(model)
              model.dispose()
            }
          }
        }
        own?.definitionPreviewFiles?.dispose()
        if (own?.virtualFiles.size) {
          const files = await getService(IFileService)
          // Only explicit browser copies are removed. Project sources and
          // read-only library files stay behind their authenticated readers.
          for (const uri of own.virtualFiles) {
            const resource = Uri.parse(uri)
            if (await files.exists(resource)) await files.del(resource)
          }
          own.virtualFiles.clear()
        }
        if (runtime.current === own) runtime.current = null
      }).catch((error) => {
        own?.definitionPreviewFiles?.dispose()
        own?.lean.dispose()
        if (runtime.current === own) runtime.current = null
        console.error(
          '[LeanFlow Web] Could not finish closing the Lean editor.',
          error,
        )
      })
    }
  }, [projectId])

  useLayoutEffect(() => {
    runtime.current?.modelCache.reconcile(buffers, file?.path ?? null)
  }, [buffers, file?.path])

  useLayoutEffect(() => {
    const active = runtime.current
    active?.modelCache.retainOpenPaths(retainedPaths)
    if (active)
      for (const path of active.viewStates.keys())
        if (!retainedPaths.includes(path)) active.viewStates.delete(path)
  }, [retainedPaths])

  useLayoutEffect(() => {
    const previous = listedFiles.current
    listedFiles.current = fileListing
    if (!previous || !fileListing) return
    const { changed, uncertain, unknownChange } = changedLeanFiles(
      previous.files,
      fileListing,
    )
    const active = runtime.current
    if (!active) return
    const foreignChange =
      unknownChange ||
      [...changed].some((path) => path !== fileRef.current?.path)
    if (foreignChange) markOpenImportsStale(active)
    // An incomplete listing cannot certify cached workers for a future visit.
    // A refresh without evidence of a change can leave the visible proof running.
    if (uncertain || foreignChange) active.modelCache.clear()
    else if (changed.size) active.modelCache.invalidate()
  }, [fileListing, markOpenImportsStale])

  useLayoutEffect(() => {
    runtime.current?.renameModels?.synchronize(buffersRef.current)
  }, [bufferDiscardVersion, buffers])

  useLayoutEffect(() => {
    const active = runtime.current
    if (!active || !savedPaths.some(affectsLean)) return
    const path = fileRef.current?.path
    if (savedPaths.some((saved) => affectsLean(saved) && saved !== path)) {
      active.modelCache.clear()
      markOpenImportsStale(active)
    } else active.modelCache.invalidate()
    let cancelled = false
    void serialize(async () => {
      if (!cancelled && runtime.current === active)
        await active.lean.closeHiddenDocuments()
    }).catch(() => {
      if (!cancelled)
        setRestartIssue(
          'Files were saved, but Lean could not refresh their imports. Use Restart Lean to reconnect.',
        )
    })
    return () => {
      cancelled = true
    }
  }, [bufferSaveVersion, projectId, savedPaths, markOpenImportsStale])

  useEffect(() => {
    if (!editorImportsVersion) return
    let cancelled = false
    void serialize(async () => {
      if (cancelled) return
      const active = runtime.current
      if (!active) return
      active.modelCache.invalidate()
      try {
        await active.lean.closeHiddenDocuments()
        await refreshVisibleImports(active)
      } finally {
        if (!cancelled) recoverVisibleConnection(active)
      }
    }).catch(() => {
      if (!cancelled)
        setRestartIssue(
          'Project imports were rebuilt, but Lean could not refresh this file. Use Restart Lean to reconnect.',
        )
    })
    return () => {
      cancelled = true
    }
  }, [
    editorImportsVersion,
    projectId,
    recoverVisibleConnection,
    refreshVisibleImports,
  ])

  useEffect(() => {
    runtime.current?.modelCache.removePaths(removedPaths)
    void runtime.current?.renameModels?.remove(removedPaths)
  }, [bufferRemoveVersion, removedPaths])

  useEffect(() => {
    let cancelled = false
    let ownEditor: WorkspaceEditor | null = null
    setVisibleEditor(undefined)
    setLoading(true)
    declarationsRef.current = []
    setRenameIssue('')
    setDeclarations([])
    setFocus({ target: null })
    setOutlineStatus('loading')
    const snapshot = fileRef.current
    void serialize(async () => {
      if (cancelled) return
      const active = runtime.current
      if (!active || active.lean.disposed) return
      const uri = snapshot
        ? `file:///workspace/${snapshot.path.split('/').map(encodeURIComponent).join('/')}`
        : null
      active.modelCache.select(uri)
      active.subscription?.dispose()
      active.outlineCleanup?.()
      active.outlineCleanup = undefined
      active.restoreOpenEditor?.()
      active.restoreOpenEditor = undefined
      active.disabledRenameAction?.dispose()
      active.disabledRenameAction = undefined
      active.collaborativeUndo?.dispose()
      active.collaborativeUndo = undefined
      active.collaboratorCursors?.dispose()
      active.collaboratorCursors = undefined
      active.commentImages?.dispose()
      active.commentImages = undefined
      active.visibleReadyPath = undefined
      await active.lean.closeHiddenDocuments()
      if (cancelled || runtime.current !== active || active.lean.disposed)
        return
      active.editor?.dispose()
      active.editor = undefined
      const host = editorEl.current
      if (!snapshot || !host || !uri) {
        setLoading(false)
        return
      }
      try {
        ownEditor = new WorkspaceEditor()
        if (!snapshot.readOnly) active.virtualFiles.add(uri)
        await ownEditor.start(
          host,
          uri,
          snapshot.content,
          !!snapshot.readOnly,
          joiningRef.current,
        )
        if (cancelled || runtime.current !== active || !host.isConnected) {
          ownEditor.dispose()
          return
        }
        active.editor = ownEditor
        const editor = ownEditor.editor
        const languageModel = editor.getModel()
        if (languageModel)
          active.collaborativeUndo = installCollaborativeEditorUndo(
            languageModel,
            snapshot.path,
            () => collaborativeCommands.current,
          )
        if (
          snapshot.path.endsWith('.lean') &&
          languageModel &&
          languageModel.getLanguageId() !== 'lean4'
        )
          monacoEditor.setModelLanguage(languageModel, 'lean4')
        if (
          isMarkdownPath(snapshot.path) &&
          languages
            .getLanguages()
            .some((language) => language.id === 'markdown')
        ) {
          const model = editor.getModel()
          if (model) monacoEditor.setModelLanguage(model, 'markdown')
        }
        const tex = texLanguage(snapshot.path)
        if (
          tex &&
          languageModel &&
          languages.getLanguages().some((language) => language.id === tex)
        )
          monacoEditor.setModelLanguage(languageModel, tex)
        // The model URI is shared by projects. Set the fetched contents explicitly
        // so a retained VS Code model cannot show a previous project's buffer.
        const currentFile = fileRef.current
        if (
          !currentFile ||
          currentFile.path !== snapshot.path ||
          currentFile.generation !== snapshot.generation
        )
          return
        if (editor.getValue() !== currentFile.content)
          editor.setValue(currentFile.content)
        const viewState = active.viewStates.get(snapshot.path)
        if (viewState) editor.restoreViewState(viewState)
        // An unchanged reload can keep a worker with stale imports alive.
        // Leave it uncached so switching away closes it before the next visit.
        if (importsStaleRef.current !== snapshot.path)
          await active.modelCache.retain(uri)
        if (cancelled || runtime.current !== active) return
        active.visibleReadyPath = snapshot.path
        setVisibleEditor(editor)
        editor.updateOptions({
          scrollBeyondLastLine: false,
          padding: { top: 16, bottom: 16 },
          fontSize: 14,
          readOnly: !!fileRef.current?.readOnly || joiningRef.current,
          // Monaco assigns definition links to the other mouse modifier.
          multiCursorModifier: 'ctrlCmd',
        })
        if (snapshot.path.endsWith('.lean'))
          active.disabledRenameAction = editor.addAction({
            id: 'leanflow.renameDisabled',
            label: 'Rename Symbol (unavailable)',
            keybindings: [KeyCode.F2],
            keybindingContext: 'editorTextFocus',
            contextMenuGroupId: '1_modification',
            contextMenuOrder: 1,
            run: () => setRenameIssue(LEAN_EDIT_DISABLED_MESSAGE),
          })
        if (snapshot.line) {
          const position = {
            lineNumber: snapshot.line,
            column: snapshot.column || 1,
          }
          editor.setPosition(position)
          editor.revealPositionInCenter(position)
        }
        const service = (
          editor as unknown as {
            _codeEditorService?: {
              openCodeEditor: (...args: unknown[]) => Promise<unknown>
            }
          }
        )._codeEditorService
        if (service) {
          const previous = service.openCodeEditor
          const replacement = async (...args: unknown[]) => {
            const result = await previous.apply(service, args)
            const input = args[0] as {
              resource?: {
                path?: string
                scheme?: string
                toString?: () => string
              }
              options?: {
                selection?: {
                  startLineNumber?: number
                  startColumn?: number
                  endLineNumber?: number
                }
              }
            }
            if (
              result == null &&
              input?.resource?.path?.startsWith('/workspace/')
            ) {
              onOpenFileRef.current(
                input.resource.path.slice('/workspace/'.length),
                input.options?.selection?.startLineNumber,
                input.options?.selection?.startColumn,
              )
            } else if (
              result == null &&
              input?.resource?.scheme === 'file' &&
              input.resource.toString
            ) {
              onOpenLibraryRef.current({
                uri: input.resource.toString(),
                line: input.options?.selection?.startLineNumber || 1,
                endLine: input.options?.selection?.endLineNumber,
              })
            }
            return result
          }
          service.openCodeEditor = replacement
          active.restoreOpenEditor = () => {
            if (service.openCodeEditor === replacement)
              service.openCodeEditor = previous
          }
        }
        active.subscription = editor.onDidChangeModelContent(() => {
          if (joiningRef.current) return
          if (syncingContent.current) return
          const content = editor.getValue()
          onChangeRef.current(snapshot.path, content)
        })
        active.collaboratorCursors = new CollaboratorCursors(
          editor,
          snapshot.path,
          (selection) => onCollaborativeSelectionRef.current?.(selection),
        )
        active.collaboratorCursors.update(collaboratorsRef.current || [])
        if (snapshot.path.endsWith('.lean'))
          active.commentImages = new LeanCommentImagePreviews(
            editor,
            projectId,
            snapshot.path,
            (path) => onOpenFileRef.current(path),
          )
        const openingImportsRevision = importsRevision.current
        await active.lean.showVisibleDocument()
        if (!cancelled) recoverVisibleConnection(active)
        if (cancelled) return
        if (
          importsRevision.current === openingImportsRevision &&
          importsStaleRef.current !== snapshot.path
        )
          // Rebuilding the same editor can reuse an unchanged Lean document.
          // Only a different file or an explicit import refresh clears its notice.
          setImportsStale(null)
        // Document symbols and proof selections belong to Lean files. Reading
        // another language must not send Lean requests for that document.
        if (!snapshot.path.endsWith('.lean')) {
          setOutlineStatus('unavailable')
          setLoading(false)
          return
        }
        let outlineDisposed = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let request: CancellationTokenSource | undefined
        const model = editor.getModel()!
        const updateFocus = () => {
          if (outlineDisposed || model.isDisposed()) return
          setFocus(
            proofTargetForSelection(
              snapshot.path,
              model.getValue(),
              editor.getSelection(),
              declarationsRef.current,
            ),
          )
        }
        const diagnostics = active.lean.proofDiagnostics
        const macros = new MacroProofDeclarations()
        let outlineVersion: number | undefined
        let outlineSession: object | undefined
        let baseDeclarations: ProofDeclaration[] = []
        let displayedOutline: ProofDeclaration[] | undefined
        let awaiting: ReturnType<ProofDiagnostics['document']>
        const updateChecks = (changedUri?: string) => {
          if (
            (changedUri && changedUri !== uri) ||
            outlineDisposed ||
            cancelled ||
            model.isDisposed() ||
            outlineVersion === undefined ||
            model.getVersionId() !== outlineVersion
          )
            return
          const doc = diagnostics.document(uri, outlineVersion)
          if (doc && doc.session !== outlineSession) {
            scheduleOutline()
            return
          }
          const next = proofCheckStatuses(baseDeclarations, doc)
          if (
            displayedOutline !== baseDeclarations ||
            next.some(
              (item, index) =>
                item.checkStatus !==
                declarationsRef.current[index]?.checkStatus,
            )
          ) {
            displayedOutline = baseDeclarations
            declarationsRef.current = next
            setDeclarations(next)
          }
          // An empty progress range can precede asynchronous diagnostics. The
          // pinned Lean server acknowledges this request after its reporter and
          // command tasks finish. Reuse the editor's version cancellation token.
          if (
            !doc ||
            !doc.hasDiagnostics ||
            !doc.progressDone ||
            doc.confirmed ||
            doc === awaiting ||
            !request ||
            request.token.isCancellationRequested ||
            !next.some((item) => item.checkStatus !== undefined)
          )
            return
          const client = active.lean.clientProvider
            ?.getClients()
            .find((item) => item.isRunning())
          if (!client) return
          awaiting = doc
          const cancellation = request
          void client
            .sendRequest(
              'textDocument/waitForDiagnostics',
              { uri, version: outlineVersion },
              cancellation.token,
            )
            .then(() => {
              if (awaiting === doc) awaiting = undefined
              if (
                !cancelled &&
                !outlineDisposed &&
                !model.isDisposed() &&
                !cancellation.token.isCancellationRequested &&
                model.getVersionId() === doc.version
              )
                diagnostics.confirm(uri, doc)
            })
            .catch(() => {}) // A failed/unsupported request leaves the proof pending.
        }
        const loadOutline = async (retries = 0) => {
          if (
            outlineDisposed ||
            model.isDisposed() ||
            active.clientLifecycle?.sleeping
          )
            return
          const client = active.lean.clientProvider
            ?.getClients()
            .find((item) => item.isRunning())
          if (!client) {
            if (retries < 30)
              timer = setTimeout(() => void loadOutline(retries + 1), 500)
            else {
              setOutlineStatus('unavailable')
              timer = setTimeout(() => void loadOutline(retries + 1), 5000)
            }
            return
          }
          setOutlineStatus('loading')
          const version = model.getVersionId()
          const session = diagnostics.document(uri, version)?.session
          const cancellation = new CancellationTokenSource()
          request?.cancel()
          request?.dispose()
          request = cancellation
          try {
            const symbols: unknown = await client.sendRequest(
              'textDocument/documentSymbol',
              { textDocument: { uri } },
              cancellation.token,
            )
            if (
              outlineDisposed ||
              cancellation.token.isCancellationRequested ||
              model.isDisposed() ||
              model.getVersionId() !== version
            )
              return
            if (session !== diagnostics.document(uri, version)?.session) {
              scheduleOutline()
              return
            }
            const source = model.getValue().replace(/\r\n?/g, '\n')
            const code = outlineCode(source)
            const next = proofDeclarationsFromCode(
              symbols,
              uri,
              model.getLineCount(),
              code,
            )
            const publish = (items: ProofDeclaration[]) => {
              baseDeclarations = items
              outlineVersion = version
              outlineSession = session
              updateChecks()
              setOutlineStatus('ready')
              updateFocus()
            }
            publish(next)
            if (session)
              await macros.collect(
                source,
                code,
                session,
                symbols,
                next,
                (position) =>
                  client.sendRequest(
                    'textDocument/hover',
                    { textDocument: { uri }, position },
                    cancellation.token,
                  ),
                () =>
                  cancelled ||
                  outlineDisposed ||
                  cancellation.token.isCancellationRequested ||
                  model.isDisposed() ||
                  model.getVersionId() !== version ||
                  diagnostics.document(uri, version)?.session !== session,
                publish,
              )
          } catch {
            if (
              !outlineDisposed &&
              !cancellation.token.isCancellationRequested &&
              !model.isDisposed() &&
              model.getVersionId() === version
            )
              setOutlineStatus('unavailable')
          }
        }
        const scheduleOutline = () => {
          clearTimeout(timer)
          request?.cancel()
          outlineVersion = undefined
          awaiting = undefined
          // Never attach a proof using ranges from an older buffer version.
          declarationsRef.current = []
          setDeclarations([])
          setOutlineStatus('loading')
          updateFocus()
          timer = setTimeout(() => void loadOutline(), 500)
        }
        const unsubscribeDiagnostics = diagnostics.subscribe(updateChecks)
        const selectionSubscription =
          editor.onDidChangeCursorSelection(updateFocus)
        const contentSubscription = model.onDidChangeContent(scheduleOutline)
        const clients = active.lean.clientProvider?.getClients() || []
        const restartSubscriptions = clients.map((client) =>
          client.restarted(scheduleOutline),
        )
        const clientAddedSubscription = active.lean.clientProvider?.clientAdded(
          (client: ConnectionClient) => {
            restartSubscriptions.push(client.restarted(scheduleOutline))
            scheduleOutline()
          },
        )
        active.outlineCleanup = () => {
          outlineDisposed = true
          clearTimeout(timer)
          request?.cancel()
          request?.dispose()
          unsubscribeDiagnostics()
          selectionSubscription.dispose()
          contentSubscription.dispose()
          clientAddedSubscription?.dispose()
          restartSubscriptions.forEach((item) => item.dispose())
        }
        updateFocus()
        void loadOutline()
        setFailure('')
        setLoading(false)
      } catch (error) {
        if (!cancelled) {
          setFailure(
            error instanceof Error
              ? error.message
              : 'Could not open this file.',
          )
          setLoading(false)
        }
      }
    }).catch(() => undefined)
    return () => {
      cancelled = true
      // Capture before disposal, including scroll and selections. State is
      // scoped to this project and retained for open tabs and recent previews.
      const viewState = ownEditor?.editor?.saveViewState()
      if (
        snapshot &&
        viewState &&
        retainedPathsRef.current.includes(snapshot.path)
      )
        runtime.current?.viewStates.set(snapshot.path, viewState)
      void serialize(() => {
        if (runtime.current?.editor === ownEditor) {
          runtime.current.subscription?.dispose()
          runtime.current.collaboratorCursors?.dispose()
          runtime.current.collaboratorCursors = undefined
          runtime.current.commentImages?.dispose()
          runtime.current.commentImages = undefined
          runtime.current.outlineCleanup?.()
          runtime.current.outlineCleanup = undefined
          runtime.current.restoreOpenEditor?.()
          runtime.current.restoreOpenEditor = undefined
          runtime.current.subscription = undefined
          runtime.current.editor = undefined
        }
        ownEditor?.dispose()
      })
    }
  }, [projectId, file?.path, file?.generation, recoverVisibleConnection])

  useLayoutEffect(() => {
    runtime.current?.editor?.editor.updateOptions({
      readOnly: !!file?.readOnly || joining,
    })
  }, [file?.readOnly, joining])

  useLayoutEffect(() => {
    const snapshot = fileRef.current
    // The source buffer is authoritative. Apply it before the next input event,
    // independently of Lean startup/import work in the shared lifecycle queue.
    // Otherwise a keystroke in a stale model can delete a pending remote edit.
    try {
      if (!snapshot) return
      const current = fileRef.current
      if (
        !current ||
        current.path !== snapshot.path ||
        current.generation !== snapshot.generation ||
        current.content !== snapshot.content
      )
        return
      const editor = runtime.current?.editor?.editor
      const model = editor?.getModel()
      if (
        !editor ||
        !model ||
        model.uri.scheme !== 'file' ||
        model.uri.path !== `/workspace/${snapshot.path}`
      )
        return

      if (model.getValue() === snapshot.content) return

      const edit = documentTextEdit(model.getValue(), snapshot.content)
      if (!edit) return
      const start = model.getPositionAt(edit.start)
      const end = model.getPositionAt(edit.start + edit.deleteCount)
      const selections = editor.getSelections() || []
      const offsets = selections.map((selection) => ({
        anchor: documentOffsetAfterEdit(
          model.getOffsetAt({
            lineNumber: selection.selectionStartLineNumber,
            column: selection.selectionStartColumn,
          }),
          edit,
        ),
        active: documentOffsetAfterEdit(
          model.getOffsetAt(selection.getPosition()),
          edit,
        ),
      }))
      const scrollTop = editor.getScrollTop(),
        scrollLeft = editor.getScrollLeft()
      syncingContent.current = true
      try {
        model.pushStackElement()
        const nextSelections = model.pushEditOperations(
          selections,
          [
            {
              range: {
                startLineNumber: start.lineNumber,
                startColumn: start.column,
                endLineNumber: end.lineNumber,
                endColumn: end.column,
              },
              text: edit.insert,
              forceMoveMarkers: false,
            },
          ],
          () =>
            offsets.map(({ anchor, active }) => {
              const from = model.getPositionAt(anchor),
                to = model.getPositionAt(active)
              return new Selection(
                from.lineNumber,
                from.column,
                to.lineNumber,
                to.column,
              )
            }),
        )
        model.pushStackElement()
        if (nextSelections) editor.setSelections(nextSelections)
        editor.setScrollPosition({ scrollTop, scrollLeft })
      } finally {
        syncingContent.current = false
      }
    } catch (error) {
      onStateRef.current('Editor update failed')
      console.error(
        '[LeanFlow Web] Could not update the saved file in the editor.',
        error,
      )
    }
  }, [projectId, file?.path, file?.generation, file?.content])

  // Presence offsets must be applied after a batched source update reaches
  // Monaco; applying them first would shift the same cursor twice.
  useLayoutEffect(() => {
    runtime.current?.collaboratorCursors?.update(collaborators || [])
  }, [collaborators])

  useLayoutEffect(() => {
    // A cached link can arrive before the asynchronously opened editor. The
    // editor identity changes even when React batches both loading updates.
    const model = visibleEditor?.getModel()
    if (
      loading ||
      joining ||
      !file ||
      file.unavailable ||
      file.savedContent !== file.content ||
      !visibleEditor ||
      visibleEditor !== runtime.current?.editor?.editor ||
      !model ||
      !paperLinks?.length ||
      model.uri.path !== `/workspace/${file.path}`
    )
      return
    return decoratePaperLinks(
      visibleEditor,
      model,
      file.path,
      paperLinks,
      (location) => paperLinkActions.current.onOpenPaperLink?.(location),
      () => paperLinkActions.current.onShowPaperLinks?.(),
    )
  }, [file, joining, loading, paperLinks, visibleEditor])

  useEffect(() => {
    void serialize(() =>
      runtime.current?.lean.updateVSCodeOptions(leanEditorTheme(theme)),
    ).catch(() => undefined)
  }, [theme])

  useEffect(() => {
    if (
      !revealTarget ||
      loading ||
      revealed.current === revealTarget.id ||
      file?.path !== revealTarget.target.path
    )
      return
    const editor = runtime.current?.editor?.editor
    const model = editor?.getModel()
    if (!editor || !model || model.uri.path !== `/workspace/${file?.path}`)
      return
    const start = Math.min(
      model.getLineCount(),
      Math.max(1, revealTarget.target.startLine),
    )
    const end = Math.min(
      model.getLineCount(),
      Math.max(start, revealTarget.target.endLine),
    )
    const range = {
      startLineNumber: start,
      startColumn: 1,
      endLineNumber: end,
      endColumn: model.getLineMaxColumn(end),
    }
    editor.setSelection(range)
    editor.revealRangeInCenter(range)
    editor.focus()
    revealed.current = revealTarget.id
  }, [revealTarget, loading, file?.path, file?.generation])

  useEffect(() => {
    if (
      !revealPosition ||
      loading ||
      revealedPosition.current === revealPosition.id ||
      file?.path !== revealPosition.path
    )
      return
    const editor = runtime.current?.editor?.editor
    const model = editor?.getModel()
    if (!editor || !model || model.uri.path !== `/workspace/${file.path}`)
      return
    const position = model.validatePosition({
      lineNumber: revealPosition.line,
      column: revealPosition.column,
    })
    editor.setPosition(position)
    editor.revealPositionInCenter(position)
    editor.focus()
    revealedPosition.current = revealPosition.id
  }, [revealPosition, loading, file?.path, file?.generation])

  function focusProof(mode?: ChatMode, request?: ProofEditorRequest) {
    const editor = runtime.current?.editor?.editor
    const current = fileRef.current
    if (
      !editor ||
      !current ||
      current.readOnly ||
      joiningRef.current ||
      !current.path.endsWith('.lean')
    )
      return
    if (editor.getModel()?.uri.path !== `/workspace/${current.path}`) return
    if (request?.path && request.path !== current.path) {
      setFocus({
        target: null,
        error: 'The active file changed. Choose the proof again.',
      })
      return
    }
    const model = editor.getModel()!
    let selection: EditorSelection | null = editor.getSelection()
    if (request?.declaration) {
      const chosen = request.declaration
      const currentDeclaration = declarationsRef.current.find(
        (item) =>
          item.name === chosen.name &&
          item.startLine === chosen.startLine &&
          item.startColumn === chosen.startColumn &&
          item.endLine === chosen.endLine &&
          item.endColumn === chosen.endColumn,
      )
      if (!currentDeclaration || currentDeclaration.kind === 'import') {
        setFocus({
          target: null,
          error: 'The outline changed. Choose the proof again.',
        })
        return
      }
      selection = {
        startLineNumber: chosen.startLine,
        startColumn: chosen.startColumn,
        endLineNumber: chosen.endLine,
        endColumn: chosen.endColumn,
      }
    } else if (request?.lines) {
      const { startLine, endLine } = request.lines
      if (
        !Number.isSafeInteger(startLine) ||
        !Number.isSafeInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine ||
        endLine > model.getLineCount()
      ) {
        setFocus({
          target: null,
          error: `Choose lines between 1 and ${model.getLineCount()}.`,
        })
        return
      }
      selection = {
        startLineNumber: startLine,
        startColumn: 1,
        endLineNumber: endLine,
        endColumn: model.getLineMaxColumn(endLine),
      }
    }
    // Read Monaco at the time of the request, including unsaved edits. Sidebar
    // and chat actions never use a delayed copy of the parent file buffer.
    const latest = proofTargetForSelection(
      current.path,
      editor.getValue(),
      selection,
      declarationsRef.current,
    )
    if (request?.lines && latest.target) latest.target.name = undefined
    if (
      latest.target &&
      selection &&
      (request?.declaration || request?.lines)
    ) {
      editor.setSelection(selection)
      editor.revealRangeInCenter(selection)
    }
    setFocus(
      latest.target || latest.error
        ? latest
        : {
            target: null,
            error:
              'Select lines in the editor or choose a declaration to focus the chat.',
          },
    )
    if (latest.target) onFocusProofRef.current?.(latest.target, mode)
  }

  useEffect(() => {
    if (
      !focusEditorRequest ||
      loading ||
      focusedRequest.current === focusEditorRequest.id
    )
      return
    focusedRequest.current = focusEditorRequest.id
    focusProof(focusEditorRequest.mode, focusEditorRequest)
    onFocusEditorHandled?.(focusEditorRequest.id)
  }, [focusEditorRequest, loading, onFocusEditorHandled])

  useEffect(() => {
    if (!file?.path.endsWith('.lean')) {
      onProofStateChange?.(null)
      return
    }
    const matching =
      runtime.current?.editor?.editor?.getModel()?.uri.path ===
      `/workspace/${file.path}`
    onProofStateChange?.({
      path: file.path,
      declarations: matching ? declarations : [],
      status: outlineStatus,
      target: matching ? focus.target : null,
      hasSelection: matching && focus.hasSelection,
      error: matching ? focus.error : undefined,
      disabled: loading || !!failure || !matching,
      readOnly: !!file.readOnly,
      lineCount: matching
        ? runtime.current?.editor?.editor?.getModel()?.getLineCount()
        : undefined,
    })
  }, [
    file?.path,
    file?.readOnly,
    declarations,
    outlineStatus,
    focus,
    loading,
    failure,
    onProofStateChange,
  ])

  useLayoutEffect(() => {
    const workspace = runtime.current?.editor
    const model = workspace?.editor?.getModel()
    if (
      !workspace ||
      workspace.disposed ||
      !model ||
      model.uri.path !== `/workspace/${file?.path}`
    )
      return
    const marks: monacoEditor.IModelDeltaDecoration[] = []
    for (const item of declarations) {
      const status = proofCheckMark(item)
      if (!status) continue
      marks.push({
        range: {
          startLineNumber: item.headerLine ?? item.startLine,
          endLineNumber: item.headerLine ?? item.startLine,
          startColumn: item.startColumn,
          endColumn: item.startColumn,
        },
        options: {
          glyphMarginClassName: `proof-check-mark proof-mark-${status} proof-gutter-${status}`,
          glyphMarginHoverMessage: { value: proofCheckMarks[status].title },
          // Multiple declarations can start on one line. Surface its highest severity.
          zIndex: proofCheckMarks[status].priority,
          // Keep Lean’s own line diagnostics visible alongside the declaration.
          glyphMargin: { position: monacoEditor.GlyphMarginLane.Right },
        },
      })
    }
    workspace.proofMarks ??= workspace.editor.createDecorationsCollection()
    workspace.proofMarks.set(marks)
  }, [declarations, file?.path])

  async function refreshImports() {
    const active = runtime.current
    const path = fileRef.current?.path
    if (!active || refreshingImports || !path) return
    setRefreshingImports(true)
    try {
      await serialize(async () => {
        if (runtime.current !== active || fileRef.current?.path !== path) return
        await refreshVisibleImports(active)
      })
    } catch {
      if (runtime.current === active)
        setRestartIssue(
          'Lean could not refresh imports. Use Restart Lean to reconnect.',
        )
    } finally {
      if (runtime.current === active) setRefreshingImports(false)
    }
  }

  async function restartLean() {
    const active = runtime.current
    if (!active?.clientLifecycle || restarting || retryingStartup || failure)
      return
    setRestarting(true)
    setSleeping(false)
    setRestartIssue('')
    try {
      await active.clientLifecycle.restart(
        new FileUri('/workspace/__lemex_client__.lean'),
      )
      if (runtime.current !== active) return
      setRequestIssue('')
      setRestartIssue('')
      setImportsStale(null)
    } catch (error) {
      if (runtime.current !== active) return
      setRestartIssue(
        error instanceof Error
          ? error.message
          : 'Lean could not restart. Try reopening the project.',
      )
    } finally {
      if (runtime.current === active) setRestarting(false)
    }
  }

  return (
    <div
      ref={workspaceEl}
      className={`lean-workspace ${showInfoview ? '' : 'info-hidden'}`}
      style={{ '--goals-size': `${goalsSize}%` } as CSSProperties}
    >
      <div className="source-pane proof-source-pane">
        {editorQueue && (
          <div
            className="lean-connection-notice lean-queue-notice"
            data-editor-queue={editorQueue.state}
          >
            <output aria-live="polite">
              {editorQueue.state === 'waiting'
                ? `Waiting for live Lean feedback — position ${editorQueue.position} of ${editorQueue.total}. You can edit and save. Lean will connect automatically if you keep this project open.`
                : 'A Lean slot is available. Starting Lean…'}
            </output>
            {editorQueue.state === 'waiting' &&
              queuedFileCheck &&
              (queuedFileCheck.inProgress ? (
                <span>Follow your check below the editor.</span>
              ) : (
                <div className="queue-file-check">
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={queuedFileCheck.submit}
                  >
                    Check this file
                  </button>
                  <span>
                    Compile the saved file and keep your place in the queue.
                  </span>
                </div>
              ))}
          </div>
        )}
        {sleeping && (
          <output className="lean-connection-notice">
            Lean editor sleeping to free memory. Click or type to reconnect.
            Your unsaved edits stay here; background jobs continue.
          </output>
        )}
        {markdownIssue && isMarkdownPath(file?.path) && (
          <output className="lean-connection-notice">{markdownIssue}</output>
        )}
        {texIssue && texLanguage(file?.path) && (
          <output className="lean-connection-notice">{texIssue}</output>
        )}
        {connectionIssue && (
          <div className="lean-connection-notice" role="alert">
            <strong>Lean checking paused</strong>
            <p>{connectionIssue}</p>
            <p>
              Your unsaved edits remain in the editor. Reduce the source, then
              reopen the project to reconnect.
            </p>
          </div>
        )}
        {restartIssue && !transportIssue && !connectionIssue && (
          <div className="lean-connection-notice" role="alert">
            {restartIssue}
          </div>
        )}
        {(requestIssue || transportIssue) &&
          !connectionIssue &&
          !editorQueue && (
            <div className="lean-connection-notice" role="alert">
              <p>{transportIssue || requestIssue}</p>
              <button
                className="button small secondary"
                onClick={() => void restartLean()}
                disabled={restarting || !!editorQueue}
              >
                {restarting ? 'Restarting…' : 'Restart Lean'}
              </button>
            </div>
          )}
        {renameIssue && (
          <div className="lean-connection-notice" role="alert">
            <p>{renameIssue}</p>
            <button
              className="button small secondary"
              onClick={() => setRenameIssue('')}
            >
              Dismiss
            </button>
          </div>
        )}
        <div
          ref={editorEl}
          className="monaco-host"
          aria-label="Lean source editor"
        />
        {loading && !failure && (
          <div className="editor-loading">
            <span className="spinner" />
            Opening Lean editor…
          </div>
        )}
        {failure && (
          <div className="editor-failure" role="alert">
            <strong>Editor could not start</strong>
            <p>{failure}</p>
            <p>
              Try opening another file or reopening the project. If the problem
              persists, save any other pending edits and reload this browser
              tab. Your saved files are preserved.
            </p>
          </div>
        )}
        {!file && !loading && (
          <div className="editor-loading">Choose a file from the sidebar.</div>
        )}
      </div>
      <section
        className="infoview-pane"
        aria-label="Lean goals and diagnostics"
      >
        {showInfoview && (
          <ResizeHandle
            className="goals-resize-handle"
            label="Resize goals panel"
            orientation={stacked ? 'horizontal' : 'vertical'}
            value={goalsSize}
            min={20}
            max={65}
            unit="percent"
            onChange={onGoalsSizeChange}
            onReset={() => onGoalsSizeChange(DEFAULT_LAYOUT.goals)}
            pixelsPerUnit={() => {
              const bounds = workspaceEl.current?.getBoundingClientRect()
              return ((stacked ? bounds?.height : bounds?.width) || 100) / 100
            }}
            direction={-1}
          />
        )}
        <div className="pane-caption">
          <span className="status-dot" />
          Goals &amp; diagnostics{' '}
          <button
            className="button small subtle"
            onClick={() => void restartLean()}
            disabled={
              loading ||
              restarting ||
              retryingStartup ||
              !!connectionIssue ||
              !!failure ||
              !!editorQueue
            }
            title="Restart this editor's Lean connection. Your unsaved edits stay in the editor."
          >
            {restarting ? 'Restarting…' : 'Restart Lean'}
          </button>
          <span className="caption-hint">
            {transportIssue || connectionIssue || failure || retryingStartup
              ? 'Live goals are unavailable while Lean is disconnected.'
              : 'Move the cursor to inspect'}
          </span>
        </div>
        {importsStale === file?.path && file?.path.endsWith('.lean') && (
          <output className="lean-import-notice">
            These goals may use out-of-date imports.
            <button
              className="button small secondary"
              disabled={refreshingImports || loading || sleeping}
              onClick={() => void refreshImports()}
            >
              {refreshingImports ? 'Refreshing…' : 'Refresh imports'}
            </button>
          </output>
        )}
        <div
          ref={infoEl}
          className="infoview-host"
          hidden={
            !!(transportIssue || connectionIssue || failure || retryingStartup)
          }
        />
      </section>
    </div>
  )
}
