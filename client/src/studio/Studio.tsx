import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type CSSProperties,
} from 'react'
import {
  api,
  ApiError,
  bindSessionUser,
  errorText,
  markSessionRestored,
  post,
  pretty,
  SESSION_EXPIRED_EVENT,
  SESSION_RESTORED_EVENT,
  type Account,
  type FileEntry,
  type GitInfo,
  type Project,
  type Preset,
  type Session,
  type TrashItem,
  type TrashDeleteResult,
} from './api'
import { AssistantPanel } from './AssistantPanel'
import { TerminalPanel } from './TerminalPanel'
import { TerminalRecoveries } from './TerminalRecoveries'
import { Dialog } from './Dialog'
import { DraftDownloads } from './DraftDownloads'
import { DraftNavigationDialog } from './DraftNavigationDialog'
import { CheckControls } from './CheckControls'
import { TrashDialog } from './TrashDialog'
import { Icon } from './Icons'
import { ToolbarAction } from './ToolbarAction'
import { LeanWorkspace } from './LeanWorkspace'
import { WorkspaceBuffers, type WorkspaceScope } from './workspaceBuffers'
import { useAutosave } from './useAutosave'
import { PdfFileViewer } from './PdfFileViewer'
import { MarkdownFilePreview } from './MarkdownFilePreview'
import { TexPanel } from './TexPanel'
import { texLanguage } from './texBuilds'
import { isMarkdownPath } from './fileReading'
import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'
import { isPdfFile, isBinaryAssetFile } from '../../../shared/file-previews.mjs'
import { ProofOutline } from './ProofOutline'
import { ProjectModal } from './ProjectModal'
import { ProjectFileRecovery } from './ProjectFileRecovery'
import { LegacyRecoveryNotice } from './LegacyRecoveryNotice'
import { StorageStatus } from './StorageStatus'
import { ImportedProjectSetup } from './ImportedProjectSetup'
import { RepositoryCredentialsDialog } from './RepositoryCredentialsDialog'
import type { RepositoryCredentials } from './RepositoryCredentialsFields'
import { ProjectSetupDetails, ProjectSetupPanel } from './ProjectSetupDetails'
import { UploadModal, type UploadFile } from './UploadFiles'
import { SingleFileActions } from './SingleFileActions'
import { WorkspaceList } from './WorkspaceList'
import { RenameWorkspaceDialog } from './RenameWorkspaceDialog'
import { ProjectSharingDialog } from './ProjectSharingDialog'
import { useProjectCollaboration } from './useProjectCollaboration'
import { usePlaygroundPreparation } from './usePlaygroundPreparation'
import { playgroundDownloadName } from './playgroundNames'
import { downloadProject, downloadWorkspaceFile } from './downloads'
import { saveAs } from 'file-saver'
import { SearchPanel } from './SearchPanel'
import { BooksPanel, type BookChatRequest } from './BooksPanel'
import { LibrarySourceDialog, type SourceRequest } from './LibrarySourceDialog'
import { SettingsModal } from './SettingsModal'
import { Brand } from './Brand'
import { AccountSetup } from './AccountSetup'
import { setRunEventTransport } from './runEventTransport'
import { FileBrowser } from './FileBrowser'
import { CreateEntryDialog, type EntryKind } from './CreateEntryDialog'
import { DetachedDraftNotice } from './DetachedDraftNotice'
import { reconcileMissingBuffers } from './workspaceFiles'
import { MoveEntryDialog } from './MoveEntryDialog'
import {
  moveRequestCurrent,
  PLAYGROUND_MOVE_REASON,
  type MoveRequest,
} from './moveEntryPaths'
import {
  FILES_MOVED_EVENT,
  parentFolders,
  remapMovedPath,
  type FilesMovedDetail,
  type PathMove,
} from './projectPaths'
import { moveStoredDrafts } from './chatDrafts'
import { GitModal } from './GitModal'
import { GitConnectionsDialog } from './GitConnectionsDialog'
import { ResizeHandle } from './ResizeHandle'
import { SessionRecovery } from './SessionRecovery'
import { useSessionActivity } from './useSessionActivity'
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
import './chat-content.css'

interface DeleteTarget {
  chatId?: string
  projectId: string
  name: string
  path?: string
  kind: 'project' | 'file' | 'folder' | 'chat'
}

interface Job {
  checkMethod?: 'lake-check' | 'lake-build'
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

function Login({ onSession }: { onSession: (session: Session) => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const signedIn = await post<{ user: Account }>('/api/login', {
        token: token.trim(),
      })
      bindSessionUser(signedIn.user.id)
      const session = await api<Session>('/api/session')
      setRunEventTransport(session.eventTransport)
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
          Use your personal token from an administrator. On your first visit,
          confirm your name and connect your own Lemex API key.
        </p>
        <p className="login-help">
          Need access? Email{' '}
          <a href="mailto:lazar.milikic@epfl.ch">lazar.milikic@epfl.ch</a> to
          request an invitation token.
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

function pendingProjectInvitation() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('share')
  if (token) {
    sessionStorage.setItem('lemex-project-invitation', token)
    const url = new URL(window.location.href)
    url.hash = ''
    window.history.replaceState(null, '', url)
  }
  return token || sessionStorage.getItem('lemex-project-invitation')
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
    Number.POSITIVE_INFINITY,
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
  const { pause: pauseSessionActivity, resume: resumeSessionActivity } =
    useSessionActivity(session?.user.id, authRequired)
  const [loggingOut, setLoggingOut] = useState(false)
  const logoutPending = useRef(false)
  const [startupError, setStartupError] = useState('')
  const [sessionRefreshing, setSessionRefreshing] = useState(false)
  const sessionRequest = useRef(0)
  const profileRevision = useRef(0)
  const [invitationToken, setInvitationToken] = useState(
    pendingProjectInvitation,
  )
  useEffect(() => {
    const changed = () => {
      const token = pendingProjectInvitation()
      if (token) setInvitationToken(token)
    }
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  const [invitationIssue, setInvitationIssue] = useState('')
  const [invitationAttempt, setInvitationAttempt] = useState(0)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setSelectedProjectId] = useState<string | null>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [foldersAvailable, setFoldersAvailable] = useState<boolean | null>(null)
  const [createdFolder, setCreatedFolder] = useState<string | null>(null)
  const [bufferStore] = useState(() => new WorkspaceBuffers())
  const {
    scope,
    file,
    buffers,
    discardVersion,
    saveVersion,
    savedPaths,
    removeVersion,
    removedPaths,
  } = useSyncExternalStore(bufferStore.subscribe, bufferStore.getSnapshot)
  const setFile = bufferStore.setFile
  const [markdownPreview, setMarkdownPreview] = useState(false)
  const [texWorkspaceElement, setTexWorkspaceElement] =
    useState<HTMLDivElement | null>(null)
  const texWorkspaceSize = useElementSize(texWorkspaceElement)
  const texNarrowViewport = useMediaQuery('(max-width: 900px)')
  const texStacked = texNarrowViewport || texWorkspaceSize.width < 650
  const [texSourceSize, setTexSourceSize] = useStoredSize(
    'lemex-layout-tex-source',
    50,
    20,
    80,
  )
  const [proofFocus, setProofFocus] = useState<ProofFocusRequest | null>(null)
  const [editorProof, setEditorProof] = useState<EditorProofState | null>(null)
  const [focusEditorRequest, setFocusEditorRequest] =
    useState<ProofEditorRequest | null>(null)
  const [revealProof, setRevealProof] = useState<{
    id: number
    target: Pick<ProofTarget, 'path' | 'startLine' | 'endLine' | 'name'>
  } | null>(null)
  const [revealPosition, setRevealPosition] = useState<{
    id: number
    path: string
    line: number
    column: number
  } | null>(null)
  const proofRequestId = useRef(0)
  const [git, setGit] = useState<GitInfo | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadBusy, setReloadBusy] = useState(false)
  const [reloadTarget, setReloadTarget] = useState<string | null>(null)
  const [agentPendingFile, setAgentPendingFile] = useState<string | null>(null)
  const [recoveryTarget, setRecoveryTarget] = useState<{
    path: string
    scope: WorkspaceScope
    userId: string
  } | null>(null)
  const [projectModal, setProjectModal] = useState<{ preset?: string } | null>(
    null,
  )
  const [uploadProjectId, setUploadProjectId] = useState<string | null>(null)
  const [repositoryAccessId, setRepositoryAccessId] = useState<string | null>(
    null,
  )
  const [renameTarget, setRenameTarget] = useState<Project | null>(null)
  const [sharingTarget, setSharingTarget] = useState<Project | null>(null)
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
  const [lastTrash, setLastTrash] = useState<TrashItem | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])
  const [trashError, setTrashError] = useState('')
  const [restoring, setRestoring] = useState<string | null>(null)
  const [gitOpen, setGitOpen] = useState<'changes' | 'publish' | null>(null)
  const [newEntryKind, setNewEntryKind] = useState<EntryKind | null>(null)
  // Bound to the project and account that opened it, so a menu action can never
  // be applied to a same-named path after switching projects or accounts.
  const [moveTarget, setMoveTarget] = useState<MoveRequest | null>(null)
  // Moves this tab started; its own broadcast then needs no "moved" notice.
  const ownMoves = useRef(new Set<string>())
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState(false)
  const [librarySource, setLibrarySource] = useState<SourceRequest | null>(null)
  const [fileFilter, setFileFilter] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(() => window.innerWidth > 1000)
  const [editorHidden, setEditorHidden] = useState(false)
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
  const [terminalActive, setTerminalActive] = useState(false)
  const [startingTerminal, setStartingTerminal] = useState(false)
  const terminalStartRequest = useRef<WorkspaceScope | null>(null)
  const [terminalRecoveryVersion, setTerminalRecoveryVersion] = useState(0)
  const [terminalProjectId, setTerminalProjectId] = useState<string | null>(
    null,
  )
  const terminalOpening = useRef<{
    projectId: string
    openingId: string
  } | null>(null)
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
  const [navigationError, setNavigationError] = useState('')
  const [navigationTarget, setNavigationTarget] = useState('')
  const workspaceInUse = useRef(false)
  const [job, setJob] = useState<Job | null>(null)
  const [jobOpen, setJobOpen] = useState(false)
  const [startingCheck, setStartingCheck] = useState(false)
  const [stoppingCheck, setStoppingCheck] = useState(false)
  workspaceInUse.current = !!(
    uploadProjectId ||
    projectModal ||
    newEntryKind ||
    recoveryTarget ||
    moveTarget ||
    pendingAction ||
    reloadTarget ||
    terminalProjectId ||
    startingTerminal ||
    gitOpen ||
    deleteTarget ||
    renameTarget ||
    sharingTarget ||
    repositoryAccessId ||
    trashOpen ||
    settingsModal ||
    gitConnectionsOpen ||
    setupDetails ||
    booksOpen ||
    opening ||
    startingCheck ||
    (job && !terminalJob(job))
  )
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
  const pendingFileOpen = useRef<{
    request: number
    scope: WorkspaceScope
    path: string
    line?: number
    column?: number
    reload: boolean
  } | null>(null)
  const pendingReload = useRef<{
    scope: WorkspaceScope
    path: string
  } | null>(null)
  const filesRequest = useRef(0)
  const navigationRequest = useRef(0)
  const generation = useRef(0)
  const savePromise = useRef<{
    scope: WorkspaceScope
    promise: Promise<void>
  } | null>(null)
  fileRef.current = file
  filesRef.current = files
  projectIdRef.current = projectId
  const project = projects.find((item) => item.id === projectId)
  const lastTrashProject = projects.find(
    (item) => item.id === lastTrash?.projectId,
  )
  const canRestoreLastTrash =
    lastTrash?.kind === 'chat' ||
    lastTrash?.kind === 'project' ||
    (!!lastTrashProject &&
      (!lastTrashProject.accessRole || lastTrashProject.accessRole === 'admin'))
  useEffect(() => {
    if (
      sharingTarget &&
      !projects.some(
        (item) =>
          item.id === sharingTarget.id &&
          (!item.accessRole || item.accessRole === 'admin'),
      )
    )
      setSharingTarget(null)
  }, [projects, sharingTarget])
  const projectAdmin = !project?.accessRole || project.accessRole === 'admin'
  const projectCanEdit = !!project && project.accessRole !== 'viewer'
  const projectAccessRef = useRef(project?.accessRole)
  projectAccessRef.current = project?.accessRole
  useEffect(() => {
    bufferStore.permissions(!projectCanEdit)
  }, [bufferStore, buffers, scope, projectCanEdit])
  const terminalOpen =
    !!project && projectCanEdit && terminalProjectId === project.id
  const projectKindRef = useRef(project?.kind)
  projectKindRef.current = project?.kind
  const singleFileMode = project?.kind === 'single-file'
  const singleFileView =
    singleFileMode &&
    !files.some(
      (entry) =>
        !entry.readOnly &&
        entry.path !== 'Main.lean' &&
        entry.path !== '.gitignore' &&
        !PROJECT_CONFIGURATION_FILES.includes(entry.path),
    )
  const playgroundPreparation = usePlaygroundPreparation(
    session?.templates.find((preset) => preset.id === 'mathlib'),
    session?.user.id,
  )
  const mathlibAvailable = playgroundPreparation.state === 'ready'
  const workspaceEditable =
    !project?.fileRecoveryRequired &&
    (project?.status === 'ready' ||
      (project?.status === 'error' &&
        (singleFileMode || project.needsPreparation === true)))
  useEffect(() => {
    if (project?.status === 'needs-setup') setToolsOpen(false)
  }, [project?.id, project?.status])
  const currentEditorProof =
    !file?.unavailable && editorProof?.path === file?.path ? editorProof : null
  const sidebarMaximum = Math.min(
    480,
    studioSize.width - 360 - (toolsOpen && !overlayTools ? 280 : 0),
  )
  const sidebarWidth = clamp(sidebarSize, 180, sidebarMaximum)
  const assistantMaximum = overlayTools
    ? studioSize.width - 40
    : studioSize.width - sidebarWidth - 280
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
  const dirtyFiles = bufferStore.drafts()
  const saveableFiles = bufferStore.dirty()
  const detachedFiles = [...buffers.values()].filter((file) => file.unavailable)
  const readOnlyDrafts = dirtyFiles.some((file) => file.readOnly)
  const dirtyKey = dirtyFiles
    .map((file) => file.path)
    .sort()
    .join('\0')
  const dirtyPaths = useMemo(
    () => new Set(dirtyKey.split('\0').filter(Boolean)),
    [dirtyKey],
  )
  const dirty = dirtyFiles.length > 0
  const pdfPreview = file?.preview === 'pdf'
  const texFiles = useMemo(
    () =>
      files
        .filter((entry) => !entry.readOnly && /\.tex$/i.test(entry.path))
        .map((entry) => entry.path),
    [files],
  )
  const texVisible = !!texLanguage(file?.path) && texFiles.length > 0
  const readingFile =
    pdfPreview || (isMarkdownPath(file?.path) && markdownPreview)
  const assistantFiles = useMemo(
    () =>
      files.filter(
        (entry) =>
          (isPdfFile(entry.path) || !isBinaryAssetFile(entry.path)) &&
          (!singleFileMode || entry.path === 'Main.lean'),
      ),
    [files, singleFileMode],
  )

  useEffect(() => setMarkdownPreview(false), [projectId, file?.path])

  const setProjectId = useCallback(
    (id: string | null) => {
      if (bufferStore.getSnapshot().scope.projectId === id) return
      // Clear the whole workspace in the selection event, before a new project
      // can mount editors or start requests with the previous project's files.
      setSelectedProjectId(id)
      projectIdRef.current = id
      fileRef.current = null
      filesRef.current = []
      ++openRequest.current
      pendingFileOpen.current = null
      pendingReload.current = null
      savePromise.current = null
      setFiles([])
      setFolders([])
      setFoldersAvailable(null)
      setCreatedFolder(null)
      setNewEntryKind(null)
      setMoveTarget(null)
      setUploadProjectId(null)
      setLibrarySource(null)
      setProofFocus(null)
      setEditorProof(null)
      setFocusEditorRequest(null)
      setRevealProof(null)
      setRevealPosition(null)
      setGit(null)
      setGitOpen(null)
      setTerminalProjectId(null)
      terminalStartRequest.current = null
      setStartingTerminal(false)
      terminalOpening.current = null
      setTerminalActive(false)
      setJob(null)
      setFileFilter('')
      setLeanState('')
      setOpening(false)
      setSaving(false)
      setReloadTarget(null)
      setReloadBusy(false)
      setAgentPendingFile(null)
      setRecoveryTarget(null)
      setPendingAction(null)
      setNavigationError('')
      setNavigationTarget('')
      setError('')
      setNotice('')
      bufferStore.selectProject(id)
    },
    [bufferStore],
  )

  const requireScope = useCallback(
    (expected: WorkspaceScope) => {
      if (!bufferStore.isCurrent(expected))
        throw new Error(
          'The workspace changed. Try again in the selected workspace.',
        )
    },
    [bufferStore],
  )

  const acceptEditorProof = useCallback(
    (state: EditorProofState | null) => {
      if (bufferStore.isCurrent(scope)) setEditorProof(state)
    },
    [bufferStore, scope],
  )

  const acceptProfile = useCallback((user: Account) => {
    profileRevision.current++
    setSession((current) =>
      current?.user.id === user.id ? { ...current, user } : current,
    )
  }, [])

  const logout = useCallback(async () => {
    if (logoutPending.current) return
    logoutPending.current = true
    setLoggingOut(true)
    try {
      await pauseSessionActivity()
      await post('/api/logout')
      bindSessionUser(null)
      sessionRequest.current++
      setSessionRefreshing(false)
      setSession(null)
      setAuthRequired(true)
      setProjectId(null)
      setFile(null)
    } catch (error) {
      resumeSessionActivity()
      throw error
    } finally {
      logoutPending.current = false
      setLoggingOut(false)
    }
  }, [pauseSessionActivity, resumeSessionActivity, setProjectId, setFile])

  const loadSession = useCallback(async () => {
    const request = ++sessionRequest.current
    const profileAtStart = profileRevision.current
    setSessionRefreshing(true)
    setStartupError('')
    try {
      const value = await api<Session>('/api/session')
      if (request !== sessionRequest.current) return
      bindSessionUser(value.user.id)
      setRunEventTransport(value.eventTransport)
      setSession((current) =>
        profileAtStart !== profileRevision.current &&
        current?.user.id === value.user.id
          ? { ...value, user: current.user }
          : value,
      )
      setAuthRequired(false)
    } catch (error) {
      if (request !== sessionRequest.current) return
      if (error instanceof ApiError && error.status === 401)
        setAuthRequired(true)
      else setStartupError(errorText(error))
    } finally {
      if (request === sessionRequest.current) setSessionRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadSession()
  }, [loadSession])
  const preparingTemplates = session?.templates.some(
    (p) =>
      p.preparationState === 'queued' || p.preparationState === 'preparing',
  )
  const sessionUser = session?.user.id
  useEffect(() => {
    if (!sessionUser || authRequired || (!projectModal && !preparingTemplates))
      return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const templates = await api<Preset[]>('/api/templates')
        if (!disposed)
          setSession((current) =>
            current?.user.id === sessionUser
              ? { ...current, templates }
              : current,
          )
      } catch {
        /* Keep existing choices during a temporary connection failure. */
      }
      if (!disposed) timer = setTimeout(() => void refresh(), 5000)
    }
    void refresh()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [sessionUser, authRequired, projectModal, preparingTemplates])
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
    if (!session || invitationToken) return
    let cancelled = false
    void api<Project[]>('/api/projects')
      .then((value) => {
        if (cancelled) return
        setProjects(value)
        // Refreshing the account must keep the current visit, including drafts
        // retained after project access ends. Explicit navigation owns leaving it.
        if (bufferStore.getSnapshot().scope.projectId) return
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
  }, [session, setProjectId, invitationToken, bufferStore])

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

  const loadFiles = useCallback(
    async (id: string) => {
      const expected = bufferStore.getSnapshot().scope
      const request = ++filesRequest.current
      const base = `/api/projects/${encodeURIComponent(id)}`
      const [value, directories] = await Promise.all([
        api<FileEntry[]>(`${base}/files`),
        api<string[]>(`${base}/folders`).catch(() => null),
      ])
      if (
        request === filesRequest.current &&
        bufferStore.isCurrent(expected) &&
        expected.projectId === id
      ) {
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
    },
    [bufferStore],
  )

  const loadGit = useCallback(
    async (id: string) => {
      const expected = bufferStore.getSnapshot().scope
      if (expected.projectId !== id) return
      if (
        projectIdRef.current === id &&
        projectKindRef.current === 'single-file'
      )
        return
      try {
        const value = await api<GitInfo>(
          `/api/projects/${encodeURIComponent(id)}/git`,
        )
        if (bufferStore.isCurrent(expected)) setGit(value)
      } catch {
        if (bufferStore.isCurrent(expected)) setGit(null)
      }
    },
    [bufferStore],
  )
  useEffect(() => {
    if (project?.status === 'ready' && project.kind !== 'single-file')
      void loadGit(project.id)
  }, [project?.id, project?.status, project?.kind, loadGit])
  const acceptGit = useCallback(
    (value: GitInfo) => {
      if (bufferStore.isCurrent(scope)) setGit(value)
    },
    [bufferStore, scope],
  )

  const openFile = useCallback(
    async (
      id: string,
      path: string,
      line?: number,
      column?: number,
      { reload = false }: { reload?: boolean } = {},
    ) => {
      const expected = bufferStore.getSnapshot().scope
      if (expected.projectId !== id) return
      const request = ++openRequest.current
      pendingFileOpen.current = null
      const revealCurrent = () => {
        if (line)
          setRevealPosition({
            id: ++proofRequestId.current,
            path,
            line,
            column: column || 1,
          })
        setSidebarOpen(false)
      }
      // Diagnostic links navigate within the current editor. Reopening it
      // would discard undo/cursor state and could
      // overwrite keystrokes made while a redundant source request was pending.
      if (
        !reload &&
        bufferStore.getSnapshot().file?.path === path &&
        !bufferStore.getSnapshot().file?.unavailable
      ) {
        setOpening(false)
        setError('')
        revealCurrent()
        return
      }
      setOpening(true)
      pendingFileOpen.current = {
        request,
        scope: expected,
        path,
        line,
        column,
        reload,
      }
      setError('')
      try {
        const pdf = isPdfFile(path)
        const cached = bufferStore.getSnapshot().buffers.get(path)
        let value =
          cached && cached.content !== cached.savedContent
            ? cached
            : pdf
              ? { content: '', hash: '', readOnly: true }
              : await api<{
                  content: string
                  hash: string
                  readOnly?: boolean
                }>(
                  `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
                )
        if (request !== openRequest.current || !bufferStore.isCurrent(expected))
          return
        const latest = bufferStore.getSnapshot().buffers.get(path)
        // A refresh may race a local edit or save. Prefer the current buffer
        // over the response, including its conflict hash and undo history.
        if (latest && latest !== cached) {
          if (bufferStore.getSnapshot().file?.path === path) {
            revealCurrent()
            return
          }
          value = latest
        }
        if (
          latest &&
          !latest.unavailable &&
          bufferStore.getSnapshot().file?.path === path &&
          value.content === latest.content &&
          value.hash === latest.hash &&
          !pdf
        ) {
          revealCurrent()
          return
        }
        setFile({
          path,
          content: value.content,
          savedContent:
            latest && value === latest ? latest.savedContent : value.content,
          hash: value.hash,
          unavailable:
            latest && value === latest ? latest.unavailable : undefined,
          generation: ++generation.current,
          readOnly:
            projectAccessRef.current === 'viewer' ||
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
        if (pendingFileOpen.current?.request === request)
          pendingFileOpen.current = null
        if (request === openRequest.current) setOpening(false)
      }
    },
    [bufferStore, setFile],
  )

  useEffect(() => {
    if (!projectId) return
    localStorage.setItem('lemex-project', projectId)
    if (!workspaceEditable) return
    const expected = scope
    let cancelled = false
    void loadFiles(projectId)
      .then((value) => {
        if (cancelled || !bufferStore.isCurrent(expected)) return
        const savedPath = localStorage.getItem(`lemex-file-${projectId}`)
        const first =
          value.find((item) => item.path === savedPath) ||
          value.find((item) => item.path === 'Main.lean') ||
          value.find((item) => item.path.endsWith('.lean')) ||
          value[0]
        if (first && (project?.status === 'ready' || !fileRef.current)) {
          const currentPath = value.find(
            (entry) => entry.path === fileRef.current?.path,
          )?.path
          void openFile(
            projectId,
            currentPath || first.path,
            undefined,
            undefined,
            {
              reload: !!currentPath,
            },
          )
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [
    projectId,
    scope,
    bufferStore,
    project?.status,
    workspaceEditable,
    loadFiles,
    loadGit,
    openFile,
    setFile,
  ])

  async function downloadFile(item: Project, path: string) {
    try {
      const snapshot = bufferStore.getSnapshot()
      const buffer =
        snapshot.scope.projectId === item.id
          ? snapshot.buffers.get(path)
          : undefined
      const filename =
        item.kind === 'single-file' && path === 'Main.lean'
          ? playgroundDownloadName(item.name)
          : path.split('/').at(-1) || 'download'
      if (buffer && buffer.content !== buffer.savedContent) {
        saveAs(
          new Blob([buffer.content], { type: 'text/plain;charset=utf-8' }),
          filename,
        )
      } else {
        await downloadWorkspaceFile(item.id, path, filename)
      }
    } catch (error) {
      setError(errorText(error))
    }
  }

  async function downloadArchive(item: Project) {
    try {
      await downloadProject(item.id, item.name)
    } catch (error) {
      setError(errorText(error))
    }
  }

  async function downloadWorkspace(item: Project) {
    return item.kind === 'single-file'
      ? downloadFile(item, 'Main.lean')
      : downloadArchive(item)
  }

  // Runs for this tab's own move (HTTP receipt) and for a collaborator's (live
  // broadcast). Re-keying is idempotent, so a duplicate announcement is a no-op.
  const handleFilesMoved = useCallback(
    ({ from, to }: PathMove) => {
      const id = bufferStore.getSnapshot().scope.projectId
      const userId = session?.user.id
      if (!id || !userId) return
      moveStoredDrafts(userId, id, from, to)
      window.dispatchEvent(
        new CustomEvent<FilesMovedDetail>(FILES_MOVED_EVENT, {
          detail: { projectId: id, from, to },
        }),
      )
      const rekey = (path: string) => remapMovedPath(path, from, to) ?? path
      const reloading = pendingReload.current
      if (reloading && bufferStore.isCurrent(reloading.scope))
        reloading.path = rekey(reloading.path)
      setReloadTarget((current) => (current ? rekey(current) : null))
      setProofFocus((current) =>
        current?.projectId === id
          ? {
              ...current,
              target: { ...current.target, path: rekey(current.target.path) },
            }
          : current,
      )
      setRevealProof((current) =>
        current
          ? {
              ...current,
              target: { ...current.target, path: rekey(current.target.path) },
            }
          : current,
      )
      setFocusEditorRequest((current) =>
        current?.path ? { ...current, path: rekey(current.path) } : current,
      )
      setAgentPendingFile((current) => (current ? rekey(current) : null))
      // Read the store, not a render-time ref: the re-render has not happened.
      const movedFile = bufferStore.getSnapshot().file
      generation.current = Math.max(
        generation.current,
        movedFile?.generation ?? 0,
      )
      const opening = pendingFileOpen.current
      if (opening && bufferStore.isCurrent(opening.scope)) {
        const destination = remapMovedPath(opening.path, from, to)
        if (destination)
          void openFile(id, destination, opening.line, opening.column, {
            reload: opening.reload,
          })
      }
      const active = movedFile?.path
      if (active) localStorage.setItem(`lemex-file-${id}`, active)
      if (!ownMoves.current.has(`${from}\0${to}`))
        setNotice(`${from} was moved to ${to}.`)
    },
    [bufferStore, session?.user.id, openFile],
  )
  const collaboration = useProjectCollaboration({
    store: bufferStore,
    scope,
    enabled: !!session && !authRequired && workspaceEditable,
    canEdit: projectCanEdit,
    onFilesChanged: async () => {
      const id = scope.projectId
      if (!id) return
      const listing = await loadFiles(id)
      await reconcileMissingBuffers(
        bufferStore,
        scope,
        listing.map((entry) => entry.path),
        (path) =>
          api(
            `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
          ),
      )
    },
    onFilesMoved: handleFilesMoved,
    onAccessChanged: async () => {
      await loadProjects()
    },
  })
  const flushCollaboration = collaboration.flush

  const saveFile = useCallback(
    async ({ automatic = false } = {}) => {
      if (savePromise.current) return savePromise.current.promise
      const expected = bufferStore.getSnapshot().scope
      const id = expected.projectId
      if (!projectCanEdit || !id) return
      // Reserve the whole operation before live flushing can yield. Manual and
      // automatic saves share this promise, including its original visit.
      setSaving(true)
      const pending = {
        scope: expected,
        promise: Promise.resolve()
          .then(async () => {
            if (!bufferStore.isCurrent(expected)) return
            if (await flushCollaboration()) return
            if (!bufferStore.isCurrent(expected)) return
            const snapshots = bufferStore.dirty()
            const snapshot = snapshots[0]
            if (!snapshot || snapshot.readOnly) return
            if (
              snapshots.length > 1 ||
              snapshot.path !== fileRef.current?.path
            ) {
              const value = await api<{
                applied: number
                requiresPreparation: boolean
                files: { path: string; hash: string }[]
              }>(`/api/projects/${encodeURIComponent(id)}/files`, {
                method: 'PUT',
                signal: AbortSignal.timeout(60_000),
                body: JSON.stringify({
                  files: snapshots.map((file) => ({
                    path: file.path,
                    content: file.content,
                    expectedHash: file.hash,
                  })),
                }),
              })
              if (!bufferStore.isCurrent(expected)) return
              bufferStore.saved(snapshots, value.files)
              if (!automatic) setNotice(`Saved ${snapshots.length} files`)
              if (value.requiresPreparation) await loadProjects()
              else if (!automatic) void loadGit(id)
              return
            }
            const value = await api<{
              content: string
              hash: string
              requiresPreparation: boolean
            }>(
              `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(snapshot.path)}`,
              {
                method: 'PUT',
                signal: AbortSignal.timeout(60_000),
                body: JSON.stringify({
                  content: snapshot.content,
                  expectedHash: snapshot.hash,
                }),
              },
            )
            if (!bufferStore.isCurrent(expected)) return
            bufferStore.saved(snapshots, [
              { path: snapshot.path, hash: value.hash },
            ])
            if (!automatic) setNotice('File saved')
            if (value.requiresPreparation) await loadProjects()
            else if (!automatic) void loadGit(id)
          })
          .finally(() => {
            // A previous visit must never release a newer visit's save lock.
            if (savePromise.current === pending) {
              setSaving(false)
              savePromise.current = null
            }
          }),
      }
      savePromise.current = pending
      return pending.promise
    },
    [loadGit, loadProjects, bufferStore, projectCanEdit, flushCollaboration],
  )

  const automaticSave = useCallback(
    () => saveFile({ automatic: true }),
    [saveFile],
  )
  const autosave = useAutosave({
    store: bufferStore,
    scope,
    save: automaticSave,
    enabled:
      !!session &&
      !authRequired &&
      workspaceEditable &&
      projectCanEdit &&
      !opening &&
      !pendingAction &&
      !reloadTarget &&
      !deleteTarget &&
      !deleteBusy &&
      !gitOpen,
  })
  useEffect(() => {
    if (!saveVersion || !scope.projectId) return
    // Coalesce source-control refreshes while the user is making small edits.
    const timer = setTimeout(() => {
      if (bufferStore.isCurrent(scope)) void loadGit(scope.projectId!)
    }, 2500)
    return () => clearTimeout(timer)
  }, [saveVersion, scope, bufferStore, loadGit])

  const saveCompletely = useCallback(async () => {
    if (bufferStore.drafts().some((file) => file.readOnly && !file.unavailable))
      throw new Error(
        'Your drafts can no longer be saved to this project. Download them before continuing, or discard them.',
      )
    const expected = bufferStore.getSnapshot().scope
    // Saving is optimistic: preserve edits made during the request and save them
    // before handing a snapshot to an assistant or changing the current file.
    await saveFile()
    requireScope(expected)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    requireScope(expected)
    if (bufferStore.dirty().length) await saveFile()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    requireScope(expected)
    if (bufferStore.drafts().some((file) => !file.unavailable))
      throw new Error(
        'Files are still being edited. Save them before continuing.',
      )
  }, [saveFile, bufferStore, requireScope])

  const saveWorkspace = useCallback(async () => {
    requireScope(scope)
    await saveCompletely()
    if (bufferStore.getSnapshot().file?.unavailable)
      throw new Error(
        'This file was deleted or moved. Choose a saved file, or save a copy of its draft before starting work on it.',
      )
  }, [requireScope, scope, saveCompletely, bufferStore])

  const beforeApply = useCallback(async () => {
    if (savePromise.current)
      throw new Error(
        'A file save is still in progress. Wait for it to finish before applying the candidate.',
      )
    if (bufferStore.drafts().some((file) => !file.unavailable))
      throw new Error(
        'The editor has unsaved changes. Keep them and start a new run, or discard them before applying this candidate.',
      )
  }, [bufferStore])

  const discardUnsavedEdits = useCallback(async () => {
    if (savePromise.current)
      throw new Error(
        'A file save is still in progress. Wait for it to finish before discarding edits.',
      )
    bufferStore.discard(++generation.current)
    setNotice('Unsaved edits discarded')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }, [bufferStore])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveFile().catch((error) => setError(errorText(error)))
      }
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (bufferStore.drafts().length || savePromise.current) {
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
  }, [saveFile, bufferStore])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 2500)
    return () => clearTimeout(timer)
  }, [notice])

  const navigate = useCallback(
    (
      action: () => Promise<void>,
      destination = '',
      keepDetachedDrafts = false,
    ) => {
      const expected = bufferStore.getSnapshot().scope
      const request = ++navigationRequest.current
      const openingRequest = openRequest.current
      setNavigationError('')
      setNavigationTarget(destination)
      void (async () => {
        try {
          if (bufferStore.drafts().length || savePromise.current)
            await saveCompletely()
          if (
            request !== navigationRequest.current ||
            openRequest.current !== openingRequest ||
            !bufferStore.isCurrent(expected)
          )
            return
          if (
            bufferStore
              .drafts()
              .some((file) => !keepDetachedDrafts || !file.unavailable)
          )
            throw new Error(
              'Your drafts are still in this tab. Download or save them before continuing, or discard them.',
            )
          await action()
        } catch (error) {
          if (
            request !== navigationRequest.current ||
            !bufferStore.isCurrent(expected)
          )
            return
          if (bufferStore.drafts().length) {
            setNavigationError(errorText(error))
            setPendingAction(() => action)
          } else setError(errorText(error))
        }
      })()
    },
    [bufferStore, saveCompletely],
  )

  useEffect(() => {
    if (!sessionUser || !invitationToken || authRequired) return
    let cancelled = false
    setInvitationIssue('')
    void post<Project>('/api/project-invitations/join', {
      token: invitationToken,
    })
      .then((joined) => {
        if (cancelled) return
        sessionStorage.removeItem('lemex-project-invitation')
        setProjects((previous) => [
          ...previous.filter((item) => item.id !== joined.id),
          joined,
        ])
        navigate(async () => {
          localStorage.setItem('lemex-project', joined.id)
          setProjectId(joined.id)
          setInvitationToken(null)
          setNotice('Shared project opened')
        }, joined.name)
      })
      .catch((error) => {
        if (!cancelled) setInvitationIssue(errorText(error))
      })
    return () => {
      cancelled = true
    }
  }, [
    sessionUser,
    invitationToken,
    invitationAttempt,
    authRequired,
    setProjectId,
    navigate,
  ])

  const chooseFile = useCallback(
    (path: string) => {
      const id = projectIdRef.current
      if (id) {
        const action = () => openFile(id, path)
        if (bufferStore.getSnapshot().buffers.has(path))
          void action().catch((error) => setError(errorText(error)))
        else navigate(action, '', true)
      }
    },
    [navigate, openFile, bufferStore],
  )

  function rememberCreatedProject(created: Project) {
    if (created.kind === 'single-file')
      localStorage.setItem(`lemex-file-${created.id}`, 'Main.lean')
    setProjects((previous) => [
      created,
      ...previous.filter((item) => item.id !== created.id),
    ])
  }

  function acceptCreatedProject(created: Project) {
    rememberCreatedProject(created)
    setProjectId(created.id)
    setSidebarOpen(false)
  }

  function startSingleFile(source?: UploadFile) {
    navigate(async () => {
      const expected = bufferStore.getSnapshot().scope
      setCreatingSingleFile(true)
      setCreatingPlaygroundSource(source ? 'upload' : 'blank')
      try {
        const created = await post<Project>('/api/projects', {
          kind: 'single-file',
          ...(source ? { file: source } : {}),
        })
        rememberCreatedProject(created)
        // Creation can take time. Keep the workspace the user has moved to,
        // and ask about edits made since the original click before leaving.
        if (
          !bufferStore.isCurrent(expected) ||
          savePromise.current ||
          workspaceInUse.current
        ) {
          setNotice(`${created.name} is ready. Open it from Playgrounds.`)
          return
        }
        navigate(async () => {
          requireScope(expected)
          setProjectId(created.id)
          setSidebarOpen(false)
        }, created.name)
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
    setNavigationError('')
    try {
      if (save) await saveCompletely()
      else await discardUnsavedEdits()
    } catch (error) {
      setNavigationError(errorText(error))
      return
    }
    const action = pendingAction
    setPendingAction(null)
    try {
      await action()
    } catch (error) {
      setError(errorText(error))
    }
  }

  async function check() {
    if (!projectCanEdit) return
    if (!projectId || !file || checkRequest.current) return
    const id = projectId
    checkRequest.current = true
    setStartingCheck(true)
    setError('')
    try {
      await saveCompletely()
      if (bufferStore.getSnapshot().file?.unavailable)
        throw new Error(
          'This file was deleted or moved. Choose a saved Lean file to check.',
        )
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
    if (!projectId || !bufferStore.isCurrent(scope)) return
    const updated = await loadProjects()
    if (!bufferStore.isCurrent(scope)) return
    if (updated.find((item) => item.id === projectId)?.status !== 'ready')
      return
    await loadFiles(projectId)
    if (!bufferStore.isCurrent(scope)) return
    if (fileRef.current)
      await openFile(projectId, fileRef.current.path, undefined, undefined, {
        reload: true,
      })
    await loadGit(projectId)
  }

  async function createEntry(path: string, kind: EntryKind) {
    if (!projectId) throw new Error('Choose a project first.')
    const expected = scope
    requireScope(expected)
    if (singleFileMode && kind === 'folder')
      throw new Error(
        'Convert this playground to a project to create an empty folder.',
      )
    if (files.some((file) => file.path === path) || folders.includes(path)) {
      throw new Error(
        'A file or folder with this name already exists. Choose another name.',
      )
    }
    if (kind === 'folder') {
      await post(`/api/projects/${encodeURIComponent(projectId)}/folders`, {
        path,
      })
      if (!bufferStore.isCurrent(expected)) return
      setFileFilter('')
      setCreatedFolder(path)
      setFolders((current) =>
        [...new Set([...current, ...parentFolders(path), path])].sort(),
      )
      try {
        await loadFiles(projectId)
      } catch {
        if (!bufferStore.isCurrent(expected)) return
        setError(
          `Created folder ${path}, but the file list could not refresh. Use Refresh files to try again.`,
        )
      }
      return
    }
    setOpening(true)
    try {
      await saveCompletely()
      requireScope(expected)
      const saved = await api<{ requiresPreparation: boolean }>(
        `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ content: '', expectedHash: null }),
        },
      )
      if (!bufferStore.isCurrent(expected)) return
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
          if (!bufferStore.isCurrent(expected)) return
          await openFile(projectId, path)
        }
      } catch {
        if (!bufferStore.isCurrent(expected)) return
        setError(
          `Created file ${path}, but the project could not refresh. Use Refresh files to try again.`,
        )
      }
    } finally {
      if (bufferStore.isCurrent(expected)) setOpening(false)
    }
  }

  async function recoverDraft(path: string) {
    if (!recoveryTarget) return
    if (!session || session.user.id !== recoveryTarget.userId)
      throw new Error(
        'The workspace account changed. Choose the draft again in this account.',
      )
    const expected = recoveryTarget.scope
    requireScope(expected)
    const id = expected.projectId
    if (!id) throw new Error('Choose a project before saving this draft.')
    const draft = bufferStore.getSnapshot().buffers.get(recoveryTarget.path)
    if (!draft?.unavailable)
      throw new Error(
        'This draft changed. Close the dialog and choose it again.',
      )
    if (path === draft.path)
      throw new Error('Choose a different filename for this copy.')
    const destination = bufferStore.getSnapshot().buffers.get(path)
    if (destination && destination.content !== destination.savedContent)
      throw new Error(
        `A draft already uses ${path}. Choose another filename for this copy.`,
      )
    const receipt = await api<{ content: string; hash: string }>(
      `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      {
        method: 'PUT',
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ content: draft.content, expectedHash: null }),
      },
    )
    requireScope(expected)
    if (
      receipt?.content !== draft.content ||
      !/^[a-f0-9]{64}$/.test(receipt.hash)
    )
      throw new Error(
        'The server did not confirm this copy. Your draft is kept here; retry saving it.',
      )
    await loadFiles(id)
    requireScope(expected)
    await openFile(id, path)
    requireScope(expected)
    const latest = bufferStore.getSnapshot().buffers.get(draft.path)
    const copied = bufferStore.getSnapshot().buffers.get(path)
    if (
      latest?.unavailable &&
      latest.content === draft.content &&
      copied?.savedContent === draft.content &&
      copied.hash === receipt.hash
    )
      bufferStore.remove(draft.path)
    setNotice(`Draft saved as ${path}`)
  }

  async function reloadSavedFile(path: string) {
    const expected = bufferStore.getSnapshot().scope
    const id = expected.projectId
    if (!id || savePromise.current) return
    const operation = { scope: expected, path }
    pendingReload.current = operation
    setReloadBusy(true)
    setError('')
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const requestedPath = operation.path
        const previous = bufferStore.getSnapshot().buffers.get(requestedPath)
        const selectedRequest = openRequest.current
        let latest: { content: string; hash: string; readOnly?: boolean }
        try {
          latest = await api(
            `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(requestedPath)}`,
          )
        } catch (error) {
          if (operation.path !== requestedPath) continue
          throw error
        }
        if (
          !bufferStore.isCurrent(expected) ||
          pendingReload.current !== operation
        )
          return
        // A committed move can overtake this HTTP response. Read the new path
        // instead of selecting a stale source that no longer exists.
        if (operation.path !== requestedPath) continue
        if (openRequest.current !== selectedRequest)
          throw new Error(
            'The selected file changed. Choose Reload file again for the file you want to reload.',
          )
        const current = bufferStore.getSnapshot().buffers.get(requestedPath)
        if (current?.unavailable && !previous?.unavailable)
          throw new Error(
            'This file was deleted or moved while reloading. Your draft is kept here; choose a saved file or save a copy.',
          )
        if (
          current &&
          previous &&
          current.content !== previous.content &&
          current.content !== current.savedContent
        )
          throw new Error(
            'New edits arrived while reloading. Your draft is kept here; review it before choosing Reload file again.',
          )
        if (
          current?.generation !== previous?.generation ||
          current?.hash !== previous?.hash
        )
          continue
        setFile({
          path: requestedPath,
          ...latest,
          savedContent: latest.content,
          generation: ++generation.current,
          readOnly:
            projectAccessRef.current === 'viewer' ||
            latest.readOnly ||
            (!!current?.readOnly && !current.unavailable) ||
            requestedPath.startsWith('.lake/') ||
            filesRef.current.find((item) => item.path === requestedPath)
              ?.readOnly,
        })
        setReloadTarget(null)
        setAgentPendingFile(null)
        return
      }
      throw new Error(
        'The saved file kept changing while reloading. Your draft is kept here; try Reload file again.',
      )
    } catch (error) {
      if (bufferStore.isCurrent(expected)) {
        setError(errorText(error))
        setReloadTarget(null)
      }
    } finally {
      if (pendingReload.current === operation) {
        pendingReload.current = null
        if (bufferStore.isCurrent(expected)) setReloadBusy(false)
      }
    }
  }

  useEffect(() => {
    if (
      moveTarget &&
      !moveRequestCurrent(moveTarget, projectId, session?.user.id)
    )
      setMoveTarget(null)
  }, [moveTarget, projectId, session?.user.id])

  async function moveEntry(targetProjectId: string, from: string, to: string) {
    // The request is bound to the project that opened the dialog; a project
    // or account switch in between must never retarget a same-named path.
    if (!projectId || projectId !== targetProjectId)
      throw new Error(
        'The project changed. Close this dialog and choose the file again.',
      )
    const expected = scope
    requireScope(expected)
    if (singleFileMode) throw new Error(PLAYGROUND_MOVE_REASON)
    if (files.some((file) => file.path === to) || folders.includes(to))
      throw new Error(
        `${to} already exists. Choose another name or location; nothing is overwritten.`,
      )
    setOpening(true)
    try {
      // Moves keep file bytes, so saved edits follow the file. Never move while
      // an edit is unsaved: saving first means the server always sees the text.
      await saveCompletely()
      requireScope(expected)
      if (savePromise.current)
        throw new Error(
          'Wait for the current file save to finish before renaming or moving.',
        )
      const ownKey = `${from}\0${to}`
      ownMoves.current.add(ownKey)
      setTimeout(() => ownMoves.current.delete(ownKey), 15_000)
      const moved = await post<{ kind: 'file' | 'folder' }>(
        `/api/projects/${encodeURIComponent(projectId)}/move`,
        { from, to },
      )
      if (!bufferStore.isCurrent(expected)) return
      // Re-key open buffers (and any text typed during the request) to the new
      // path; later saves then target the new file, never the removed one. A
      // live broadcast of this same move may already have done so.
      ++openRequest.current
      bufferStore.move(from, to, ++generation.current)
      // Drafts, proof focus and the remembered file follow the move too.
      handleFilesMoved({ from, to })
      setFileFilter('')
      setCreatedFolder(
        moved.kind === 'folder'
          ? to
          : to.includes('/')
            ? to.slice(0, to.lastIndexOf('/'))
            : null,
      )
      try {
        await loadFiles(projectId)
        if (!bufferStore.isCurrent(expected)) return
        void loadGit(projectId)
      } catch {
        if (!bufferStore.isCurrent(expected)) return
        setError(
          `Moved ${from} to ${to}, but the file list could not refresh. Use Refresh files to try again.`,
        )
      }
      setNotice(`Moved to ${to}`)
    } finally {
      if (bufferStore.isCurrent(expected)) setOpening(false)
    }
  }

  const refreshLiveFiles = useCallback(
    async (
      paths: string[],
      source: 'agent' | 'terminal' = 'agent',
      expected = bufferStore.getSnapshot().scope,
    ) => {
      if (!bufferStore.isCurrent(expected)) return
      const id = expected.projectId
      if (!id) return
      const current = bufferStore.getSnapshot().file
      const [, updated] = await Promise.all([
        loadFiles(id),
        source === 'agent'
          ? api<Project>(`/api/projects/${encodeURIComponent(id)}`)
          : Promise.resolve(null),
      ])
      if (!bufferStore.isCurrent(expected)) return
      if (updated)
        setProjects((previous) =>
          previous.map((item) => (item.id === id ? updated : item)),
        )
      if (source === 'agent') void loadGit(id)
      if (!current || (paths.length && !paths.includes(current.path))) return
      const selected = bufferStore.getSnapshot().file
      if (
        selected?.path !== current.path ||
        selected.generation !== current.generation
      )
        return
      if (current.preview === 'pdf') {
        // Terminal polling supplies no changed paths. Keep the reader's page
        // and scroll position until a reported edit or an explicit reload.
        if (paths.includes(current.path))
          await openFile(id, current.path, undefined, undefined, {
            reload: true,
          })
        return
      }
      if (collaboration.manages(current.path)) {
        setAgentPendingFile((pending) =>
          pending === current.path ? null : pending,
        )
        return
      }
      let latest: { content: string; hash: string }
      try {
        latest = await api(
          `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(current.path)}`,
        )
      } catch (error) {
        if (collaboration.manages(current.path)) return
        const now = bufferStore.getSnapshot().file
        if (error instanceof ApiError && error.status === 404) {
          if (
            bufferStore.isCurrent(expected) &&
            now?.path === current.path &&
            now.generation === current.generation &&
            now.hash === current.hash
          ) {
            bufferStore.detach(current.path)
            setAgentPendingFile(null)
          }
          return
        }
        throw error
      }
      const now = bufferStore.getSnapshot().file
      if (collaboration.manages(current.path)) return
      if (
        !bufferStore.isCurrent(expected) ||
        now?.path !== current.path ||
        now.generation !== current.generation
      )
        return
      if (latest.hash === now.hash) {
        if (now.content === now.savedContent)
          setAgentPendingFile((pending) =>
            pending === now.path ? null : pending,
          )
        return
      }
      if (latest.content === now.content) {
        // The file can become readable before this tab receives its save ACK.
        // Keep waiting for that receipt without claiming an outside conflict.
        setAgentPendingFile((pending) =>
          pending === now.path ? null : pending,
        )
        return
      }
      if (savePromise.current || now.content !== now.savedContent) {
        setAgentPendingFile(now.path)
        return
      }
      if (now.hash !== current.hash) return
      setFile((previous) =>
        previous?.path === current.path &&
        previous.generation === current.generation &&
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
    [bufferStore, loadFiles, loadGit, openFile, setFile, collaboration.manages],
  )

  useEffect(() => {
    if (!terminalOpen) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        await refreshLiveFiles([], 'terminal', scope)
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
    scope,
    project?.id,
    project?.status,
    refreshLiveFiles,
    loadProjects,
  ])

  async function openTerminal() {
    const expected = bufferStore.getSnapshot().scope
    const id = expected.projectId
    if (!id || terminalStartRequest.current) return
    terminalStartRequest.current = expected
    setStartingTerminal(true)
    try {
      await saveCompletely()
      requireScope(expected)
      setTerminalProjectId(id)
    } catch (error) {
      if (bufferStore.isCurrent(expected)) setError(errorText(error))
    } finally {
      if (terminalStartRequest.current === expected) {
        terminalStartRequest.current = null
        setStartingTerminal(false)
      }
    }
  }

  async function closeTerminal() {
    const opening = terminalOpening.current
    terminalOpening.current = null
    setTerminalProjectId(null)
    setTerminalActive(false)
    const id = terminalProjectId
    if (!id || opening?.projectId !== id) return
    try {
      await post(`/api/projects/${encodeURIComponent(id)}/terminal/stop`, {
        openingId: opening.openingId,
      })
      await loadProjects()
      if (projectIdRef.current !== id) return
      await refreshLiveFiles([], 'terminal', scope)
      void loadGit(id)
    } catch (error) {
      if (projectIdRef.current === id) setError(errorText(error))
    } finally {
      if (projectIdRef.current === id)
        setTerminalRecoveryVersion((value) => value + 1)
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
  async function deleteItem() {
    if (!deleteTarget || deleteBusy) return
    const target = deleteTarget
    setDeleteBusy(true)
    setDeleteError('')
    try {
      if (savePromise.current)
        throw new Error(
          'Wait for the current file save to finish before deleting.',
        )
      if (
        target.kind !== 'chat' &&
        projectIdRef.current === target.projectId &&
        bufferStore
          .drafts()
          .some(
            (buffer) =>
              !target.path ||
              buffer.path === target.path ||
              buffer.path.startsWith(target.path + '/'),
          )
      )
        throw new Error(
          'Save or discard unsaved changes in the files being deleted before moving them to Trash.',
        )
      const receipt = await post<TrashItem>(
        target.kind === 'chat'
          ? `/api/chats/${encodeURIComponent(target.chatId!)}/trash`
          : `/api/projects/${encodeURIComponent(target.projectId)}/trash`,
        {
          ...(target.path === undefined ? {} : { path: target.path }),
          ...(target.kind !== 'chat' ? { stopActive: true } : {}),
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
        if (target.path) bufferStore.remove(target.path)
        if (removed) ++openRequest.current
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

  const draftNavigationDialog = pendingAction && (
    <DraftNavigationDialog
      files={dirtyFiles}
      destination={navigationTarget}
      error={navigationError}
      saving={saving}
      onClose={() => setPendingAction(null)}
      onDiscard={() => void continueNavigation(false)}
      onSave={() => void continueNavigation(true)}
    />
  )

  const invitationNotice = invitationToken && (
    <div
      className="workspace-alert"
      role={invitationIssue ? 'alert' : 'status'}
    >
      <span>{invitationIssue || 'Opening shared project…'}</span>
      {invitationIssue && (
        <>
          <button
            className="button small secondary"
            onClick={() => setInvitationAttempt((value) => value + 1)}
          >
            Retry invitation
          </button>
          <button
            className="button small subtle"
            onClick={() => {
              sessionStorage.removeItem('lemex-project-invitation')
              setInvitationToken(null)
              setInvitationIssue('')
            }}
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  )

  if (authRequired && !session)
    return (
      <Login
        onSession={(value) => {
          setSession(value)
          setAuthRequired(false)
        }}
      />
    )
  if (
    session &&
    (session.user.profileComplete === false ||
      (session.lemex?.configured === false &&
        project?.accessRole !== 'viewer' &&
        !project?.fileRecoveryRequired &&
        !(
          project?.legacyRecoveryReviewAvailable &&
          (!project.accessRole || project.accessRole === 'admin')
        )))
  )
    return (
      <>
        <AccountSetup
          session={session}
          refreshError={startupError}
          refreshing={sessionRefreshing}
          onRetry={() => void loadSession()}
          onSaved={() => {
            void loadSession()
          }}
          onProfileSaved={acceptProfile}
          onLogout={async () => navigate(logout)}
          invitationNotice={invitationNotice}
          viewerProjects={
            session.user.profileComplete === false
              ? []
              : projects.filter((item) => item.accessRole === 'viewer')
          }
          onOpenViewer={(id) =>
            navigate(async () => {
              localStorage.setItem('lemex-project', id)
              setProjectId(id)
            })
          }
        />
        {draftNavigationDialog}
        {authRequired && <SessionRecovery user={session.user} />}
      </>
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
      className={`studio ${toolsOpen ? '' : 'tools-hidden'} ${toolsOpen && editorHidden ? 'editor-hidden' : ''} ${singleFileView ? 'single-file-mode' : ''}`}
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
                      onClick={() => setUploadProjectId(projectId)}
                      disabled={!projectCanEdit || project?.status !== 'ready'}
                      title="Upload local files or a folder"
                    >
                      Upload
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => setNewEntryKind('file')}
                      disabled={
                        !projectCanEdit ||
                        !workspaceEditable ||
                        opening ||
                        saving
                      }
                      title="New file"
                      aria-label="New file"
                    >
                      <Icon name="filePlus" size={16} />
                    </button>
                    {!singleFileMode && (
                      <button
                        className="icon-button"
                        onClick={() => {
                          setCreatedFolder(null)
                          setNewEntryKind('folder')
                        }}
                        disabled={
                          !projectCanEdit ||
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
                    )}
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
                  dirtyPaths={dirtyPaths}
                  disabled={opening || saving}
                  filter={fileFilter}
                  ready={workspaceEditable}
                  writable={projectCanEdit}
                  onSelect={chooseFile}
                  onDownload={(path) =>
                    project && void downloadFile(project, path)
                  }
                  onDownloadProject={() =>
                    project && void downloadArchive(project)
                  }
                  onDelete={(path, kind) =>
                    projectId &&
                    requestDelete({ projectId, path, name: path, kind })
                  }
                  playground={singleFileMode}
                  onRename={(path, kind) =>
                    projectId &&
                    !singleFileMode &&
                    setMoveTarget({
                      mode: 'rename',
                      path,
                      kind,
                      projectId,
                      userId: session.user.id,
                    })
                  }
                  onMove={(path, kind) =>
                    projectId &&
                    !singleFileMode &&
                    setMoveTarget({
                      mode: 'move',
                      path,
                      kind,
                      projectId,
                      userId: session.user.id,
                    })
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
          <section className="sidebar-projects-section" aria-label="Workspaces">
            <WorkspaceList
              projects={projects}
              selectedId={projectId}
              disabled={opening || saving}
              onCreateProject={() => setProjectModal({})}
              onDownload={(item) => void downloadWorkspace(item)}
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
              onShare={setSharingTarget}
              playgroundActions={
                <SingleFileActions
                  available={mathlibAvailable}
                  compact
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
        {projectCanEdit &&
          !singleFileMode &&
          git &&
          git.repository !== false &&
          project?.status === 'ready' && (
            <div className="git-sidebar">
              <button
                className="git-source-entry"
                aria-label={`Source control, ${git.branch || 'Detached HEAD'}, ${git.changes?.length || 0} changes`}
                title={`Source control · ${git.branch || 'Detached HEAD'}`}
                onClick={() => setGitOpen('changes')}
              >
                <Icon name="git" size={14} />
                <span className="git-branch">
                  {git.branch || 'Detached HEAD'}
                </span>
                <span className="git-source-label">Source control</span>
                <span className="git-change-count">
                  {git.changes?.length || 0}
                </span>
              </button>
              <button
                className="icon-button"
                aria-label="Refresh Git status"
                title="Refresh Git status"
                onClick={() => projectId && void loadGit(projectId)}
              >
                <Icon name="refresh" size={13} />
              </button>
            </div>
          )}
        <div className="sidebar-footer">
          <button
            type="button"
            className="account-button"
            aria-label="Account settings"
            title="Account settings · Profile, API key, and assistant preferences"
            onClick={() => setSettingsModal(true)}
          >
            <span className="user-avatar">
              {session.user.name?.[0]?.toUpperCase() || 'U'}
            </span>
            <span className="account-summary">
              <span className="user-name">{session.user.name}</span>
              <span className="account-hint">Profile &amp; API key</span>
            </span>
          </button>
          <div className="sidebar-footer-actions">
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
              disabled={loggingOut}
              onClick={() => navigate(logout)}
            >
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </aside>
      {sidebarOpen && mobileLayout && (
        <button
          className="sidebar-backdrop"
          aria-label="Close project sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <main
        className="workbench"
        inert={toolsOpen && editorHidden}
        aria-hidden={toolsOpen && editorHidden}
      >
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
            {projectCanEdit &&
              project?.status === 'ready' &&
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
            {project && !singleFileMode && projectAdmin && (
              <ToolbarAction
                label="Share"
                icon={<Icon name="external" size={15} />}
                onClick={() => setSharingTarget(project)}
                help="Invite editors or viewers to this project. Your chats and provider settings stay private."
              />
            )}
            {project?.accessRole && (
              <span className="tag">
                {projectAdmin ? 'Admin' : projectCanEdit ? 'Editor' : 'Viewer'}
              </span>
            )}
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
            {projectCanEdit && project?.status === 'ready' && (
              <ToolbarAction
                label="Terminal"
                icon={<Icon name="terminal" size={15} />}
                pressed={terminalOpen}
                disabled={startingTerminal}
                onClick={() => {
                  if (terminalOpen) closeTerminal()
                  else void openTerminal()
                }}
                help="Run commands in your private working copy. File changes sync with conflict checks. Terminal Git history stays private; use Source control to publish project history."
              />
            )}
            {projectCanEdit &&
              project?.status === 'ready' &&
              !singleFileMode && (
                <ToolbarAction
                  label="Refresh setup"
                  icon={<Icon name="refresh" size={14} />}
                  onClick={retryPrepare}
                  disabled={saving || !!(job && !terminalJob(job))}
                  help={
                    <>
                      Recheck the project’s Lean environment, reuse valid
                      compiled caches, and prepare missing libraries. If setup
                      still fails, Lemex repairs it automatically when enabled.
                      Your files and pinned versions are preserved. Stop active
                      checks and chats, and close the terminal first.
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
          <div className="workspace-search-row">
            <SearchPanel
              projectId={project?.status === 'ready' ? project.id : undefined}
              onOpenSource={setLibrarySource}
            />
            <ToolbarAction
              className="workspace-docs-action"
              label="Lean docs"
              icon={<Icon name="book" size={15} />}
              onClick={() => {
                setBooksMounted(true)
                setBooksOpen((value) => !value)
              }}
              pressed={booksOpen}
              help="Browse and search the local Lean books alongside your code. Use Ask Lemex to add the current chapter or selected passage to your message."
            />
          </div>
        </header>
        {projectId && (
          <TerminalRecoveries
            key={`${session.user.id}:${projectId}`}
            projectId={projectId}
            active={terminalOpen && terminalActive}
            refreshKey={`${terminalRecoveryVersion}:${project?.accessRole || (project ? 'admin' : 'revoked')}`}
          />
        )}
        {projectCanEdit &&
          project?.status === 'ready' &&
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
        {singleFileMode && !singleFileView && (
          <div className="workspace-alert">
            <span>
              This playground has additional files. They share its terminal
              workspace. Use Convert to project for empty folders and multi-file
              Lemex requests.
            </span>
          </div>
        )}
        {autosave.issue && dirty && (
          <div className="workspace-alert autosave-alert" role="status">
            <span>{autosave.issue.message}</span>
            <button
              className="button small secondary"
              disabled={
                saving || authRequired || !!reloadTarget || !!pendingAction
              }
              onClick={autosave.retry}
            >
              Retry save
            </button>
          </div>
        )}
        {agentPendingFile &&
          file?.path === agentPendingFile &&
          !file.unavailable && (
            <div className="workspace-alert live-edit-alert" role="status">
              <span>
                The saved file changed outside this editor. Your unsaved edits
                are preserved in this editor.
              </span>
              <button
                className="button small secondary"
                onClick={() =>
                  projectId &&
                  navigate(async () => {
                    await openFile(
                      projectId,
                      agentPendingFile,
                      undefined,
                      undefined,
                      {
                        reload: true,
                      },
                    )
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
            {canRestoreLastTrash ? (
              <>
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
              </>
            ) : (
              <span>Ask a project Admin to restore this item from Trash.</span>
            )}
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
        {startupError && (
          <div className="workspace-alert" role="alert">
            <span>Could not refresh your workspace. {startupError}</span>
            <button
              className="button small secondary"
              disabled={sessionRefreshing}
              onClick={() => void loadSession()}
            >
              {sessionRefreshing ? 'Refreshing…' : 'Retry workspace refresh'}
            </button>
          </div>
        )}
        {invitationNotice}
        <StorageStatus
          key={session.user.id}
          initial={session.storage}
          enabled={!authRequired}
        />
        {project?.legacyRecoveryReviewAvailable &&
          !project.fileRecoveryRequired &&
          (!project.accessRole || project.accessRole === 'admin') && (
            <LegacyRecoveryNotice
              key={`${session.user.id}:${project.id}`}
              project={project}
              onRecovered={(value) => {
                if (!bufferStore.isCurrent(scope) || value.id !== project.id)
                  return
                setProjects((previous) =>
                  previous.map((item) => (item.id === value.id ? value : item)),
                )
              }}
            />
          )}
        {collaboration.issue && project && (
          <div className="workspace-alert draft-protection-alert" role="status">
            <span>{collaboration.issue}</span>
            <DraftDownloads
              files={dirtyFiles.filter((file) => !file.unavailable)}
            />
          </div>
        )}
        <DetachedDraftNotice
          files={detachedFiles}
          canRecover={projectCanEdit && !saving && !singleFileMode}
          onRecover={(path) =>
            setRecoveryTarget({ path, scope, userId: session.user.id })
          }
        />
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
        {projectId && !project && (
          <div
            className="workspace-alert revoked-access-notice draft-protection-alert"
            role="status"
          >
            <span>
              Your access to this project has ended. Any drafts are kept in this
              tab. Download them before opening another project.
            </span>
            <DraftDownloads files={dirtyFiles} />
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
        ) : project.fileRecoveryRequired ? (
          <ProjectFileRecovery
            key={project.id}
            project={project}
            drafts={dirtyFiles}
            onRecovered={(value) => {
              if (!bufferStore.isCurrent(scope) || value.id !== project.id)
                return
              setProjects((previous) =>
                previous.map((item) => (item.id === value.id ? value : item)),
              )
            }}
          />
        ) : project.status === 'needs-setup' && !projectCanEdit ? (
          <div className="preparation-state">
            <h1>Project setup is pending</h1>
            <p>An editor needs to choose this project’s Lean environment.</p>
          </div>
        ) : project.status === 'needs-setup' ? (
          <ImportedProjectSetup
            key={project.id}
            project={project}
            templates={session.templates}
            onConfigured={(value) =>
              setProjects((previous) =>
                previous.map((item) => (item.id === value.id ? value : item)),
              )
            }
          />
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
                {projectCanEdit && (
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
                )}
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
                {projectCanEdit && (
                  <button className="button primary" onClick={retryPrepare}>
                    <Icon name="refresh" size={16} />
                    {singleFileMode ? 'Retry opening' : 'Retry setup'}
                  </button>
                )}
              </>
            )}
            {projectCanEdit && !singleFileMode && (
              <ProjectSetupDetails project={project} />
            )}
          </div>
        ) : (
          <>
            {projectCanEdit && project.status === 'error' && (
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
            {projectCanEdit && !singleFileMode && (
              <ProjectSetupPanel project={project} />
            )}
            <div className="file-toolbar">
              <div className="file-tab">
                <Icon name="file" size={15} />
                <span title={file?.path}>{file?.path || 'Choose a file'}</span>
                {file?.readOnly && <span className="tag">Read only</span>}
                {file && collaboration.joining(file.path) && (
                  <span className="tag">Joining live editing…</span>
                )}
                {dirty && (
                  <span
                    className="dirty-dot"
                    aria-label="Unsaved changes"
                    title="Autosave pending"
                  />
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
                    {(!file || file.path === 'Main.lean') && (
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
                    )}
                    <button
                      className="button small subtle"
                      disabled={
                        !projectCanEdit ||
                        project.status === 'preparing' ||
                        convertingSingleFile
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
                  disabled={
                    !projectCanEdit ||
                    !saveableFiles.length ||
                    saving ||
                    opening ||
                    file?.readOnly
                  }
                  title="Autosave is enabled. Save now with Ctrl+S or ⌘S."
                >
                  <Icon name="save" size={14} />
                  {saving
                    ? 'Saving…'
                    : saveableFiles.length > 1
                      ? `Save all (${saveableFiles.length})`
                      : 'Save'}
                </button>
                {file && !file.readOnly && (
                  <button
                    className="button small subtle"
                    disabled={saving || opening}
                    onClick={() => setReloadTarget(file.path)}
                  >
                    Reload file
                  </button>
                )}
                <CheckControls
                  onCheck={() => void check()}
                  onStop={() => void stopCheck()}
                  disabled={
                    !projectCanEdit ||
                    project.status !== 'ready' ||
                    project.needsPreparation ||
                    !file?.path.endsWith('.lean') ||
                    file.unavailable ||
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
              ref={setTexWorkspaceElement}
              className={`file-reading-workspace ${readingFile ? 'reading' : ''} ${texVisible ? 'tex-reading' : ''} ${texVisible && texStacked ? 'tex-stacked' : ''}`}
              style={
                { '--tex-source-size': `${texSourceSize}%` } as CSSProperties
              }
            >
              {project.status === 'ready' ? (
                <LeanWorkspace
                  key={`editor:${project.id}`}
                  projectId={project.id}
                  files={files}
                  file={pdfPreview ? null : file}
                  joining={!!file && collaboration.joining(file.path)}
                  buffers={buffers}
                  bufferDiscardVersion={discardVersion}
                  bufferSaveVersion={saveVersion}
                  editorImportsVersion={project.editorImportsVersion}
                  savedPaths={savedPaths}
                  bufferRemoveVersion={removeVersion}
                  removedPaths={removedPaths}
                  onRenameSources={(sources) => {
                    requireScope(scope)
                    bufferStore.register(sources)
                  }}
                  onCollaborativeUndo={collaboration.undo}
                  onCollaborativeRedo={collaboration.redo}
                  theme={theme}
                  showInfoview={showInfoview && !!file?.path.endsWith('.lean')}
                  goalsSize={goalsSize}
                  onGoalsSizeChange={setGoalsSize}
                  revealTarget={revealProof || undefined}
                  revealPosition={revealPosition}
                  onProofStateChange={acceptEditorProof}
                  focusEditorRequest={focusEditorRequest}
                  onFocusEditorHandled={(id) =>
                    setFocusEditorRequest((current) =>
                      current?.id === id ? null : current,
                    )
                  }
                  onFocusProof={(target, mode) => {
                    if (!bufferStore.isCurrent(scope)) return
                    setProofFocus({
                      id: ++proofRequestId.current,
                      projectId: project.id,
                      target,
                      mode,
                    })
                    setToolsOpen(true)
                    setSidebarOpen(false)
                  }}
                  onState={(state) => {
                    if (bufferStore.isCurrent(scope)) setLeanState(state)
                  }}
                  onChange={(path, content) => {
                    if (bufferStore.isCurrent(scope))
                      bufferStore.change(path, content)
                  }}
                  onOpenFile={(path, line, column) => {
                    if (!bufferStore.isCurrent(scope)) return
                    const action = () =>
                      openFile(project.id, path, line, column)
                    if (bufferStore.getSnapshot().buffers.has(path))
                      void action().catch((error) => setError(errorText(error)))
                    else navigate(action, '', true)
                  }}
                  onOpenLibrary={(source) => {
                    if (bufferStore.isCurrent(scope)) setLibrarySource(source)
                  }}
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
              {texVisible && (
                <ResizeHandle
                  label="Resize LaTeX source and PDF"
                  orientation={texStacked ? 'horizontal' : 'vertical'}
                  value={texSourceSize}
                  min={20}
                  max={80}
                  onChange={setTexSourceSize}
                  onReset={() => setTexSourceSize(50)}
                  pixelsPerUnit={() =>
                    (texStacked
                      ? texWorkspaceSize.height
                      : texWorkspaceSize.width) / 100
                  }
                  unit="percent"
                  className="tex-resize-handle"
                />
              )}
              {texFiles.length > 0 && (
                <TexPanel
                  key={`tex:${project.id}`}
                  projectId={project.id}
                  files={texFiles}
                  currentPath={file?.path}
                  visible={texVisible}
                  buffers={buffers}
                  saving={saving}
                  saveVersion={saveVersion}
                  savedPaths={savedPaths}
                  save={saveWorkspace}
                  onOpenFile={(path, line) => {
                    if (!bufferStore.isCurrent(scope)) return
                    const action = () => openFile(project.id, path, line)
                    if (bufferStore.getSnapshot().buffers.has(path))
                      void action().catch((error) => setError(errorText(error)))
                    else navigate(action, '', true)
                  }}
                />
              )}
              {pdfPreview && file ? (
                <PdfFileViewer
                  key={`pdf:${project.id}:${file.path}:${file.generation}`}
                  projectId={project.id}
                  path={file.path}
                />
              ) : readingFile && file ? (
                <MarkdownFilePreview
                  key={`markdown:${project.id}:${file.path}`}
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
                    {job.checkMethod === 'lake-check' && (
                      <p className="field-help">
                        Builds the default targets and independently checks
                        every project declaration and its full dependency chain
                        with Lean’s kernel. Unused declarations from imported
                        libraries are excluded. A selected file outside the
                        default targets also receives a compiler check.
                      </p>
                    )}
                    {job.checkMethod === 'lake-build' && (
                      <p className="field-help">
                        Uses the project’s pinned Lean compiler. This check does
                        not include an independent project kernel replay.
                      </p>
                    )}
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
        {terminalOpen && project && (
          <TerminalPanel
            key={`${session.user.id}:${project.id}`}
            projectId={project.id}
            projectName={project.name}
            needsPreparation={project.status !== 'ready'}
            theme={theme}
            beforeConnect={saveCompletely}
            onClose={closeTerminal}
            onOpeningChange={(openingId) => {
              if (bufferStore.isCurrent(scope))
                terminalOpening.current = { projectId: project.id, openingId }
            }}
            onStateChange={(active) => {
              if (!bufferStore.isCurrent(scope)) return
              setTerminalActive(active)
              setTerminalRecoveryVersion((value) => value + 1)
            }}
          />
        )}
        {booksMounted && (
          <BooksPanel
            open={booksOpen}
            canAsk={projectCanEdit && project?.status === 'ready'}
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
              : project?.status === 'needs-setup'
                ? 'Choose a Lean environment'
                : project
                  ? project.status
                  : 'Ready to open a project'}
          </span>
          <span className="statusbar-notice" role="status">
            {saving
              ? 'Saving…'
              : readOnlyDrafts
                ? 'Unsaved drafts · download to keep'
                : dirty
                  ? autosave.issue
                    ? autosave.issue.retrying
                      ? 'Waiting to save'
                      : 'Autosave paused'
                    : 'Autosave pending…'
                  : notice || (file ? 'All changes saved' : '')}
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
        {!mobileLayout && toolsOpen && !editorHidden && (
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
            type="button"
            className="button small subtle assistant-editor-toggle"
            onClick={() => setEditorHidden((value) => !value)}
            aria-pressed={editorHidden}
          >
            {editorHidden ? 'Show editor' : 'Hide editor'}
          </button>
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
                onOpenSettings={() => setSettingsModal(true)}
                key={`${session.user.id}:${project.id}`}
                projectId={project.id}
                file={pdfPreview || file?.unavailable ? undefined : file?.path}
                currentFile={file?.unavailable ? undefined : file?.path}
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
                canRun={projectCanEdit}
                session={session}
                onModelsUpdated={(access) =>
                  setSession((current) =>
                    current?.user.id === session.user.id
                      ? { ...current, ...access }
                      : current,
                  )
                }
                dirty={dirty}
                dirtyFileCount={dirtyFiles.length}
                beforeRun={saveWorkspace}
                beforeApply={async () => {
                  requireScope(scope)
                  await beforeApply()
                }}
                onDiscard={async () => {
                  requireScope(scope)
                  await discardUnsavedEdits()
                }}
                onApplied={async () => {
                  if (bufferStore.isCurrent(scope)) await refreshAfterApply()
                }}
                onFilesUpdated={(paths) =>
                  refreshLiveFiles(paths, 'agent', scope)
                }
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
                Active checks, Lemex runs, terminals, and project setup will
                stop automatically before the item moves to Trash.
              </p>
            )}
            {dirty &&
              deleteTarget.projectId === projectId &&
              dirtyFiles.some(
                (buffer) =>
                  deleteTarget.kind === 'project' ||
                  buffer.path === deleteTarget.path ||
                  buffer.path.startsWith(deleteTarget.path + '/'),
              ) && (
                <p className="review-note">
                  Save or discard unsaved edits in this item before moving it to
                  Trash. Edits in other files are kept.
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
            <button
              className="button danger"
              disabled={deleteBusy}
              onClick={() => void deleteItem()}
            >
              {deleteBusy
                ? deleteTarget.kind === 'chat'
                  ? 'Moving…'
                  : 'Stopping and moving…'
                : 'Move to Trash'}
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
      {sharingTarget &&
        (!sharingTarget.accessRole || sharingTarget.accessRole === 'admin') && (
          <ProjectSharingDialog
            key={sharingTarget.id}
            project={sharingTarget}
            currentUserId={session.user.id}
            onChanged={async () => {
              await loadProjects()
            }}
            onClose={() => setSharingTarget(null)}
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
      {uploadProjectId && uploadProjectId === projectId && (
        <UploadModal
          key={uploadProjectId}
          projectId={uploadProjectId}
          onClose={() => setUploadProjectId(null)}
          onUploaded={async () => {
            if (!bufferStore.isCurrent(scope)) return
            const updated = await loadProjects()
            if (!bufferStore.isCurrent(scope)) return
            if (
              updated.find((item) => item.id === uploadProjectId)?.status ===
              'ready'
            )
              await loadFiles(uploadProjectId)
            if (bufferStore.isCurrent(scope)) setNotice('Local files uploaded')
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
          user={session.user}
          onProfileSaved={acceptProfile}
          onProviderSaved={() => {
            void loadSession()
          }}
          onClose={() => setSettingsModal(false)}
          onSaved={() => setNotice('Assistant settings saved')}
        />
      )}
      {gitConnectionsOpen && (
        <GitConnectionsDialog onClose={() => setGitConnectionsOpen(false)} />
      )}
      {gitOpen && project && projectCanEdit && (
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
      {reloadTarget && (
        <Dialog
          title="Reload saved file"
          busy={reloadBusy}
          onClose={() => {
            if (!reloadBusy) setReloadTarget(null)
          }}
        >
          <p>
            Discard unsaved changes in {reloadTarget} and reload its saved
            contents? Edits in other files are kept.
          </p>
          <footer className="dialog-actions">
            <button
              className="button secondary"
              disabled={reloadBusy}
              onClick={() => setReloadTarget(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={reloadBusy}
              onClick={() => void reloadSavedFile(reloadTarget)}
            >
              Reload this file
            </button>
          </footer>
        </Dialog>
      )}
      {recoveryTarget &&
        project &&
        recoveryTarget.userId === session.user.id &&
        bufferStore.isCurrent(recoveryTarget.scope) && (
          <CreateEntryDialog
            key={`${project.id}:${recoveryTarget.path}`}
            kind="file"
            projectName={project.name}
            presetProject={!!project.preset}
            folders={folders}
            title="Save draft as a new file"
            actionLabel="Save a copy"
            initialName={(
              recoveryTarget.path.split('/').at(-1) || 'Draft.lean'
            ).replace(/(\.[^.]*)?$/, '-recovered$1')}
            onCreate={recoverDraft}
            onClose={() => setRecoveryTarget(null)}
          />
        )}
      {draftNavigationDialog}
      {newEntryKind &&
        project &&
        (newEntryKind === 'file' || !singleFileMode) && (
          <CreateEntryDialog
            kind={newEntryKind}
            projectName={project.name}
            presetProject={
              !singleFileMode &&
              !!project.preset &&
              !project.repository &&
              !project.uploaded
            }
            folders={folders}
            onCreate={(path) => createEntry(path, newEntryKind)}
            onClose={() => setNewEntryKind(null)}
          />
        )}
      {project &&
        !singleFileMode &&
        moveRequestCurrent(moveTarget, project.id, session.user.id) && (
          <MoveEntryDialog
            key={`${moveTarget.userId}:${moveTarget.projectId}:${moveTarget.path}`}
            mode={moveTarget.mode}
            subject={moveTarget}
            projectName={project.name}
            folders={folders}
            existing={
              new Set([...files.map((entry) => entry.path), ...folders])
            }
            onSubmit={(to) =>
              moveEntry(moveTarget.projectId, moveTarget.path, to)
            }
            onClose={() => setMoveTarget(null)}
          />
        )}
      {authRequired && <SessionRecovery user={session.user} />}
    </div>
  )
}
