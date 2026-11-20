import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { CopyButton } from './CopyButton'
import { getFailures, subscribeToFailures } from './failureLog'
import { Icon } from './Icons'
import './failure-log.css'

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' })

export function WorkspaceStatusBar({ children }: { children: ReactNode }) {
  const entries = useSyncExternalStore(subscribeToFailures, getFailures)
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const headingId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (open) panel.current?.focus()
  }, [open])

  return (
    <>
      {open && (
        <section
          ref={panel}
          id={panelId}
          className="failure-log"
          aria-labelledby={headingId}
          tabIndex={-1}
        >
          <header className="failure-log-header">
            <h2 id={headingId}>Failure log</h2>
            {entries.length > 0 && (
              <CopyButton
                label="Copy log"
                text={entries
                  .map(({ time, action, code, message, count }) => {
                    const repeats = count > 1 ? ` (${count} occurrences)` : ''
                    return `${new Date(time).toISOString()} · ${action} · ${code}${repeats}\n${message}`
                  })
                  .join('\n\n')}
              />
            )}
            <button
              type="button"
              className="icon-button"
              title="Close failure log"
              aria-label="Close failure log"
              onClick={() => {
                setOpen(false)
                toggle.current?.focus()
              }}
            >
              <Icon name="close" size={15} />
            </button>
          </header>
          {entries.length === 0 ? (
            <p className="failure-log-empty">
              No failures recorded in this tab yet.
            </p>
          ) : (
            <ol className="failure-log-entries" aria-label="Recent failures">
              {entries.map(({ id, time, action, code, message, count }) => (
                <li key={id}>
                  <div className="failure-log-entry-header">
                    <time
                      dateTime={new Date(time).toISOString()}
                      title={new Date(time).toLocaleString()}
                    >
                      {clock.format(time)}
                    </time>
                    <strong>{action}</strong>
                    <span>{code}</span>
                    {count > 1 && <span>{count} occurrences</span>}
                  </div>
                  <p>{message}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <footer className="statusbar">
        {children}
        <button
          ref={toggle}
          type="button"
          className="failure-log-toggle"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          data-has-failures={entries.length > 0}
          onClick={() => setOpen(!open)}
        >
          <Icon name="log" size={13} />
          Failure log
        </button>
      </footer>
    </>
  )
}
