import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from 'react'
import {
  api,
  ApiError,
  errorText,
  markSessionRestored,
  post,
  pretty,
  SESSION_EXPIRED_EVENT,
  SESSION_RESTORED_EVENT,
  type FileEntry,
  type GitInfo,
  type OpenFile,
  type Project,
  type Session,
  type TrashItem,
  type TrashDeleteResult,
} from './api'
import { AssistantPanel } from './AssistantPanel'
import { TerminalPanel } from './TerminalPanel'
import { Dialog } from './Dialog'
import { CheckControls } from './CheckControls'
import { TrashDialog } from './TrashDialog'
import { Icon } from './Icons'
import { HelpTip } from './HelpTip'
import { ToolbarAction } from './ToolbarAction'
import { LeanWorkspace } from './LeanWorkspace'
import { PdfFileViewer } from './PdfFileViewer'
import { MarkdownFilePreview } from './MarkdownFilePreview'
import { isMarkdownPath } from './fileReading'
import { isPdfFile } from '../../../shared/file-previews.mjs'
import { ProofOutline } from './ProofOutline'
import { ProjectModal } from './ProjectModal'
import { RepositoryCredentialsDialog } from './RepositoryCredentialsDialog'
import type { RepositoryCredentials } from './RepositoryCredentialsFields'
import { ProjectSetupDetails, ProjectSetupPanel } from './ProjectSetupDetails'
import { UploadModal, type UploadFile } from './UploadFiles'
import { SingleFileActions } from './SingleFileActions'
import { WorkspaceList } from './WorkspaceList'
import { RenameWorkspaceDialog } from './RenameWorkspaceDialog'
import { usePlaygroundPreparation } from './usePlaygroundPreparation'
import { playgroundDownloadName } from './playgroundNames'
import { saveAs } from 'file-saver'
import { SearchPanel } from './SearchPanel'
import { BooksPanel, type BookChatRequest } from './BooksPanel'
import { LibrarySourceDialog, type SourceRequest } from './LibrarySourceDialog'
import { SettingsModal } from './SettingsModal'
import { FileBrowser } from './FileBrowser'
import { CreateEntryDialog, type EntryKind } from './CreateEntryDialog'
import { parentFolders } from './projectPaths'
import { GitModal } from './GitModal'
import { GitConnectionsDialog } from './GitConnectionsDialog'
import { ResizeHandle } from './ResizeHandle'
import { SessionRecovery } from './SessionRecovery'
import type {
  EditorProofState,
  ProofEditorRequest,
  ProofFocusRequest,
  ProofTarget,
} from './proofTarget'
import {
  DEFAULT_LAYOUT,
  clamp,
  useElementSize,
  useMediaQuery,
  useStoredSize,
} from './layout'
import './studio.css'
import './single-file.css'
import './file-reading.css'

interface DeleteTarget {
  chatId?: string
  projectId: string
  name: string
  path?: string
  kind: 'project' | 'file' | 'folder' | 'chat'
}

interface Job {
  id: string
  projectId: string
  createdAt: string
  status: string
  log?: string
  result?: unknown
  error?: string
  [key: string]: unknown
}
const terminalJob = (job: Job) =>
  ['completed', 'failed', 'cancelled', 'interrupted', 'error'].includes(
    job.status,
  )

function Brand() {
  return (
    <div className="brand">
      <div className="brand-main">
        <img className="brand-mark" src="/leanflow-mark.svg" alt="" />
        <strong>LeanFlow Web</strong>
      </div>
      <div className="brand-links">
        <a
          className="brand-credit"
          href="https://lara.epfl.ch/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Developed by EPFL LARA
        </a>
        <span aria-hidden="true">·</span>
        <a
          className="brand-credit"
          href="https://github.com/epfl-lara/leanflow-web"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="LeanFlow Web on GitHub (opens in a new tab)"
        >
          GitHub
        </a>
      </div>
    </div>
  )
}

function Login({ onSession }: { onSession: (session: Session) => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await post('/api/login', { token: token.trim() })
      const session = await api<Session>('/api/session')
      markSessionRestored()
      onSession(session)
    } catch (error) {
      setError(errorText(error))
      setBusy(false)
    }
  }
  return (
    <main className="login-screen">
      <div className="login-card">
        <Brand />
        <h1>
          Your Lean workspace,
          <br />
          with a proof partner.
        </h1>
        <p>Sign in to open projects, inspect goals, and work with Lemex.</p>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="access-token">
            Access token
          </label>
          <input
            id="access-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Enter your collaborator token"
            required
            autoFocus
            autoComplete="current-password"
            disabled={busy}
          />
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy || !token.trim()}>
            {busy ? (
              <span className="spinner" />
            ) : (
              <Icon name="arrow" size={16} />
            )}
            {busy ? 'Signing in…' : 'Open workspace'}
          </button>
        </form>
        <p className="login-help">
          Use the token provided by your server administrator. For the first
          sign-in, the owner token is in <code>.data/auth/owner.token</code> on
          the server.
        </p>
      </div>
      <div className="login-art" aria-hidden="true">
        <div className="proof-orbit">
          <span>∀</span>
          <span>→</span>
          <span>∎</span>
          <span>λ</span>
        </div>
        <p>Write. Explore. Verify.</p>
      </div>
    </main>
  )
}

export function Studio() {
  const [studioElement, setStudioElement] = useState<HTMLDivElement | null>(
    null,
  )
  const [navigationElement, setNavigationElement] =
    useState<HTMLDivElement | null>(null)
  const [sourceSectionsElement, setSourceSectionsElement] =
    useState<HTMLDivElement | null>(null)
  const [headerElement, setHeaderElement] = useState<HTMLElement | null>(null)
  const studioSize = useElementSize(studioElement)
  const navigationSize = useElementSize(navigationElement)
  const sourceSectionsSize = useElementSize(sourceSectionsElement)
  const headerSize = useElementSize(headerElement)
  const mobileLayout = useMediaQuery('(max-width: 720px)')
  const overlayTools = useMediaQuery('(max-width: 1000px)')
  const [sidebarSize, setSidebarSize] = useStoredSize(
    'lemex-layout-sidebar',
    DEFAULT_LAYOUT.sidebar,
    180,
    480,
  )
  const [assistantSize, setAssistantSize] = useStoredSize(
    'lemex-layout-assistant',
    DEFAULT_LAYOUT.assistant,
    280,
    640,
  )
  const [goalsSize, setGoalsSize] = useStoredSize(
    'lemex-layout-goals',
    DEFAULT_LAYOUT.goals,
    20,
    65,
  )
  const [filesSize, setFilesSize] = useStoredSize(
    'lemex-layout-files',
    DEFAULT_LAYOUT.files,
    20,
    85,
  )
  const [fileTreeSize, setFileTreeSize] = useStoredSize(
    'lemex-layout-file-tree',
    45,
    20,
    80,
  )
  const [session, setSession] = useState<Session | null>(null)
  const [authRequired, setAuthRequired] = useState(false)
  const [startupError, setStartupError] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [foldersAvailable, setFoldersAvailable] = useState<boolean | null>(null)
  const [createdFolder, setCreatedFolder] = useState<string | null>(null)
  const [file, setFile] = useState<OpenFile | null>(null)
  const [markdownPreview, setMarkdownPreview] = useState(false)
  const [proofFocus, setProofFocus] = useState<ProofFocusRequest | null>(null)
  const [editorProof, setEditorProof] = useState<EditorProofState | null>(null)
  const [focusEditorRequest, setFocusEditorRequest] =
    useState<ProofEditorRequest | null>(null)
  const [revealProof, setRevealProof] = useState<{
    id: number
    target: Pick<ProofTarget, 'path' | 'startLine' | 'endLine' | 'name'>
  } | null>(null)
  const proofRequestId = useRef(0)
  const [git, setGit] = useState<GitInfo | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [agentPendingFile, setAgentPendingFile] = useState<string | null>(null)
  const [projectModal, setProjectModal] = useState<{ preset?: string } | null>(
    null,
  )
  const [uploadModal, setUploadModal] = useState(false)
  const [repositoryAccessId, setRepositoryAccessId] = useState<string | null>(
    null,
  )
  const [renameTarget, setRenameTarget] = useState<Project | null>(null)
  const [creatingSingleFile, setCreatingSingleFile] = useState(false)
  const [creatingPlaygroundSource, setCreatingPlaygroundSource] = useState<
    'blank' | 'upload'
  >('blank')
  const [convertingSingleFile, setConvertingSingleFile] = useState(false)
  const [stoppingSetup, setStoppingSetup] = useState(false)
  const [setupDetails, setSetupDetails] = useState(false)
  const [settingsModal, setSettingsModal] = useState(false)
  const [gitConnectionsOpen, setGitConnectionsOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleteStopping, setDeleteStopping] = useState(false)
  const [lastTrash, setLastTrash] = useState<TrashItem | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])
  const [trashError, setTrashError] = useState('')
  const [restoring, setRestoring] = useState<string | null>(null)
  const [gitOpen, setGitOpen] = useState<'changes' | 'publish' | null>(null)
  const [newEntryKind, setNewEntryKind] = useState<EntryKind | null>(null)
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState(false)
  const [librarySource, setLibrarySource] = useState<SourceRequest | null>(null)
  const [fileFilter, setFileFilter] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(() => window.innerWidth > 1000)
  const [booksOpen, setBooksOpen] = useState(false)
  const [booksMounted, setBooksMounted] = useState(false)
  const [bookChatRequest, setBookChatRequest] =
    useState<BookChatRequest | null>(null)
  const [bookPageRequest, setBookPageRequest] = useState<{
    id: number
    url: string
  } | null>(null)
  const bookRequestId = useRef(0)
  const closeBooks = useCallback(() => setBooksOpen(false), [])
  const [showInfoview, setShowInfoview] = useState(true)
  const [terminalProjectId, setTerminalProjectId] = useState<string | null>(
    null,
  )
  const [leanState, setLeanState] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('lemex-theme')
    return saved === 'light' || saved === 'dark'
      ? saved
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
  })
  const [pendingAction, setPendingAction] = useState<
    (() => Promise<void>) | null
  >(null)
  const [job, setJob] = useState<Job | null>(null)
  const [jobOpen, setJobOpen] = useState(false)
  const [startingCheck, setStartingCheck] = useState(false)
  const [stoppingCheck, setStoppingCheck] = useState(false)
  const checkRequest = useRef(false)
  const fileRef = useRef(file)
  const filesRef = useRef(files)
  const projectIdRef = useRef(projectId)
  const setupLogRef = useRef<{
    owner: string
    project: Pick<
      Project,
      'id' | 'status' | 'setupStartedAt' | 'setupEventAfter' | 'log'
    >
  } | null>(null)
  const openRequest = useRef(0)
  const generation = useRef(0)
  const savePromise = useRef<Promise<void> | null>(null)
  fileRef.current = file
  filesRef.current = files
  projectIdRef.current = projectId
  const project = projects.find((item) => item.id === projectId)
  const terminalOpen = !!project && terminalProjectId === project.id
  const projectKindRef = useRef(project?.kind)
  projectKindRef.current = project?.kind
  const singleFileMode = project?.kind === 'single-file'
  const singleFileView = singleFileMode
  const playgroundPreparation = usePlaygroundPreparation(
    session?.templates.find((preset) => preset.id === 'mathlib'),
    session?.user.id,
  )
  const mathlibAvailable = playgroundPreparation.state === 'ready'
  const workspaceEditable =
    project?.status === 'ready' ||
    (project?.status === 'error' &&
      (singleFileMode || project.needsPreparation === true))
  const loadedProjectId = useRef<string | null>(null)
  const currentEditorProof =
    editorProof?.path === file?.path ? editorProof : null
  const sidebarMaximum = Math.min(
    480,
    studioSize.width - 360 - (toolsOpen && !overlayTools ? 280 : 0),
  )
  const sidebarWidth = clamp(sidebarSize, 180, sidebarMaximum)
  const assistantMaximum = Math.min(
    640,
    overlayTools
      ? studioSize.width - 40
      : studioSize.width - sidebarWidth - 360,
  )
  const assistantWidth = clamp(assistantSize, 280, assistantMaximum)
  const filesMinimum = Math.min(
    65,
    Math.max(20, (110 / navigationSize.height) * 100),
  )
  const filesMaximum = Math.max(
    filesMinimum,
    Math.min(85, 100 - (90 / navigationSize.height) * 100),
  )
  const filesPercent = clamp(filesSize, filesMinimum, filesMaximum)
  const fileTreeMinimum = Math.min(
    60,
    Math.max(20, (80 / sourceSectionsSize.height) * 100),
  )
  const fileTreeMaximum = Math.max(
    fileTreeMinimum,
    Math.min(80, 100 - (100 / sourceSectionsSize.height) * 100),
  )
  const fileTreePercent = clamp(fileTreeSize, fileTreeMinimum, fileTreeMaximum)
  const dirty = !!file && file.content !== file.savedContent
  const pdfPreview = file?.preview === 'pdf'
  const readingFile =
    pdfPreview || (isMarkdownPath(file?.path) && markdownPreview)
  const assistantFiles = useMemo(
    () =>
      files.filter(
        (entry) =>
          !isPdfFile(entry.path) &&
          (!singleFileMode || entry.path === 'Main.lean'),
      ),
    [files, singleFileMode],
  )

  useEffect(() => setMarkdownPreview(false), [projectId, file?.path])

  const loadSession = useCallback(async () => {
    setStartupError('')
    try {
      setSession(await api<Session>('/api/session'))
      setAuthRequired(false)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        setAuthRequired(true)
      else setStartupError(errorText(error))
    }
  }, [])

  useEffect(() => {
    void loadSession()
  }, [loadSession])
  useEffect(() => {
    const expired = () => setAuthRequired(true)
    const restored = () => {
      setAuthRequired(false)
      setError('')
      setDeleteError('')
      setTrashError('')
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    window.addEventListener(SESSION_RESTORED_EVENT, restored)
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expired)
      window.removeEventListener(SESSION_RESTORED_EVENT, restored)
    }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('lemex-theme', theme)
  }, [theme])

  const sessionOwner = session?.user.id
  const loadProjects = useCallback(async () => {
    const value = await api<Project[]>('/api/projects')
    const selected = value.findIndex((item) => item.id === projectIdRef.current)
    if (selected >= 0) {
      const metadata = value[selected]
      const cached = setupLogRef.current
      // A completed attempt's output is immutable. Keep fresh list metadata
      // while avoiding another large log request when other projects prepare.
      if (
        metadata.status !== 'preparing' &&
        cached &&
        cached.owner === sessionOwner &&
        cached.project.id === metadata.id &&
        cached.project.status === metadata.status &&
        cached.project.setupStartedAt === metadata.setupStartedAt &&
        cached.project.setupEventAfter === metadata.setupEventAfter
      ) {
        value[selected] = { ...metadata, log: cached.project.log }
      } else {
        setupLogRef.current = null
        const detail = await api<Project>(
          `/api/projects/${encodeURIComponent(metadata.id)}`,
        )
        value[selected] = detail
        if (detail.status !== 'preparing' && sessionOwner)
          setupLogRef.current = { owner: sessionOwner, project: detail }
      }
    }
    setProjects(value)
    return value
  }, [sessionOwner])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    void api<Project[]>('/api/projects')
      .then((value) => {
        if (cancelled) return
        setProjects(value)
        const savedId = localStorage.getItem('lemex-project')
        setProjectId(
          value.some((item) => item.id === savedId)
            ? savedId
            : value[0]?.id || null,
        )
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [session])

  const preparing = projects.some((item) => item.status === 'preparing')
  useEffect(() => {
    setSetupDetails(false)
    if (projectId)
      void loadProjects().catch((error) => setError(errorText(error)))
  }, [projectId, loadProjects])
  useEffect(() => {
    if (!session || !preparing) return
    const timer = setInterval(() => {
      void loadProjects().catch((error) => setError(errorText(error)))
    }, 3000)
    return () => clearInterval(timer)
  }, [session, preparing, loadProjects])

  const loadFiles = useCallback(async (id: string) => {
    const base = `/api/projects/${encodeURIComponent(id)}`
    const [value, directories] = await Promise.all([
      api<FileEntry[]>(`${base}/files`),
      api<string[]>(`${base}/folders`).catch(() => null),
    ])
    if (projectIdRef.current === id) {
      setFiles(value)
      setFoldersAvailable(directories !== null)
      // A server being updated or an unavailable folder listing must not hide files.
      const parents = new Set<string>()
      if (!directories) {
        for (const file of value) {
          if (file.readOnly || file.path.startsWith('.lake/')) continue
          for (const folder of parentFolders(file.path)) parents.add(folder)
        }
      }
      setFolders(directories ?? [...parents].sort())
    }
    return value
  }, [])

  const loadGit = useCallback(async (id: string) => {
    if (projectIdRef.current === id && projectKindRef.current === 'single-file')
      return
    try {
      const value = await api<GitInfo>(
        `/api/projects/${encodeURIComponent(id)}/git`,
      )
      if (projectIdRef.current === id) setGit(value)
    } catch {
      if (projectIdRef.current === id) setGit(null)
    }
  }, [])
  useEffect(() => {
    if (project?.status === 'ready' && project.kind !== 'single-file')
      void loadGit(project.id)
  }, [project?.id, project?.status, project?.kind, loadGit])
  const acceptGit = useCallback(
    (value: GitInfo) => {
      if (projectIdRef.current === projectId) setGit(value)
    },
    [projectId],
  )

  const openFile = useCallback(
    async (id: string, path: string, line?: number, column?: number) => {
      const request = ++openRequest.current
      setOpening(true)
      setError('')
      try {
        const pdf = isPdfFile(path)
        const value = pdf
          ? { content: '', hash: '', readOnly: true }
          : await api<{
              content: string
              hash: string
              readOnly?: boolean
            }>(
              `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
            )
        if (request !== openRequest.current || projectIdRef.current !== id)
          return
        setFile({
          path,
          content: value.content,
          savedContent: value.content,
          hash: value.hash,
          generation: ++generation.current,
          readOnly:
            value.readOnly ||
            path.startsWith('.lake/packages/') ||
            filesRef.current.find((item) => item.path === path)?.readOnly,
          line,
          column,
          preview: pdf ? 'pdf' : undefined,
        })
        localStorage.setItem(`lemex-file-${id}`, path)
        setSidebarOpen(false)
      } catch (error) {
        if (request === openRequest.current) setError(errorText(error))
      } finally {
        if (request === openRequest.current) setOpening(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (loadedProjectId.current !== projectId) {
      loadedProjectId.current = projectId
      setFiles([])
      setFolders([])
      setFoldersAvailable(null)
      setCreatedFolder(null)
      setNewEntryKind(null)
      setFile(null)
      setLibrarySource(null)
      setProofFocus(null)
      setEditorProof(null)
      setFocusEditorRequest(null)
      setRevealProof(null)
      setGit(null)
      setGitOpen(null)
      setTerminalProjectId(null)
      setJob(null)
      setFileFilter('')
      setLeanState('')
      ++openRequest.current
    }
    if (!projectId) return
    localStorage.setItem('lemex-project', projectId)
    if (!workspaceEditable) return
    let cancelled = false
    void loadFiles(projectId)
      .then((value) => {
        if (cancelled || projectIdRef.current !== projectId) return
        const savedPath = localStorage.getItem(`lemex-file-${projectId}`)
        const first =
          value.find((item) => item.path === savedPath) ||
          value.find((item) => item.path === 'Main.lean') ||
          value.find((item) => item.path.endsWith('.lean')) ||
          value[0]
        if (first && (project?.status === 'ready' || !fileRef.current))
          void openFile(projectId, fileRef.current?.path || first.path)
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [
    projectId,
    project?.status,
    workspaceEditable,
    loadFiles,
    loadGit,
    openFile,
  ])

  const saveFile = useCallback(async () => {
    if (savePromise.current) return savePromise.current
    const snapshot = fileRef.current
    const id = projectIdRef.current
    if (
      !snapshot ||
      !id ||
      snapshot.readOnly ||
      snapshot.content === snapshot.savedContent
    )
      return
    const task = (async () => {
      setSaving(true)
      try {
        const value = await api<{
          content: string
          hash: string
          requiresPreparation: boolean
        }>(
          `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(snapshot.path)}`,
          {
            method: 'PUT',
            body: JSON.stringify({
              content: snapshot.content,
              expectedHash: snapshot.hash,
            }),
          },
        )
        if (projectIdRef.current === id)
          setFile((current) =>
            current?.path === snapshot.path
              ? {
                  ...current,
                  savedContent: value.content ?? snapshot.content,
                  hash: value.hash,
                }
              : current,
          )
        setNotice('File saved')
        if (value.requiresPreparation) await loadProjects()
        else void loadGit(id)
      } finally {
        setSaving(false)
        savePromise.current = null
      }
    })()
    savePromise.current = task
    return task
  }, [loadGit, loadProjects])

  const saveCompletely = useCallback(async () => {
    // Saving is optimistic: preserve edits made during the request and save them
    // before handing a snapshot to an assistant or changing the current file.
    await saveFile()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const current = fileRef.current
    if (current && current.content !== current.savedContent) await saveFile()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (
      fileRef.current &&
      fileRef.current.content !== fileRef.current.savedContent
    )
      throw new Error(
        'The file is still being edited. Save it before continuing.',
      )
  }, [saveFile])

  const beforeApply = useCallback(async () => {
    if (savePromise.current)
      throw new Error(
        'A file save is still in progress. Wait for it to finish before applying the candidate.',
      )
    const current = fileRef.current
    if (current && current.content !== current.savedContent)
      throw new Error(
        'The editor has unsaved changes. Keep them and start a new run, or discard them before applying this candidate.',
      )
  }, [])

  const discardUnsavedEdits = useCallback(async () => {
    if (savePromise.current)
      throw new Error(
        'A file save is still in progress. Wait for it to finish before discarding edits.',
      )
    setFile((current) =>
      current
        ? {
            ...current,
            content: current.savedContent,
            generation: ++generation.current,
          }
        : current,
    )
    setNotice('Unsaved edits discarded')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }, [])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveFile().catch((error) => setError(errorText(error)))
      }
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        fileRef.current &&
        fileRef.current.content !== fileRef.current.savedContent
      ) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('keydown', keydown)
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('keydown', keydown)
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [saveFile])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2500)
    return () => clearTimeout(timer)
  }, [notice])

  const navigate = useCallback((action: () => Promise<void>) => {
    if (
      fileRef.current &&
      fileRef.current.content !== fileRef.current.savedContent
    )
      setPendingAction(() => action)
    else void action().catch((error) => setError(errorText(error)))
  }, [])

  const chooseFile = useCallback(
    (path: string) => {
      const id = projectIdRef.current
      if (id) navigate(() => openFile(id, path))
    },
    [navigate, openFile],
  )

  function acceptCreatedProject(created: Project) {
    if (created.kind === 'single-file')
      localStorage.setItem(`lemex-file-${created.id}`, 'Main.lean')
    setProjects((previous) => [
      created,
      ...previous.filter((item) => item.id !== created.id),
    ])
    setProjectId(created.id)
    setSidebarOpen(false)
  }

  function startSingleFile(source?: UploadFile) {
    navigate(async () => {
      setCreatingSingleFile(true)
      setCreatingPlaygroundSource(source ? 'upload' : 'blank')
      try {
        const created = await post<Project>('/api/projects', {
          kind: 'single-file',
          ...(source ? { file: source } : {}),
        })
        acceptCreatedProject(created)
      } catch (error) {
        if (error instanceof ApiError && error.status === 503)
          void playgroundPreparation.refresh().catch(() => {})
        throw error
      } finally {
        setCreatingSingleFile(false)
      }
    })
  }

  async function convertSingleFile() {
    if (!projectId) return
    setConvertingSingleFile(true)
    try {
      const updated = await post<Project>(
        `/api/projects/${encodeURIComponent(projectId)}/convert`,
      )
      setProjects((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      )
      setNotice('Converted to a project. Your file and chats are preserved.')
    } catch (error) {
      setError(errorText(error))
    } finally {
      setConvertingSingleFile(false)
    }
  }

  async function continueNavigation(save: boolean) {
    if (!pendingAction) return
    try {
      if (save) await saveCompletely()
      const action = pendingAction
      setPendingAction(null)
      await action()
    } catch (error) {
      setError(errorText(error))
    }
  }

  async function check() {
    if (!projectId || !file || checkRequest.current) return
    const id = projectId
    checkRequest.current = true
    setStartingCheck(true)
    setError('')
    try {
      await saveCompletely()
      const value = await post<Job>(
        `/api/projects/${encodeURIComponent(id)}/check`,
        { path: file.path },
      )
      if (projectIdRef.current === id) {
        setJob(value)
        setJobOpen(true)
      }
    } catch (error) {
      setError(errorText(error))
    } finally {
      checkRequest.current = false
      setStartingCheck(false)
    }
  }

  async function stopCheck() {
    if (!job || terminalJob(job) || stoppingCheck) return
    const id = job.id
    setStoppingCheck(true)
    setError('')
    try {
      const stopped = await post<Job>(
        `/api/jobs/${encodeURIComponent(id)}/stop`,
      )
      setJob((current) => (current?.id === id ? stopped : current))
      if (projectIdRef.current === stopped.projectId) {
        const active = await api<Job[]>(
          `/api/projects/${encodeURIComponent(stopped.projectId)}/checks`,
        )
        setJob((current) =>
          current?.id === id ? active[0] || stopped : current,
        )
      }
    } catch (error) {
      setError(errorText(error))
    } finally {
      setStoppingCheck(false)
    }
  }

  useEffect(() => {
    setJob(null)
    if (!projectId || !session) return
    let cancelled = false
    void api<Job[]>(`/api/projects/${encodeURIComponent(projectId)}/checks`)
      .then((active) => {
        if (!cancelled && active.length)
          setJob((current) =>
            current && !terminalJob(current) ? current : active[0],
          )
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [projectId, session])

  useEffect(() => {
    if (!job || terminalJob(job)) return
    const id = job.id
    let cancelled = false
    const timer = setInterval(() => {
      void api<Job>(`/api/jobs/${encodeURIComponent(id)}`)
        .then((value) => {
          if (!cancelled) setJob(value)
        })
        .catch((error) => {
          if (!cancelled) setError(errorText(error))
        })
    }, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [job?.id, job?.status])

  async function refreshAfterApply() {
    if (!projectId) return
    const updated = await loadProjects()
    if (updated.find((item) => item.id === projectId)?.status !== 'ready')
      return
    await loadFiles(projectId)
    if (fileRef.current) await openFile(projectId, fileRef.current.path)
    await loadGit(projectId)
  }

  async function createEntry(path: string, kind: EntryKind) {
    if (!projectId) throw new Error('Choose a project first.')
    if (files.some((file) => file.path === path) || folders.includes(path)) {
      throw new Error(
        'A file or folder with this name already exists. Choose another name.',
      )
    }
    if (kind === 'folder') {
      await post(`/api/projects/${encodeURIComponent(projectId)}/folders`, {
        path,
      })
      setFileFilter('')
      setCreatedFolder(path)
      setFolders((current) =>
        [...new Set([...current, ...parentFolders(path), path])].sort(),
      )
      try {
        await loadFiles(projectId)
      } catch {
        setError(
          `Created folder ${path}, but the file list could not refresh. Use Refresh files to try again.`,
        )
      }
      return
    }
    setOpening(true)
    try {
      await saveCompletely()
      const saved = await api<{ requiresPreparation: boolean }>(
        `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ content: '', expectedHash: null }),
        },
      )
      setFiles((current) =>
        current.some((entry) => entry.path === path)
          ? current
          : [...current, { path, size: 0 }],
      )
      setFileFilter('')
      try {
        if (saved.requiresPreparation) await loadProjects()
        else {
          await loadFiles(projectId)
          await openFile(projectId, path)
        }
      } catch {
        setError(
          `Created file ${path}, but the project could not refresh. Use Refresh files to try again.`,
        )
      }
    } finally {
      setOpening(false)
    }
  }

  const refreshLiveFiles = useCallback(
    async (paths: string[], source: 'agent' | 'terminal' = 'agent') => {
      const id = projectIdRef.current
      if (!id) return
      const listing = await loadFiles(id)
      if (projectIdRef.current !== id) return
      if (source === 'agent') void loadGit(id)
      const current = fileRef.current
      if (!current || (paths.length && !paths.includes(current.path))) return
      if (!listing.some((entry) => entry.path === current.path)) {
        setAgentPendingFile(current.path)
        return
      }
      if (current.preview === 'pdf') {
        // Terminal polling supplies no changed paths. Keep the reader's page
        // and scroll position until a reported edit or an explicit reload.
        if (paths.includes(current.path)) await openFile(id, current.path)
        return
      }
      const latest = await api<{ content: string; hash: string }>(
        `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(current.path)}`,
      )
      const now = fileRef.current
      if (
        projectIdRef.current !== id ||
        now?.path !== current.path ||
        now.generation !== current.generation
      )
        return
      if (latest.hash === now.hash) return
      if (savePromise.current || now.content !== now.savedContent) {
        setAgentPendingFile(now.path)
        return
      }
      if (now.hash !== current.hash) return
      setFile((previous) =>
        previous?.path === current.path &&
        previous.hash === current.hash &&
        previous.content === previous.savedContent
          ? {
              ...previous,
              content: latest.content,
              savedContent: latest.content,
              hash: latest.hash,
            }
          : previous,
      )
      setAgentPendingFile(null)
      setNotice(
        source === 'terminal'
          ? 'Terminal edits refreshed'
          : 'Agent edits updated live',
      )
    },
    [loadFiles, loadGit, openFile],
  )

  useEffect(() => {
    if (!terminalOpen || project?.status !== 'ready') return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        await refreshLiveFiles([], 'terminal')
        if (!disposed) await loadProjects()
      } catch (error) {
        if (!disposed) setError(errorText(error))
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [
    terminalOpen,
    project?.id,
    project?.status,
    refreshLiveFiles,
    loadProjects,
  ])

  async function closeTerminal() {
    setTerminalProjectId(null)
    const id = terminalProjectId
    if (!id) return
    try {
      await post(`/api/projects/${encodeURIComponent(id)}/terminal/stop`)
      await loadProjects()
      if (projectIdRef.current !== id) return
      await refreshLiveFiles([], 'terminal')
      void loadGit(id)
    } catch (error) {
      if (projectIdRef.current === id) setError(errorText(error))
    }
  }

  async function retryPrepare() {
    if (!projectId) return
    if (project?.repositoryAuthenticationRequired) {
      setRepositoryAccessId(projectId)
      return
    }
    try {
      await prepareProject(projectId)
    } catch (error) {
      setError(errorText(error))
    }
  }

  async function prepareProject(
    id: string,
    credentials?: RepositoryCredentials,
  ) {
    if (projectIdRef.current === id) await saveCompletely()
    const value = await post<Project>(
      `/api/projects/${encodeURIComponent(id)}/prepare`,
      credentials,
    )
    setProjects((previous) =>
      previous.map((item) => (item.id === value.id ? value : item)),
    )
  }

  function requestDelete(target: DeleteTarget) {
    setDeleteError('')
    setDeleteStopping(false)
    setDeleteTarget(target)
  }
  async function showTrash() {
    setTrashOpen(true)
    setTrashError('')
    try {
      setTrashItems(await api<TrashItem[]>('/api/trash'))
    } catch (error) {
      setTrashError(errorText(error))
    }
  }
  async function deleteItem(stopActive = false) {
    if (!deleteTarget || deleteBusy) return
    const target = deleteTarget
    setDeleteBusy(true)
    setDeleteStopping(stopActive)
    setDeleteError('')
    try {
      if (savePromise.current)
        throw new Error(
          'Wait for the current file save to finish before deleting.',
        )
      const receipt = await post<TrashItem>(
        target.kind === 'chat'
          ? `/api/chats/${encodeURIComponent(target.chatId!)}/trash`
          : `/api/projects/${encodeURIComponent(target.projectId)}/trash`,
        {
          ...(target.path === undefined ? {} : { path: target.path }),
          ...(stopActive ? { stopActive: true } : {}),
        },
      )
      setLastTrash({ ...receipt, name: target.name })
      const active = projectIdRef.current === target.projectId
      if (target.kind === 'chat') {
        window.dispatchEvent(new Event('lemex-chats-changed'))
      } else if (target.kind === 'project') {
        setJob((current) =>
          current?.projectId === target.projectId ? null : current,
        )
        if (active) {
          ++openRequest.current
          setFile(null)
          setFiles([])
          setFolders([])
          setGit(null)
          setProjectId(null)
          localStorage.removeItem('lemex-project')
        }
        const remaining = await loadProjects()
        if (active) setProjectId(remaining[0]?.id || null)
      } else if (active) {
        const current = fileRef.current
        const removed =
          !!current &&
          (current.path === target.path ||
            current.path.startsWith(target.path + '/'))
        if (removed) {
          ++openRequest.current
          setFile(null)
        }
        const updated = await loadProjects()
        if (
          updated.find((item) => item.id === target.projectId)?.status ===
          'ready'
        ) {
          const remaining = await loadFiles(target.projectId)
          await loadGit(target.projectId)
          if (removed) {
            const next = remaining.find(
              (item) => !item.readOnly && item.path.endsWith('.lean'),
            )
            if (next) await openFile(target.projectId, next.path)
          }
        }
      }
      setNotice('Moved to Trash')
      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(errorText(error))
    } finally {
      setDeleteBusy(false)
      setDeleteStopping(false)
    }
  }
  async function deleteForever(item: TrashItem) {
    await post(`/api/trash/${encodeURIComponent(item.trashId)}/delete-forever`)
    forgetTrash(
      new Set([item.trashId]),
      new Set(item.kind === 'project' ? [item.projectId] : []),
    )
    if (item.kind === 'chat' || item.kind === 'project')
      window.dispatchEvent(new Event('lemex-chats-changed'))
    setNotice('Permanently deleted')
  }
  function forgetTrash(ids: Set<string>, projectIds: Set<string>) {
    setTrashItems((previous) =>
      previous.filter(
        (entry) => !ids.has(entry.trashId) && !projectIds.has(entry.projectId),
      ),
    )
    setLastTrash((previous) =>
      previous &&
      (ids.has(previous.trashId) || projectIds.has(previous.projectId))
        ? null
        : previous,
    )
  }
  async function deleteAll(items: TrashItem[]) {
    const result = await post<TrashDeleteResult>('/api/trash/delete-all', {
      trashIds: items.map((item) => item.trashId),
    })
    const ids = new Set(result.deletedTrashIds)
    const projects = new Set(
      items
        .filter((item) => item.kind === 'project' && ids.has(item.trashId))
        .map((item) => item.projectId),
    )
    forgetTrash(ids, projects)
    try {
      setTrashItems(await api<TrashItem[]>('/api/trash'))
    } catch (error) {
      setTrashError(errorText(error))
    }
    if (result.deletedTrashIds.length)
      window.dispatchEvent(new Event('lemex-chats-changed'))
    setNotice(
      result.failures.length
        ? `Deleted ${ids.size} items from Trash`
        : 'Deleted all confirmed items from Trash',
    )
    return result
  }
  async function restoreItem(item: TrashItem) {
    if (restoring) return
    setRestoring(item.trashId)
    setTrashError('')
    try {
      await post(`/api/trash/${encodeURIComponent(item.trashId)}/restore`)
      const updated = await loadProjects()
      if (item.kind === 'chat')
        window.dispatchEvent(new Event('lemex-chats-changed'))
      else if (item.kind === 'project' && !projectIdRef.current)
        setProjectId(item.projectId)
      else if (
        projectIdRef.current === item.projectId &&
        updated.find((project) => project.id === item.projectId)?.status ===
          'ready'
      ) {
        const restoredFiles = await loadFiles(item.projectId)
        await loadGit(item.projectId)
        if (!fileRef.current) {
          const next = restoredFiles.find(
            (file) =>
              !file.readOnly &&
              (file.path === item.path ||
                file.path.startsWith(item.path + '/')) &&
              file.path.endsWith('.lean'),
          )
          if (next) await openFile(item.projectId, next.path)
        }
      }
      setTrashItems((previous) =>
        previous.filter((entry) => entry.trashId !== item.trashId),
      )
      setLastTrash((previous) =>
        previous?.trashId === item.trashId ? null : previous,
      )
      setNotice('Restored from Trash')
    } catch (error) {
      setTrashError(errorText(error))
    } finally {
      setRestoring(null)
    }
  }

  if (authRequired && !session)
    return (
      <Login
        onSession={(value) => {
          setSession(value)
          setAuthRequired(false)
        }}
      />
    )
  if (!session)
    return (
      <main className="startup-screen">
        <Brand />
        {startupError ? (
          <>
            <h1>Cannot reach the workspace</h1>
            <p className="error-message">{startupError}</p>
            <button
              className="button primary"
              onClick={() => void loadSession()}
            >
              <Icon name="refresh" size={16} />
              Try again
            </button>
          </>
        ) : (
          <>
            <span className="spinner" />
            <p>Opening your workspace…</p>
          </>
        )}
      </main>
    )

  return (
    <div
      ref={setStudioElement}
      onClickCapture={(event) => {
        const anchor =
          event.target instanceof Element ? event.target.closest('a') : null
        if (!anchor) return
        const target = new URL(anchor.href, window.location.href)
        if (
          target.origin !== window.location.origin ||
          !/^\/api\/books\/(functional-programming|theorem-proving|reference)\/content\//.test(
            target.pathname,
          )
        )
          return
        event.preventDefault()
        setBookPageRequest({
          id: ++bookRequestId.current,
          url: target.pathname + target.hash,
        })
        setBooksMounted(true)
        setBooksOpen(true)
      }}
      className={`studio ${toolsOpen ? '' : 'tools-hidden'} ${singleFileView ? 'single-file-mode' : ''}`}
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--assistant-width': `${assistantWidth}px`,
          '--files-size': `${filesPercent}%`,
          '--file-tree-size': `${fileTreePercent}%`,
          '--workbench-header-height': `${headerElement ? headerSize.height : 96}px`,
        } as CSSProperties
      }
    >
      <aside
        className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}
        aria-label="Files and projects"
      >
        <div className="sidebar-brand">
          <Brand />
          <button
            className="icon-button mobile-only"
            title="Close sidebar"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <div ref={setNavigationElement} className="sidebar-navigation">
          <div
            ref={setSourceSectionsElement}
            className="sidebar-source-sections"
          >
            {!singleFileView && (
              <section className="sidebar-files-section" aria-label="Files">
                <div className="sidebar-section-title">
                  <span>Files</span>
                  <div>
                    <button
                      className="button small subtle"
                      onClick={() => setUploadModal(true)}
                      disabled={project?.status !== 'ready'}
                      title="Upload local files or a folder"
                    >
                      Upload
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => setNewEntryKind('file')}
                      disabled={!workspaceEditable || opening || saving}
                      title="New file"
                      aria-label="New file"
                    >
                      <Icon name="filePlus" size={16} />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => {
                        setCreatedFolder(null)
                        setNewEntryKind('folder')
                      }}
                      disabled={
                        !workspaceEditable ||
                        opening ||
                        saving ||
                        !foldersAvailable
                      }
                      title={
                        !workspaceEditable
                          ? 'Choose a ready project to create a folder.'
                          : foldersAvailable === null
                            ? 'Loading folders…'
                            : foldersAvailable
                              ? 'New folder'
                              : 'Folder creation is unavailable. Refresh files to try again.'
                      }
                      aria-label="New folder"
                    >
                      <Icon name="folderPlus" size={16} />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() =>
                        projectId &&
                        void loadFiles(projectId).catch((error) =>
                          setError(errorText(error)),
                        )
                      }
                      disabled={!workspaceEditable}
                      title="Refresh files"
                      aria-label="Refresh files"
                    >
                      <Icon name="refresh" size={14} />
                    </button>
                  </div>
                </div>
                {files.length + folders.length > 8 && (
                  <div className="file-filter">
                    <Icon name="search" size={13} />
                    <input
                      aria-label="Filter files"
                      value={fileFilter}
                      onChange={(event) => setFileFilter(event.target.value)}
                      placeholder="Find a file or folder…"
                    />
                  </div>
                )}
                <FileBrowser
                  key={projectId}
                  files={files}
                  folders={folders}
                  projectName={project?.name}
                  revealFolder={createdFolder}
                  selectedPath={file?.path}
                  dirty={dirty}
                  disabled={opening || saving}
                  filter={fileFilter}
                  ready={workspaceEditable}
                  onSelect={chooseFile}
                  onDelete={(path, kind) =>
                    projectId &&
                    requestDelete({ projectId, path, name: path, kind })
                  }
                />
              </section>
            )}
            {file?.path.endsWith('.lean') && project?.status === 'ready' && (
              <>
                {!singleFileView && (
                  <ResizeHandle
                    label="Resize files and outline"
                    orientation="horizontal"
                    value={fileTreePercent}
                    min={fileTreeMinimum}
                    max={fileTreeMaximum}
                    onChange={setFileTreeSize}
                    onReset={() => setFileTreeSize(45)}
                    pixelsPerUnit={() => sourceSectionsSize.height / 100}
                    unit="percent"
                    className="outline-resize-handle"
                  />
                )}
                <ProofOutline
                  key={file.path}
                  declarations={currentEditorProof?.declarations || []}
                  status={currentEditorProof?.status || 'loading'}
                  target={currentEditorProof?.target || null}
                  error={currentEditorProof?.error}
                  disabled={!currentEditorProof || currentEditorProof.disabled}
                  readOnly={!!file.readOnly}
                  onSelect={(item) => {
                    setRevealProof({
                      id: ++proofRequestId.current,
                      target: {
                        path: file.path,
                        startLine: item.startLine,
                        endLine: item.endLine,
                        name: item.name,
                      },
                    })
                    setSidebarOpen(false)
                  }}
                  onFocus={(mode) =>
                    setFocusEditorRequest({
                      id: ++proofRequestId.current,
                      path: file.path,
                      mode,
                    })
                  }
                  onUseDeclaration={(declaration, mode) =>
                    setFocusEditorRequest({
                      id: ++proofRequestId.current,
                      path: file.path,
                      declaration,
                      mode,
                    })
                  }
                />
              </>
            )}
          </div>
          {!singleFileView && (
            <ResizeHandle
              label="Resize files and projects"
              orientation="horizontal"
              value={filesPercent}
              min={filesMinimum}
              max={filesMaximum}
              onChange={setFilesSize}
              onReset={() => setFilesSize(DEFAULT_LAYOUT.files)}
              pixelsPerUnit={() => navigationSize.height / 100}
              unit="percent"
              className="navigation-resize-handle"
            />
          )}
          <section className="sidebar-projects-section" aria-label="Projects">
            <WorkspaceList
              projects={projects}
              selectedId={projectId}
              disabled={opening || saving}
              onSelect={(id) =>
                navigate(async () => {
                  setProjectId(id)
                  setSidebarOpen(false)
                })
              }
              onDelete={(item) =>
                requestDelete({
                  projectId: item.id,
                  name: item.name,
                  kind: 'project',
                })
              }
              onRename={setRenameTarget}
              playgroundActions={
                <SingleFileActions
                  available={mathlibAvailable}
                  busy={creatingSingleFile}
                  busySource={creatingPlaygroundSource}
                  preparationState={playgroundPreparation.state}
                  onRetry={() =>
                    void playgroundPreparation
                      .retry()
                      .catch((error) => setError(errorText(error)))
                  }
                  onCreate={startSingleFile}
                  onError={setError}
                />
              }
            />
            <button
              className="import-button"
              onClick={() => setProjectModal({})}
            >
              <Icon name="plus" size={16} />
              Import or create project
            </button>
          </section>
        </div>
        {!mobileLayout && (
          <ResizeHandle
            label="Resize file sidebar"
            orientation="vertical"
            value={sidebarWidth}
            min={180}
            max={Math.max(180, sidebarMaximum)}
            onChange={setSidebarSize}
            onReset={() => setSidebarSize(DEFAULT_LAYOUT.sidebar)}
            className="sidebar-resize-handle"
          />
        )}
        {!singleFileMode &&
          git &&
          git.repository !== false &&
          project?.status === 'ready' && (
            <div className="git-sidebar">
              <div className="git-sidebar-caption">
                <Icon name="git" size={14} />
                <span title={git.branch || undefined}>
                  {git.branch || 'Detached HEAD'}
                </span>
                <button
                  className="icon-button"
                  aria-label="Refresh Git status"
                  title="Refresh Git status"
                  onClick={() => projectId && void loadGit(projectId)}
                >
                  <Icon name="refresh" size={13} />
                </button>
              </div>
              <button
                className="button secondary small git-source-entry"
                onClick={() => setGitOpen('changes')}
              >
                <Icon name="git" size={14} />
                Source control
                <span>{git.changes?.length || 0}</span>
              </button>
            </div>
          )}
        <div className="sidebar-footer">
          <span className="user-avatar">
            {session.user.name?.[0]?.toUpperCase() || 'U'}
          </span>
          <span className="user-name">{session.user.name}</span>
          <button
            className="icon-button"
            title={theme === 'light' ? 'Use dark theme' : 'Use light theme'}
            aria-label={
              theme === 'light' ? 'Use dark theme' : 'Use light theme'
            }
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            <Icon name={theme === 'light' ? 'moon' : 'sun'} size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Open Trash"
            title="Open Trash"
            onClick={() => void showTrash()}
          >
            <Icon name="trash" size={16} />
          </button>
          <button
            className="logout-button"
            onClick={() =>
              navigate(async () => {
                await post('/api/logout')
                setSession(null)
                setAuthRequired(true)
                setProjectId(null)
                setFile(null)
              })
            }
          >
            Sign out
          </button>
        </div>
      </aside>
      {sidebarOpen && mobileLayout && (
        <button
          className="sidebar-backdrop"
          aria-label="Close project sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <main className="workbench">
        <header ref={setHeaderElement} className="workbench-header">
          <button
            className="icon-button mobile-only"
            title="Open sidebar"
            aria-label="Open projects and files"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="workspace-title">
            <Icon name={singleFileMode ? 'file' : 'folder'} size={18} />
            <strong>{project?.name || 'Welcome'}</strong>
            {!singleFileMode && git?.branch && (
              <span className="branch-label">
                <Icon name="git" size={13} />
                {git.branch}
              </span>
            )}
            {project?.status === 'ready' &&
              project.repository &&
              !singleFileMode && (
                <ToolbarAction
                  className="workspace-publish"
                  label="Publish"
                  icon={<Icon name="git" size={14} />}
                  onClick={() => setGitOpen('publish')}
                  help={
                    <>
                      Save and commit your changes, then review a push to the
                      imported repository or your existing fork. After
                      publishing, open GitHub or GitLab to finish creating a
                      pull request or merge request.
                    </>
                  }
                />
              )}
          </div>
          <div className="header-actions">
            <ToolbarAction
              label="Lean docs"
              icon={<Icon name="book" size={15} />}
              onClick={() => {
                setBooksMounted(true)
                setBooksOpen((value) => !value)
              }}
              pressed={booksOpen}
              help="Browse and search the local Lean books alongside your code. Use Ask Lemex to add the current chapter or selected passage to your message."
            />
            <ToolbarAction
              label="Goals"
              onClick={() => setShowInfoview((value) => !value)}
              pressed={showInfoview}
              help={
                <>
                  Show Lean’s goals, local assumptions, and messages at your
                  cursor. Click inside a proof to see what remains to prove.
                </>
              }
            />
            <ToolbarAction
              label="Lemex"
              icon={<Icon name="bot" size={15} />}
              onClick={() => setToolsOpen((value) => !value)}
              pressed={toolsOpen}
              help="Show or hide your Lemex assistant. Ask questions about the project, work on proofs, and review its changes in chat."
            />
            {project?.status === 'ready' && (
              <ToolbarAction
                label="Terminal"
                icon={<Icon name="terminal" size={15} />}
                pressed={terminalOpen}
                onClick={() => {
                  if (terminalOpen) closeTerminal()
                  else setTerminalProjectId(project.id)
                }}
                help="Open a terminal in this project to run commands and inspect their output. Commands can change project files; close the terminal before refreshing setup."
              />
            )}
            {project?.status === 'ready' && !singleFileMode && (
              <ToolbarAction
                label="Refresh setup"
                icon={<Icon name="refresh" size={14} />}
                onClick={retryPrepare}
                disabled={saving || !!(job && !terminalJob(job))}
                help={
                  <>
                    Recheck the project’s Lean environment, reuse valid compiled
                    caches, and prepare missing libraries. If setup still fails,
                    Lemex repairs it automatically when enabled. Your files and
                    pinned versions are preserved. Stop active checks and chats,
                    and close the terminal first.
                  </>
                }
              />
            )}
            <button
              className="icon-button"
              aria-label="Git connections"
              title="Git connections"
              onClick={() => setGitConnectionsOpen(true)}
            >
              <Icon name="git" size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Assistant settings"
              title="Assistant settings"
              onClick={() => setSettingsModal(true)}
            >
              <Icon name="settings" size={17} />
            </button>
          </div>
          <SearchPanel
            projectId={project?.status === 'ready' ? project.id : undefined}
            onOpenSource={setLibrarySource}
          />
        </header>
        {project?.status === 'ready' &&
          project.setupRepair?.status === 'completed' && (
            <div className="workspace-alert live-edit-alert">
              <span>
                Setup repaired by Lemex.{' '}
                {project.setupRepair.changes?.length || 0} configuration files
                updated.
              </span>
              <button
                className="button small subtle"
                onClick={() => setSetupDetails(true)}
              >
                Setup details
              </button>
            </div>
          )}
        {agentPendingFile && file?.path === agentPendingFile && (
          <div className="workspace-alert live-edit-alert" role="status">
            <span>
              The saved file changed outside this editor. Your unsaved edits are
              preserved in this editor.
            </span>
            <button
              className="button small secondary"
              onClick={() =>
                projectId &&
                navigate(async () => {
                  await openFile(projectId, agentPendingFile)
                  setAgentPendingFile(null)
                })
              }
            >
              Reload saved file
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss live edit notice"
              onClick={() => setAgentPendingFile(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {lastTrash && (
          <div className="trash-notice" role="status">
            <span>
              <strong>
                {lastTrash.name ||
                  lastTrash.path ||
                  lastTrash.projectName ||
                  'Project'}
              </strong>{' '}
              moved to Trash.
            </span>
            <button
              className="button small secondary"
              onClick={() => void restoreItem(lastTrash)}
              disabled={!!restoring}
            >
              Undo
            </button>
            <button
              className="button small subtle"
              onClick={() => void showTrash()}
            >
              Open Trash
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss deletion notice"
              onClick={() => setLastTrash(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        {trashError && !trashOpen && (
          <div className="workspace-alert" role="alert">
            {trashError}
          </div>
        )}
        {error && (
          <div className="workspace-alert" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              onClick={() => setError('')}
              aria-label="Dismiss error"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {!project ? (
          <div className="welcome-state">
            <img className="welcome-mark" src="/leanflow-mark.svg" alt="" />
            <div className="eyebrow">A place to work on proofs</div>
            <h1>Start with your project.</h1>
            <p>
              Start a Mathlib Playground, bring a Lean repository, or create a
              workspace with Mathlib, CSLib, or Physlib. Your files and
              assistant sessions are saved in your workspace.
            </p>
            <SingleFileActions
              available={mathlibAvailable}
              busy={creatingSingleFile}
              busySource={creatingPlaygroundSource}
              preparationState={playgroundPreparation.state}
              onRetry={() =>
                void playgroundPreparation
                  .retry()
                  .catch((error) => setError(errorText(error)))
              }
              primary
              onCreate={startSingleFile}
              onError={setError}
            />
            <button
              className="button secondary"
              onClick={() => setProjectModal({})}
            >
              <Icon name="plus" size={17} />
              Import or create project
            </button>
            <div className="welcome-presets">
              {session.templates.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  aria-label={`Create a ${preset.name} project`}
                  onClick={() => setProjectModal({ preset: preset.id })}
                >
                  <Icon name="folder" size={18} />
                  <strong>{preset.name}</strong>
                  <span className="welcome-preset-description">
                    {preset.description}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : !workspaceEditable ? (
          <div className="preparation-state">
            {project.status === 'preparing' ? (
              <>
                <span className="spinner large" />
                <h1>
                  {singleFileMode
                    ? `Opening ${project.name}`
                    : `Preparing ${project.name}`}
                </h1>
                <p>
                  {singleFileMode
                    ? 'Opening your private copy of the prepared Mathlib environment.'
                    : 'Setting up the Lean toolchain and project dependencies. You can return to another project while this runs.'}
                </p>
                <button
                  className="button secondary"
                  disabled={stoppingSetup}
                  onClick={async () => {
                    setStoppingSetup(true)
                    try {
                      await post(
                        `/api/projects/${encodeURIComponent(project.id)}/prepare/stop`,
                      )
                      await loadProjects()
                    } catch (error) {
                      setError(errorText(error))
                    } finally {
                      setStoppingSetup(false)
                    }
                  }}
                >
                  {stoppingSetup ? 'Stopping setup…' : 'Stop setup'}
                </button>
              </>
            ) : (
              <>
                <h1>
                  {singleFileMode
                    ? 'Playground could not open'
                    : 'Project setup needs attention'}
                </h1>
                <p className="error-message">
                  {project.error || 'The environment could not be prepared.'}
                </p>
                <button className="button primary" onClick={retryPrepare}>
                  <Icon name="refresh" size={16} />
                  {singleFileMode ? 'Retry opening' : 'Retry setup'}
                </button>
              </>
            )}
            {!singleFileMode && <ProjectSetupDetails project={project} />}
          </div>
        ) : (
          <>
            {project.status === 'error' && (
              <div className="workspace-alert" role="status">
                <span>
                  {project.error}{' '}
                  {singleFileMode
                    ? 'Your file is preserved. Retry opening after Mathlib preparation is ready.'
                    : 'You can edit the setup files or retry.'}
                </span>
                <button
                  className="button small secondary"
                  disabled={saving}
                  onClick={retryPrepare}
                >
                  {singleFileMode ? 'Retry opening' : 'Retry setup'}
                </button>
              </div>
            )}
            {!singleFileMode && <ProjectSetupPanel project={project} />}
            <div className="file-toolbar">
              <div className="file-tab">
                <Icon name="file" size={15} />
                <span title={file?.path}>{file?.path || 'Choose a file'}</span>
                {file?.readOnly && <span className="tag">Read only</span>}
                {dirty && (
                  <span className="dirty-dot" aria-label="Unsaved changes" />
                )}
                {opening && <span className="spinner" />}
              </div>
              <div className="file-actions">
                {isMarkdownPath(file?.path) && (
                  <button
                    className="button small secondary"
                    aria-pressed={markdownPreview}
                    onClick={() => setMarkdownPreview((current) => !current)}
                  >
                    {markdownPreview ? 'Edit Markdown' : 'Preview Markdown'}
                  </button>
                )}
                {singleFileMode && (
                  <>
                    <button
                      className="button small subtle"
                      disabled={!file || opening}
                      onClick={() =>
                        file &&
                        saveAs(
                          new Blob([file.content], {
                            type: 'text/plain;charset=utf-8',
                          }),
                          playgroundDownloadName(project.name),
                        )
                      }
                    >
                      Download .lean
                    </button>
                    <button
                      className="button small subtle"
                      disabled={
                        project.status === 'preparing' || convertingSingleFile
                      }
                      onClick={() => void convertSingleFile()}
                    >
                      {convertingSingleFile
                        ? 'Converting…'
                        : 'Convert to project'}
                    </button>
                  </>
                )}
                <button
                  className="button small secondary"
                  onClick={() =>
                    void saveFile().catch((error) => setError(errorText(error)))
                  }
                  disabled={!dirty || saving || opening || file?.readOnly}
                >
                  <Icon name="save" size={14} />
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <CheckControls
                  onCheck={() => void check()}
                  onStop={() => void stopCheck()}
                  disabled={
                    project.status !== 'ready' ||
                    project.needsPreparation ||
                    !file?.path.endsWith('.lean') ||
                    saving
                  }
                  singleFile={singleFileMode}
                  starting={startingCheck}
                  activeJob={job && !terminalJob(job) ? job : null}
                  stopping={stoppingCheck}
                />
              </div>
            </div>
            <div
              className={`file-reading-workspace ${readingFile ? 'reading' : ''}`}
            >
              {project.status === 'ready' ? (
                <LeanWorkspace
                  key={project.id}
                  projectId={project.id}
                  file={pdfPreview ? null : file}
                  theme={theme}
                  showInfoview={showInfoview && !!file?.path.endsWith('.lean')}
                  goalsSize={goalsSize}
                  onGoalsSizeChange={setGoalsSize}
                  revealTarget={revealProof || undefined}
                  onProofStateChange={setEditorProof}
                  focusEditorRequest={focusEditorRequest}
                  onFocusEditorHandled={(id) =>
                    setFocusEditorRequest((current) =>
                      current?.id === id ? null : current,
                    )
                  }
                  onFocusProof={(target, mode) => {
                    setProofFocus({
                      id: ++proofRequestId.current,
                      projectId: project.id,
                      target,
                      mode,
                    })
                    setToolsOpen(true)
                    setSidebarOpen(false)
                  }}
                  onState={setLeanState}
                  onChange={(path, content) =>
                    setFile((current) =>
                      current?.path === path
                        ? { ...current, content }
                        : current,
                    )
                  }
                  onOpenFile={(path, line, column) =>
                    navigate(() => openFile(project.id, path, line, column))
                  }
                  onOpenLibrary={setLibrarySource}
                />
              ) : (
                <textarea
                  className="setup-file-editor"
                  aria-label="Project file content"
                  spellCheck={false}
                  readOnly={file?.readOnly || !file}
                  value={file?.content || ''}
                  onChange={(event) =>
                    setFile((current) =>
                      current
                        ? { ...current, content: event.target.value }
                        : current,
                    )
                  }
                />
              )}
              {pdfPreview && file ? (
                <PdfFileViewer
                  key={`${project.id}:${file.path}:${file.generation}`}
                  projectId={project.id}
                  path={file.path}
                />
              ) : readingFile && file ? (
                <MarkdownFilePreview
                  key={file.path}
                  path={file.path}
                  content={file.content}
                  files={files}
                  onOpenFile={chooseFile}
                />
              ) : null}
            </div>
            {job && (
              <section className={`build-output ${jobOpen ? 'expanded' : ''}`}>
                <button
                  className="build-caption"
                  onClick={() => setJobOpen((value) => !value)}
                >
                  <Icon name="log" size={14} />
                  <strong>Lean check</strong>
                  <span
                    className={`tag ${job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : ''}`}
                  >
                    {!terminalJob(job) && <span className="spinner" />}
                    {job.status}
                  </span>
                  <Icon
                    name="chevron"
                    size={13}
                    style={{ transform: jobOpen ? 'rotate(90deg)' : undefined }}
                  />
                </button>
                {jobOpen && (
                  <>
                    {job.error && (
                      <p className="error-message" role="alert">
                        {job.error}
                      </p>
                    )}
                    <pre>
                      {job.log ||
                        (job.result
                          ? pretty(job.result)
                          : job.error || 'Waiting for Lean…')}
                    </pre>
                  </>
                )}
              </section>
            )}
          </>
        )}
        {terminalOpen && project?.status === 'ready' && (
          <TerminalPanel
            key={project.id}
            projectId={project.id}
            projectName={project.name}
            theme={theme}
            onClose={closeTerminal}
          />
        )}
        {booksMounted && (
          <BooksPanel
            open={booksOpen}
            canAsk={project?.status === 'ready'}
            pageRequest={bookPageRequest}
            onClose={closeBooks}
            onAsk={(text) => {
              if (!project || project.status !== 'ready') return
              setBookChatRequest({
                id: ++bookRequestId.current,
                projectId: project.id,
                text,
              })
              setToolsOpen(true)
              if (mobileLayout) setBooksOpen(false)
            }}
          />
        )}
        <footer className="statusbar">
          <span>
            <span
              className={`status-dot ${project?.status === 'ready' && leanState === 'Lean connected' ? '' : 'muted'}`}
            />
            {project?.status === 'ready'
              ? leanState || 'Connecting to Lean'
              : project
                ? project.status
                : 'Ready to open a project'}
          </span>
          <span className="statusbar-notice" role="status">
            {notice || (dirty ? 'Unsaved changes' : file ? 'Saved' : '')}
          </span>
          <span title={project?.toolchain}>
            {project?.toolchain?.replace('leanprover/lean4:', 'Lean ')}
          </span>
        </footer>
      </main>
      <aside
        className={`tools-panel ${toolsOpen ? '' : 'closed'}`}
        aria-label="Lemex assistant"
      >
        {!mobileLayout && toolsOpen && (
          <ResizeHandle
            label="Resize assistant panel"
            orientation="vertical"
            value={assistantWidth}
            min={280}
            max={Math.max(280, assistantMaximum)}
            onChange={setAssistantSize}
            onReset={() => setAssistantSize(DEFAULT_LAYOUT.assistant)}
            direction={-1}
            className="assistant-resize-handle"
          />
        )}
        <header className="tools-header">
          <div id="lemex-panel-title" className="tools-title">
            <Icon name="bot" size={16} />
            Lemex
          </div>
          <button
            className="icon-button"
            onClick={() => setToolsOpen(false)}
            aria-label="Close tools panel"
            title="Close tools panel"
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="tools-content" aria-labelledby="lemex-panel-title">
          <div className="tool-view">
            {project?.status === 'ready' ? (
              <AssistantPanel
                key={project.id}
                projectId={project.id}
                file={pdfPreview ? undefined : file?.path}
                currentFile={file?.path}
                files={assistantFiles}
                focusRequest={proofFocus || undefined}
                bookRequest={bookChatRequest}
                onBookHandled={(id) =>
                  setBookChatRequest((current) =>
                    current?.id === id ? null : current,
                  )
                }
                editorProof={currentEditorProof || undefined}
                onFocusEditor={(request) => {
                  if (!currentEditorProof) return
                  setFocusEditorRequest({
                    ...request,
                    id: ++proofRequestId.current,
                    path: currentEditorProof.path,
                  })
                }}
                onFocusHandled={(id) =>
                  setProofFocus((current) =>
                    current?.id === id ? null : current,
                  )
                }
                onOpenTarget={(target) => {
                  if (fileRef.current?.path === target.path) {
                    setRevealProof({ id: ++proofRequestId.current, target })
                  } else {
                    navigate(async () => {
                      await openFile(
                        project.id,
                        target.path,
                        target.startLine,
                        1,
                      )
                      if (projectIdRef.current === project.id)
                        setRevealProof({ id: ++proofRequestId.current, target })
                    })
                  }
                }}
                onDeleteChat={(chat) =>
                  requestDelete({
                    projectId: project.id,
                    chatId: chat.id,
                    name: chat.title,
                    kind: 'chat',
                  })
                }
                readOnly={file?.readOnly}
                session={session}
                dirty={dirty}
                beforeRun={saveCompletely}
                beforeApply={beforeApply}
                onDiscard={discardUnsavedEdits}
                onApplied={refreshAfterApply}
                onFilesUpdated={refreshLiveFiles}
              />
            ) : (
              <div className="tool-idle">
                <Icon name="bot" size={30} />
                <h2>Your proof partner</h2>
                <p>
                  Open a prepared project to repair proofs, formalize
                  mathematics, and explore your library with Lemex.
                </p>
              </div>
            )}
          </div>
        </div>
        <footer className="tools-footer" title={session.lemex?.revision}>
          Lemex{session.lemex?.version ? ` ${session.lemex.version}` : ''}
          {session.lemex?.revision
            ? ` · ${session.lemex.revision.slice(0, 8)}`
            : ''}
          <span>Lean-checked candidates</span>
        </footer>
      </aside>
      {librarySource && projectId && (
        <LibrarySourceDialog
          projectId={projectId}
          request={librarySource}
          onClose={() => setLibrarySource(null)}
        />
      )}
      {deleteTarget && (
        <Dialog
          title={`Delete ${deleteTarget.kind === 'project' && projects.find((item) => item.id === deleteTarget.projectId)?.kind === 'single-file' ? 'playground' : deleteTarget.kind}?`}
          subtitle="Deleted items remain recoverable in Trash."
          busy={deleteBusy}
          onClose={() => setDeleteTarget(null)}
        >
          <div className="delete-confirmation">
            <p>
              Move <strong>{deleteTarget.name}</strong> to Trash?
            </p>
            {deleteTarget.kind === 'chat' && (
              <p>
                The conversation and its saved runs will be kept in Trash for
                recovery.
              </p>
            )}
            {deleteTarget.kind === 'folder' && (
              <p>This includes all files and subfolders inside it.</p>
            )}
            {deleteTarget.kind === 'project' && (
              <p>
                The project will leave the sidebar. Its files and saved runs are
                kept so you can restore it.
              </p>
            )}
            {deleteTarget.kind !== 'chat' && (
              <p>
                If this project has active checks, Lemex runs, or setup, choose
                <strong> Stop all processes and move to Trash</strong>. LeanFlow
                will wait for them to stop before moving the item.
              </p>
            )}
            {dirty &&
              deleteTarget.projectId === projectId &&
              (deleteTarget.kind === 'project' ||
                file?.path === deleteTarget.path ||
                file?.path.startsWith(deleteTarget.path + '/')) && (
                <p className="review-note">
                  Unsaved changes in this item will be discarded. Cancel to keep
                  or save them first.
                </p>
              )}
            {deleteError && (
              <p className="error-message" role="alert">
                {deleteError}
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="button secondary"
              disabled={deleteBusy}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </button>
            {deleteTarget.kind !== 'chat' && (
              <button
                className="button danger"
                disabled={deleteBusy}
                onClick={() => void deleteItem(true)}
              >
                {deleteBusy && deleteStopping
                  ? 'Stopping processes…'
                  : 'Stop all processes and move to Trash'}
              </button>
            )}
            <button
              className="button danger"
              disabled={deleteBusy}
              onClick={() => void deleteItem()}
            >
              {deleteBusy && !deleteStopping ? 'Moving…' : 'Move to Trash'}
            </button>
          </footer>
        </Dialog>
      )}
      {trashOpen && (
        <TrashDialog
          items={trashItems}
          error={trashError}
          restoring={restoring}
          onRestore={restoreItem}
          onDeleteForever={deleteForever}
          onDeleteAll={deleteAll}
          onClose={() => setTrashOpen(false)}
        />
      )}
      {projectModal && (
        <ProjectModal
          templates={session.templates}
          repairAvailable={session.lemex?.configured === true}
          initialPreset={projectModal.preset}
          onOpenConnections={() => setGitConnectionsOpen(true)}
          onClose={() => setProjectModal(null)}
          onCreated={(created) => {
            setProjectModal(null)
            navigate(async () => acceptCreatedProject(created))
          }}
        />
      )}
      {repositoryAccessId && (
        <RepositoryCredentialsDialog
          repository={
            projects.find((item) => item.id === repositoryAccessId)?.repository
          }
          onClose={() => setRepositoryAccessId(null)}
          onOpenConnections={() => setGitConnectionsOpen(true)}
          onSubmit={(credentials) =>
            prepareProject(repositoryAccessId, credentials)
          }
        />
      )}
      {renameTarget && (
        <RenameWorkspaceDialog
          project={renameTarget}
          onClose={() => setRenameTarget(null)}
          onRenamed={(updated) => {
            setProjects((previous) =>
              previous.map((item) => (item.id === updated.id ? updated : item)),
            )
            setRenameTarget(null)
            setNotice('Playground renamed')
          }}
        />
      )}
      {uploadModal && projectId && (
        <UploadModal
          projectId={projectId}
          onClose={() => setUploadModal(false)}
          onUploaded={async () => {
            const updated = await loadProjects()
            if (
              updated.find((item) => item.id === projectId)?.status === 'ready'
            )
              await loadFiles(projectId)
            setNotice('Local files uploaded')
          }}
        />
      )}
      {setupDetails && project?.setupRepair && (
        <Dialog
          title="Project setup repair"
          onClose={() => setSetupDetails(false)}
        >
          <p>{project.setupRepair.message}</p>
          <p>
            Changed:{' '}
            {project.setupRepair.changes?.join(', ') ||
              'No configuration changes accepted'}
          </p>
          <p className="field-help">
            The original configuration is retained with repair{' '}
            {project.setupRepair.id}.
          </p>
          <pre className="setup-log">{project.log}</pre>
        </Dialog>
      )}
      {settingsModal && (
        <SettingsModal
          onClose={() => setSettingsModal(false)}
          onSaved={() => setNotice('Assistant settings saved')}
        />
      )}
      {gitConnectionsOpen && (
        <GitConnectionsDialog onClose={() => setGitConnectionsOpen(false)} />
      )}
      {gitOpen && project && (
        <GitModal
          key={project.id}
          project={project}
          initialInfo={git}
          initialTab={gitOpen}
          dirty={dirty}
          localBlockedReason={
            job && !terminalJob(job)
              ? 'Finish or stop the active Lean check before changing source control.'
              : undefined
          }
          onSave={saveCompletely}
          onUpdated={acceptGit}
          onClose={() => setGitOpen(null)}
          onOpenConnections={() => setGitConnectionsOpen(true)}
        />
      )}
      {pendingAction && (
        <Dialog
          title="Save your changes?"
          subtitle={`${file?.path || 'This file'} has unsaved edits.`}
          onClose={() => setPendingAction(null)}
          busy={saving}
        >
          <p className="dialog-body">
            Save the current file before continuing, or discard these edits.
          </p>
          <footer className="dialog-actions">
            <button
              className="button secondary"
              onClick={() => setPendingAction(null)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="button secondary"
              onClick={() => void continueNavigation(false)}
              disabled={saving}
            >
              Discard edits
            </button>
            <button
              className="button primary"
              onClick={() => void continueNavigation(true)}
              disabled={saving}
            >
              {saving ? (
                <span className="spinner" />
              ) : (
                <Icon name="save" size={15} />
              )}
              Save &amp; continue
            </button>
          </footer>
        </Dialog>
      )}
      {newEntryKind && project && (
        <CreateEntryDialog
          kind={newEntryKind}
          projectName={project.name}
          presetProject={
            !!project.preset && !project.repository && !project.uploaded
          }
          folders={folders}
          onCreate={(path) => createEntry(path, newEntryKind)}
          onClose={() => setNewEntryKind(null)}
        />
      )}
      {authRequired && <SessionRecovery user={session.user} />}
    </div>
  )
}
