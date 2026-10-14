import { Icon } from './Icons'
import { HelpTip } from './HelpTip'
import type { Project } from './api'
import type { ReactNode } from 'react'

export function WorkspaceList({
  projects,
  selectedId,
  disabled,
  onSelect,
  onDelete,
  onRename,
  playgroundActions,
}: {
  projects: Project[]
  selectedId: string | null
  disabled: boolean
  onSelect: (id: string) => void
  onDelete: (project: Project) => void
  onRename: (project: Project) => void
  playgroundActions: ReactNode
}) {
  return (
    <div className="workspace-lists">
      {[
        {
          title: 'Playgrounds',
          help: 'Start a single Lean file with Mathlib ready to use. Choose New playground or Open .lean file. Convert to a project when you need more files or custom dependencies.',
          items: projects.filter((item) => item.kind === 'single-file'),
        },
        {
          title: 'Projects',
          help: 'Work with multiple files and the project’s own Lean version and dependencies. Import a repository, upload local files, or start from a library.',
          items: projects.filter((item) => item.kind !== 'single-file'),
        },
      ].map(({ title, help, items }) => (
        <details
          key={title}
          className="sidebar-projects-details"
          aria-label={title}
          open
        >
          <summary className="sidebar-section-title">
            <Icon name="chevron" size={13} />
            <span>{title}</span>
            <HelpTip label={title}>{help}</HelpTip>
          </summary>
          {title === 'Playgrounds' && (
            <div className="playground-create">{playgroundActions}</div>
          )}
          <div className="project-list">
            {items.map((item) => (
              <div className="project-row" key={item.id}>
                <button
                  className={`project-item ${item.id === selectedId ? 'selected' : ''}`}
                  aria-current={item.id === selectedId ? 'page' : undefined}
                  onClick={() => onSelect(item.id)}
                  title={item.name}
                  disabled={disabled}
                >
                  <span className={`project-icon ${item.status}`}>
                    <Icon
                      name={item.kind === 'single-file' ? 'file' : 'folder'}
                      size={17}
                    />
                  </span>
                  <span className="project-label">
                    <strong>{item.name}</strong>
                    <span>
                      {item.status === 'preparing'
                        ? 'Preparing dependencies…'
                        : item.status === 'error'
                          ? 'Needs attention'
                          : item.toolchain?.replace('leanprover/lean4:', '') ||
                            'Lean project'}
                    </span>
                  </span>
                  {item.status === 'preparing' && <span className="spinner" />}
                </button>
                <div
                  className={`project-actions ${item.kind === 'single-file' ? 'playground-actions' : ''}`}
                >
                  {item.kind === 'single-file' && (
                    <button
                      className="icon-button"
                      aria-label={`Rename playground ${item.name}`}
                      title="Rename playground"
                      disabled={disabled || item.status === 'preparing'}
                      onClick={() => onRename(item)}
                    >
                      <Icon name="edit" size={14} />
                    </button>
                  )}
                  {!item.protected && (
                    <button
                      className="icon-button project-delete"
                      aria-label={`Move ${item.kind === 'single-file' ? 'playground' : 'project'} ${item.name} to trash`}
                      title={`Delete ${item.kind === 'single-file' ? 'playground' : 'project'} ${item.name}`}
                      disabled={disabled || item.status === 'preparing'}
                      onClick={() => onDelete(item)}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!items.length && title === 'Projects' && (
              <p className="sidebar-empty">
                Your {title.toLowerCase()} appear here.
              </p>
            )}
          </div>
        </details>
      ))}
    </div>
  )
}
