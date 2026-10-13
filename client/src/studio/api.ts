export interface Preset {
  id: string
  name: string
  description: string
  toolchain?: string
  ready?: boolean
}

export interface Session {
  user: { id: string; name: string }
  templates: Preset[]
  models: { id: string; name: string }[]
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
  name: string
  status: 'preparing' | 'ready' | 'error'
  toolchain?: string
  preset?: string
  repository?: string
  revision?: string
  error?: string
  log?: string
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
  message?: string
  reasoning?: string
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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
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
