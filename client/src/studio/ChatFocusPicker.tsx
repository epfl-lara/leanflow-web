import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useComposerPopoverPosition } from './useComposerPopoverPosition'
import { Icon } from './Icons'
import type { EditorProofState, ProofEditorRequest } from './proofTarget'

export function ChatFocusPicker({
  editor,
  onFocus,
}: {
  editor?: EditorProofState
  onFocus: (request: Omit<ProofEditorRequest, 'id'>) => void
}) {
  const id = useId()
  const control = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const position = useComposerPopoverPosition(open, control)
  const positioned = position !== null
  const [filter, setFilter] = useState('')
  const [lineRange, setLineRange] = useState('')
  const [lineError, setLineError] = useState('')
  const disabled = !editor?.path || editor.disabled || editor.readOnly
  const declarations = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return (editor?.declarations || []).filter(
      (item) =>
        !query || `${item.name} ${item.kind}`.toLowerCase().includes(query),
    )
  }, [editor?.declarations, filter])

  useLayoutEffect(() => {
    if (open && positioned) search.current?.focus({ preventScroll: true })
  }, [open, positioned])
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !control.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])
  useEffect(() => {
    setLineError('')
    setLineRange('')
    setFilter('')
  }, [editor?.path])

  const choose = (request: Omit<ProofEditorRequest, 'id'>) => {
    if (disabled || !editor) return
    onFocus({ path: editor.path, ...request })
    setOpen(false)
  }
  function chooseLines() {
    const match = /^(\d+)\s*(?:[-–:]\s*(\d+))?$/.exec(lineRange.trim())
    const startLine = Number(match?.[1])
    const endLine = Number(match?.[2] || match?.[1])
    if (
      !match ||
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine
    ) {
      setLineError('Enter a line number or range, such as 70–74.')
      return
    }
    if (editor?.lineCount && endLine > editor.lineCount) {
      setLineError(
        `This file has ${editor.lineCount} lines. Choose a range within the file.`,
      )
      return
    }
    setLineError('')
    choose({ lines: { startLine, endLine } })
  }

  return (
    <div
      className="chat-focus-control"
      ref={control}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          trigger.current?.focus({ preventScroll: true })
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="chat-focus-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="log" size={14} />
        Focus proof / lines
        <Icon name="chevron" size={11} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="chat-focus-popover"
            style={{ ...position, visibility: position ? 'visible' : 'hidden' }}
            id={`${id}-panel`}
            role="dialog"
            aria-label="Choose a proof or lines"
          >
            <div className="chat-focus-heading">
              <strong>Focus Lemex on</strong>
              <span title={editor?.path}>
                {editor?.path || 'Open a Lean file'}
              </span>
            </div>
            <button
              type="button"
              className="chat-focus-current"
              disabled={disabled || !editor?.target}
              onClick={() => choose({})}
            >
              <Icon name="arrow" size={13} />
              <span>
                <strong>Use editor selection or current proof</strong>
                <small>
                  {editor?.target
                    ? `${editor.target.name || 'Selected lines'} · lines ${editor.target.startLine}${editor.target.endLine === editor.target.startLine ? '' : `–${editor.target.endLine}`}`
                    : editor?.readOnly
                      ? 'Choose a writable project file to edit a proof.'
                      : 'Click inside a declaration or select lines in the editor.'}
                </small>
              </span>
            </button>
            <label className="sr-only" htmlFor={`${id}-filter`}>
              Find a proof to focus
            </label>
            <input
              ref={search}
              id={`${id}-filter`}
              type="search"
              placeholder="Find a theorem, definition…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault()
              }}
            />
            <div
              className="chat-focus-declarations"
              role="list"
              aria-label="Proof targets in this file"
            >
              {declarations.map((declaration) => (
                <button
                  key={`${declaration.name}:${declaration.startLine}:${declaration.startColumn}`}
                  type="button"
                  className="chat-focus-declaration"
                  disabled={disabled || declaration.kind === 'import'}
                  onClick={() => choose({ declaration })}
                  title={`Focus on ${declaration.name}, lines ${declaration.startLine}–${declaration.endLine}`}
                >
                  <span
                    className={`declaration-kind declaration-kind-${declaration.kind || 'other'}`}
                  >
                    {declaration.kind || 'declaration'}
                  </span>
                  <span className="chat-focus-name">{declaration.name}</span>
                  <span className="chat-focus-line">
                    {declaration.startLine}
                  </span>
                </button>
              ))}
              {!declarations.length && (
                <p className="chat-focus-help">
                  {editor?.status === 'loading'
                    ? 'Reading declarations…'
                    : filter.trim()
                      ? 'No declarations match. Try selecting lines instead.'
                      : 'Select editor text or enter line numbers below.'}
                </p>
              )}
            </div>
            <div className="chat-focus-lines">
              <label htmlFor={`${id}-lines`}>Lines</label>
              <input
                id={`${id}-lines`}
                placeholder="e.g. 70–74"
                value={lineRange}
                disabled={disabled}
                onChange={(event) => {
                  setLineRange(event.target.value)
                  setLineError('')
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    chooseLines()
                  }
                }}
                aria-describedby={lineError ? `${id}-error` : undefined}
                aria-invalid={!!lineError}
              />
              <button
                type="button"
                className="button small secondary"
                disabled={disabled || !lineRange.trim()}
                onClick={chooseLines}
              >
                Use lines
              </button>
            </div>
            {lineError && (
              <p id={`${id}-error`} className="error-message" role="alert">
                {lineError}
              </p>
            )}
            <p className="chat-focus-help">
              Adds a visible target to this message. Send when ready.
            </p>
          </div>,
          document.body,
        )}
    </div>
  )
}
