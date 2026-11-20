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
    paths: Array.isArray(document.paths)
      ? document.paths.filter(
          (path): path is string => typeof path === 'string',
        )
      : [document.path],
    buildId:
      typeof document.buildId === 'string' ? document.buildId : undefined,
  }
}

type SourceEntry = RunProofTarget & {
  name: string
  status: string
  type?: string
  axioms?: string[]
}

function sourceEntry(value: unknown): value is SourceEntry {
  return (
    record(value) &&
    typeof value.path === 'string' &&
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    typeof value.startLine === 'number' &&
    typeof value.endLine === 'number' &&
    (value.type === undefined || typeof value.type === 'string') &&
    (value.axioms === undefined ||
      (Array.isArray(value.axioms) &&
        value.axioms.every((name) => typeof name === 'string')))
  )
}

type OpenTarget = (target: RunProofTarget) => void

function TheoremList({
  entries,
  onOpenTarget,
  checked,
}: {
  entries: SourceEntry[]
  onOpenTarget?: OpenTarget
  checked?: boolean
}) {
  return (
    <ul>
      {entries.map(({ path, name, startLine, endLine, type, axioms }) => (
        <li key={JSON.stringify([path, name, startLine])}>
          <button
            type="button"
            className="turn-action"
            disabled={!onOpenTarget}
            onClick={() => onOpenTarget?.({ path, name, startLine, endLine })}
          >
            {name} · {path}:{startLine}
            {endLine !== startLine ? `–${endLine}` : ''}
          </button>
          {type && checked && <pre>{type}</pre>}
          {!!axioms?.length && <p>Axioms used: {axioms.join(', ')}</p>}
        </li>
      ))}
    </ul>
  )
}

function SourceFileLink({
  path,
  onOpenTarget,
}: {
  path: string
  onOpenTarget?: OpenTarget
}) {
  return (
    <button
      className="turn-action"
      type="button"
      disabled={!onOpenTarget}
      onClick={() => onOpenTarget?.({ path, startLine: 1, endLine: 1 })}
    >
      {path}
    </button>
  )
}

// Older saved runs stored only a count for theorems without source ranges.
function sourceExplanation(detail: string) {
  return detail.replace(
    /Lean supplied no source location for (\d+) theorem declaration\(s\)\./g,
    (_, count: string) =>
      `Lean could not match ${count} ${count === '1' ? 'theorem' : 'theorems'} to lines in the source file. This run did not record ${count === '1' ? 'its name' : 'their names'}. Run Informalize again for details.`,
  )
}

function SourceChecks({
  sources,
  onOpenTarget,
}: {
  sources: Record<string, unknown>
  onOpenTarget?: OpenTarget
}) {
  const [expanded, setExpanded] = useState(false)
  const entries = Array.isArray(sources.entries)
    ? sources.entries.filter(sourceEntry)
    : []
  const checked = entries.filter((entry) => entry.status === 'checked')
  const incomplete = entries.filter((entry) => entry.status !== 'checked')
  const unlocated = Array.isArray(sources.unlocated)
    ? sources.unlocated.filter(
        (item): item is { name: string; path: string } =>
          record(item) &&
          typeof item.name === 'string' &&
          typeof item.path === 'string',
      )
    : []
  const failedPaths = Array.isArray(sources.failedPaths)
    ? sources.failedPaths.filter(
        (file): file is string => typeof file === 'string',
      )
    : []
  return (
    <>
      {(sources.status !== 'checked' || !entries.length) && (
        <p>
          {typeof sources.detail === 'string' && sources.detail
            ? sourceExplanation(sources.detail)
            : 'Lean could not finish checking the source proofs.'}
        </p>
      )}
      {unlocated.length > 0 && (
        <ul aria-label="Theorems without source lines">
          {unlocated.map(({ name, path }) => (
            <li key={JSON.stringify([name, path])}>
              {name} ·{' '}
              <SourceFileLink path={path} onOpenTarget={onOpenTarget} />
            </li>
          ))}
        </ul>
      )}
      {failedPaths.length > 0 && (
        <ul aria-label="Files Lean could not check">
          {failedPaths.map((path) => (
            <li key={path}>
              <SourceFileLink path={path} onOpenTarget={onOpenTarget} />
            </li>
          ))}
        </ul>
      )}
      {incomplete.length > 0 && (
        <TheoremList entries={incomplete} onOpenTarget={onOpenTarget} />
      )}
      {checked.length > 0 && (
        <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>
            Lean checked {checked.length}{' '}
            {checked.length === 1 ? 'proof' : 'proofs'}.
          </summary>
          {expanded && (
            <TheoremList
              entries={checked}
              onOpenTarget={onOpenTarget}
              checked
            />
          )}
        </details>
      )}
    </>
  )
}

export function InformalizationResult({
  value,
  projectId,
  saved = false,
  reviewFirst = true,
  onOpenTarget,
}: {
  value: unknown
  projectId?: string
  saved?: boolean
  reviewFirst?: boolean
  onOpenTarget?: (target: RunProofTarget) => void
}) {
  const [error, setError] = useState('')
  if (!hasInformalizationChecks(value)) return null
  const result = value.informalization
  const sources = record(result.sources) ? result.sources : {}
  const document = informalizationDocument(value)
  const path = document?.path ?? ''
  const complete = value.complete === true
  const multipleFiles =
    document &&
    (document.paths.length > 1 ||
      (document.paths.length === 1 && document.paths[0] !== path))
  // Source checking can stop a run before the writer starts. Saved runs used
  // the same reason at both stages, sometimes with a separate draft recovery hint.
  const reason = typeof value.reason === 'string' ? value.reason : ''
  const documentIssue =
    typeof sources.detail === 'string' && reason.startsWith(sources.detail)
      ? reason.slice(sources.detail.length).trim()
      : reason
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
      <strong>
        {path
          ? complete
            ? saved
              ? 'Document saved'
              : 'Document'
            : 'Draft needs revision'
          : 'No document to review'}
      </strong>
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
      {multipleFiles && (
        <details>
          <summary>
            {document.paths.length}{' '}
            {document.paths.length === 1 ? 'file changed' : 'files changed'}
          </summary>
          <ul>
            {document.paths.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
      )}
      {!complete && documentIssue && <p>{documentIssue}</p>}
      <SourceChecks sources={sources} onOpenTarget={onOpenTarget} />
      {complete && reviewFirst && !saved && (
        <p>Review the mathematical wording before applying the document.</p>
      )}
      {(pdfUrl || (saved && path)) && (
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
          {saved && path && (
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
                  {multipleFiles
                    ? 'Download main file'
                    : 'Download project file'}
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
