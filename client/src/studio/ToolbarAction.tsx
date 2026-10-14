import type { ReactNode } from 'react'
import { HelpTip } from './HelpTip'

export function ToolbarAction({
  label,
  icon,
  help,
  pressed,
  disabled,
  onClick,
  className = '',
}: {
  label: string
  icon?: ReactNode
  help: ReactNode
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <fieldset
      className={`toolbar-action ${pressed ? 'selected' : ''} ${className}`}
      aria-label={label}
    >
      <button
        type="button"
        className="button small subtle"
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
        {label}
      </button>
      <HelpTip label={label}>{help}</HelpTip>
    </fieldset>
  )
}
