import { useId } from 'react'
import { Icon } from './Icons'
import './chat-controls.css'

export interface ChatChoice {
  id: string
  title: string
  updatedAt?: string
}

export interface ChatPickerProps {
  chats: ChatChoice[]
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete?: (chat: { id: string; title: string }) => void
  disabled: boolean
  loading?: boolean
  deleteDisabled?: boolean
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
  disabled,
  loading = false,
  deleteDisabled = false,
}: ChatPickerProps) {
  const id = useId()
  const selected = chats.find((chat) => chat.id === selectedId)
  return (
    <div className="chat-picker" aria-busy={loading}>
      <label className="chat-picker-field" htmlFor={id}>
        <span>Chat</span>
        <select
          id={id}
          aria-label="Select chat"
          value={selectedId || ''}
          onChange={(event) => {
            if (event.target.value) onSelect(event.target.value)
          }}
          disabled={disabled || loading || chats.length === 0}
          title={selected?.title || 'Choose a chat'}
        >
          <option value="" disabled>
            {loading
              ? 'Loading chats…'
              : chats.length
                ? 'Choose a chat'
                : 'No chats yet'}
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
      </label>
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
    </div>
  )
}
