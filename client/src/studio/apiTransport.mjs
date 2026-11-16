// Only reads are repeated. A mutation whose connection drops may already have
// reached the server, so it runs once and reports an unknown outcome.
const SAFE_METHODS = new Set(['GET', 'HEAD'])
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])
// Exact browser messages for a failed connection or an interrupted response
// body. Any other TypeError is a programming error and propagates unchanged.
const NETWORK_ERROR_MESSAGES = new Set([
  'Failed to fetch', // Chromium
  'network error', // Chromium, while reading a response body
  'Load failed', // Safari
  'The network connection was lost.', // Safari before 17
  'The Internet connection appears to be offline.', // Safari before 17
  'NetworkError when attempting to fetch resource.', // Firefox
])

export const MAX_API_ATTEMPTS = 3

export class ApiNetworkError extends Error {
  constructor(method, attempts, cause) {
    super(
      SAFE_METHODS.has(method)
        ? `Could not reach LeanFlow${attempts > 1 ? ` after ${attempts} attempts` : ''}. Check your network connection and try again.`
        : 'The connection to LeanFlow was interrupted, so this change may or may not have been applied. Check the current state before trying again.',
      { cause },
    )
    this.name = 'ApiNetworkError'
    this.status = 0
    this.method = method
    this.attempts = attempts
  }
}

export function isBrowserNetworkError(error) {
  if (error instanceof TypeError)
    return NETWORK_ERROR_MESSAGES.has(error.message)
  return (
    typeof DOMException === 'function' &&
    error instanceof DOMException &&
    error.name === 'NetworkError'
  )
}

const isRetryableHttpError = (error) =>
  error instanceof Error &&
  'status' in error &&
  RETRYABLE_STATUSES.has(error.status)

// Jittered exponential backoff: 250-500 ms, then 750-1500 ms.
const retryDelayMs = (retry) =>
  Math.round(500 * 3 ** (retry - 1) * (0.5 + Math.random() / 2))

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

// Runs the caller's whole request, including reading the body, so a response
// that fails mid-body is repeated as one unit. beforeAttempt runs before every
// attempt; whatever it throws ends the operation unchanged.
export async function withApiRetries(operation, options = {}) {
  const { signal, beforeAttempt, delayMs = retryDelayMs } = options
  const method = (options.method || 'GET').toUpperCase()
  const maxAttempts = SAFE_METHODS.has(method) ? MAX_API_ATTEMPTS : 1
  for (let attempt = 1; ; attempt += 1) {
    let retryAfterMs = 0
    if (signal?.aborted) throw signal.reason
    beforeAttempt?.()
    try {
      const value = await operation(attempt)
      if (signal?.aborted) throw signal.reason
      return value
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      const network = isBrowserNetworkError(error)
      if (attempt >= maxAttempts || !(network || isRetryableHttpError(error)))
        throw network ? new ApiNetworkError(method, attempt, error) : error
      if (isRetryableHttpError(error) && Number.isFinite(error.retryAfterMs)) {
        // Keep recovery short without retrying earlier than the server asks.
        if (error.retryAfterMs > 3000) throw error
        retryAfterMs = Math.max(0, error.retryAfterMs)
      }
    }
    await wait(Math.max(delayMs(attempt), retryAfterMs), signal)
  }
}
