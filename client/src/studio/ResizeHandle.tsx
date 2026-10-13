import { useEffect, useRef, type PointerEvent } from 'react'
import { clamp } from './layout'

export function ResizeHandle({
  label,
  orientation,
  value,
  min,
  max,
  onChange,
  onReset,
  pixelsPerUnit = () => 1,
  direction = 1,
  className = '',
  unit = 'pixels',
}: {
  label: string
  orientation: 'vertical' | 'horizontal'
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  onReset: () => void
  pixelsPerUnit?: () => number
  direction?: 1 | -1
  className?: string
  unit?: string
}) {
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])
  function drag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    cleanup.current?.()
    const target = event.currentTarget
    const pointer = event.pointerId
    const start = orientation === 'vertical' ? event.clientX : event.clientY
    const scale = Math.max(0.01, pixelsPerUnit())
    target.setPointerCapture(pointer)
    document.body.classList.add('panel-resizing', `resizing-${orientation}`)
    target.dataset.dragging = 'true'
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointer) return
      const position = orientation === 'vertical' ? next.clientX : next.clientY
      onChange(
        clamp(value + (direction * (position - start)) / scale, min, max),
      )
    }
    const finish = (next?: globalThis.PointerEvent) => {
      if (next && next.pointerId !== pointer) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (target.hasPointerCapture(pointer))
        target.releasePointerCapture(pointer)
      document.body.classList.remove(
        'panel-resizing',
        'resizing-vertical',
        'resizing-horizontal',
      )
      delete target.dataset.dragging
      cleanup.current = null
    }
    cleanup.current = finish
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }
  return (
    <div
      className={`resize-handle ${orientation} ${className}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} ${unit}`}
      title={`${label}. Drag or use arrow keys; double-click to reset.`}
      onPointerDown={drag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const negative = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
        const positive = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
        const step = unit === 'percent' ? 2 : event.shiftKey ? 40 : 10
        let next: number | undefined
        if (event.key === negative) next = value - direction * step
        else if (event.key === positive) next = value + direction * step
        else if (event.key === 'Home') next = min
        else if (event.key === 'End') next = max
        if (next !== undefined) {
          event.preventDefault()
          onChange(clamp(next, min, max))
        }
      }}
    />
  )
}
