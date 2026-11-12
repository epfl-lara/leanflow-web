import { requestBearerToken } from './auth.mjs'

const mismatchMessage =
  'Another account is signed in in this browser. Sign in again as the account that owns this workspace tab.'

// Browser tabs share cookies, but their drafts and active connections belong to
// one account. Bearer clients keep their explicit token-based identity.
export function expectedSessionUser(request) {
  const header = request.headers['x-leanflow-user']
  const query = new URL(
    request.url,
    'http://leanflow.invalid',
  ).searchParams.getAll('expectedUserId')
  if (header === undefined && !query.length) return undefined
  if (
    query.length > 1 ||
    (header !== undefined && typeof header !== 'string') ||
    (header !== undefined && query.length && header !== query[0])
  )
    throw Object.assign(
      new Error('The workspace account binding is invalid.'),
      {
        status: 400,
      },
    )
  const expected = header ?? query[0]
  if (!expected || expected.length > 200 || /[\p{Cc}\s]/u.test(expected))
    throw Object.assign(
      new Error('The workspace account binding is invalid.'),
      {
        status: 400,
      },
    )
  return expected
}

export function requireSessionUser(user, expected) {
  if (expected !== undefined && user?.id !== expected)
    throw Object.assign(new Error(mismatchMessage), { status: 401 })
}

export function requireBrowserSessionBinding(request, expected) {
  if (expected === undefined && requestBearerToken(request) === null)
    throw Object.assign(
      new Error(
        'This tab uses an older workspace version. Copy or download unsaved editor drafts and copy unsent messages before reloading this page. Signing in again will not update this tab.',
      ),
      { status: 428 },
    )
}
