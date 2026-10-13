import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './Icons'
import type { ChatMode } from './chatModes'
import type { ProofDeclaration, ProofTarget } from './proofTarget'
import './proof-outline.css'

export function ProofOutline({
  declarations,
  status,
  target,
  error,
  disabled,
  readOnly,
  onSelect,
  onFocus,
}: {
  declarations: ProofDeclaration[]
  status: 'loading' | 'ready' | 'unavailable'
  target: ProofTarget | null
  error?: string
  disabled: boolean
  readOnly: boolean
  onSelect: (declaration: ProofDeclaration) => void
  onFocus: (mode: ChatMode) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const id = useId()
  const filtered = declarations.filter((item) =>
    item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        root.current?.contains(event.target as Node)
      ) {
        event.stopPropagation()
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const hint = readOnly
    ? 'Choose an editable Lean file to focus Lemex'
    : error ||
      (target
        ? `${target.name || 'Selected lines'} · ${target.startLine === target.endLine ? `line ${target.startLine}` : `lines ${target.startLine}–${target.endLine}`}`
        : 'Select lines or choose a declaration')
  return (
    <div className="proof-focus-toolbar" aria-label="Focus a proof">
      <div className="proof-outline" ref={root}>
        <button
          type="button"
          ref={button}
          className="proof-outline-trigger"
          aria-expanded={open}
          aria-controls={id}
          disabled={disabled}
          onClick={() => {
            setOpen(!open)
            setQuery('')
          }}
        >
          <Icon name="log" size={15} /> Outline{' '}
          <Icon name="chevron" size={12} />
        </button>
        {open && (
          <div className="proof-outline-popover" id={id}>
            <input
              ref={search}
              type="search"
              aria-label="Find a declaration"
              placeholder="Find a theorem, definition…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul
              className="proof-outline-results"
              aria-label="Declarations in this file"
            >
              {filtered.map((item) => (
                <li key={`${item.startLine}:${item.startColumn}:${item.name}`}>
                  <button
                    type="button"
                    title={item.name}
                    onClick={() => {
                      onSelect(item)
                      setOpen(false)
                    }}
                  >
                    <span>{item.name}</span>
                    <small>line {item.startLine}</small>
                  </button>
                </li>
              ))}
              {!filtered.length && (
                <li>
                  <p>
                    {query
                      ? 'No matching declarations.'
                      : status === 'loading'
                        ? 'Loading Lean outline… You can select lines while Lean checks the file.'
                        : status === 'unavailable'
                          ? 'Lean outline is unavailable. Select lines in the editor instead.'
                          : 'No declarations in this file. You can select lines in the editor.'}
                  </p>
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
      <span
        className={`proof-focus-hint ${error ? 'proof-focus-error' : ''}`}
        title={hint}
      >
        {hint}
      </span>
      <div className="proof-focus-actions">
        <button
          type="button"
          disabled={disabled || readOnly || !target}
          title={
            readOnly
              ? 'Library source is read-only'
              : 'Add this proof or selection to the chat'
          }
          onClick={() => onFocus('proofs')}
        >
          <Icon name="bot" size={15} /> Ask Lemex
        </button>
        <button
          type="button"
          disabled={disabled || readOnly || !target}
          title={
            readOnly
              ? 'Library source is read-only'
              : 'Focus proof optimization on this proof or selection'
          }
          onClick={() => onFocus('optimize')}
        >
          Optimize
        </button>
      </div>
    </div>
  )
}
