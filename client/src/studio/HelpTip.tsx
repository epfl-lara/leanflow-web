import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import ClickAwayListener from '@mui/material/ClickAwayListener'
import Tooltip from '@mui/material/Tooltip'
import { Icon } from './Icons'
import './help-tip.css'

export function HelpTip({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const button = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    pinned.current = false
    setOpen(false)
  }, [])
  useEffect(() => {
    if (!open) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Dismiss the help before the browser cancels its containing dialog.
      event.preventDefault()
      event.stopImmediatePropagation()
      close()
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [close, open])
  return (
    <ClickAwayListener onClickAway={close}>
      <Tooltip
        title={
          <>
            <strong>{label}</strong>
            {children}
          </>
        }
        describeChild
        placement="bottom"
        open={open}
        onOpen={() => setOpen(true)}
        onClose={(event) => {
          if (!pinned.current || event.type === 'keydown') close()
        }}
        disableTouchListener
        enterDelay={0}
        enterNextDelay={0}
        slotProps={{
          tooltip: { className: 'help-tooltip' },
          popper: {
            // Native dialogs occupy the browser's top layer, above body portals.
            container: () => button.current?.closest('dialog') || document.body,
          },
        }}
      >
        <button
          ref={button}
          type="button"
          className="help-tip"
          aria-label={`About ${label}`}
          onBlur={close}
          onClick={(event) => {
            // Keep help inside a section summary from collapsing the section.
            event.preventDefault()
            event.stopPropagation()
            if (pinned.current) {
              close()
              return
            }
            pinned.current = true
            setOpen(true)
          }}
        >
          <Icon name="info" size={14} />
        </button>
      </Tooltip>
    </ClickAwayListener>
  )
}
