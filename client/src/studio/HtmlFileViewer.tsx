import { useFilePreview } from './useFilePreview'

// The server sanitizes the document and embeds local assets. Keep fetched HTML
// in an opaque, script-free frame with its own network policy as well.
const previewPolicy = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`

export function HtmlFileViewer({
  projectId,
  path,
  revision,
}: {
  projectId: string
  path: string
  revision?: string | number
}) {
  const { content, error, retry } = useFilePreview(
    `/api/projects/${encodeURIComponent(projectId)}/file-preview?path=${encodeURIComponent(path)}`,
    'html',
    revision,
    projectId,
  )
  return (
    <section className="html-file-viewer" aria-label="HTML document">
      <div className="media-file-actions">
        <button className="button small secondary" onClick={retry}>
          Reload HTML
        </button>
        <span className="field-help">Static preview</span>
      </div>
      {error ? (
        <div className="file-preview-error">
          <p className="error-message" role="alert">
            {error}
          </p>
          <button className="button secondary" onClick={retry}>
            Retry HTML
          </button>
        </div>
      ) : content !== undefined ? (
        <iframe
          title="HTML preview"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={previewPolicy + content}
        />
      ) : (
        <output className="file-preview-loading">Loading HTML…</output>
      )}
    </section>
  )
}
