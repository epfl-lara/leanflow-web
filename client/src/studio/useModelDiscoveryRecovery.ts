import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { api, ApiError, errorText, type ModelAccess, type Session } from './api'

// A temporary discovery queue must not leave an otherwise valid account with
// an empty picker until the user finds the refresh action in settings.
export function useModelDiscoveryRecovery(
  session: Session | null,
  setSession: Dispatch<SetStateAction<Session | null>>,
) {
  const userId = session?.user.id
  const retryable =
    session?.lemex?.modelErrorRetryable === true && !session.models.length
  const providerUpdatedAt = session?.lemex?.updatedAt
  useEffect(() => {
    if (!userId || !retryable) return
    let disposed = false
    let delay = 2000
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const retry = async () => {
      try {
        const access = await api<ModelAccess>('/api/models', {
          signal: controller.signal,
        })
        if (disposed) return
        setSession((current) =>
          current?.user.id === userId &&
          current.lemex?.updatedAt === providerUpdatedAt
            ? {
                ...current,
                ...access,
                lemex: {
                  ...current.lemex,
                  modelError: null,
                  modelErrorRetryable: false,
                },
              }
            : current,
        )
      } catch (error) {
        if (disposed) return
        if (error instanceof ApiError && error.status === 429) {
          delay = Math.min(15000, delay * 2)
          timer = setTimeout(() => void retry(), delay)
        } else {
          setSession((current) =>
            current?.user.id === userId &&
            current.lemex?.updatedAt === providerUpdatedAt
              ? {
                  ...current,
                  lemex: {
                    ...current.lemex,
                    modelError: errorText(error),
                    modelErrorRetryable: false,
                  },
                }
              : current,
          )
        }
      }
    }
    timer = setTimeout(() => void retry(), delay)
    return () => {
      disposed = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [userId, retryable, providerUpdatedAt, setSession])
}
