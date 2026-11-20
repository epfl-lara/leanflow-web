interface FailureDetails {
  action: string
  code: string
  message: string
}

interface FailureEntry extends FailureDetails {
  id: number
  time: number
  count: number
}

const FAILURE_LOG_LIMIT = 50
const REPEAT_WINDOW_MS = 60_000
const listeners = new Set<() => void>()
const seen = new Set<string>()
let entries: readonly FailureEntry[] = []
let nextId = 0
let enabled = false

export const subscribeToFailures = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const getFailures = () => entries

function publish(next: readonly FailureEntry[]) {
  entries = next
  for (const listener of listeners) listener()
}

export function resetFailureLog(signedIn: boolean) {
  enabled = signedIn
  seen.clear()
  if (entries.length) publish([])
}

// Callers supply fixed descriptions. Job IDs can deduplicate observations,
// but neither IDs nor free-form errors, URLs, and source go into the report.
export function recordFailure(
  { action, code, message }: FailureDetails,
  eventId?: string,
) {
  if (!enabled) return
  if (eventId !== undefined) {
    if (seen.has(eventId)) return
    seen.add(eventId)
    if (seen.size > FAILURE_LOG_LIMIT * 4) {
      const oldest = seen.values().next()
      if (!oldest.done) seen.delete(oldest.value)
    }
  }
  const time = Date.now()
  const repeated = entries.find(
    (entry) =>
      entry.action === action &&
      entry.code === code &&
      entry.message === message &&
      time - entry.time < REPEAT_WINDOW_MS,
  )
  const entry = repeated
    ? { ...repeated, time, count: repeated.count + 1 }
    : { action, code, message, id: ++nextId, time, count: 1 }
  publish(
    [entry, ...entries.filter((item) => item !== repeated)].slice(
      0,
      FAILURE_LOG_LIMIT,
    ),
  )
}

const API_ACTIONS: ReadonlyArray<readonly [RegExp, string, string?]> = [
  [/^\/api\/session\/?$/, 'Open workspace'],
  [/^\/api\/projects\/?$/, 'Load projects', 'Create or import project'],
  [/^\/api\/projects\/[^/]+\/?$/, 'Load project'],
  [/^\/api\/projects\/[^/]+\/file\/?$/, 'Open file', 'Save file'],
  [
    /^\/api\/projects\/[^/]+\/(files|folders)\/?$/,
    'List project files',
    'Update project files',
  ],
  [/^\/api\/projects\/[^/]+\/move\/?$/, 'Move project file'],
  [/^\/api\/projects\/[^/]+\/(prepare|environment)(\/|$)/, 'Project setup'],
  [
    /^\/api\/projects\/[^/]+\/checks?\/?$/,
    'Load Lean checks',
    'Start Lean check',
  ],
  [/^\/api\/jobs\//, 'Read Lean check result', 'Stop Lean check'],
  [
    /^\/api\/projects\/[^/]+\/tex(\/|$)/,
    'Read LaTeX build',
    'Manage LaTeX build',
  ],
  [/^\/api\/projects\/[^/]+\/terminal(\/|$)/, 'Project terminal'],
  [/^\/api\/projects\/[^/]+\/chats\/?$/, 'Load chats', 'Create chat'],
  [/^\/api\/chats\/[^/]+\/runs\/?$/, 'Load Lemex runs', 'Start Lemex run'],
  [/^\/api\/runs\/[^/]+\/messages\/?$/, 'Send Lemex follow-up'],
  [
    /^\/api\/runs\/|^\/api\/projects\/[^/]+\/runs\/?$/,
    'Read Lemex run',
    'Manage Lemex run',
  ],
  [/^\/api\/chats\//, 'Open chat', 'Update chat'],
  [
    /^\/api\/projects\/[^/]+\/git(\/|$)/,
    'Read source control',
    'Update source control',
  ],
  [/^\/api\/search\/?$/, 'Search Lean declarations'],
  [
    /^\/api\/(settings|provider|profile|models|git-connections)(\/|$)/,
    'Load settings',
    'Update settings',
  ],
]

const HTTP_REASONS: Readonly<Record<number, string>> = {
  400: 'LeanFlow rejected the request. Check the inputs and try again.',
  401: 'Your session needs attention. Sign in again to continue.',
  403: 'Your account does not have permission for this action.',
  404: 'The requested item is unavailable. Refresh the workspace and check whether it still exists.',
  409: 'The action conflicted with the current state. Check the workspace before trying again.',
  413: 'The request exceeds the size limit. Try with a smaller file or selection.',
  422: 'LeanFlow could not use the submitted data. Check the inputs and try again.',
  429: 'LeanFlow or a connected service is busy. Wait a moment and try again.',
  502: 'A connected service could not complete the request. Try again shortly.',
  503: 'The service is temporarily unavailable. Try again shortly.',
  504: 'The server did not receive a response in time.',
  507: 'The server has insufficient storage. Contact your administrator if this continues.',
}

export function recordApiFailure(
  path: string,
  method: string,
  status: number | 'timeout',
) {
  const route = path.split(/[?#]/, 1)[0]
  if (!route.startsWith('/api/') || route === '/api/session/activity') return
  const read = /^(GET|HEAD)$/i.test(method)
  const match = API_ACTIONS.find(([pattern]) => pattern.test(route))
  const action = match
    ? read
      ? match[1]
      : match[2] || match[1]
    : read
      ? 'Load workspace data'
      : 'Update workspace'
  if (status === 'timeout' || status === 0) {
    recordFailure({
      action,
      code: status === 'timeout' ? 'Request timed out' : 'Network error',
      message: read
        ? 'LeanFlow did not respond. Check your connection and try again.'
        : 'LeanFlow did not respond. Check whether the change was applied before trying again.',
    })
    return
  }
  recordFailure({
    action,
    code: `HTTP ${status}`,
    message:
      HTTP_REASONS[status] ||
      (status >= 200 && status < 300
        ? 'LeanFlow returned an unreadable response.'
        : status >= 500
          ? 'The server could not complete the action. Try again or share this log if it continues.'
          : 'LeanFlow could not complete the request.'),
  })
}
