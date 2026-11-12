import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { FileEntry } from './api'
import { Icon } from './Icons'
import {
  fileMentionQuery,
  insertFileMention,
  matchingProjectFiles,
} from './fileMentions'

export function FileMentionTextarea({
  value,
  onChange,
  files,
  selected,
  onAddFile,
  placeholder,
  scope,
}: {
  value: string
  onChange: (value: string) => void
  files: FileEntry[]
  selected: string[]
  onAddFile: (path: string) => boolean
  placeholder: string
  scope: string
}) {
  const field = useRef<HTMLTextAreaElement>(null),
    list = useRef<HTMLDivElement>(null),
    pendingSelection = useRef<{
      text: string
      caret: number
      scope: string
    } | null>(null),
    id = useId()
  const [caret, setCaret] = useState(value.length),
    [active, setActive] = useState(0),
    [dismissed, setDismissed] = useState(false)
  const query = fileMentionQuery(value, caret)
  const matches = useMemo(
    () => (query ? matchingProjectFiles(files, query.query) : []),
    [files, query?.query],
  )
  const open = !!query && !dismissed
  const choice = Math.min(active, Math.max(0, matches.length - 1))
  useLayoutEffect(() => {
    const selection = pendingSelection.current
    pendingSelection.current = null
    if (selection?.scope === scope && field.current?.value === selection.text) {
      field.current.focus()
      field.current.setSelectionRange(selection.caret, selection.caret)
    }
  }, [scope, value])
  useEffect(() => {
    setCaret(value.length)
    setActive(0)
    setDismissed(false)
  }, [scope])
  useEffect(() => {
    setActive(0)
  }, [query?.query])
  useEffect(() => {
    const container = list.current
    const option = container?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    )
    if (!container || !option) return
    const bounds = container.getBoundingClientRect()
    const selectedBounds = option.getBoundingClientRect()
    // Keep keyboard choices visible without moving the composer or transcript.
    if (selectedBounds.top < bounds.top)
      container.scrollTop -= bounds.top - selectedBounds.top
    else if (selectedBounds.bottom > bounds.bottom)
      container.scrollTop += selectedBounds.bottom - bounds.bottom
  }, [open, choice, query?.query])
  function select(path: string) {
    if (!query || !onAddFile(path)) return
    const inserted = insertFileMention(value, query, path)
    pendingSelection.current = { ...inserted, scope }
    onChange(inserted.text)
    setCaret(inserted.caret)
    setDismissed(true)
  }
  return (
    <div className="file-mention-field">
      <textarea
        id="assistant-prompt"
        ref={field}
        aria-label="Message Lemex"
        aria-autocomplete="list"
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={
          open && matches.length ? `${id}-${choice}` : undefined
        }
        placeholder={placeholder}
        rows={3}
        maxLength={32000}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setCaret(event.target.selectionStart)
          setDismissed(false)
        }}
        onSelect={(event) =>
          setCaret(
            event.currentTarget.selectionStart ===
              event.currentTarget.selectionEnd
              ? event.currentTarget.selectionStart
              : -1,
          )
        }
        onClick={() => setDismissed(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
            event.preventDefault()
            if (event.repeat) return
            if (open && matches.length && !event.ctrlKey && !event.metaKey) {
              select(matches[choice].path)
              return
            }
            setDismissed(true)
            const form = event.currentTarget.form
            const submit = form?.querySelector<HTMLButtonElement>(
              'button[type="submit"]',
            )
            if (submit && !submit.disabled) form?.requestSubmit(submit)
            return
          }
          if (!open) return
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setDismissed(true)
          } else if (
            matches.length &&
            ['ArrowUp', 'ArrowDown'].includes(event.key)
          ) {
            event.preventDefault()
            setActive(
              (index) =>
                (index +
                  (event.key === 'ArrowDown' ? 1 : -1) +
                  matches.length) %
                matches.length,
            )
          }
        }}
      />
      {open && (
        <div className="file-mention-popover">
          <div className="file-mention-heading">
            Project files <span>↑ ↓ · Enter to attach</span>
          </div>
          <div
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label="Project files"
          >
            {matches.map((file, index) => (
              <button
                key={file.path}
                type="button"
                id={`${id}-${index}`}
                role="option"
                aria-selected={index === choice}
                tabIndex={-1}
                disabled={
                  selected.length >= 12 && !selected.includes(file.path)
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(file.path)}
              >
                <Icon name="file" size={13} />
                <span>{file.path}</span>
                {selected.includes(file.path) && (
                  <Icon name="check" size={12} />
                )}
              </button>
            ))}
          </div>
          {!matches.length && (
            <p className="field-help">No project files match.</p>
          )}
          {selected.length >= 12 && (
            <p className="field-help">
              12 files attached. Remove one to attach another.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
