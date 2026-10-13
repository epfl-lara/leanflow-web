import { useEffect, useRef, useState } from 'react'
import { api, errorText, type LibrarySource } from './api'
import { Dialog } from './Dialog'

export type SourceRequest =
  | { module: string; signature: string }
  | { uri: string; line: number; endLine?: number }

export function LibrarySourceDialog({
  projectId,
  request,
  onClose,
}: {
  projectId: string
  request: SourceRequest
  onClose: () => void
}) {
  const [source, setSource] = useState<LibrarySource | null>(null)
  const [error, setError] = useState('')
  const text = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const controller = new AbortController()
    setSource(null)
    setError('')
    void api<LibrarySource>(
      `/api/projects/${encodeURIComponent(projectId)}/library-source`,
      {
        method: 'POST',
        body: JSON.stringify(request),
        signal: controller.signal,
      },
    ).then(
      (value) => {
        if (!controller.signal.aborted) setSource(value)
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setError(errorText(failure))
      },
    )
    return () => controller.abort()
  }, [projectId, request])

  useEffect(() => {
    const element = text.current
    if (!element || !source?.line) return
    const lines = element.value.split('\n')
    const start =
      lines.slice(0, source.line - 1).join('\n').length +
      (source.line > 1 ? 1 : 0)
    const end = lines.slice(0, source.endLine || source.line).join('\n').length
    element.focus()
    element.setSelectionRange(start, end)
    element.scrollTop =
      Math.max(0, source.line - 6) *
      parseFloat(getComputedStyle(element).lineHeight)
  }, [source])

  return (
    <Dialog
      title={
        source?.module ||
        ('module' in request ? request.module : 'Lean library source')
      }
      subtitle="Local project source · Read only"
      onClose={onClose}
    >
      <div className="library-source-body">
        {error ? (
          <p className="error-message" role="alert">
            {error}
          </p>
        ) : source ? (
          <>
            <p className="field-help">
              {source.path}
              <br />
              {source.toolchain?.replace('leanprover/lean4:', 'Lean ') ||
                'Project library'}
              {source.line
                ? ` · Line ${source.line}`
                : ' · Declaration location could not be matched in this version. Showing the module.'}
            </p>
            <textarea
              ref={text}
              aria-label="Library source"
              className="library-source-text"
              value={source.content}
              readOnly
              spellCheck={false}
              wrap="off"
            />
          </>
        ) : (
          <output>Loading local source…</output>
        )}
      </div>
    </Dialog>
  )
}
