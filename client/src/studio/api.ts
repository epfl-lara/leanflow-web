import type { ProofTarget } from './proofTarget'
import type { ReasoningBlock } from '../../../shared/reasoning-timeline.mjs'
export type { ReasoningBlock } from '../../../shared/reasoning-timeline.mjs'
export type RunProofTarget = Omit<ProofTarget, 'source'> & { source?: string }

export interface LeanBook {
  id: string
  title: string
  url: string
  localUrl: string
  available: boolean
  downloadedAt?: string
  leanVersion?: string | null
  pageCount: number
}

export interface BookSearchResult {
  bookId: string
  bookTitle: string
  title: string
  path: string
  url: string
  excerpt: string
}

export interface Preset {
  id: string
  name: string
  description: string
  toolchain?: string
  ready?: boolean
  preparationState?: 'queued' | 'preparing' | 'ready' | 'failed' | 'unavailable'
  versions?: string[]
  playgroundReady?: boolean
  playgroundState?: PlaygroundPreparationState
}

export type PlaygroundPreparationState =
  | 'ready'
  | 'verifying'
  | 'failed'
  | 'unavailable'

export interface Account {
  id: string
  name: string
  role: 'owner' | 'admin' | 'user'
}

export interface ProviderStatus {
  configured: boolean
  updatedAt?: string | null
  provider?: 'rcp' | 'custom'
  baseUrl?: string
  defaultBaseUrl?: string
}

export interface Session {
  user: Account
  eventTransport?: 'sse' | 'poll'
  templates: Preset[]
  models: {
    id: string
    name: string
    reasoningEfforts?: { id: string; description?: string }[]
    defaultReasoningEffort?: string | null
  }[]
  defaultModel?: string | null
  savedModels?: string[]
  modelsUpdatedAt?: string | null
  runtime?: Record<string, unknown>
  capacity?: {
    workers: number
    workerQueue: number
    editors: number
    editorsPerProject: number
    terminals: number
    terminalsPerProject: number
    agents: number
    agentQueue: number
    searches: number
    sourceRequests: number
    sourceRequestsPerUser: number
    smallSourceRequests: number
    smallSourceRequestsPerUser: number
    setupBuildTimeoutMs: number
    workerCpus: number
    workerMemory: string
  }
  lemex?: {
    revision?: string
    version?: string
    configured?: boolean
    modelError?: string | null
    [key: string]: unknown
  }
}

export interface ModelAccess {
  providerId?: string
  isRcp?: boolean
  models: Session['models']
  defaultModel: string | null
  savedModels: string[]
  modelsUpdatedAt?: string | null
}

export interface Project {
  id: string
  kind?: 'project' | 'single-file'
  protected?: boolean
  name: string
  status: 'preparing' | 'needs-setup' | 'ready' | 'error'
  needsPreparation?: boolean
  toolchain?: string
  preset?: string
  libraries?: string[]
  repository?: string
  repositoryAuthenticationRequired?: boolean
  importWarning?: string
  revision?: string
  publishingEnabled?: boolean
  workingBranch?: string
  publishingBaseBranch?: string
  publishingWarning?: string
  error?: string
  buildWarning?: string
  dependencyWarning?: string
  setupStartedAt?: string
  setupEventAfter?: number
  setupBuildStatus?: 'passed' | 'warnings' | 'reused'
  editorImportsVersion?: number
  sourceRevision?: string
  log?: string
  subdirectory?: string
  uploaded?: boolean
  autoRepair?: boolean
  setupPhase?:
    | 'reading-project'
    | 'cloning-repository'
    | 'selecting-revision'
    | 'preparing-lean'
    | 'preparing-dependencies'
    | 'building-project'
    | 'checking-environment'
    | 'repairing-setup'
    | 'waiting-for-repair'
    | 'waiting-for-rcp'
    | 'validating-repair'
  setupRepair?: {
    id: string
    status: 'running' | 'completed' | 'failed'
    message: string
    startedAt?: string
    activity?: string
    changes?: string[]
  }
}

export interface TrashDeleteResult {
  deletedTrashIds: string[]
  failures: { trashId: string; name: string; error: string }[]
}

export interface TrashItem {
  workspaceKind?: 'single-file' | 'project'
  chatId?: string
  trashId: string
  projectId: string
  projectName?: string
  name?: string
  path: string | null
  kind: 'project' | 'file' | 'folder' | 'chat'
  createdAt: string
  sizeBytes?: number | null
  recoverable?: boolean
  deleting?: boolean
}

export interface GitInfo {
  repository: boolean
  branch?: string | null
  revision?: string | null
  head?: string | null
  remoteUrl?: string | null
  publishingEnabled?: boolean
  provider?: GitProvider
  suggestedBranch?: string
  baseBranch?: string | null
  lastPublished?: GitPushResult
  changes?: { status: string; path: string; from?: string }[]
  diff?: string
  commits?: { sha: string; message: string }[]
  mutationBlocked?: boolean
  blockedReason?: string
  reviewToken?: string
  author?: { name: string; email: string }
}

export type GitProvider = 'github' | 'gitlab' | 'other'

export interface GitConnection {
  host: string
  provider: GitProvider
  username: string
  updatedAt: string
}

export interface GitIdentity {
  name: string
  email: string
}

export interface GitConnections {
  connections: GitConnection[]
  identity: GitIdentity
}

export interface GitPushPreview {
  previewId: string
  head: string
  branch: string
  remoteUrl: string
  provider: GitProvider
  baseBranch?: string | null
  commits: { sha: string; message: string }[]
  historyCount: number
  uncommittedCount: number
  review?: GitPushResult['review']
}

export interface GitPushResult {
  pushed: boolean
  head: string
  branch: string
  remoteUrl: string
  provider?: GitProvider
  baseBranch?: string | null
  warning?: string
  review?: {
    kind: 'pull-request' | 'merge-request'
    label: string
    url: string
  }
}

export interface FileEntry {
  path: string
  size?: number
  readOnly?: boolean
}
export interface OpenFile {
  path: string
  content: string
  savedContent: string
  hash: string
  generation: number
  readOnly?: boolean
  line?: number
  column?: number
  preview?: 'pdf'
}
export interface TexDiagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
  path?: string
  line?: number
}
export interface TexBuild {
  id: string
  projectId: string
  rootFile: string
  engine: 'pdflatex'
  origin?: 'agent' | 'user'
  cleanupFailed?: boolean
  status: string
  sourceRevision: string | null
  workspaceRevision: string | null
  createdAt: string
  updatedAt: string
  diagnostics: TexDiagnostic[]
  log: string
  textAvailable: boolean
  textTruncated: boolean
  pageCount?: number
  error?: string
  pdf?: { url: string; revision: string; filename: string }
}
export interface TexStatus {
  available: boolean
  error?: string
  engines: string[]
  workspaceRevision: string | null
  build: TexBuild | null
  activeBuild?: TexBuild | null
  lastSuccessful: TexBuild | null
}
export interface LibrarySource {
  module: string
  path: string
  toolchain: string | null
  content: string
  readOnly: true
  line: number | null
  endLine: number | null
}
export interface RunEvent {
  seq: number
  type: string
  data: Record<string, unknown>
}
export type { ToolStep } from '../../../shared/tool-activity.mjs'
export interface Change {
  path: string
  before: string
  after: string
  beforeHash?: string
}
export interface Run {
  id: string
  projectId?: string
  status: string
  mode?: string
  prompt?: string
  createdAt?: string
  chatId?: string | null
  files?: string[]
  currentFile?: string | null
  proofTarget?: RunProofTarget
  followups?: RunFollowup[]
  changeCount?: number
  liveChangeCount?: number
  changePaths?: string[]
  liveChangePaths?: string[]
  reasoningChars?: number
  reasoningSummaryChars?: number
  logChars?: number
  progress?: { label: string; detail?: string; updatedAt?: string }
  message?: string
  messageBaseOffset?: number
  messageTruncated?: boolean
  reasoning?: string
  reasoningBlocks?: ReasoningBlock[]
  reasoningHistoryAvailable?: boolean
  reasoningHistoryCursor?: number
  reasoningBaseOffset?: number
  reasoningSummaryBaseOffset?: number
  reasoningTruncated?: boolean
  reasoningSummary?: string
  log?: string
  eventCursor?: number
  liveEdits?: boolean
  liveChanges?: Change[]
  liveRevision?: number
  liveUndone?: boolean
  liveEditConflict?: string
  maxSeconds?: number | null
  error?: string
  events?: RunEvent[]
  toolActivity?: import('../../../shared/tool-activity.mjs').ToolStep[]
  toolActivityTruncated?: boolean
  changes?: Change[]
  verification?: unknown
  usage?: unknown
  appliedAt?: string
  [key: string]: unknown
}

export interface ReasoningPage {
  reasoning: string
  reasoningSummary: string
  nextOffset: number | null
}

// Polls and steering acknowledge a run without sending full proof previews.
export interface RunReceipt extends Run {
  changes?: never
  liveChanges?: never
}

export interface RunFollowup {
  id: string
  text: string
  status: 'pending' | 'accepted' | 'failed'
  createdAt: string
  messageOffset: number
  error?: string
  files?: string[]
  currentFile?: string | null
  currentFileUnavailable?: boolean
  proofTarget?: RunProofTarget
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export const SESSION_EXPIRED_EVENT = 'leanflow:session-expired'
export const SESSION_RESTORED_EVENT = 'leanflow:session-restored'
let sessionRevision = 0

// A late response from the expired session must not reopen recovery after login.
export function markSessionRestored() {
  sessionRevision += 1
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event(SESSION_RESTORED_EVENT))
}

async function request(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const requestSessionRevision = sessionRevision
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  if (
    response.status === 401 &&
    path.split('?')[0] !== '/api/login' &&
    requestSessionRevision === sessionRevision &&
    typeof window !== 'undefined'
  )
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
  return response
}

async function responseData(response: Response): Promise<unknown> {
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    throw new ApiError(
      response.ok
        ? 'The server returned an unreadable response.'
        : `Request failed (${response.status}).`,
      response.status,
    )
  }
  if (!response.ok) {
    const error =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof data.error === 'string'
        ? data.error
        : data &&
            typeof data === 'object' &&
            'message' in data &&
            typeof data.message === 'string'
          ? data.message
          : `Request failed (${response.status}).`
    throw new ApiError(error, response.status)
  }
  return data
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const data = await responseData(await request(path, options))
  return data as T
}

export async function apiPdf(path: string, signal: AbortSignal): Promise<Blob> {
  const response = await request(path, { signal })
  if (!response.ok) await responseData(response)
  if (
    response.headers.get('content-type')?.split(';')[0].trim() !==
    'application/pdf'
  )
    throw new Error(
      'This file could not be opened as a PDF. Choose a PDF document.',
    )
  return response.blob()
}

export async function apiDownload(
  path: string,
): Promise<{ blob: Blob; filename: string | null }> {
  const response = await request(path)
  if (!response.ok) await responseData(response)
  const disposition = response.headers.get('content-disposition') || ''
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const quoted = /filename="((?:[^"\\]|\\.)*)"/i.exec(disposition)?.[1]
  let filename = quoted?.replace(/\\(.)/g, '$1') || null
  if (encoded) {
    try {
      filename = decodeURIComponent(encoded)
    } catch {
      // A malformed filename must not prevent downloading the file itself.
    }
  }
  filename =
    filename
      ?.split(/[\\/]/)
      .at(-1)
      ?.replace(/[\x00-\x1f\x7f]/g, '') || null
  return { blob: await response.blob(), filename }
}

export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) })
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
export const runIsActive = (run?: Run | null) =>
  !!run &&
  [
    'queued',
    'starting',
    'running',
    'verifying',
    'stopping',
    'preparing',
  ].includes(run.status)
export const pretty = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)
