import { LeanMonaco, LeanMonacoEditor } from 'lean4monaco'
import { FileUri } from 'lean4monaco/dist/vscode-lean4/vscode-lean4/src/utils/exturi'
import { CancellationTokenSource } from 'monaco-editor'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { OpenFile } from './api'
import { connectInfoviewTheme } from './infoviewTheme'
import { ResizeHandle } from './ResizeHandle'
import { DEFAULT_LAYOUT, useMediaQuery } from './layout'
import type { ChatMode } from './chatModes'
import { ProofOutline } from './ProofOutline'
import {
  proofDeclarations,
  proofTargetForSelection,
  type ProofDeclaration,
  type ProofTarget,
} from './proofTarget'

class BrowserLeanMonaco extends LeanMonaco {
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
  lean: LeanMonaco
  editor?: LeanMonacoEditor
  subscription?: { dispose(): void }
  restoreOpenEditor?: () => void
  connectionSubscriptions?: { dispose(): void }[]
  outlineCleanup?: () => void
}
interface ConnectionClient {
  isRunning(): boolean
  restarted(listener: () => void): { dispose(): void }
  restarting(listener: () => void): { dispose(): void }
  serverFailed(listener: () => void): { dispose(): void }
}

export function LeanWorkspace({
  projectId,
  file,
  theme,
  onChange,
  onState,
  showInfoview,
  onOpenFile,
  goalsSize,
  onGoalsSizeChange,
  onFocusProof,
  revealTarget,
}: {
  projectId: string
  file: OpenFile | null
  theme: 'light' | 'dark'
  onChange: (path: string, content: string) => void
  onState: (state: string) => void
  showInfoview: boolean
  onOpenFile: (path: string, line?: number, column?: number) => void
  goalsSize: number
  onGoalsSizeChange: (value: number) => void
  onFocusProof?: (target: ProofTarget, mode?: ChatMode) => void
  revealTarget?: {
    id: number
    target: Pick<ProofTarget, 'path' | 'startLine' | 'endLine' | 'name'>
  } | null
}) {
  const workspaceEl = useRef<HTMLDivElement>(null)
  const editorEl = useRef<HTMLDivElement>(null)
  const infoEl = useRef<HTMLDivElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const fileRef = useRef(file)
  const syncingContent = useRef(false)
  const pendingLocalChange = useRef<{
    path: string
    generation: number
    content: string
  } | null>(null)
  const onChangeRef = useRef(onChange)
  const onStateRef = useRef(onState)
  const onOpenFileRef = useRef(onOpenFile)
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
  const [failure, setFailure] = useState('')
  const [loading, setLoading] = useState(true)
  const stacked = useMediaQuery('(max-width: 1250px)')
  fileRef.current = file
  onChangeRef.current = onChange
  onStateRef.current = onState
  onOpenFileRef.current = onOpenFile
  themeRef.current = theme
  onFocusProofRef.current = onFocusProof

  useEffect(() => {
    if (!infoEl.current) return
    return connectInfoviewTheme(infoEl.current)
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    let own: Runtime | null = null
    setFailure('')
    setLoading(true)
    onStateRef.current('Connecting to Lean')
    void serialize(async () => {
      if (cancelled || !editorEl.current || !infoEl.current) return
      const lean = new BrowserLeanMonaco()
      own = { lean }
      runtime.current = own
      lean.setInfoviewElement(infoEl.current)
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      try {
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
        }
      } catch (error) {
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
        own?.editor?.dispose()
        // The upstream provider calls stop() without awaiting it. Finish socket
        // shutdown before another project uses the shared /workspace model URIs.
        const clients = own?.lean.clientProvider?.getClients() || []
        await Promise.allSettled(clients.map((client) => client.stop()))
        own?.lean.dispose()
        if (runtime.current === own) runtime.current = null
      })
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    let ownEditor: LeanMonacoEditor | null = null
    setLoading(true)
    declarationsRef.current = []
    setDeclarations([])
    setFocus({ target: null })
    setOutlineStatus('loading')
    const snapshot = fileRef.current
    void serialize(async () => {
      if (cancelled) return
      const active = runtime.current
      if (!active || active.lean.disposed) return
      active.subscription?.dispose()
      active.outlineCleanup?.()
      active.outlineCleanup = undefined
      active.restoreOpenEditor?.()
      active.restoreOpenEditor = undefined
      active.editor?.dispose()
      active.editor = undefined
      if (!snapshot || !editorEl.current) {
        setLoading(false)
        return
      }
      try {
        ownEditor = new LeanMonacoEditor()
        active.editor = ownEditor
        const uri = `file:///workspace/${snapshot.path.split('/').map(encodeURIComponent).join('/')}`
        await ownEditor.start(editorEl.current, uri, snapshot.content)
        if (cancelled) {
          ownEditor.dispose()
          return
        }
        const editor = ownEditor.editor
        // The model URI is shared by projects. Set the fetched contents explicitly
        // so a retained VS Code model cannot show a previous project's buffer.
        if (editor.getValue() !== snapshot.content)
          editor.setValue(snapshot.content)
        pendingLocalChange.current = null
        editor.updateOptions({
          scrollBeyondLastLine: false,
          padding: { top: 16, bottom: 16 },
          fontSize: 14,
          readOnly: !!snapshot.readOnly,
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
              resource?: { path?: string }
              options?: {
                selection?: { startLineNumber?: number; startColumn?: number }
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
            const next = proofDeclarations(symbols, uri, model.getLineCount())
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

  function selectDeclaration(declaration: ProofDeclaration) {
    const editor = runtime.current?.editor?.editor
    if (!editor) return
    const range = {
      startLineNumber: declaration.startLine,
      startColumn: declaration.startColumn,
      endLineNumber: declaration.endLine,
      endColumn: declaration.endColumn,
    }
    editor.setSelection(range)
    editor.revealRangeInCenter(range)
    editor.focus()
  }

  function focusProof(mode: ChatMode) {
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
    // Capture the current editor buffer, including unsaved edits, at click time.
    const latest = proofTargetForSelection(
      current.path,
      editor.getValue(),
      editor.getSelection(),
      declarationsRef.current,
    )
    setFocus(latest)
    if (latest.target) onFocusProofRef.current?.(latest.target, mode)
  }

  return (
    <div
      ref={workspaceEl}
      className={`lean-workspace ${showInfoview ? '' : 'info-hidden'}`}
      style={{ '--goals-size': `${goalsSize}%` } as CSSProperties}
    >
      <div className="source-pane proof-source-pane">
        {file && onFocusProof && (
          <ProofOutline
            declarations={declarations}
            status={outlineStatus}
            target={focus.target}
            error={focus.error}
            disabled={loading || !!failure}
            readOnly={!!file.readOnly || !file.path.endsWith('.lean')}
            onSelect={selectDeclaration}
            onFocus={focusProof}
          />
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
            <p>Try reopening the project. Your saved files are preserved.</p>
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
          <span className="caption-hint">Move the cursor to inspect</span>
        </div>
        <div ref={infoEl} className="infoview-host" />
      </section>
    </div>
  )
}
