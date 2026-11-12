import { useId, useMemo, useState } from 'react'
import { Icon } from './Icons'
import type { EditorProofState, ProofEditorRequest } from './proofTarget'

export function ChatFocusOptions({
  editor,
  filter,
  onFocus,
}: {
  editor: EditorProofState
  filter: string
  onFocus: (request: Omit<ProofEditorRequest, 'id'>) => void
}) {
  const id = useId()
  const [lineRange, setLineRange] = useState('')
  const [lineError, setLineError] = useState('')
  const disabled = editor.disabled || editor.readOnly
  const declarations = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return editor.declarations.filter(
      (item) =>
        item.kind !== 'import' &&
        (!query || `${item.name} ${item.kind}`.toLowerCase().includes(query)),
    )
  }, [editor.declarations, filter])

  const choose = (request: Omit<ProofEditorRequest, 'id'>) => {
    if (disabled) return
    onFocus({ ...request, path: editor.path })
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
    if (editor.lineCount && endLine > editor.lineCount) {
      setLineError(
        `This file has ${editor.lineCount} lines. Choose a range within the file.`,
      )
      return
    }
    setLineError('')
    choose({ lines: { startLine, endLine } })
  }

  return (
    <section className="chat-focus-options" aria-label="Declarations and lines">
      <div className="chat-focus-heading">
        <strong>From the editor</strong>
        <span title={editor.path}>{editor.path}</span>
      </div>
      <button
        type="button"
        className="chat-focus-current"
        disabled={disabled || !editor.target}
        onClick={() =>
          choose(
            editor.hasSelection && editor.target
              ? {
                  lines: {
                    startLine: editor.target.startLine,
                    endLine: editor.target.endLine,
                  },
                }
              : {},
          )
        }
      >
        <Icon name="arrow" size={13} />
        <span>
          <strong>
            {editor.hasSelection
              ? 'Use selected lines'
              : 'Use current declaration'}
          </strong>
          <small>
            {editor.target
              ? `${editor.hasSelection ? 'Selected lines' : editor.target.name || 'Selected lines'} · lines ${editor.target.startLine}${editor.target.endLine === editor.target.startLine ? '' : `–${editor.target.endLine}`}`
              : editor.readOnly
                ? 'Choose a writable project file.'
                : 'Highlight lines or click inside a declaration in the editor.'}
          </small>
        </span>
      </button>
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
      <div className="file-context-section">Declarations</div>
      <ul
        className="chat-focus-declarations"
        aria-label="Proof targets in this file"
      >
        {declarations.map((declaration) => (
          <li
            key={`${declaration.name}:${declaration.startLine}:${declaration.startColumn}`}
          >
            <button
              type="button"
              className="chat-focus-declaration"
              disabled={disabled}
              onClick={() => choose({ declaration })}
              title={`Add ${declaration.name}, lines ${declaration.startLine}–${declaration.endLine}`}
            >
              <span
                className={`declaration-kind declaration-kind-${declaration.kind || 'other'}`}
              >
                {declaration.kind || 'declaration'}
              </span>
              <span className="chat-focus-name">{declaration.name}</span>
              <span className="chat-focus-line">{declaration.startLine}</span>
            </button>
          </li>
        ))}
        {!declarations.length && (
          <li className="chat-focus-help">
            {editor.status === 'loading'
              ? 'Reading declarations…'
              : filter.trim()
                ? 'No declarations match.'
                : 'Select editor text or enter line numbers above.'}
          </li>
        )}
      </ul>
    </section>
  )
}
