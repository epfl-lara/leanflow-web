import { useId, useState } from 'react'
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
  onUseDeclaration,
}: {
  declarations: ProofDeclaration[]
  status: 'loading' | 'ready' | 'unavailable'
  target: ProofTarget | null
  error?: string
  disabled: boolean
  readOnly: boolean
  onSelect: (declaration: ProofDeclaration) => void
  onFocus: (mode: ChatMode) => void
  onUseDeclaration?: (declaration: ProofDeclaration, mode?: ChatMode) => void
}) {
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  const id = useId()
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = declarations.filter((item) =>
    `${item.name} ${item.kind || 'declaration'}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  )
  const hint = readOnly
    ? 'Library source is read-only.'
    : error ||
      (target
        ? `${target.name || 'Selected lines'} · ${target.startLine === target.endLine ? `line ${target.startLine}` : `lines ${target.startLine}–${target.endLine}`}`
        : 'Choose a declaration or select lines, then ask Lemex.')
  return (
    <section
      className={`proof-outline-sidebar${open ? '' : ' collapsed'}`}
      aria-label="File outline"
    >
      <button
        type="button"
        className="proof-outline-heading"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <Icon
          name="chevron"
          size={13}
          style={{ transform: open ? 'rotate(90deg)' : undefined }}
        />
        <span>Outline</span>
        <small>{declarations.length}</small>
      </button>
      {open && (
        <div className="proof-outline-content" id={id}>
          <div className="proof-outline-filter">
            <Icon name="search" size={14} />
            <input
              type="search"
              aria-label="Find a declaration"
              placeholder="Filter declarations…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ul
            className="proof-outline-results"
            aria-label="Declarations in this file"
          >
            {filtered.map((item) => {
              const kind = item.kind || 'other'
              const active =
                item.kind !== 'import' &&
                target &&
                (target.name === item.name ||
                  (target.startLine >= item.startLine &&
                    target.endLine <= item.endLine))
              return (
                <li
                  key={`${item.startLine}:${item.startColumn}:${item.name}`}
                  className={
                    active ? 'proof-outline-row active' : 'proof-outline-row'
                  }
                >
                  <button
                    type="button"
                    className="proof-outline-entry"
                    title={`${item.name} · ${kind} · line ${item.startLine}`}
                    disabled={disabled}
                    aria-current={active ? 'location' : undefined}
                    onClick={() => onSelect(item)}
                  >
                    <span
                      className={`proof-outline-kind proof-outline-kind-${kind}`}
                    >
                      {kind === 'other' ? 'symbol' : kind}
                    </span>
                    <span className="proof-outline-name">{item.name}</span>
                    <small>L{item.startLine}</small>
                  </button>
                  {kind !== 'import' && onUseDeclaration && (
                    <button
                      type="button"
                      className="proof-outline-chat-action"
                      aria-label={`Focus ${item.name} in chat`}
                      title={
                        readOnly
                          ? 'Library source is read-only'
                          : 'Focus this declaration in chat'
                      }
                      disabled={disabled || readOnly}
                      onClick={() => onUseDeclaration(item)}
                    >
                      <Icon name="plus" size={12} /> Chat
                    </button>
                  )}
                </li>
              )
            })}
            {!filtered.length && (
              <li className="proof-outline-empty">
                {normalizedQuery
                  ? 'No matching declarations.'
                  : status === 'loading'
                    ? 'Loading Lean outline…'
                    : status === 'unavailable'
                      ? 'Lean outline is unavailable. Select lines in the editor to focus the chat.'
                      : 'No declarations in this file.'}
              </li>
            )}
          </ul>
          <div className="proof-outline-focus">
            <p className={error ? 'proof-focus-error' : ''} title={hint}>
              {hint}
            </p>
            <div className="proof-focus-actions">
              <button
                type="button"
                disabled={disabled || readOnly || !target}
                title="Ask about the current proof, definition, or selected lines"
                onClick={() => onFocus('search')}
              >
                <Icon name="bot" size={15} /> Ask Lemex
              </button>
              <button
                type="button"
                disabled={disabled || readOnly || !target}
                title="Focus proof optimization on the current proof or selected lines"
                onClick={() => onFocus('optimize')}
              >
                Optimize
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
