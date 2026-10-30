import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'

export function useComposerPopoverPosition(
  open: boolean,
  control: RefObject<HTMLElement | null>,
) {
  const [position, setPosition] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const anchor =
      control.current?.closest('.composer-attachments') || control.current
    if (!anchor) return
    const place = () => {
      const bounds = anchor.getBoundingClientRect()
      const viewport = window.visualViewport
      const viewportTop = viewport?.offsetTop || 0
      const viewportLeft = viewport?.offsetLeft || 0
      const viewportHeight = viewport?.height || window.innerHeight
      const viewportWidth = viewport?.width || window.innerWidth
      const margin = 8
      const gap = 7
      const width = Math.min(
        Math.max(bounds.width, 280),
        viewportWidth - margin * 2,
      )
      const left = Math.max(
        viewportLeft + margin,
        Math.min(bounds.left, viewportLeft + viewportWidth - margin - width),
      )
      const above = bounds.top - gap - viewportTop - margin
      const below = viewportTop + viewportHeight - margin - bounds.bottom - gap
      let next: CSSProperties
      if (Math.max(above, below) < 120) {
        next = {
          left,
          width,
          top: viewportTop + margin,
          maxHeight: Math.max(0, viewportHeight - margin * 2),
        }
      } else if (above >= below) {
        const bottomEdge = Math.min(
          bounds.top - gap,
          viewportTop + viewportHeight - margin,
        )
        next = {
          left,
          width,
          bottom: window.innerHeight - bottomEdge,
          maxHeight: Math.min(420, bottomEdge - viewportTop - margin),
        }
      } else {
        const top = Math.max(bounds.bottom + gap, viewportTop + margin)
        next = {
          left,
          width,
          top,
          maxHeight: Math.min(420, viewportTop + viewportHeight - margin - top),
        }
      }
      setPosition((previous) =>
        previous &&
        (['left', 'width', 'top', 'bottom', 'maxHeight'] as const).every(
          (key) => previous[key] === next[key],
        )
          ? previous
          : next,
      )
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(anchor)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [open, control])
  return position
}
