import { Icon } from './Icons'
import { HelpTip } from './HelpTip'
import type { Project } from './api'
import type { ReactNode } from 'react'
import { useEffect, useId, useState } from 'react'
import { ContextMenu, useContextMenu } from './ContextMenu'

function WorkspaceSection({
  title,
  help,
  actions,
  children,
}: {
  title: string
  help: string
  actions: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(true)
  const id = useId()
  return (
    <section className="sidebar-projects-details" aria-label={title}>
      <div className="sidebar-projects-header sidebar-section-title">
        <button
          className="sidebar-section-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon
            name="chevron"
            size={13}
            style={{ transform: open ? 'rotate(90deg)' : undefined }}
          />
          <span>{title}</span>
        </button>
        <HelpTip label={title}>{help}</HelpTip>
        <div className="sidebar-section-actions">{actions}</div>
      </div>
      <div id={id} hidden={!open}>
        {children}
      </div>
    </section>
  )
}

export function WorkspaceList({
  projects,
  selectedId,
  disabled,
  onSelect,
  onDelete,
  onRename,
  onDownload,
  onCreateProject,
  playgroundActions,
}: {
  projects: Project[]
  selectedId: string | null
  disabled: boolean
  onSelect: (id: string) => void
  onDelete: (project: Project) => void
  onRename: (project: Project) => void
  onDownload: (project: Project) => void
  onCreateProject: () => void
  playgroundActions: ReactNode
}) {
  const context = useContextMenu<Project>()
  useEffect(() => {
    if (disabled) context.close()
  }, [disabled, context.close])
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
        <WorkspaceSection
          key={title}
          title={title}
          help={help}
          actions={
            title === 'Playgrounds' ? (
              playgroundActions
            ) : (
              <button
                className="icon-button"
                type="button"
                aria-label="Import or create project"
                title="Import or create project"
                disabled={disabled}
                onClick={onCreateProject}
              >
                <Icon name="plus" size={17} />
              </button>
            )
          }
        >
          <div className="project-list">
            {items.map((item) => (
              <div
                className="project-row"
                key={item.id}
                {...context.triggerProps(item, disabled)}
              >
                <button
                  className={`project-item ${item.id === selectedId ? 'selected' : ''}`}
                  aria-current={item.id === selectedId ? 'page' : undefined}
                  aria-haspopup={disabled ? undefined : 'menu'}
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
                  <button
                    className="icon-button row-menu-button"
                    type="button"
                    aria-label={`Actions for ${item.kind === 'single-file' ? 'playground' : 'project'} ${item.name}`}
                    title={`Actions for ${item.kind === 'single-file' ? 'playground' : 'project'} ${item.name}`}
                    aria-haspopup="menu"
                    aria-expanded={context.menu?.target.id === item.id}
                    disabled={disabled}
                    onClick={(event) => context.open(item, event.currentTarget)}
                  >
                    <Icon name="more" size={15} />
                  </button>
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
        </WorkspaceSection>
      ))}
      {context.menu && (
        <ContextMenu
          position={context.menu}
          label={`Actions for ${context.menu.target.name}`}
          onClose={context.close}
          items={[
            {
              label:
                context.menu.target.kind === 'single-file'
                  ? 'Download .lean file'
                  : 'Download project ZIP',
              icon: <Icon name="download" size={15} />,
              description:
                context.menu.target.kind === 'single-file'
                  ? undefined
                  : 'Saved files only. Save edits first.',
              disabled: disabled || context.menu.target.status === 'preparing',
              onSelect: () => context.menu && onDownload(context.menu.target),
            },
            ...(context.menu.target.kind === 'single-file'
              ? [
                  {
                    label: 'Rename playground',
                    icon: <Icon name="edit" size={15} />,
                    disabled:
                      disabled || context.menu.target.status === 'preparing',
                    onSelect: () =>
                      context.menu && onRename(context.menu.target),
                  },
                ]
              : []),
            ...(!context.menu.target.protected
              ? [
                  {
                    label: 'Move to trash',
                    icon: <Icon name="trash" size={15} />,
                    danger: true,
                    disabled:
                      disabled || context.menu.target.status === 'preparing',
                    onSelect: () =>
                      context.menu && onDelete(context.menu.target),
                  },
                ]
              : []),
          ]}
        />
      )}
    </div>
  )
}
