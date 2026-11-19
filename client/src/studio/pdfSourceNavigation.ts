import type { PDFPageProxy } from 'pdfjs-dist'
import type { PaperLink } from './api'

export interface PdfSourceBox {
  path: string
  line: number
  x: number
  y: number
  width: number
  height: number
}

export interface PdfSourcePage {
  page: number
  boxes: PdfSourceBox[]
  links: PaperLink[]
}

export interface PdfSourceNavigation {
  endpoint: string
  enabled: boolean
  revision: string
  dirtyPaths?: ReadonlySet<string>
  onOpenSource: (path: string, line: number) => void
}

export type PdfViewport = ReturnType<PDFPageProxy['getViewport']>

export function pdfSourcePoint(viewport: PdfViewport, x: number, y: number) {
  const [pdfX, pdfY]: unknown[] = viewport.convertToPdfPoint(x, y)
  if (typeof pdfX !== 'number' || typeof pdfY !== 'number') return null
  return {
    x: pdfX - viewport.viewBox[0],
    y: viewport.viewBox[3] - pdfY,
  }
}

export function pdfSourceBoxBounds(viewport: PdfViewport, box: PdfSourceBox) {
  const pdfX = viewport.viewBox[0] + box.x
  const pdfY = viewport.viewBox[3] - box.y
  const [x1, y1]: unknown[] = viewport.convertToViewportPoint(pdfX, pdfY)
  const [x2, y2]: unknown[] = viewport.convertToViewportPoint(
    pdfX + box.width,
    pdfY - box.height,
  )
  if (
    typeof x1 !== 'number' ||
    typeof y1 !== 'number' ||
    typeof x2 !== 'number' ||
    typeof y2 !== 'number'
  )
    return null
  const left = Math.max(0, Math.min(x1, x2))
  const top = Math.max(0, Math.min(y1, y2))
  const width = Math.min(viewport.width, Math.max(x1, x2)) - left
  const height = Math.min(viewport.height, Math.max(y1, y2)) - top
  return width > 1 && height > 1 ? { left, top, width, height } : null
}

export function pdfSourceAtPoint(
  boxes: readonly PdfSourceBox[],
  x: number,
  y: number,
) {
  let closest: PdfSourceBox | null = null
  let area = Infinity
  for (const box of boxes) {
    if (
      x < box.x ||
      x > box.x + box.width ||
      y < box.y ||
      y > box.y + box.height
    )
      continue
    const candidateArea = box.width * box.height
    if (candidateArea < area) {
      closest = box
      area = candidateArea
    }
  }
  return closest
}

export function pdfSourceLinkMatches(link: PaperLink, box: PdfSourceBox) {
  const { source, renderRange } = link
  return (
    'line' in source &&
    source.path === box.path &&
    (source.line === box.line ||
      (!!renderRange &&
        box.line >= renderRange.startLine &&
        box.line <= renderRange.endLine))
  )
}
