import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './context-menu.css'

interface MenuPosition {
  x: number
  y: number
  trigger: HTMLElement
}

export interface ContextMenuItem {
  label: string
  icon?: ReactNode
  disabled?: boolean
  title?: string
  description?: string
  danger?: boolean
  onSelect: () => void
}

export function useContextMenu<T>() {
  const [menu, setMenu] = useState<(MenuPosition & { target: T }) | null>(null)
  const current = useRef(menu)
  current.current = menu
  const close = useCallback((restoreFocus = false) => {
    if (restoreFocus) current.current?.trigger.focus({ preventScroll: true })
    setMenu(null)
  }, [])
  const open = useCallback((target: T, trigger: HTMLElement) => {
    const bounds = trigger.getBoundingClientRect()
    setMenu({ target, trigger, x: bounds.left, y: bounds.bottom })
  }, [])

  function focusTarget(element: HTMLElement) {
    return element.matches('button, [tabindex]')
      ? element
      : element.querySelector<HTMLButtonElement>('button') || element
  }

  function triggerProps(
    target: T,
    disabled = false,
  ): HTMLAttributes<HTMLElement> {
    return {
      'aria-haspopup': disabled ? undefined : 'menu',
      onContextMenu(event) {
        if (disabled) return
        event.preventDefault()
        event.stopPropagation()
        setMenu({
          target,
          x: event.clientX,
          y: event.clientY,
          trigger: focusTarget(event.currentTarget),
        })
      },
      onKeyDown(event) {
        if (
          disabled ||
          (event.key !== 'ContextMenu' &&
            !(event.shiftKey && event.key === 'F10'))
        )
          return
        event.preventDefault()
        event.stopPropagation()
        const bounds = event.currentTarget.getBoundingClientRect()
        setMenu({
          target,
          x: bounds.left,
          y: bounds.bottom,
          trigger: focusTarget(event.currentTarget),
        })
      },
    }
  }

  return { menu, open, close, triggerProps }
}

export function ContextMenu({
  position,
  label,
  items,
  onClose,
}: {
  position: MenuPosition
  label: string
  items: ContextMenuItem[]
  onClose: (restoreFocus?: boolean) => void
}) {
  const popup = useRef<HTMLDivElement>(null)
  const descriptionId = useId()
  const triggerBounds = useRef(position.trigger.getBoundingClientRect())
  const [style, setStyle] = useState<CSSProperties>({
    left: position.x,
    top: position.y,
    visibility: 'hidden',
  })

  useLayoutEffect(() => {
    triggerBounds.current = position.trigger.getBoundingClientRect()
    const place = () => {
      const bounds = popup.current?.getBoundingClientRect()
      if (!bounds) return
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft || 0
      const top = viewport?.offsetTop || 0
      const width = viewport?.width || window.innerWidth
      const height = viewport?.height || window.innerHeight
      const margin = 6
      setStyle({
        left: Math.max(
          left + margin,
          Math.min(position.x, left + width - bounds.width - margin),
        ),
        top: Math.max(
          top + margin,
          Math.min(position.y, top + height - bounds.height - margin),
        ),
        maxWidth: Math.max(0, width - margin * 2),
        maxHeight: Math.max(0, height - margin * 2),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    window.visualViewport?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('scroll', place)
    }
  }, [position])

  useLayoutEffect(() => {
    if (style.visibility === 'hidden') return
    const focus =
      popup.current?.querySelector<HTMLButtonElement>(
        'button:not(:disabled)',
      ) || popup.current
    focus?.focus({ preventScroll: true })
  }, [style.visibility])

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !popup.current?.contains(event.target)
      )
        onClose()
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target))
        return
      if (
        event.target instanceof Node &&
        !event.target.contains(position.trigger)
      )
        return
      const bounds = position.trigger.getBoundingClientRect()
      if (
        bounds.x === triggerBounds.current.x &&
        bounds.y === triggerBounds.current.y
      )
        return
      onClose(popup.current?.contains(document.activeElement))
    }
    const blur = () => onClose()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', blur)
    }
  }, [onClose, position])

  return createPortal(
    <div
      ref={popup}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      className="workspace-context-menu"
      style={style}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose(true)
          return
        }
        if (event.key === 'Tab') {
          onClose(true)
          return
        }
        const buttons = [
          ...(popup.current?.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled)',
          ) || []),
        ]
        const index = buttons.findIndex(
          (button) => button === document.activeElement,
        )
        const next =
          event.key === 'ArrowDown'
            ? (index + 1) % buttons.length
            : event.key === 'ArrowUp'
              ? (index - 1 + buttons.length) % buttons.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : -1
        if (next < 0 || !buttons[next]) return
        event.preventDefault()
        buttons[next].focus()
      }}
    >
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={item.danger ? 'danger' : undefined}
          disabled={item.disabled}
          title={item.title}
          aria-label={item.label}
          aria-describedby={
            item.description ? `${descriptionId}-${index}` : undefined
          }
          onClick={() => {
            onClose(true)
            item.onSelect()
          }}
        >
          {item.icon}
          <span>
            <span>{item.label}</span>
            {item.description && (
              <span
                className="context-menu-description"
                id={`${descriptionId}-${index}`}
              >
                {item.description}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
