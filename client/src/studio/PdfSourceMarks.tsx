import {
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import type { PaperLink } from './api'
import { Icon } from './Icons'
import {
  PdfLeanBadgeText,
  PdfLeanPreview,
  pdfLeanBadgePosition,
} from './PdfLeanBadge'
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
  const [hover, setHover] = useState<string | null>(null)
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
      const style: CSSProperties = { top: anchor.top, left: anchor.left }
      const badge = pdfLeanBadgePosition(anchor, viewport.width, links.length)
      const target = links.length === 1 ? links[0].target : null
      const expanded = !target && (tap === id || hover === id)
      const close = () => {
        setTap((current) => (current === id ? null : current))
        setHover((current) => (current === id ? null : current))
      }
      const closeOnEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'Escape' || !expanded) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget
          .closest('.linked-pdf-source-actions')
          ?.querySelector<HTMLButtonElement>('.linked-pdf-lean-badge')
          ?.focus()
        close()
      }
      return (
        <div
          key={id}
          style={style}
          className="linked-pdf-source-mark"
          data-tapped={tap === id || undefined}
          onPointerEnter={(event) => {
            if (!target && event.pointerType !== 'touch') setHover(id)
          }}
          onPointerLeave={() => {
            if (!target)
              setHover((current) => (current === id ? null : current))
          }}
          onPointerUp={(event) => {
            if (
              event.pointerType === 'touch' &&
              event.target instanceof Element &&
              event.target.classList.contains('linked-pdf-source-hit')
            )
              setTap((current) => (current === id ? null : id))
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) close()
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
          <div
            className="linked-pdf-source-actions"
            style={badge.style}
            data-preview-below={badge.below || undefined}
            data-preview-align-end={badge.alignEnd || undefined}
          >
            {target ? (
              <button
                type="button"
                className="linked-pdf-source-lean linked-pdf-lean-badge"
                data-lean-badge-side={badge.side}
                aria-label={`Open ${target.declaration} in Lean`}
                onClick={() => onOpen(target)}
              >
                <PdfLeanBadgeText />
                <PdfLeanPreview target={target} />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="linked-pdf-lean-badge"
                  data-lean-badge-side={badge.side}
                  aria-expanded={expanded}
                  aria-label={`Show ${links.length} Lean declarations`}
                  onKeyDown={closeOnEscape}
                  onClick={() =>
                    setTap((current) => (current === id ? null : id))
                  }
                >
                  <PdfLeanBadgeText count={links.length} />
                </button>
                {expanded && (
                  <div className="linked-pdf-lean-preview linked-pdf-source-choices">
                    {links.map(({ id: linkId, target: choice }) => (
                      <button
                        key={linkId}
                        type="button"
                        className="linked-pdf-source-lean"
                        aria-label={`Open ${choice.declaration} in Lean`}
                        onKeyDown={closeOnEscape}
                        onFocus={() => setTap(id)}
                        onClick={() => {
                          close()
                          onOpen(choice)
                        }}
                      >
                        <span>
                          <strong>{choice.declaration}</strong>
                          <small>
                            {choice.path}:{choice.line}
                          </small>
                        </span>
                        <Icon name="arrow" size={14} />
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )
    },
  )
}
