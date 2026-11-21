import type { PaperLink } from './api'
import { Dialog } from './Dialog'
import { Icon } from './Icons'

export function PaperLinksPanel({
  result,
  previousLinks,
  onRefresh,
  dirtyPaths,
  onOpen,
  onFindLinks,
  onClose,
}: {
  result: { links: PaperLink[] } | { error: string } | null
  previousLinks?: readonly PaperLink[]
  onRefresh: () => void
  dirtyPaths: ReadonlySet<string>
  onOpen: (location: PaperLink['source'] | PaperLink['target']) => void
  onFindLinks?: () => void
  onClose?: () => void
}) {
  const valid = result && 'links' in result ? result : null
  const links = valid?.links ?? previousLinks
  const refresh = (
    <button
      type="button"
      className="icon-button"
      title="Refresh paper links"
      aria-label="Refresh paper links"
      aria-disabled={!result}
      onClick={() => {
        if (result) onRefresh()
      }}
    >
      <Icon name="refresh" size={14} />
    </button>
  )
  const find = onFindLinks && (
    <button
      type="button"
      className="button small secondary paper-links-find"
      onClick={onFindLinks}
    >
      Find links with Lemex
    </button>
  )
  const content = (
    <>
      {!result ? (
        <output className={links?.length ? 'sr-only' : 'paper-links-message'}>
          {links?.length ? 'Refreshing paper links…' : 'Loading paper links…'}
        </output>
      ) : 'error' in result ? (
        <p className="paper-links-message error-message" role="alert">
          {result.error}
        </p>
      ) : null}
      {links?.length ? (
        <ul className="paper-links-list">
          {links.map(({ id, source, target, status, difference }) => {
            const pdfSource = 'page' in source
            const sourceLocation = pdfSource
              ? `Page ${source.page}`
              : `Line ${source.line}`
            const dirty =
              dirtyPaths.has(source.path) || dirtyPaths.has(target.path)
            const disabled = !valid || status === 'stale' || dirty
            return (
              <li key={id} className="paper-link-card">
                <button
                  type="button"
                  className="paper-link-location"
                  aria-disabled={disabled}
                  onClick={() => {
                    if (!disabled) onOpen(source)
                  }}
                  aria-label={`Open ${source.path}, ${sourceLocation.toLowerCase()}`}
                >
                  <Icon name="file" size={15} />
                  <span>
                    <strong>
                      {pdfSource
                        ? sourceLocation
                        : source.label || sourceLocation}
                    </strong>
                    <small>
                      {source.path}
                      {pdfSource ? '' : `:${source.line}`}
                    </small>
                  </span>
                  <Icon name="arrow" size={14} />
                </button>
                {pdfSource && source.quote && (
                  <blockquote>{source.quote}</blockquote>
                )}
                <button
                  type="button"
                  className="paper-link-location"
                  aria-disabled={disabled}
                  onClick={() => {
                    if (!disabled) onOpen(target)
                  }}
                  aria-label={`Open ${target.declaration} in ${target.path}`}
                >
                  <Icon name="fileCheck" size={15} />
                  <span>
                    <strong>
                      <code>{target.declaration}</code>
                    </strong>
                    <small>
                      {target.path}:{target.line}
                    </small>
                  </span>
                  <Icon name="arrow" size={14} />
                </button>
                {difference && (
                  <p className="paper-link-difference">
                    <strong>Formalization note</strong>
                    {difference}
                  </p>
                )}
                {(dirty || status === 'stale') && (
                  <p className="paper-link-stale">
                    {dirty
                      ? 'Save edits to refresh this link.'
                      : 'This link needs updating.'}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      ) : valid ? (
        <p className="paper-links-message">No paper links for this file yet.</p>
      ) : null}
    </>
  )

  if (onClose)
    return (
      <Dialog id="paper-links-panel" title="Paper links" onClose={onClose}>
        <div className="paper-links-dialog-actions">
          {find}
          {refresh}
        </div>
        {content}
      </Dialog>
    )

  return (
    <aside
      id="paper-links-panel"
      className="paper-links-panel"
      aria-label="Paper links"
    >
      <header className="paper-links-header">
        <h2>Paper links</h2>
        {refresh}
      </header>
      {find}
      {content}
    </aside>
  )
}
