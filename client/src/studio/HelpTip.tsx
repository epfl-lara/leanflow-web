import { useRef, useState, type ReactNode } from 'react'
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
  function close() {
    pinned.current = false
    setOpen(false)
  }
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
        slotProps={{ tooltip: { className: 'help-tooltip' } }}
      >
        <button
          type="button"
          className="help-tip"
          aria-label={`About ${label}`}
          onBlur={close}
          onClick={(event) => {
            // Keep help inside a section summary from collapsing the section.
            event.preventDefault()
            event.stopPropagation()
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
