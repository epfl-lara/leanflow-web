import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import type { PaperLink } from './api'
import { Icon } from './Icons'

export interface PdfMarkBounds {
  left: number
  top: number
  width: number
  height: number
}

function markPosition(anchor: PdfMarkBounds, pageWidth: number) {
  const size = 24
  const inset = 4
  const before = anchor.left - size - 3
  const after = anchor.left + anchor.width + 3
  const hasMargin = before >= inset || after + size <= pageWidth - inset
  const left = before >= inset ? before : hasMargin ? after : inset
  const top = Math.max(
    inset,
    hasMargin ? anchor.top + (anchor.height - size) / 2 : anchor.top - size,
  )
  const availableAfter = pageWidth - left - inset
  const availableBefore = left + size - inset
  const alignEnd = availableAfter < 280 && availableBefore > availableAfter
  const below = top < 150
  const style: CSSProperties & {
    '--pdf-note-width': string
    '--pdf-note-height': string
  } = {
    left,
    top,
    '--pdf-note-width': `${Math.max(0, alignEnd ? availableBefore : availableAfter)}px`,
    '--pdf-note-height': `${below ? 240 : top - inset}px`,
  }
  return { left, top, style, alignEnd, below }
}

export function PdfLeanMark({
  links,
  rectangles,
  anchor = rectangles[0],
  pageWidth,
  onOpen,
}: {
  links: readonly PaperLink[]
  rectangles: readonly PdfMarkBounds[]
  anchor?: PdfMarkBounds
  pageWidth: number
  onOpen: (target: PaperLink['target']) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(false)
  const first = links[0]
  const annotated = links.some(({ difference }) => !!difference)
  const multiple = links.length > 1
  const disclosure = multiple || annotated
  const { left, top, style, alignEnd, below } = markPosition(anchor, pageWidth)
  const label = multiple
    ? `Show ${links.length} Lean declarations${annotated ? ' and formalization notes' : ''}`
    : annotated
      ? `Show formalization note for ${first.target.declaration}`
      : `Open ${first.target.declaration} in Lean`
  const closeOnEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape' || !expanded) return
    event.preventDefault()
    event.stopPropagation()
    trigger.current?.focus()
    setExpanded(false)
  }

  return (
    <div
      className="linked-pdf-mark"
      style={style}
      data-annotated={annotated || undefined}
      data-expanded={expanded || undefined}
      data-align-end={alignEnd || undefined}
      data-preview-below={below || undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setExpanded(false)
      }}
    >
      {rectangles.map((box, index) => (
        <span
          aria-hidden="true"
          className="linked-pdf-mark-part"
          key={index}
          style={{ ...box, left: box.left - left, top: box.top - top }}
        />
      ))}
      <button
        type="button"
        ref={trigger}
        className="linked-pdf-mark-button"
        aria-label={label}
        aria-expanded={disclosure ? expanded : undefined}
        aria-controls={expanded ? id : undefined}
        onKeyDown={disclosure ? closeOnEscape : undefined}
        onClick={() => {
          if (disclosure) {
            trigger.current?.focus()
            setExpanded((current) => !current)
          } else onOpen(first.target)
        }}
      >
        <Icon
          name={annotated ? 'info' : multiple ? 'log' : 'arrow'}
          size={14}
        />
      </button>
      {!disclosure && (
        <div className="linked-pdf-mark-preview" aria-hidden="true">
          <strong>{first.target.declaration}</strong>
          <small>
            {first.target.path}:{first.target.line}
          </small>
        </div>
      )}
      {expanded && (
        <div className="linked-pdf-mark-details" id={id}>
          {links.map(({ id, target, difference }) => (
            <div key={id}>
              {difference && (
                <p className="paper-link-difference">
                  <strong>Formalization note</strong>
                  {difference}
                </p>
              )}
              <button
                type="button"
                className="linked-pdf-mark-destination"
                aria-label={`Open ${target.declaration} in Lean`}
                onKeyDown={closeOnEscape}
                onClick={() => {
                  setExpanded(false)
                  onOpen(target)
                }}
              >
                <span>
                  <strong>{target.declaration}</strong>
                  <small>
                    {target.path}:{target.line}
                  </small>
                </span>
                <Icon name="arrow" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
