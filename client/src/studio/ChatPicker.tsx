import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { api, errorText } from './api'
import { Icon } from './Icons'
import './chat-controls.css'

export interface ChatChoice {
  id: string
  title: string
  updatedAt?: string
  runCount?: number
}

export interface ChatPickerProps {
  chats: ChatChoice[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete?: (chat: { id: string; title: string }) => void
  onRenamed: (chat: ChatChoice) => void
  disabled: boolean
  loading?: boolean
  deleteDisabled?: boolean
}

function ChatRenameForm({
  chat,
  onRenamed,
  onClose,
}: {
  chat: ChatChoice
  onRenamed: (chat: ChatChoice) => void
  onClose: () => void
}) {
  const id = useId()
  const [title, setTitle] = useState(chat.title)
  const [saving, setSaving] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  const revision = useRef(0)
  const suggestion = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    mounted.current = true
    input.current?.focus()
    input.current?.select()
    return () => {
      mounted.current = false
      suggestion.current?.abort()
    }
  }, [])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const name = title.trim()
    if (!name || name.length > 120) {
      setError('Enter a chat name between 1 and 120 characters.')
      input.current?.focus()
      return
    }
    ++revision.current
    suggestion.current?.abort()
    setSuggesting(false)
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const renamed = await api<ChatChoice>(
        `/api/chats/${encodeURIComponent(chat.id)}`,
        { method: 'PATCH', body: JSON.stringify({ title: name }) },
      )
      // Update the original chat's label even if the user navigated away.
      // The parent guards project unmounts and never changes the selection.
      onRenamed(renamed)
      if (mounted.current) onClose()
    } catch (error) {
      if (mounted.current) setError(errorText(error))
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  async function suggest() {
    if (saving || suggesting) return
    const requestedRevision = revision.current
    const controller = new AbortController()
    suggestion.current = controller
    setSuggesting(true)
    setError('')
    setNotice('')
    try {
      const value = await api<{ title: string; model: string }>(
        `/api/chats/${encodeURIComponent(chat.id)}/title`,
        { method: 'POST', body: '{}', signal: controller.signal },
      )
      if (!mounted.current || controller.signal.aborted) return
      // Suggestions must never overwrite a name typed while the request ran.
      if (revision.current !== requestedRevision) return
      setTitle(value.title)
      setNotice('Suggested name. Edit it or save to apply.')
    } catch (error) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        revision.current === requestedRevision
      )
        setError(errorText(error))
    } finally {
      if (mounted.current && suggestion.current === controller)
        setSuggesting(false)
    }
  }

  return (
    <form
      className="chat-rename-form"
      aria-label="Rename chat"
      onSubmit={(event) => void save(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <label htmlFor={id}>Chat name</label>
      <div className="chat-rename-field">
        <input
          id={id}
          ref={input}
          value={title}
          maxLength={120}
          disabled={saving}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          autoComplete="off"
          onChange={(event) => {
            ++revision.current
            setTitle(event.target.value)
            setError('')
            setNotice('')
          }}
        />
        <button type="submit" className="chat-control-button" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="chat-control-button chat-rename-cancel"
          disabled={saving}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
      {(chat.runCount || 0) > 0 && (
        <button
          type="button"
          className="chat-rename-suggest"
          disabled={saving || suggesting}
          onClick={() => void suggest()}
        >
          <Icon name="bot" size={14} />
          {suggesting ? 'Suggesting…' : 'Suggest with DeepSeek'}
        </button>
      )}
      {suggesting && (
        <span className="chat-controls-sr-only" role="status">
          Suggesting a chat name with DeepSeek.
        </span>
      )}
      {notice && (
        <p className="chat-rename-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="chat-rename-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

function updatedLabel(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
      }).format(date)
}

export function ChatPicker({
  chats,
  selectedId,
  onSelect,
  onNew,
  onDelete,
  onRenamed,
  disabled,
  loading = false,
  deleteDisabled = false,
}: ChatPickerProps) {
  const id = useId()
  const selected = chats.find((chat) => chat.id === selectedId)
  const [editingId, setEditingId] = useState<string | null>(null)
  const renameButton = useRef<HTMLButtonElement>(null)
  useEffect(() => setEditingId(null), [selectedId])
  const closeRename = () => {
    setEditingId(null)
    renameButton.current?.focus()
  }
  return (
    <div className="chat-picker" aria-busy={loading}>
      <label className="chat-picker-field" htmlFor={id}>
        <span>Chat</span>
        <div className="chat-picker-select">
          <select
            id={id}
            aria-label="Select chat"
            value={selectedId || ''}
            onChange={(event) => {
              if (event.target.value) onSelect(event.target.value)
            }}
            disabled={disabled || loading || chats.length === 0}
            title={selected?.title || 'New chat'}
          >
            <option value="" disabled>
              {loading ? 'Loading chats…' : 'New chat'}
            </option>
            {chats.map((chat) => {
              const updated = updatedLabel(chat.updatedAt)
              return (
                <option key={chat.id} value={chat.id}>
                  {chat.title.trim() || 'Untitled chat'}
                  {updated ? ` · ${updated}` : ''}
                </option>
              )
            })}
          </select>
          <Icon name="chevron" size={14} />
        </div>
      </label>
      {selected && (
        <button
          ref={renameButton}
          type="button"
          className="chat-control-button chat-picker-rename"
          title="Rename chat"
          aria-label="Rename chat"
          aria-expanded={editingId === selectedId}
          onClick={() =>
            setEditingId(editingId === selectedId ? null : selectedId)
          }
          disabled={disabled || loading}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m16 3 5 5-12 12-6 1 1-6ZM14 5l5 5" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className="chat-control-button chat-picker-new"
        onClick={onNew}
        disabled={disabled || loading}
      >
        <Icon name="plus" size={14} />
        New chat
      </button>
      {onDelete && selected && (
        <button
          type="button"
          className="chat-control-button chat-picker-delete"
          title="Move selected chat to trash"
          aria-label={`Delete chat ${selected.title || 'Untitled chat'}`}
          onClick={() => onDelete({ id: selected.id, title: selected.title })}
          disabled={disabled || loading || deleteDisabled}
        >
          <Icon name="trash" size={14} />
        </button>
      )}
      {selected && editingId === selected.id && (
        <ChatRenameForm
          key={selected.id}
          chat={selected}
          onRenamed={onRenamed}
          onClose={closeRename}
        />
      )}
    </div>
  )
}
