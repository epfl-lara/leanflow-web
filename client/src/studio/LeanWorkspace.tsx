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
  Uri,
  editor as monacoEditor,
  languages,
} from 'monaco-editor'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { FileEntry, OpenFile } from './api'
import { connectInfoviewTheme } from './infoviewTheme'
import { ResizeHandle } from './ResizeHandle'
import { DEFAULT_LAYOUT, useMediaQuery } from './layout'
import { isMarkdownPath } from './fileReading'
import { texLanguage } from './texBuilds'
import { RenameModels } from './renameModels'
import { initializeLeanEditor } from './leanEditorServices'
import { DefinitionPreviewFiles } from './definitionPreviewFiles'
import { WorkspaceEditor } from './workspaceEditor'
import { LeanModelCache } from './leanModelCache'
import type { RenameSource } from './workspaceBuffers'
import { installLeanRenameMiddleware } from './leanRenameMiddleware'
import { LEAN_EDIT_DISABLED_MESSAGE } from '../../../shared/lean-edit-policy.mjs'
import type { ChatMode } from './chatModes'
import {
  proofDeclarations,
  proofTargetForSelection,
  type ProofDeclaration,
  type EditorProofState,
  type ProofEditorRequest,
  type EditorSelection,
  type ProofTarget,
} from './proofTarget'

class BrowserLeanMonaco extends LeanMonaco {
  closeHiddenDocuments: () => Promise<void> = async () => {}
  showVisibleDocument: () => Promise<void> = async () => {}
  refreshVisibleDocument: () => Promise<void> = async () => {}
  constructor(
    private readonly onConnectionIssue: (message: string) => void,
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
  ) {
    super()
  }

  protected override getWebSocketOptions(
    options: Parameters<LeanMonaco['start']>[0],
  ): WebSocketConfigOptionsUrl {
    const settings = super.getWebSocketOptions(options)
    const onConnectionIssue = this.onConnectionIssue
    const onProcessingNotice = this.onProcessingNotice
    const onRenameIssue = this.onRenameIssue
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
                const reason = /reason = ([\s\S]*)$/
                  .exec(error.message)?.[1]
                  ?.trim()
                onConnectionIssue(
                  reason ||
                    'The Lean message is too large. Reduce the source or split it into smaller modules.',
                )
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
  renameModels?: RenameModels
  modelCache: LeanModelCache
  disabledRenameAction?: { dispose(): void }
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
  files,
  file,
  buffers,
  bufferDiscardVersion,
  bufferSaveVersion,
  editorImportsVersion,
  savedPaths,
  bufferRemoveVersion,
  removedPaths,
  onRenameSources,
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
}: {
  projectId: string
  files: readonly FileEntry[]
  file: OpenFile | null
  buffers: ReadonlyMap<string, OpenFile>
  bufferDiscardVersion: number
  bufferSaveVersion: number
  editorImportsVersion?: number
  savedPaths: readonly string[]
  bufferRemoveVersion: number
  removedPaths: readonly string[]
  onRenameSources: (sources: RenameSource[]) => void
  theme: 'light' | 'dark'
  onChange: (path: string, content: string) => void
  onState: (state: string) => void
  showInfoview: boolean
  onOpenFile: (path: string, line?: number, column?: number) => void
  onOpenLibrary: (request: SourceRequest) => void
  goalsSize: number
  onGoalsSizeChange: (value: number) => void
  onFocusProof?: (target: ProofTarget, mode?: ChatMode) => void
  onProofStateChange?: (state: EditorProofState | null) => void
  focusEditorRequest?: ProofEditorRequest | null
  onFocusEditorHandled?: (id: number) => void
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
  const fileRef = useRef(file)
  const buffersRef = useRef(buffers)
  buffersRef.current = buffers
  const syncingContent = useRef(false)
  const pendingLocalChange = useRef<{
    path: string
    generation: number
    content: string
  } | null>(null)
  const onChangeRef = useRef(onChange)
  const onRenameSourcesRef = useRef(onRenameSources)
  const onStateRef = useRef(onState)
  const onOpenFileRef = useRef(onOpenFile)
  const onOpenLibraryRef = useRef(onOpenLibrary)
  const themeRef = useRef(theme)
  const onFocusProofRef = useRef(onFocusProof)
  const declarationsRef = useRef<ProofDeclaration[]>([])
  const [declarations, setDeclarations] = useState<ProofDeclaration[]>([])
  const [outlineStatus, setOutlineStatus] = useState<
    'loading' | 'ready' | 'unavailable'
  >('loading')
  const [focus, setFocus] = useState<{
    target: ProofTarget | null
    error?: string
  }>({ target: null })
  const revealed = useRef<number | null>(null)
  const revealedPosition = useRef<number | null>(null)
  const focusedRequest = useRef<number | null>(null)
  const [failure, setFailure] = useState('')
  const [markdownIssue, setMarkdownIssue] = useState('')
  const [texIssue, setTexIssue] = useState('')
  const [connectionIssue, setConnectionIssue] = useState('')
  const [restarting, setRestarting] = useState(false)
  const [restartIssue, setRestartIssue] = useState('')
  const [requestIssue, setRequestIssue] = useState('')
  const [renameIssue, setRenameIssue] = useState('')
  const [loading, setLoading] = useState(true)
  const stacked = useMediaQuery('(max-width: 1250px)')
  fileRef.current = file
  onChangeRef.current = onChange
  onStateRef.current = onState
  onOpenFileRef.current = onOpenFile
  onOpenLibraryRef.current = onOpenLibrary
  themeRef.current = theme
  onRenameSourcesRef.current = onRenameSources
  onFocusProofRef.current = onFocusProof

  useEffect(() => {
    if (!infoEl.current) return
    return connectInfoviewTheme(infoEl.current)
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    let own: Runtime | null = null
    setFailure('')
    setMarkdownIssue('')
    setConnectionIssue('')
    setRequestIssue('')
    setRenameIssue('')
    setLoading(true)
    onStateRef.current('Connecting to Lean')
    void serialize(async () => {
      if (cancelled || !editorEl.current || !infoEl.current) return
      const lean = new BrowserLeanMonaco(
        (message) => {
          if (cancelled) return
          setConnectionIssue(message)
          onStateRef.current('Lean paused: source too large')
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
      )
      own = {
        lean,
        virtualFiles: new Set(),
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
            url: `${protocol}//${location.host}/websocket/${encodeURIComponent(projectId)}`,
          },
          // Global VS Code UI services retain this element across projects.
          htmlElement: document.getElementById('root') ?? editorEl.current,
          vscode: {
            'workbench.colorTheme':
              themeRef.current === 'dark'
                ? 'Visual Studio Dark'
                : 'Visual Studio Light',
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
            const rootDocument = new FileUri('/workspace/__lemex_client__.lean')
            provider.ensureClient = (uri) =>
              ensureClient(uri.scheme === 'file' ? rootDocument : uri)
            own.connectionSubscriptions.push(
              provider.clientAdded((client: ConnectionClient) => {
                if (cancelled) return
                onStateRef.current('Connecting to Lean')
                own?.connectionSubscriptions?.push(
                  client.restarted(() => {
                    if (!cancelled)
                      onStateRef.current(
                        client.isRunning()
                          ? 'Lean connected'
                          : 'Lean connection failed',
                      )
                  }),
                  client.restarting(() => {
                    if (!cancelled) onStateRef.current('Restarting Lean')
                  }),
                  client.serverFailed(() => {
                    if (!cancelled) onStateRef.current('Lean connection failed')
                  }),
                )
              }),
              provider.clientStopped(() => {
                if (!cancelled) onStateRef.current('Lean server stopped')
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
      void serialize(async () => {
        own?.subscription?.dispose()
        own?.outlineCleanup?.()
        own?.connectionSubscriptions?.forEach((subscription) =>
          subscription.dispose(),
        )
        own?.restoreOpenEditor?.()
        own?.disabledRenameAction?.dispose()
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
        const clients = own?.lean.clientProvider?.getClients() || []
        await Promise.allSettled(clients.map((client) => client.stop()))
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
      })
    }
  }, [projectId])

  useLayoutEffect(() => {
    runtime.current?.modelCache.reconcile(buffers, file?.path ?? null)
  }, [buffers, file?.path])

  useLayoutEffect(() => {
    // Listings refresh after terminal/agent changes, even when the visible
    // source is unchanged. Their importers must reopen against new sources.
    runtime.current?.modelCache.clear()
  }, [projectId, files])

  useLayoutEffect(() => {
    runtime.current?.renameModels?.synchronize(buffersRef.current)
  }, [bufferDiscardVersion])

  useEffect(() => {
    let cancelled = false
    void serialize(async () => {
      if (cancelled) return
      const active = runtime.current
      const path = fileRef.current?.path
      if (
        savedPaths.some(
          (saved) =>
            saved.endsWith('.lean') ||
            ['lean-toolchain', 'lakefile.toml', 'lake-manifest.json'].includes(
              saved,
            ),
        )
      ) {
        active?.modelCache.invalidate()
        await active?.lean.closeHiddenDocuments()
      }
      // Another saved Lean module can invalidate the visible file's imports.
      // Saving this proof still preserves its own incremental snapshots.
      if (
        path?.endsWith('.lean') &&
        savedPaths.some((saved) => saved.endsWith('.lean') && saved !== path)
      )
        return active?.lean.refreshVisibleDocument()
    }).catch(() => {
      if (!cancelled)
        setRestartIssue(
          'Files were saved, but Lean could not refresh their imports. Use Restart Lean to reconnect.',
        )
    })
    return () => {
      cancelled = true
    }
  }, [bufferSaveVersion, projectId, savedPaths])

  useEffect(() => {
    if (!editorImportsVersion) return
    let cancelled = false
    void serialize(async () => {
      if (cancelled) return
      const active = runtime.current
      active?.modelCache.invalidate()
      await active?.lean.closeHiddenDocuments()
      await active?.lean.refreshVisibleDocument()
    }).catch(() => {
      if (!cancelled)
        setRestartIssue(
          'Project imports were rebuilt, but Lean could not refresh this file. Use Restart Lean to reconnect.',
        )
    })
    return () => {
      cancelled = true
    }
  }, [editorImportsVersion, projectId])

  useEffect(() => {
    runtime.current?.modelCache.removePaths(removedPaths)
    void runtime.current?.renameModels?.remove(removedPaths)
  }, [bufferRemoveVersion, removedPaths])

  useEffect(() => {
    let cancelled = false
    let ownEditor: WorkspaceEditor | null = null
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
        active.editor = ownEditor
        if (!snapshot.readOnly) active.virtualFiles.add(uri)
        await ownEditor.start(host, uri, snapshot.content, !!snapshot.readOnly)
        if (cancelled || runtime.current !== active || !host.isConnected) {
          ownEditor.dispose()
          return
        }
        const editor = ownEditor.editor
        const languageModel = editor.getModel()
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
        if (editor.getValue() !== snapshot.content)
          editor.setValue(snapshot.content)
        if (!snapshot.readOnly) await active.modelCache.retain(uri)
        if (cancelled || runtime.current !== active) return
        active.visibleReadyPath = snapshot.path
        pendingLocalChange.current = null
        editor.updateOptions({
          scrollBeyondLastLine: false,
          padding: { top: 16, bottom: 16 },
          fontSize: 14,
          readOnly: !!snapshot.readOnly,
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
          if (syncingContent.current) return
          const content = editor.getValue()
          pendingLocalChange.current = {
            path: snapshot.path,
            generation: snapshot.generation,
            content,
          }
          onChangeRef.current(snapshot.path, content)
        })
        await active.lean.showVisibleDocument()
        if (cancelled) return
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
        const loadOutline = async (retries = 0) => {
          if (outlineDisposed || model.isDisposed()) return
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
            const next = proofDeclarations(
              symbols,
              uri,
              model.getLineCount(),
              model.getValue(),
            )
            declarationsRef.current = next
            setDeclarations(next)
            setOutlineStatus('ready')
            updateFocus()
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
          // Never attach a proof using ranges from an older buffer version.
          declarationsRef.current = []
          setDeclarations([])
          setOutlineStatus('loading')
          updateFocus()
          timer = setTimeout(() => void loadOutline(), 500)
        }
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
      void serialize(() => {
        if (runtime.current?.editor === ownEditor) {
          runtime.current.subscription?.dispose()
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
  }, [projectId, file?.path, file?.generation])

  useLayoutEffect(() => {
    const draft = pendingLocalChange.current
    if (
      draft &&
      draft.path === file?.path &&
      draft.generation === file?.generation &&
      draft.content === file?.content
    )
      pendingLocalChange.current = null
  }, [file?.path, file?.generation, file?.content])

  useEffect(() => {
    let cancelled = false
    const snapshot = fileRef.current
    void serialize(() => {
      if (cancelled || !snapshot) return
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

      // A keystroke may arrive after the server update was rendered but before
      // this queued effect runs. Wait for the parent to acknowledge that local
      // draft rather than replacing it with an earlier saved-file notification.
      const draft = pendingLocalChange.current
      if (
        draft?.path === snapshot.path &&
        draft.generation === snapshot.generation
      ) {
        if (draft.content !== snapshot.content) return
        pendingLocalChange.current = null
      }
      if (model.getValue() === snapshot.content) return

      const viewState = editor.saveViewState()
      syncingContent.current = true
      try {
        model.pushStackElement()
        model.pushEditOperations(
          editor.getSelections() || [],
          [
            {
              range: model.getFullModelRange(),
              text: snapshot.content,
              forceMoveMarkers: true,
            },
          ],
          () => null,
        )
        model.pushStackElement()
        if (viewState) editor.restoreViewState(viewState)
      } finally {
        syncingContent.current = false
      }
    }).catch((error) => {
      if (!cancelled) {
        onStateRef.current('Editor update failed')
        console.error(
          '[LeanFlow Web] Could not update the saved file in the editor.',
          error,
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [projectId, file?.path, file?.generation, file?.content])

  useEffect(() => {
    void serialize(() =>
      runtime.current?.lean.updateVSCodeOptions({
        'workbench.colorTheme':
          theme === 'dark' ? 'Visual Studio Dark' : 'Visual Studio Light',
      }),
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

  async function restartLean() {
    const clients = runtime.current?.lean.clientProvider?.getClients() || []
    if (!clients.length || restarting) return
    setRestarting(true)
    setRestartIssue('')
    try {
      await Promise.all(clients.map((client) => client.restart()))
      if (clients.some((client) => !client.isRunning()))
        throw new Error(
          'Lean could not reconnect. Try Restart Lean again or reopen the project.',
        )
      setRequestIssue('')
      setRestartIssue('')
    } catch (error) {
      setRestartIssue(
        error instanceof Error
          ? error.message
          : 'Lean could not restart. Try reopening the project.',
      )
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div
      ref={workspaceEl}
      className={`lean-workspace ${showInfoview ? '' : 'info-hidden'}`}
      style={{ '--goals-size': `${goalsSize}%` } as CSSProperties}
    >
      <div className="source-pane proof-source-pane">
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
        {restartIssue && (
          <div className="lean-connection-notice" role="alert">
            {restartIssue}
          </div>
        )}
        {requestIssue && (
          <div className="lean-connection-notice" role="alert">
            <p>{requestIssue}</p>
            <button
              className="button small secondary"
              onClick={() => void restartLean()}
              disabled={restarting}
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
            disabled={loading || restarting || !!connectionIssue}
            title="Restart this editor's Lean connection. Your unsaved edits stay in the editor."
          >
            {restarting ? 'Restarting…' : 'Restart Lean'}
          </button>
          <span className="caption-hint">Move the cursor to inspect</span>
        </div>
        <div ref={infoEl} className="infoview-host" />
      </section>
    </div>
  )
}
