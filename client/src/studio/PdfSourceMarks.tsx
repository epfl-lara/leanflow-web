import { useMemo } from 'react'
import type { PaperLink } from './api'
import { PdfLeanMark, type PdfMarkBounds } from './PdfLeanMark'
import {
  pdfSourceBoxBounds,
  pdfSourceLinkMatches,
  type PdfSourcePage,
  type PdfViewport,
} from './pdfSourceNavigation'

export function PdfSourceMarks({
  mapping,
  viewport,
  dirtyPaths,
  onOpen,
}: {
  mapping: PdfSourcePage
  viewport: PdfViewport
  dirtyPaths?: ReadonlySet<string>
  onOpen: (location: PaperLink['target']) => void
}) {
  const areas = useMemo(() => {
    const groups = new Map<
      string,
      {
        rectangles: PdfMarkBounds[]
        links: PaperLink[]
      }
    >()
    for (const link of mapping.links) {
      const { source, status, target } = link
      if (
        status !== 'current' ||
        !('line' in source) ||
        dirtyPaths?.has(source.path) ||
        dirtyPaths?.has(target.path)
      )
        continue
      const id = JSON.stringify([source.path, source.line])
      const existing = groups.get(id)
      if (existing) {
        existing.links.push(link)
        continue
      }
      const rectangles = []
      const positions = new Set<string>()
      for (const box of mapping.boxes) {
        if (!pdfSourceLinkMatches(link, box)) continue
        const bounds = pdfSourceBoxBounds(viewport, box)
        if (!bounds) continue
        const key = JSON.stringify(bounds)
        if (positions.has(key)) continue
        positions.add(key)
        rectangles.push(bounds)
      }
      if (rectangles.length) groups.set(id, { rectangles, links: [link] })
    }
    return [...groups]
  }, [mapping, viewport, dirtyPaths])

  return areas.map(([id, { rectangles, links }]) => (
    <PdfLeanMark
      key={id}
      links={links}
      rectangles={rectangles}
      pageWidth={viewport.width}
      onOpen={onOpen}
    />
  ))
}
