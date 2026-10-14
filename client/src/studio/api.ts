import type { ProofTarget } from './proofTarget'
import type { ReasoningBlock } from '../../../shared/reasoning-timeline.mjs'
export type { ReasoningBlock } from '../../../shared/reasoning-timeline.mjs'
export type RunProofTarget = Omit<ProofTarget, 'source'> & { source?: string }

export interface Preset {
  id: string
  name: string
  description: string
  toolchain?: string
  ready?: boolean
  playgroundReady?: boolean
  playgroundState?: PlaygroundPreparationState
}

export type PlaygroundPreparationState =
  | 'ready'
  | 'verifying'
  | 'failed'
  | 'unavailable'

export interface Session {
  user: { id: string; name: string }
  templates: Preset[]
  models: {
    id: string
    name: string
    reasoningEfforts?: { id: string; description?: string }[]
    defaultReasoningEffort?: string | null
  }[]
  defaultModel?: string
  runtime?: Record<string, unknown>
  lemex?: {
    revision?: string
    version?: string
    available?: boolean
    [key: string]: unknown
  }
}

export interface Project {
  id: string
  kind?: 'project' | 'single-file'
  protected?: boolean
  name: string
  status: 'preparing' | 'ready' | 'error'
  needsPreparation?: boolean
  toolchain?: string
  preset?: string
  libraries?: string[]
  repository?: string
  revision?: string
  error?: string
  log?: string
  subdirectory?: string
  uploaded?: boolean
  autoRepair?: boolean
  setupRepair?: {
    id: string
    status: 'running' | 'completed' | 'failed'
    message: string
    changes?: string[]
  }
}

export interface GitInfo {
  repository: boolean
  branch?: string | null
  revision?: string | null
  head?: string | null
  remoteUrl?: string | null
  changes?: { status: string; path: string; from?: string }[]
  diff?: string
  commits?: { sha: string; message: string }[]
  mutationBlocked?: boolean
  blockedReason?: string
  reviewToken?: string
  author?: { name: string; email: string }
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
  proofTarget?: RunProofTarget
  followups?: RunFollowup[]
  changeCount?: number
  liveChangeCount?: number
  reasoningChars?: number
  reasoningSummaryChars?: number
  logChars?: number
  progress?: { label: string; detail?: string; updatedAt?: string }
  message?: string
  messageBaseOffset?: number
  messageTruncated?: boolean
  reasoning?: string
  reasoningBlocks?: ReasoningBlock[]
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
  changes?: Change[]
  verification?: unknown
  usage?: unknown
  appliedAt?: string
  [key: string]: unknown
}

export interface RunFollowup {
  id: string
  text: string
  status: 'pending' | 'accepted' | 'failed'
  createdAt: string
  messageOffset: number
  error?: string
  files?: string[]
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

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
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
    const error = data as { error?: string; message?: string } | undefined
    throw new ApiError(
      error?.error || error?.message || `Request failed (${response.status}).`,
      response.status,
    )
  }
  return data as T
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
