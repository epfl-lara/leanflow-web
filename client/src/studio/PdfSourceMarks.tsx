import { useMemo, useState, type CSSProperties } from 'react'
import type { PaperLink } from './api'
import { Icon } from './Icons'
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
  const [tap, setTap] = useState<string | null>(null)
  const areas = useMemo(() => {
    const groups = new Map<
      string,
      {
        rectangles: NonNullable<ReturnType<typeof pdfSourceBoxBounds>>[]
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

  return areas.map(
    ([
      id,
      {
        rectangles: [anchor, ...rest],
        links,
      },
    ]) => {
      const style: CSSProperties & { '--source-box-height': string } = {
        top: anchor.top,
        left: anchor.left,
        '--source-box-height': `${anchor.height}px`,
      }
      return (
        <div
          key={id}
          style={style}
          className="linked-pdf-source-mark"
          data-tapped={tap === id || undefined}
          data-below={anchor.top < 44 || undefined}
          onPointerUp={(event) => {
            if (
              event.pointerType === 'touch' &&
              event.target instanceof Element &&
              event.target.classList.contains('linked-pdf-source-hit')
            )
              setTap((current) => (current === id ? null : id))
          }}
        >
          {[anchor, ...rest].map((box, index) => (
            <span
              key={index}
              aria-hidden="true"
              className="linked-pdf-source-hit"
              style={{
                ...box,
                left: box.left - anchor.left,
                top: box.top - anchor.top,
              }}
            />
          ))}
          <div className="linked-pdf-source-actions">
            {links.map(({ id, target }) => (
              <button
                key={id}
                type="button"
                className="linked-pdf-source-lean"
                aria-label={`Open ${target.declaration} in Lean`}
                onClick={() => onOpen(target)}
              >
                <span>
                  <strong>Open in Lean</strong>
                  <code>{target.declaration}</code>
                </span>
                <Icon name="arrow" size={14} />
              </button>
            ))}
          </div>
        </div>
      )
    },
  )
}
