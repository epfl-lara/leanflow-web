import { errorText, sessionBoundUrl, type RunProofTarget } from './api'
import { useState } from 'react'
import { downloadWorkspaceFile } from './downloads'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object'

export const hasInformalizationChecks = (
  value: unknown,
): value is Record<string, unknown> & {
  informalization: Record<string, unknown>
} => record(value) && record(value.informalization)

export function informalizationDocument(value: unknown) {
  if (!hasInformalizationChecks(value)) return null
  const document = value.informalization.document ?? value.informalization.draft
  if (!record(document) || typeof document.path !== 'string') return null
  return {
    path: document.path,
    buildId:
      typeof document.buildId === 'string' ? document.buildId : undefined,
  }
}

export function InformalizationResult({
  value,
  projectId,
  applied,
  onOpenTarget,
}: {
  value: unknown
  projectId?: string
  applied?: boolean
  onOpenTarget?: (target: RunProofTarget) => void
}) {
  const [error, setError] = useState('')
  const [showDeclarations, setShowDeclarations] = useState(false)
  if (!hasInformalizationChecks(value)) return null
  const result = value.informalization
  const sources = record(result.sources) ? result.sources : {}
  const entries = Array.isArray(sources.entries)
    ? sources.entries.filter(record)
    : []
  const document = informalizationDocument(value)
  const path = document?.path ?? ''
  const pdfUrl =
    path && projectId && document?.buildId
      ? sessionBoundUrl(
          `/api/projects/${encodeURIComponent(projectId)}/tex/builds/${encodeURIComponent(document.buildId)}/pdf`,
        )
      : ''
  return (
    <section
      className="informalization-result"
      aria-label="Informalization checks"
    >
      <strong>Lean source proofs</strong>
      <p>
        {sources.status === 'checked'
          ? entries.length
            ? 'Source proofs checked with Lean.'
            : 'Source inventory checked with Lean.'
          : sources.status === 'incomplete'
            ? 'Source proof checks incomplete.'
            : 'Source proof checks unavailable.'}
      </p>
      {(sources.status !== 'checked' || !entries.length) &&
        typeof sources.detail === 'string' &&
        sources.detail && <p>{sources.detail}</p>}
      {!!entries.length && (
        <details
          onToggle={(event) => setShowDeclarations(event.currentTarget.open)}
        >
          <summary>
            {entries.length} source{' '}
            {entries.length === 1 ? 'declaration' : 'declarations'}
          </summary>
          {showDeclarations && (
            <ul>
              {entries.map((entry, index) => {
                const { name, path, startLine, endLine } = entry
                if (
                  typeof path !== 'string' ||
                  typeof name !== 'string' ||
                  typeof startLine !== 'number' ||
                  typeof endLine !== 'number'
                )
                  return null
                return (
                  <li key={`${path}:${startLine}:${name}:${index}`}>
                    <button
                      type="button"
                      className="turn-action"
                      disabled={!onOpenTarget}
                      onClick={() =>
                        onOpenTarget?.({ path, name, startLine, endLine })
                      }
                    >
                      {name} · {path}:{startLine}
                      {endLine !== startLine ? `–${endLine}` : ''}
                    </button>
                    <span>
                      {' '}
                      · {entry.status === 'checked' ? 'Checked' : 'Incomplete'}
                    </span>
                    {typeof entry.type === 'string' && <pre>{entry.type}</pre>}
                    {Array.isArray(entry.axioms) && entry.axioms.length > 0 && (
                      <p>
                        Axioms:{' '}
                        {entry.axioms
                          .filter((name) => typeof name === 'string')
                          .join(', ')}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </details>
      )}
      <strong>Document</strong>
      {path && (
        <p>
          {path}
          {pdfUrl
            ? ' · PDF built'
            : /\.(md|markdown)$/i.test(path)
              ? ' · Markdown'
              : ''}
        </p>
      )}
      {value.complete === true
        ? !applied && (
            <p>Review the mathematical wording before applying the document.</p>
          )
        : typeof value.reason === 'string' &&
          value.reason && <p>{value.reason}</p>}
      {(pdfUrl || (applied && path)) && (
        <div className="turn-footer">
          {pdfUrl && (
            <>
              <a
                className="turn-action"
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open PDF
              </a>
              <a
                className="turn-action"
                href={pdfUrl}
                download={path
                  .split('/')
                  .at(-1)
                  ?.replace(/\.tex$/i, '.pdf')}
              >
                Download PDF
              </a>
            </>
          )}
          {applied && path && (
            <>
              {onOpenTarget && (
                <button
                  className="turn-action"
                  type="button"
                  onClick={() =>
                    onOpenTarget({ path, startLine: 1, endLine: 1 })
                  }
                >
                  Open document
                </button>
              )}
              {projectId && (
                <button
                  className="turn-action"
                  type="button"
                  onClick={() => {
                    setError('')
                    void downloadWorkspaceFile(projectId, path).catch((error) =>
                      setError(errorText(error)),
                    )
                  }}
                >
                  Download project file
                </button>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </section>
  )
}
