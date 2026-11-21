import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PaperLink } from './api'
import type { PdfPaperLink } from './LinkedPdfReader'
import { PdfLeanMark, type PdfMarkBounds } from './PdfLeanMark'
import { indexPdfQuotes } from './pdfPaperQuotes'

interface Placement {
  links: PdfPaperLink[]
  rectangles: PdfMarkBounds[]
  anchor: PdfMarkBounds
  width: number
}

function overlap(a: PdfMarkBounds, b: PdfMarkBounds) {
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
  const matches = new Map<string, Placement>()
  for (const link of links) {
    const found = find(link.source.quote)
    if (!found) continue
    const key = JSON.stringify(found)
    const existing = matches.get(key)
    if (existing) {
      existing.links.push(link)
      continue
    }
    const firstSpan = sheet.spans[found.start.item]
    const start = firstSpan?.firstChild
    const end = sheet.spans[found.end.item]?.firstChild
    if (
      !(start instanceof Text) ||
      !(end instanceof Text) ||
      found.start.offset >= start.length ||
      found.end.offset > end.length
    )
      continue
    const range = document.createRange()
    const rectangles: PdfMarkBounds[] = []
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
    const first = rectangles[0]
    if (first) {
      // Use the whole text run for placement when the quote starts mid-line.
      const bounds = firstSpan.getBoundingClientRect()
      const left = Math.max(0, Math.min(first.left, bounds.left - frame.left))
      const right = Math.min(
        frame.width,
        Math.max(first.left + first.width, bounds.right - frame.left),
      )
      matches.set(key, {
        links: [link],
        rectangles,
        anchor: { ...first, left, width: right - left },
        width: frame.width,
      })
    }
  }

  // Let the page-level list disambiguate overlapping annotations.
  const placements = [...matches.values()]
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
    placed.placements.map(({ links, rectangles, anchor, width }) => (
      <PdfLeanMark
        key={links[0].id}
        links={links}
        rectangles={rectangles}
        anchor={anchor}
        pageWidth={width}
        onOpen={onOpen}
      />
    )),
    sheet.element,
  )
}
