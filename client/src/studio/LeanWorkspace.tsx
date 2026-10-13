import { LeanMonaco, LeanMonacoEditor } from 'lean4monaco'
import { FileUri } from 'lean4monaco/dist/vscode-lean4/vscode-lean4/src/utils/exturi'
import { useEffect, useRef, useState } from 'react'
import type { OpenFile } from './api'

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
}: {
  projectId: string
  file: OpenFile | null
  theme: 'light' | 'dark'
  onChange: (path: string, content: string) => void
  onState: (state: string) => void
  showInfoview: boolean
  onOpenFile: (path: string, line?: number, column?: number) => void
}) {
  const editorEl = useRef<HTMLDivElement>(null)
  const infoEl = useRef<HTMLDivElement>(null)
  const runtime = useRef<Runtime | null>(null)
  const fileRef = useRef(file)
  const onChangeRef = useRef(onChange)
  const onStateRef = useRef(onState)
  const onOpenFileRef = useRef(onOpenFile)
  const themeRef = useRef(theme)
  const [failure, setFailure] = useState('')
  const [loading, setLoading] = useState(true)
  fileRef.current = file
  onChangeRef.current = onChange
  onStateRef.current = onState
  onOpenFileRef.current = onOpenFile
  themeRef.current = theme

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
    const snapshot = fileRef.current
    void serialize(async () => {
      if (cancelled) return
      const active = runtime.current
      if (!active || active.lean.disposed) return
      active.subscription?.dispose()
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
          onChangeRef.current(snapshot.path, editor.getValue())
        })
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
          runtime.current.restoreOpenEditor?.()
          runtime.current.restoreOpenEditor = undefined
          runtime.current.subscription = undefined
          runtime.current.editor = undefined
        }
        ownEditor?.dispose()
      })
    }
  }, [projectId, file?.path, file?.generation])

  useEffect(() => {
    void serialize(() =>
      runtime.current?.lean.updateVSCodeOptions({
        'workbench.colorTheme':
          theme === 'dark' ? 'Visual Studio Dark' : 'Visual Studio Light',
      }),
    ).catch(() => undefined)
  }, [theme])

  return (
    <div className={`lean-workspace ${showInfoview ? '' : 'info-hidden'}`}>
      <div className="source-pane">
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
