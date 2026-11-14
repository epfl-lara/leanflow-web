import { useEffect, useRef, useId } from 'react'
import type { OpenFile } from './api'
import { Icon } from './Icons'

export function FileTabs({
  paths,
  previewPath,
  file,
  buffers,
  opening,
  joining,
  onSelect,
  onClose,
  onKeepOpen,
}: {
  paths: readonly string[]
  previewPath: string | null
  file: OpenFile | null
  buffers: ReadonlyMap<string, OpenFile>
  opening: boolean
  joining: boolean
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onKeepOpen: (path: string) => void
}) {
  const descriptionId = useId()
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = list.current
    const reveal = () =>
      element
        ?.querySelector('.file-tab-item.active')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    reveal()
    const observer = new ResizeObserver(reveal)
    if (element) observer.observe(element)
    return () => observer.disconnect()
  }, [file?.path, paths])
  return (
    <div
      className="file-tabs"
      ref={list}
      role="tablist"
      aria-label="Open files"
    >
      {!paths.length && <span className="file-tabs-empty">Choose a file</span>}
      {paths.map((path, index) => {
        const active = path === file?.path
        const preview = path === previewPath
        const buffer = buffers.get(path)
        const dirty = !!buffer && buffer.content !== buffer.savedContent
        const name = path.split('/').at(-1) || path
        const duplicate = paths.some(
          (other) => other !== path && other.split('/').at(-1) === name,
        )
        return (
          <div
            className={`file-tab-item ${active ? 'active' : ''} ${preview ? 'preview' : ''}`}
            role="presentation"
            key={path}
          >
            <button
              className={`file-tab-button ${active ? 'file-tab' : ''}`}
              role="tab"
              aria-label={path}
              aria-describedby={`${descriptionId}-${index}`}
              aria-selected={active}
              aria-controls="file-editor-panel"
              tabIndex={active || (!file && path === paths[0]) ? 0 : -1}
              title={
                preview ? `${path} — Preview. Double-click to keep open.` : path
              }
              aria-disabled={opening}
              onClick={() => {
                if (!opening) onSelect(path)
              }}
              onDoubleClick={() => onKeepOpen(path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && preview && !opening) {
                  event.preventDefault()
                  onKeepOpen(path)
                  onSelect(path)
                  return
                }
                if (event.key === 'Delete' && !opening) {
                  event.preventDefault()
                  onClose(path)
                  return
                }
                const tabs = Array.from(
                  list.current?.querySelectorAll<HTMLButtonElement>(
                    '[role="tab"]',
                  ) || [],
                )
                const index = tabs.indexOf(event.currentTarget)
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index - 1 + tabs.length) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : null
                if (next !== null) {
                  event.preventDefault()
                  tabs[next]?.focus()
                }
              }}
            >
              <Icon name="file" size={14} />
              <span className="file-tab-name">{duplicate ? path : name}</span>
              {buffer?.readOnly && <span className="tag">Read only</span>}
              {active && joining && (
                <span className="tag">Joining live editing…</span>
              )}
              {dirty && (
                <span
                  className="dirty-dot"
                  aria-label="Unsaved changes"
                  title="Autosave pending"
                />
              )}
              {active && opening && <span className="spinner" />}
              <span
                className="file-tab-close"
                aria-hidden="true"
                title={`Close ${path}`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!opening) onClose(path)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <Icon name="close" size={12} />
              </span>
            </button>
            {preview && (
              <button
                className="file-tab-keep"
                aria-label={`Keep ${path} open`}
                title="Keep open"
                onClick={(event) => {
                  event.currentTarget.parentElement
                    ?.querySelector<HTMLButtonElement>('[role="tab"]')
                    ?.focus()
                  onKeepOpen(path)
                }}
              >
                <Icon name="pin" size={14} />
              </button>
            )}
            <span id={`${descriptionId}-${index}`} className="sr-only">
              {preview
                ? 'Preview. Use Keep open, double-click, or press Enter to keep open. '
                : ''}
              {dirty ? 'Unsaved changes. ' : ''}
              {buffer?.unavailable
                ? 'File deleted or moved. '
                : buffer?.readOnly
                  ? 'Read only. '
                  : ''}
              {active && joining ? 'Joining live editing. ' : ''}
              Press Delete to close this file.
            </span>
          </div>
        )
      })}
    </div>
  )
}
