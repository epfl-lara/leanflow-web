import { useCallback, useMemo, useState } from 'react'
import { sessionBoundUrl, type PaperLink } from './api'
import { LinkedPdfReader, type PdfPaperLink } from './LinkedPdfReader'
import type { PdfSourceNavigation } from './pdfSourceNavigation'
import { useFilePreview } from './useFilePreview'

export function PdfFileViewer({
  projectId,
  path,
  previewUrl,
  revision,
  showActions = true,
  fitWidth = false,
  revealPage,
  paperLinks,
  keepLinkedReader,
  sourceNavigation,
  onOpenPaperLink,
}: {
  projectId: string
  path: string
  previewUrl?: string
  revision?: string
  showActions?: boolean
  fitWidth?: boolean
  revealPage?: { page: number; id: number }
  paperLinks?: readonly PaperLink[]
  keepLinkedReader?: boolean
  sourceNavigation?: PdfSourceNavigation
  onOpenPaperLink?: (location: PaperLink['target']) => void
}) {
  const previewPath =
    previewUrl ||
    `/api/projects/${encodeURIComponent(projectId)}/file-preview?path=${encodeURIComponent(path)}`
  const {
    content: url,
    error,
    retry,
  } = useFilePreview(previewPath, 'pdf', revision, projectId)
  const pageFragment = revealPage ? `page=${revealPage.page}` : ''
  const fragment = [pageFragment, fitWidth && 'view=FitH&navpanes=0']
    .filter(Boolean)
    .join('&')
  const [nativeUrl, setNativeUrl] = useState('')
  const [fallbackUrl, setFallbackUrl] = useState('')
  const quotedLinks = useMemo(
    () =>
      paperLinks?.filter(
        (link): link is PdfPaperLink =>
          link.status === 'current' &&
          link.source.path === path &&
          'page' in link.source &&
          !!link.source.quote?.trim(),
      ) || [],
    [paperLinks, path],
  )
  const canShowHighlights =
    !!url &&
    url !== fallbackUrl &&
    (quotedLinks.length > 0 || !!keepLinkedReader) &&
    !!onOpenPaperLink
  const showHighlights = canShowHighlights && url !== nativeUrl
  const showLinkedReader =
    showHighlights || (!!sourceNavigation && url !== fallbackUrl)
  const showOriginal = useCallback(() => {
    if (url) setFallbackUrl(url)
  }, [url])

  return (
    <section className="pdf-file-viewer" aria-label="PDF document">
      {url ? (
        <>
          <div className="pdf-file-actions" hidden={!showActions}>
            <button className="button small secondary" onClick={retry}>
              Reload PDF
            </button>
            {canShowHighlights && (
              <button
                className="button small secondary"
                type="button"
                aria-pressed={showHighlights}
                onClick={() => setNativeUrl(showHighlights ? url : '')}
              >
                Linked passages
              </button>
            )}
            <a
              className="button small secondary"
              href={url}
              download={path.split('/').at(-1)}
            >
              Download PDF
            </a>
            <a
              className="button small subtle"
              href={`${sessionBoundUrl(previewPath)}${pageFragment ? `#${pageFragment}` : ''}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open PDF in new tab
            </a>
          </div>
          {showLinkedReader ? (
            <LinkedPdfReader
              key={url}
              url={url}
              links={quotedLinks}
              revealPage={revealPage}
              sourceNavigation={sourceNavigation}
              onOpen={onOpenPaperLink}
              onFallback={showOriginal}
            />
          ) : (
            <iframe
              key={revealPage?.id}
              title="PDF preview"
              src={fragment ? `${url}#${fragment}` : url}
            />
          )}
        </>
      ) : error ? (
        <div className="file-preview-error">
          <p className="error-message" role="alert">
            {error}
          </p>
          <button className="button secondary" onClick={retry}>
            Retry PDF
          </button>
        </div>
      ) : (
        <output className="file-preview-loading">Loading PDF…</output>
      )}
    </section>
  )
}
