import { useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { PaperLink } from './api'
import type { PdfPaperLink } from './LinkedPdfReader'
import { indexPdfQuotes } from './pdfPaperQuotes'

interface Bounds {
  left: number
  top: number
  width: number
  height: number
}

interface Placement {
  link: PdfPaperLink
  rectangles: Bounds[]
  width: number
}

function overlap(a: Bounds, b: Bounds) {
  const width =
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const height =
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  return width > 1 && height > 1
}

function placeLinks(
  sheet: {
    element: HTMLDivElement
    texts: { str: string; hasEOL?: boolean }[]
    spans: HTMLElement[]
  },
  links: readonly PdfPaperLink[],
) {
  const frame = sheet.element.getBoundingClientRect()
  const find = indexPdfQuotes(sheet.texts)
  const placements: Placement[] = []
  for (const link of links) {
    const found = find(link.source.quote)
    if (!found) continue
    const start = sheet.spans[found.start.item]?.firstChild
    const end = sheet.spans[found.end.item]?.firstChild
    if (
      !(start instanceof Text) ||
      !(end instanceof Text) ||
      found.start.offset >= start.length ||
      found.end.offset > end.length
    )
      continue
    const range = document.createRange()
    const rectangles: Bounds[] = []
    for (let item = found.start.item; item <= found.end.item; item++) {
      const node = sheet.spans[item]?.firstChild
      if (!(node instanceof Text) || !node.length) continue
      range.setStart(node, item === found.start.item ? found.start.offset : 0)
      range.setEnd(
        node,
        item === found.end.item ? found.end.offset : node.length,
      )
      for (const box of range.getClientRects()) {
        const left = Math.max(box.left, frame.left)
        const top = Math.max(box.top, frame.top)
        const width = Math.min(box.right, frame.right) - left
        const height = Math.min(box.bottom, frame.bottom) - top
        if (width > 1 && height > 1)
          rectangles.push({
            left: left - frame.left,
            top: top - frame.top,
            width,
            height,
          })
      }
    }
    if (rectangles.length)
      placements.push({ link, rectangles, width: frame.width })
  }

  // Let the page-level list disambiguate overlapping annotations.
  return placements.filter(
    (placement) =>
      !placements.some(
        (other) =>
          placement !== other &&
          placement.rectangles.some((a) =>
            other.rectangles.some((b) => overlap(a, b)),
          ),
      ),
  )
}

export function PdfPassageMarks({
  sheet,
  links,
  onOpen,
}: {
  sheet: Parameters<typeof placeLinks>[0]
  links: readonly PdfPaperLink[]
  onOpen: (location: PaperLink['target']) => void
}) {
  const [placed, setPlaced] = useState<{
    sheet: typeof sheet
    links: typeof links
    placements: Placement[]
  }>()
  useEffect(() => {
    if (!links.length) return
    const frame = requestAnimationFrame(() => {
      setPlaced({ sheet, links, placements: placeLinks(sheet, links) })
    })
    return () => cancelAnimationFrame(frame)
  }, [sheet, links])
  if (placed?.sheet !== sheet || placed.links !== links) return null

  return createPortal(
    placed.placements.map(({ link, rectangles: [first, ...rest], width }) => {
      const { target } = link
      const style: CSSProperties & { '--tooltip-anchor': string } = {
        ...first,
        // Keep the tooltip centered on the sheet's middle for long names.
        '--tooltip-anchor': `${width / 2 - first.left}px`,
      }
      return (
        <button
          type="button"
          key={link.id}
          className="linked-pdf-passage"
          style={style}
          onClick={() => onOpen(target)}
          aria-label={`Open ${target.declaration} in Lean`}
        >
          {rest.map((box, index) => (
            <span
              aria-hidden="true"
              className="linked-pdf-passage-part"
              key={index}
              style={{
                ...box,
                left: box.left - first.left,
                top: box.top - first.top,
              }}
            />
          ))}
          <span className="linked-pdf-tooltip" aria-hidden="true">
            <strong>{target.declaration}</strong>
            <small>
              {target.path}:{target.line}
            </small>
          </span>
        </button>
      )
    }),
    sheet.element,
  )
}
