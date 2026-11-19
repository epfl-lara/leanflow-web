import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { PDFDocumentProxy, RenderTask, TextLayer } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { api, type PaperLink } from './api'
import { PdfPassageMarks } from './PdfPassageMarks'
import { PdfSourceMarks } from './PdfSourceMarks'
import {
  pdfSourceAtPoint,
  pdfSourcePoint,
  type PdfSourceNavigation,
  type PdfSourcePage,
  type PdfViewport,
} from './pdfSourceNavigation'
import './linked-pdf.css'

export type PdfPaperLink = PaperLink & {
  source: { path: string; page: number; quote: string }
}

interface OpenPdf {
  document: PDFDocumentProxy
  TextLayer: typeof TextLayer
}

interface LinkedPage {
  element: HTMLDivElement
  texts: { str: string; hasEOL?: boolean }[]
  spans: HTMLElement[]
}

const zoomLevels = ['100', '125', '150', '200'] as const
type PdfZoom = 'fit' | (typeof zoomLevels)[number]

function LinkedPdfPage({
  pdf,
  page,
  fitWidth,
  zoom,
  links,
  mapping,
  sourceNavigation,
  onOpen,
  onFallback,
}: {
  pdf: OpenPdf
  page: number
  fitWidth?: number
  zoom: PdfZoom
  links: readonly PdfPaperLink[]
  mapping?: PdfSourcePage
  sourceNavigation?: PdfSourceNavigation
  onOpen?: (location: PaperLink['target']) => void
  onFallback: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const drawing = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState<{
    fitWidth?: number
    zoom: PdfZoom
    layer: LinkedPage | null
    viewport: PdfViewport
  } | null>(null)
  const [sourceMessage, setSourceMessage] = useState('')
  const loaded =
    rendered?.fitWidth === fitWidth && rendered?.zoom === zoom ? rendered : null

  useEffect(() => {
    const container = host.current
    const surface = drawing.current
    if (!container || !surface || (zoom === 'fit' && !fitWidth)) return
    let cancelled = false
    let painting: RenderTask | undefined
    let textLayer: TextLayer | undefined

    const render = async () => {
      const source = await pdf.document.getPage(page)
      if (cancelled) return
      const original = source.getViewport({ scale: 1 })
      // PDF units are points, with 72 points and 96 CSS pixels per inch.
      const requestedScale =
        zoom === 'fit'
          ? (fitWidth ?? 0) / original.width
          : (Number(zoom) / 100) * (96 / 72)
      const scale = Math.min(
        requestedScale,
        2400 / Math.max(original.height, original.width),
      )
      const viewport = source.getViewport({ scale })
      if (!Number.isFinite(viewport.width + viewport.height) || scale <= 0)
        throw new Error('The PDF page has invalid dimensions.')
      const ratio = Math.min(
        2,
        window.devicePixelRatio || 1,
        4096 / Math.max(viewport.width, viewport.height),
        Math.sqrt(12_000_000 / (viewport.width * viewport.height)),
      )
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width * ratio)
      canvas.height = Math.ceil(viewport.height * ratio)
      canvas.setAttribute('aria-hidden', 'true')
      container.style.width = `${viewport.width}px`
      container.style.height = `${viewport.height}px`
      container.style.setProperty(
        '--total-scale-factor',
        String(scale * source.userUnit),
      )
      const text = document.createElement('div')
      text.className = 'linked-pdf-text'
      surface.replaceChildren(canvas, text)
      painting = source.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      })
      await painting.promise
      if (cancelled) return

      let layer: LinkedPage | null = null
      try {
        const content = await source.getTextContent()
        if (cancelled) return
        textLayer = new pdf.TextLayer({
          textContentSource: content,
          container: text,
          viewport,
        })
        await textLayer.render()
        const texts = content.items.filter((item) => 'str' in item)
        if (texts.length === textLayer.textDivs.length)
          layer = { element: container, texts, spans: textLayer.textDivs }
      } catch {
        // Complete the canvas even when a PDF has no usable text layer.
      }
      if (!cancelled) setRendered({ layer, fitWidth, zoom, viewport })
    }
    void render().catch(() => {
      if (!cancelled) onFallback()
    })
    return () => {
      cancelled = true
      painting?.cancel()
      textLayer?.cancel()
      surface.replaceChildren()
    }
  }, [pdf, page, fitWidth, zoom, onFallback])

  function openSource(event: MouseEvent<HTMLDivElement>) {
    if (
      !loaded ||
      !mapping ||
      !sourceNavigation?.enabled ||
      (event.target instanceof Element && event.target.closest('button'))
    )
      return
    const rect = event.currentTarget.getBoundingClientRect()
    const point = pdfSourcePoint(
      loaded.viewport,
      event.clientX - rect.left,
      event.clientY - rect.top,
    )
    const box = point && pdfSourceAtPoint(mapping.boxes, point.x, point.y)
    if (!box || sourceNavigation.dirtyPaths?.has(box.path)) {
      setSourceMessage('No saved LaTeX location was found at this point.')
      return
    }
    event.preventDefault()
    const selection = window.getSelection()
    if (
      selection?.anchorNode &&
      event.currentTarget.contains(selection.anchorNode)
    )
      selection.removeAllRanges()
    setSourceMessage('')
    sourceNavigation.onOpenSource(box.path, box.line)
  }

  return (
    <>
      {!rendered && (
        <output className="file-preview-loading">Loading page {page}…</output>
      )}
      <div
        ref={host}
        className="linked-pdf-sheet"
        aria-label={`PDF page ${page}`}
        aria-busy={!loaded}
        hidden={!rendered}
        onDoubleClick={
          mapping && sourceNavigation?.enabled ? openSource : undefined
        }
      >
        <div ref={drawing} className="linked-pdf-page-content" />
        {loaded && mapping && sourceNavigation?.enabled && onOpen && (
          <PdfSourceMarks
            mapping={mapping}
            viewport={loaded.viewport}
            dirtyPaths={sourceNavigation.dirtyPaths}
            onOpen={onOpen}
          />
        )}
      </div>
      {sourceMessage && mapping && (
        <output className="linked-pdf-source-message">{sourceMessage}</output>
      )}
      {loaded?.layer && onOpen && (
        <PdfPassageMarks sheet={loaded.layer} links={links} onOpen={onOpen} />
      )}
    </>
  )
}

export function LinkedPdfReader({
  url,
  links,
  revealPage,
  sourceNavigation,
  onOpen,
  onFallback,
}: {
  url: string
  links: readonly PdfPaperLink[]
  revealPage?: { page: number; id: number }
  sourceNavigation?: PdfSourceNavigation
  onOpen?: (location: PaperLink['target']) => void
  onFallback: () => void
}) {
  const reader = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<OpenPdf | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<PdfZoom>('fit')
  const [selection, setSelection] = useState<{
    request?: number
    page: number
  }>({ page: 1 })
  const wanted =
    selection.request === revealPage?.id
      ? selection.page
      : revealPage?.page || 1
  const pageCount = pdf?.document.numPages || 1
  const page = Math.min(wanted, pageCount)
  const pageLinks = useMemo(
    () => links.filter((link) => link.source.page === page),
    [links, page],
  )
  const sourcePageUrl =
    pdf && sourceNavigation?.enabled
      ? `${sourceNavigation.endpoint}?page=${page}`
      : null
  const sourceRevision = sourceNavigation?.revision
  const [sourcePage, setSourcePage] = useState<{
    url: string
    revision?: string
    mapping?: PdfSourcePage
  }>()
  const sourceResult =
    sourcePage?.url === sourcePageUrl && sourcePage.revision === sourceRevision
      ? sourcePage
      : undefined

  useEffect(() => {
    if (!sourcePageUrl) return
    const controller = new AbortController()
    void api<PdfSourcePage>(sourcePageUrl, { signal: controller.signal }).then(
      (mapping) => {
        if (!controller.signal.aborted)
          setSourcePage({
            url: sourcePageUrl,
            revision: sourceRevision,
            mapping,
          })
      },
      () => {
        if (!controller.signal.aborted)
          setSourcePage({ url: sourcePageUrl, revision: sourceRevision })
      },
    )
    return () => controller.abort()
  }, [sourcePageUrl, sourceRevision])

  useEffect(() => {
    let cancelled = false
    let loading:
      | ReturnType<(typeof import('pdfjs-dist'))['getDocument']>
      | undefined
    const load = async () => {
      const library = await import('pdfjs-dist')
      if (cancelled) return
      library.GlobalWorkerOptions.workerSrc = pdfWorker
      const assets = `${import.meta.env.BASE_URL}pdfjs/`
      loading = library.getDocument({
        url,
        enableXfa: false,
        cMapUrl: `${assets}cmaps/`,
        standardFontDataUrl: `${assets}standard_fonts/`,
        wasmUrl: `${assets}wasm/`,
        iccUrl: `${assets}iccs/`,
        maxImageSize: 16_000_000,
      })
      const document = await loading.promise
      if (!cancelled) setPdf({ document, TextLayer: library.TextLayer })
    }
    void load().catch(() => {
      if (!cancelled) onFallback()
    })
    return () => {
      cancelled = true
      void loading?.destroy().catch(() => {})
    }
  }, [url, onFallback])

  useEffect(() => {
    const element = reader.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setWidth(Math.max(1, Math.min(1200, element.clientWidth - 24)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function go(next: number) {
    if (!Number.isSafeInteger(next) || next < 1 || next > pageCount) return
    setSelection({ request: revealPage?.id, page: next })
  }

  useEffect(() => {
    reader.current?.scrollTo({ top: 0, left: 0 })
  }, [page, revealPage?.id])

  return (
    <>
      {pdf && (
        <form
          className="linked-pdf-pager"
          aria-label="PDF pages"
          onSubmit={(event) => {
            event.preventDefault()
            go(Number(new FormData(event.currentTarget).get('page')))
          }}
        >
          <div className="linked-pdf-navigation">
            <button
              className="button small secondary"
              type="button"
              disabled={page === 1}
              onClick={() => go(page - 1)}
            >
              Previous
            </button>
            <input
              className="linked-pdf-page-number"
              key={page}
              type="number"
              name="page"
              aria-label="PDF page number"
              min={1}
              max={pageCount}
              defaultValue={page}
              required
            />
            <span aria-label={`${pageCount} pages`}>/ {pageCount}</span>
            <button
              className="button small secondary"
              type="button"
              disabled={page === pageCount}
              onClick={() => go(page + 1)}
            >
              Next
            </button>
          </div>
          <select
            className="linked-pdf-zoom"
            aria-label="PDF zoom"
            value={zoom}
            onChange={(event) => {
              const value = event.currentTarget.value
              setZoom(zoomLevels.find((level) => level === value) ?? 'fit')
            }}
          >
            <option value="fit">Fit width</option>
            {zoomLevels.map((level) => (
              <option key={level} value={level}>
                {level}%
              </option>
            ))}
          </select>
        </form>
      )}
      {sourceNavigation?.enabled && pdf && (
        <p className="linked-pdf-source-hint">
          {sourceResult && !sourceResult.mapping
            ? 'LaTeX source locations are unavailable for this page.'
            : 'Double-click the PDF to jump to LaTeX.'}
        </p>
      )}
      <div ref={reader} className="linked-pdf-scroll">
        {pdf ? (
          <LinkedPdfPage
            key={page}
            pdf={pdf}
            page={page}
            fitWidth={zoom === 'fit' ? width : undefined}
            zoom={zoom}
            links={pageLinks}
            mapping={sourceResult?.mapping}
            sourceNavigation={sourceNavigation}
            onOpen={onOpen}
            onFallback={onFallback}
          />
        ) : (
          <output className="file-preview-loading">Loading PDF…</output>
        )}
      </div>
    </>
  )
}
