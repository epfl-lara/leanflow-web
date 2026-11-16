export const MAX_API_ATTEMPTS: number
export class ApiNetworkError extends Error {
  readonly status: 0
  readonly method: string
  readonly attempts: number
  constructor(method: string, attempts: number, cause: unknown)
}
export interface ApiRetryOptions {
  method?: string
  signal?: AbortSignal | null
  beforeAttempt?: () => void
  delayMs?: (retry: number) => number
}
export function isBrowserNetworkError(error: unknown): boolean
export function withApiRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options?: ApiRetryOptions,
): Promise<T>
