import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from 'react'
import {
  api,
  ApiError,
  errorText,
  post,
  pretty,
  type FileEntry,
  type GitInfo,
  type OpenFile,
  type Project,
  type Session,
} from './api'
import { AssistantPanel } from './AssistantPanel'
import { Dialog } from './Dialog'
import { Icon } from './Icons'
import { LeanWorkspace } from './LeanWorkspace'
import { ProjectModal } from './ProjectModal'
import { UploadModal } from './UploadFiles'
import { SearchPanel } from './SearchPanel'
import { SettingsModal } from './SettingsModal'
import { FileBrowser } from './FileBrowser'
import { GitModal } from './GitModal'
import { ResizeHandle } from './ResizeHandle'
import {
  DEFAULT_LAYOUT,
  clamp,
  useElementSize,
  useMediaQuery,
  useStoredSize,
} from './layout'
import './studio.css'

interface TrashItem {
  chatId?: string
  trashId: string
  projectId: string
  projectName?: string
  name?: string
  path: string | null
  kind: 'project' | 'file' | 'folder' | 'chat'
  createdAt: string
}
interface DeleteTarget {
  chatId?: string
  projectId: string
  name: string
  path?: string
  kind: 'project' | 'file' | 'folder' | 'chat'
}

interface Job {
  id: string
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
      <a
        className="brand-credit"
        href="https://lara.epfl.ch/"
        target="_blank"
        rel="noreferrer"
      >
        Developed by EPFL LARA
      </a>
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
      onSession(await api<Session>('/api/session'))
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
  const studioSize = useElementSize(studioElement)
  const navigationSize = useElementSize(navigationElement)
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
  const [session, setSession] = useState<Session | null>(null)
  const [authRequired, setAuthRequired] = useState(false)
  const [startupError, setStartupError] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [files, setFiles] = useState<FileEntry[]>([])
  const [file, setFile] = useState<OpenFile | null>(null)
  const [git, setGit] = useState<GitInfo | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [agentPendingFile, setAgentPendingFile] = useState<string | null>(null)
  const [projectModal, setProjectModal] = useState(false)
  const [uploadModal, setUploadModal] = useState(false)
  const [stoppingSetup, setStoppingSetup] = useState(false)
  const [setupDetails, setSetupDetails] = useState(false)
  const [settingsModal, setSettingsModal] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [lastTrash, setLastTrash] = useState<TrashItem | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])
  const [trashError, setTrashError] = useState('')
  const [restoring, setRestoring] = useState<string | null>(null)
  const [gitOpen, setGitOpen] = useState(false)
  const [newFileModal, setNewFileModal] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [newFileError, setNewFileError] = useState('')
  const [saving, setSaving] = useState(false)
  const [opening, setOpening] = useState(false)
  const [fileFilter, setFileFilter] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toolTab, setToolTab] = useState<'assistant' | 'search'>('assistant')
  const [toolsOpen, setToolsOpen] = useState(() => window.innerWidth > 1000)
  const [showInfoview, setShowInfoview] = useState(true)
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
  const fileRef = useRef(file)
  const filesRef = useRef(files)
  const projectIdRef = useRef(projectId)
  const openRequest = useRef(0)
  const generation = useRef(0)
  const savePromise = useRef<Promise<void> | null>(null)
  fileRef.current = file
  filesRef.current = files
  projectIdRef.current = projectId
  const project = projects.find((item) => item.id === projectId)
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
  const dirty = !!file && file.content !== file.savedContent

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
    document.documentElement.dataset.theme = theme
    localStorage.setItem('lemex-theme', theme)
  }, [theme])

  const loadProjects = useCallback(async () => {
    const value = await api<Project[]>('/api/projects')
    const selected = value.findIndex((item) => item.id === projectIdRef.current)
    if (
      selected >= 0 &&
      (value[selected].status !== 'ready' || value[selected].setupRepair)
    )
      value[selected] = await api<Project>(
        `/api/projects/${encodeURIComponent(value[selected].id)}`,
      )
    setProjects(value)
    return value
  }, [])

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
    const value = await api<FileEntry[]>(
      `/api/projects/${encodeURIComponent(id)}/files`,
    )
    if (projectIdRef.current === id) setFiles(value)
    return value
  }, [])

  const loadGit = useCallback(async (id: string) => {
    try {
      const value = await api<GitInfo>(
        `/api/projects/${encodeURIComponent(id)}/git`,
      )
      if (projectIdRef.current === id) setGit(value)
    } catch {
      if (projectIdRef.current === id) setGit(null)
    }
  }, [])
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
        const value = await api<{
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
    setFiles([])
    setFile(null)
    setGit(null)
    setGitOpen(false)
    setJob(null)
    setFileFilter('')
    setLeanState('')
    ++openRequest.current
    if (!projectId) return
    localStorage.setItem('lemex-project', projectId)
    if (project?.status !== 'ready') return
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
        if (first) void openFile(projectId, first.path)
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error))
      })
    void loadGit(projectId)
    return () => {
      cancelled = true
    }
  }, [projectId, project?.status, loadFiles, loadGit, openFile])

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
        const value = await api<{ content: string; hash: string }>(
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
        void loadGit(id)
      } finally {
        setSaving(false)
        savePromise.current = null
      }
    })()
    savePromise.current = task
    return task
  }, [loadGit])

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
    if (!projectId || !file) return
    setError('')
    try {
      await saveCompletely()
      const value = await post<Job>(
        `/api/projects/${encodeURIComponent(projectId)}/check`,
        { path: file.path },
      )
      setJob(value)
      setJobOpen(true)
    } catch (error) {
      setError(errorText(error))
    }
  }

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
    await loadFiles(projectId)
    if (fileRef.current) await openFile(projectId, fileRef.current.path)
    await loadGit(projectId)
  }

  async function createFile(event: FormEvent) {
    event.preventDefault()
    if (!projectId || !newFileName.trim()) return
    const path = newFileName.trim()
    if (files.some((file) => file.path === path)) {
      setNewFileError('A file with this path already exists.')
      return
    }
    setOpening(true)
    setNewFileError('')
    try {
      await saveCompletely()
      await api(
        `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ content: '', expectedHash: null }),
        },
      )
      await loadFiles(projectId)
      await openFile(projectId, path)
      setNewFileModal(false)
      setNewFileName('')
    } catch (error) {
      setNewFileError(errorText(error))
    } finally {
      setOpening(false)
    }
  }

  const refreshLiveFiles = useCallback(
    async (paths: string[]) => {
      const id = projectIdRef.current
      if (!id) return
      await loadFiles(id)
      void loadGit(id)
      const current = fileRef.current
      if (!current || (paths.length && !paths.includes(current.path))) return
      if (savePromise.current || current.content !== current.savedContent) {
        setAgentPendingFile(current.path)
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
      setNotice('Agent edits updated live')
    },
    [loadFiles, loadGit],
  )

  async function retryPrepare() {
    if (!projectId) return
    try {
      const value = await post<Project>(
        `/api/projects/${encodeURIComponent(projectId)}/prepare`,
      )
      setProjects((previous) =>
        previous.map((item) => (item.id === value.id ? value : item)),
      )
    } catch (error) {
      setError(errorText(error))
    }
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
      const receipt = await post<TrashItem>(
        target.kind === 'chat'
          ? `/api/chats/${encodeURIComponent(target.chatId!)}/trash`
          : `/api/projects/${encodeURIComponent(target.projectId)}/trash`,
        target.path === undefined ? {} : { path: target.path },
      )
      setLastTrash({ ...receipt, name: target.name })
      const active = projectIdRef.current === target.projectId
      if (target.kind === 'chat') {
        window.dispatchEvent(new Event('lemex-chats-changed'))
      } else if (target.kind === 'project') {
        if (active) {
          ++openRequest.current
          setFile(null)
          setFiles([])
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
        const remaining = await loadFiles(target.projectId)
        await loadGit(target.projectId)
        if (removed) {
          const next = remaining.find(
            (item) => !item.readOnly && item.path.endsWith('.lean'),
          )
          if (next) await openFile(target.projectId, next.path)
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
  async function restoreItem(item: TrashItem) {
    if (restoring) return
    setRestoring(item.trashId)
    setTrashError('')
    try {
      await post(`/api/trash/${encodeURIComponent(item.trashId)}/restore`)
      await loadProjects()
      if (item.kind === 'chat')
        window.dispatchEvent(new Event('lemex-chats-changed'))
      else if (item.kind === 'project' && !projectIdRef.current)
        setProjectId(item.projectId)
      else if (projectIdRef.current === item.projectId) {
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
      className={`studio ${toolsOpen ? '' : 'tools-hidden'}`}
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--assistant-width': `${assistantWidth}px`,
          '--files-size': `${filesPercent}%`,
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
                  onClick={() => {
                    setNewFileName('')
                    setNewFileError('')
                    setNewFileModal(true)
                  }}
                  disabled={project?.status !== 'ready'}
                  title="New file"
                  aria-label="New file"
                >
                  <Icon name="plus" size={16} />
                </button>
                <button
                  className="icon-button"
                  onClick={() =>
                    projectId &&
                    void loadFiles(projectId).catch((error) =>
                      setError(errorText(error)),
                    )
                  }
                  disabled={project?.status !== 'ready'}
                  title="Refresh files"
                  aria-label="Refresh files"
                >
                  <Icon name="refresh" size={14} />
                </button>
              </div>
            </div>
            {files.length > 8 && (
              <div className="file-filter">
                <Icon name="search" size={13} />
                <input
                  aria-label="Filter files"
                  value={fileFilter}
                  onChange={(event) => setFileFilter(event.target.value)}
                  placeholder="Find a file…"
                />
              </div>
            )}
            <FileBrowser
              files={files}
              selectedPath={file?.path}
              dirty={dirty}
              disabled={opening || saving}
              filter={fileFilter}
              ready={project?.status === 'ready'}
              onSelect={chooseFile}
              onDelete={(path, kind) =>
                projectId &&
                requestDelete({ projectId, path, name: path, kind })
              }
            />
          </section>
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
          <section className="sidebar-projects-section" aria-label="Projects">
            <details className="sidebar-projects-details" open>
              <summary className="sidebar-section-title">
                <Icon name="chevron" size={13} />
                <span>Projects</span>
              </summary>
              <div className="project-list">
                {projects.map((item) => (
                  <div className="project-row" key={item.id}>
                    <button
                      className={`project-item ${item.id === projectId ? 'selected' : ''}`}
                      aria-current={item.id === projectId ? 'page' : undefined}
                      onClick={() =>
                        navigate(async () => {
                          setProjectId(item.id)
                          setSidebarOpen(false)
                        })
                      }
                      title={item.name}
                      disabled={opening || saving}
                    >
                      <span className={`project-icon ${item.status}`}>
                        <Icon name="folder" size={17} />
                      </span>
                      <span className="project-label">
                        <strong>{item.name}</strong>
                        <span>
                          {item.status === 'preparing'
                            ? 'Preparing dependencies…'
                            : item.status === 'error'
                              ? 'Needs attention'
                              : item.toolchain?.replace(
                                  'leanprover/lean4:',
                                  '',
                                ) || 'Lean project'}
                        </span>
                      </span>
                      {item.status === 'preparing' && (
                        <span className="spinner" />
                      )}
                    </button>
                    <button
                      className="icon-button project-delete"
                      aria-label={`Move project ${item.name} to trash`}
                      title={`Delete project ${item.name}`}
                      disabled={
                        opening || saving || item.status === 'preparing'
                      }
                      onClick={() =>
                        requestDelete({
                          projectId: item.id,
                          name: item.name,
                          kind: 'project',
                        })
                      }
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))}
                {!projects.length && (
                  <p className="sidebar-empty">Your projects appear here.</p>
                )}
              </div>
            </details>
            <button
              className="icon-button sidebar-projects-create"
              onClick={() => setProjectModal(true)}
              title="Import or create project"
              aria-label="Import or create project"
            >
              <Icon name="plus" size={17} />
            </button>
            <button
              className="import-button"
              onClick={() => setProjectModal(true)}
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
        {git && git.repository !== false && project?.status === 'ready' && (
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
              onClick={() => setGitOpen(true)}
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
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close project sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <main className="workbench">
        <header className="workbench-header">
          <button
            className="icon-button mobile-only"
            title="Open sidebar"
            aria-label="Open projects and files"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <div className="workspace-title">
            <Icon name="folder" size={18} />
            <strong>{project?.name || 'Welcome'}</strong>
            {git?.branch && (
              <span className="branch-label">
                <Icon name="git" size={13} />
                {git.branch}
              </span>
            )}
          </div>
          <div className="header-actions">
            <button
              className={`button small ${showInfoview ? 'subtle selected' : 'subtle'}`}
              onClick={() => setShowInfoview((value) => !value)}
              aria-pressed={showInfoview}
            >
              Goals
            </button>
            <button
              className={`button small ${toolsOpen ? 'subtle selected' : 'subtle'}`}
              onClick={() => setToolsOpen((value) => !value)}
              aria-pressed={toolsOpen}
            >
              <Icon name="bot" size={15} />
              Lemex
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
              Lemex updated the saved file. Your unsaved edits are preserved in
              this editor.
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
              Bring a Lean repository, or create a workspace with Mathlib,
              CSLib, or Physlib. Your files and assistant sessions stay with the
              project.
            </p>
            <button
              className="button primary"
              onClick={() => setProjectModal(true)}
            >
              <Icon name="plus" size={17} />
              Import or create project
            </button>
            <div className="welcome-presets">
              {session.templates.map((preset) => (
                <div key={preset.id}>
                  <Icon name="folder" size={18} />
                  <strong>{preset.name}</strong>
                  <p>{preset.description}</p>
                </div>
              ))}
            </div>
          </div>
        ) : project.status !== 'ready' ? (
          <div className="preparation-state">
            {project.status === 'preparing' ? (
              <>
                <span className="spinner large" />
                <h1>Preparing {project.name}</h1>
                <p>
                  Setting up the Lean toolchain and project dependencies. You
                  can return to another project while this runs.
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
                <h1>Project setup needs attention</h1>
                <p className="error-message">
                  {project.error || 'The environment could not be prepared.'}
                </p>
                <button className="button primary" onClick={retryPrepare}>
                  <Icon name="refresh" size={16} />
                  Retry setup
                </button>
              </>
            )}
            {project.setupRepair && (
              <div className="setup-repair-notice" role="status">
                <strong>
                  {project.setupRepair.status === 'running'
                    ? 'Lemex is repairing setup'
                    : project.setupRepair.status === 'completed'
                      ? 'Setup repaired by Lemex'
                      : 'Lemex setup repair needs attention'}
                </strong>
                <p>{project.setupRepair.message}</p>
                {!!project.setupRepair.changes?.length && (
                  <p>Updated: {project.setupRepair.changes.join(', ')}</p>
                )}
              </div>
            )}
            {project.log && (
              <details open={project.status === 'error'}>
                <summary>Setup output</summary>
                <pre className="setup-log">{project.log}</pre>
              </details>
            )}
            {project.repository && (
              <p className="field-help">{project.repository}</p>
            )}
          </div>
        ) : (
          <>
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
                <button
                  className="button small primary"
                  onClick={check}
                  disabled={
                    !file?.path.endsWith('.lean') ||
                    saving ||
                    !!(job && !terminalJob(job))
                  }
                >
                  <Icon name="check" size={14} />
                  {job && !terminalJob(job) ? 'Checking…' : 'Check Lean'}
                </button>
              </div>
            </div>
            <LeanWorkspace
              key={project.id}
              projectId={project.id}
              file={file}
              theme={theme}
              showInfoview={showInfoview}
              goalsSize={goalsSize}
              onGoalsSizeChange={setGoalsSize}
              onState={setLeanState}
              onChange={(path, content) =>
                setFile((current) =>
                  current?.path === path ? { ...current, content } : current,
                )
              }
              onOpenFile={(path, line, column) =>
                navigate(() => openFile(project.id, path, line, column))
              }
            />
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
                  <pre>
                    {job.log ||
                      (job.result
                        ? pretty(job.result)
                        : job.error || 'Waiting for Lean…')}
                  </pre>
                )}
              </section>
            )}
          </>
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
        aria-label="Assistant and search"
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
          <div
            className="tools-tabs"
            role="tablist"
            aria-label="Workspace tools"
          >
            <button
              id="assistant-tab"
              role="tab"
              aria-selected={toolTab === 'assistant'}
              className={toolTab === 'assistant' ? 'selected' : ''}
              onClick={() => setToolTab('assistant')}
            >
              <Icon name="bot" size={16} />
              Assistant
            </button>
            <button
              id="search-tab"
              role="tab"
              aria-selected={toolTab === 'search'}
              className={toolTab === 'search' ? 'selected' : ''}
              onClick={() => setToolTab('search')}
            >
              <Icon name="search" size={15} />
              Search
            </button>
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
        <div
          className="tools-content"
          role="tabpanel"
          aria-labelledby={
            toolTab === 'assistant' ? 'assistant-tab' : 'search-tab'
          }
        >
          <div
            className={
              toolTab === 'assistant' ? 'tool-view' : 'tool-view hidden'
            }
          >
            {project?.status === 'ready' ? (
              <AssistantPanel
                key={project.id}
                projectId={project.id}
                file={file?.path}
                files={files}
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
          <div
            className={toolTab === 'search' ? 'tool-view' : 'tool-view hidden'}
          >
            <SearchPanel
              projectId={project?.status === 'ready' ? project.id : undefined}
            />
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
      {deleteTarget && (
        <Dialog
          title={`Delete ${deleteTarget.kind}?`}
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
            <button
              className="button danger"
              disabled={deleteBusy}
              onClick={() => void deleteItem()}
            >
              {deleteBusy ? 'Moving…' : 'Move to Trash'}
            </button>
          </footer>
        </Dialog>
      )}
      {trashOpen && (
        <Dialog
          title="Trash"
          subtitle="Restore deleted files, folders, or projects. Existing files are never overwritten."
          busy={!!restoring}
          onClose={() => setTrashOpen(false)}
        >
          <div className="trash-list">
            {trashError && (
              <p className="error-message" role="alert">
                {trashError}
              </p>
            )}
            {!trashItems.length && !trashError && (
              <p className="field-help">Trash is empty.</p>
            )}
            {trashItems.map((item) => (
              <div className="trash-item" key={item.trashId}>
                <Icon
                  name={item.kind === 'file' ? 'file' : 'folder'}
                  size={18}
                />
                <div>
                  <strong>
                    {item.name ||
                      item.path ||
                      item.projectName ||
                      'Deleted project'}
                  </strong>
                  <span>
                    {item.kind} · {item.projectName || item.projectId} ·{' '}
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                </div>
                <button
                  className="button small secondary"
                  disabled={!!restoring}
                  onClick={() => void restoreItem(item)}
                >
                  {restoring === item.trashId ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            ))}
          </div>
          <footer className="dialog-actions">
            <button
              className="button secondary"
              disabled={!!restoring}
              onClick={() => setTrashOpen(false)}
            >
              Close
            </button>
          </footer>
        </Dialog>
      )}
      {projectModal && (
        <ProjectModal
          templates={session.templates}
          onClose={() => setProjectModal(false)}
          onCreated={(created) => {
            setProjectModal(false)
            setProjects((previous) => [
              created,
              ...previous.filter((item) => item.id !== created.id),
            ])
            navigate(async () => setProjectId(created.id))
          }}
        />
      )}
      {uploadModal && projectId && (
        <UploadModal
          projectId={projectId}
          onClose={() => setUploadModal(false)}
          onUploaded={async () => {
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
      {gitOpen && project && (
        <GitModal
          key={project.id}
          project={project}
          initialInfo={git}
          dirty={dirty}
          localBlockedReason={
            job && !terminalJob(job)
              ? 'Finish or stop the active Lean check before changing source control.'
              : undefined
          }
          onSave={saveCompletely}
          onUpdated={acceptGit}
          onClose={() => setGitOpen(false)}
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
      {newFileModal && (
        <Dialog
          title="Create a file"
          subtitle="Use a path relative to the project root."
          onClose={() => setNewFileModal(false)}
          busy={opening}
        >
          <form onSubmit={createFile}>
            <label className="field-label" htmlFor="new-file-name">
              File path
            </label>
            <input
              id="new-file-name"
              autoFocus
              placeholder="Main/Extra.lean"
              value={newFileName}
              onChange={(event) => setNewFileName(event.target.value)}
              required
              disabled={opening}
            />
            <p className="field-help">
              Put Lean modules inside your project's library directory. Preset
              projects use Main.
            </p>
            {newFileError && (
              <p className="error-message" role="alert">
                {newFileError}
              </p>
            )}
            <footer className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setNewFileModal(false)}
                disabled={opening}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={opening || !newFileName.trim()}
              >
                {opening ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="plus" size={15} />
                )}
                Create file
              </button>
            </footer>
          </form>
        </Dialog>
      )}
    </div>
  )
}
