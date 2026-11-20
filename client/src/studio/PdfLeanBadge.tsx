import type { CSSProperties } from 'react'
import type { PaperLink } from './api'
import { Icon } from './Icons'

export function pdfLeanBadgePosition(
  {
    left,
    top,
    width,
    height,
  }: { left: number; top: number; width: number; height: number },
  pageWidth: number,
  count = 1,
) {
  const badgeWidth = count > 1 ? 72 : 52
  const badgeHeight = 22
  const right = left + width
  const after = right + 4 + badgeWidth <= pageWidth - 4
  const before = !after && left >= badgeWidth + 8
  const x = after
    ? right + 4
    : before
      ? left - badgeWidth - 4
      : Math.max(4, Math.min(right, pageWidth - 4) - badgeWidth)
  const y =
    after || before
      ? Math.max(2, top + (height - badgeHeight) / 2)
      : top >= badgeHeight + 2
        ? top - badgeHeight
        : top + height
  const fromStart = pageWidth - x - 4
  const fromEnd = x + badgeWidth - 4
  const alignEnd = fromStart < 280 && fromStart < fromEnd
  const previewWidth = Math.max(
    0,
    Math.min(280, alignEnd ? fromEnd : fromStart),
  )
  const below = y < 66
  const gap = below
    ? Math.max(0, top + height - (y + badgeHeight))
    : Math.max(0, y - top)
  const style: CSSProperties & {
    '--lean-preview-width': string
    '--lean-preview-gap': string
  } = {
    left: x - left,
    top: y - top,
    '--lean-preview-width': `${previewWidth}px`,
    '--lean-preview-gap': `${gap}px`,
  }
  return {
    style,
    below,
    alignEnd,
    side: after ? 'after' : before ? 'before' : undefined,
  }
}

export function PdfLeanBadgeText({ count = 1 }: { count?: number }) {
  return (
    <>
      <span>Lean{count > 1 && ` · ${count}`}</span>
      <Icon name="arrow" size={12} />
    </>
  )
}

export function PdfLeanPreview({ target }: { target: PaperLink['target'] }) {
  return (
    <span className="linked-pdf-lean-preview" aria-hidden="true">
      <span className="linked-pdf-lean-preview-name">
        <Icon name="fileCheck" size={14} />
        <strong>{target.declaration}</strong>
      </span>
      <small>
        {target.path}:{target.line}
      </small>
      <span className="linked-pdf-lean-preview-action">
        Open in Lean <Icon name="arrow" size={12} />
      </span>
    </span>
  )
}
