import { useEffect, useState } from 'react'
import {
  apiHtml,
  apiImage,
  apiPdf,
  errorText,
  sessionBoundUrl,
  SESSION_RESTORED_EVENT,
} from './api'

export function useFilePreview(
  path: string,
  kind: 'pdf' | 'image' | 'html',
  revision?: string | number,
  scope?: string,
) {
  const [loaded, setLoaded] = useState<{
    key: string
    content?: string
    error?: string
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify([scope, path, kind, revision, attempt])

  useEffect(() => {
    const retry = () => setAttempt((current) => current + 1)
    window.addEventListener(SESSION_RESTORED_EVENT, retry)
    return () => window.removeEventListener(SESSION_RESTORED_EVENT, retry)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    const load =
      kind === 'html' ? apiHtml : kind === 'image' ? apiImage : apiPdf
    void load(path, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return
        let content: string
        if (typeof value === 'string') content = value
        else if (
          kind === 'image' &&
          value.type.split(';')[0] === 'image/svg+xml'
        ) {
          // SVG is safe in <img>, but opening an app-origin Blob as a document
          // would lose the server's sandbox policy. Retain the protected URL.
          const source = new URL(
            sessionBoundUrl(path),
            'http://leanflow.invalid',
          )
          source.searchParams.set(
            'previewRevision',
            JSON.stringify([revision, attempt]),
          )
          content = path.startsWith('/')
            ? source.pathname + source.search
            : source.href
        } else content = objectUrl = URL.createObjectURL(value)
        setLoaded({ key, content })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({ key, error: errorText(error) })
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path, kind, key, revision, attempt])

  return {
    content: loaded?.key === key ? loaded.content : undefined,
    error: loaded?.key === key ? loaded.error : undefined,
    retry: () => setAttempt((current) => current + 1),
  }
}
