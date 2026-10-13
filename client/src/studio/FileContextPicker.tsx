import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FileEntry } from './api'
import { Icon } from './Icons'
import './chat-controls.css'

const MAX_FILES = 12
const MAX_RESULTS = 200

export interface FileContextPickerProps {
  files: FileEntry[]
  selected: string[]
  onChange: (paths: string[]) => void
  disabled: boolean
}

export function FileContextPicker({
  files,
  selected,
  onChange,
  disabled,
}: FileContextPickerProps) {
  const id = useId()
  const details = useRef<HTMLDetailsElement>(null)
  const filterInput = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState('')
  const selectedPaths = useMemo(() => [...new Set(selected)], [selected])
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths])
  const byPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  )
  const selectedFiles = selectedPaths.map(
    (path): FileEntry =>
      byPath.get(path) || { path, readOnly: path.startsWith('.lake/') },
  )
  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase()
    return files.filter(
      (file) =>
        !selectedSet.has(file.path) &&
        (!query || file.path.toLowerCase().includes(query)),
    )
  }, [files, filter, selectedSet])
  const visibleMatches = matches.slice(
    0,
    Math.max(0, MAX_RESULTS - selectedFiles.length),
  )
  const atLimit = selectedPaths.length >= MAX_FILES

  useEffect(() => {
    if (disabled && details.current) details.current.open = false
  }, [disabled])

  function change(path: string, checked: boolean) {
    if (disabled) return
    if (!checked) onChange(selectedPaths.filter((item) => item !== path))
    else if (!selectedSet.has(path) && !atLimit)
      onChange([...selectedPaths, path])
  }

  function option(file: FileEntry) {
    const checked = selectedSet.has(file.path)
    const readOnly = file.readOnly || file.path.startsWith('.lake/')
    const blocked = disabled || (!checked && atLimit)
    return (
      <label
        key={file.path}
        className={`file-context-option ${checked ? 'selected' : ''} ${blocked ? 'blocked' : ''}`}
        title={file.path}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => change(file.path, event.target.checked)}
          disabled={blocked}
          aria-label={file.path}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault()
          }}
        />
        <Icon name="file" size={13} />
        <span className="file-context-path">
          <span>{file.path.split('/').at(-1)}</span>
          {file.path.includes('/') && (
            <span className="file-context-directory">
              {file.path.slice(0, file.path.lastIndexOf('/'))}
            </span>
          )}
        </span>
        {readOnly && <span className="file-context-library">Read only</span>}
      </label>
    )
  }

  return (
    <div className="file-context-control">
      {selectedFiles.length > 0 && (
        <div className="file-context-chips" aria-label="Selected context files">
          {selectedFiles.map((file) => (
            <span
              key={file.path}
              className="file-context-chip"
              title={file.path}
            >
              <Icon name="file" size={11} />
              <span className="file-context-chip-name">
                {file.path.split('/').at(-1)}
              </span>
              {(file.readOnly || file.path.startsWith('.lake/')) && (
                <span className="file-context-chip-library">Library</span>
              )}
              <button
                type="button"
                aria-label={`Remove ${file.path} from context`}
                onClick={() => change(file.path, false)}
                disabled={disabled}
              >
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <details
        ref={details}
        className="file-context-picker"
        onToggle={(event) => {
          if (event.currentTarget.open) filterInput.current?.focus()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && details.current?.open) {
            event.preventDefault()
            event.stopPropagation()
            details.current.open = false
            details.current.querySelector('summary')?.focus()
          }
        }}
      >
        <summary
          aria-label="Select files"
          aria-controls={`${id}-panel`}
          aria-disabled={disabled}
          tabIndex={disabled ? -1 : 0}
          onClick={(event) => {
            if (disabled) event.preventDefault()
          }}
          onKeyDown={(event) => {
            if (disabled && ['Enter', ' '].includes(event.key))
              event.preventDefault()
          }}
        >
          <Icon name="plus" size={13} />
          <span>Select files</span>
          <span className="file-context-count" aria-hidden="true">
            {selectedPaths.length}/{MAX_FILES}
          </span>
          <Icon name="chevron" size={11} />
        </summary>
        <div className="file-context-popover" id={`${id}-panel`}>
          <label className="chat-controls-sr-only" htmlFor={`${id}-filter`}>
            Filter context files
          </label>
          <div className="file-context-filter">
            <Icon name="search" size={13} />
            <input
              id={`${id}-filter`}
              ref={filterInput}
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a project or library file…"
              disabled={disabled}
              autoComplete="off"
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault()
              }}
            />
          </div>
          <p className="file-context-help" role="status">
            {atLimit
              ? `${selectedPaths.length} files selected. ${selectedPaths.length === MAX_FILES ? 'Remove one to attach another.' : 'Choose no more than 12 files.'}`
              : 'Choose up to 12 files to include as context.'}
          </p>
          <div className="file-context-results">
            {selectedFiles.length > 0 && (
              <>
                <div className="file-context-section">Selected</div>
                {selectedFiles.map(option)}
              </>
            )}
            {visibleMatches.length > 0 && (
              <>
                <div className="file-context-section">
                  {filter.trim() ? 'Matching files' : 'Project and libraries'}
                </div>
                {visibleMatches.map(option)}
              </>
            )}
            {matches.length === 0 && (
              <p className="file-context-help">
                {filter.trim()
                  ? 'No more files match this filter.'
                  : files.length
                    ? 'All available files are selected.'
                    : 'No files are available yet.'}
              </p>
            )}
          </div>
          {matches.length > visibleMatches.length && (
            <p className="file-context-help">
              More matches are available. Narrow the filter to find them.
            </p>
          )}
        </div>
      </details>
    </div>
  )
}
