import { memo, useEffect, useMemo, useState } from 'react'
import type { FileEntry } from './api'
import { Icon } from './Icons'

const MAX_VISIBLE = 200

export const FileBrowser = memo(function FileBrowser({
  files,
  selectedPath,
  dirty,
  disabled,
  filter,
  ready,
  onSelect,
}: {
  files: FileEntry[]
  selectedPath?: string
  dirty: boolean
  disabled: boolean
  filter: string
  ready: boolean
  onSelect: (path: string) => void
}) {
  const [librariesOpen, setLibrariesOpen] = useState(false)
  useEffect(() => {
    if (selectedPath?.startsWith('.lake/packages/')) setLibrariesOpen(true)
  }, [selectedPath])
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase()
    const project: FileEntry[] = []
    const dependencies: FileEntry[] = []
    for (const file of files) {
      if (query && !file.path.toLowerCase().includes(query)) continue
      if (file.readOnly || file.path.startsWith('.lake/packages/'))
        dependencies.push(file)
      else project.push(file)
    }
    return { project, dependencies }
  }, [files, filter])
  const item = (file: FileEntry) => (
    <button
      key={file.path}
      className={`file-item ${selectedPath === file.path ? 'selected' : ''}`}
      aria-current={selectedPath === file.path ? 'true' : undefined}
      title={file.path}
      disabled={disabled}
      onClick={() => {
        if (selectedPath !== file.path) onSelect(file.path)
      }}
    >
      <Icon name="file" size={15} />
      <span>
        <span className="file-basename">{file.path.split('/').at(-1)}</span>
        {file.path.includes('/') && (
          <span className="file-directory">
            {file.path
              .replace(/^\.lake\/packages\//, '')
              .slice(
                0,
                file.path.replace(/^\.lake\/packages\//, '').lastIndexOf('/'),
              )}
          </span>
        )}
      </span>
      {selectedPath === file.path && dirty && (
        <span className="dirty-dot" aria-label="Unsaved changes" />
      )}
    </button>
  )
  const showDependencies = librariesOpen || !!filter.trim()
  const visibleDependencies = filtered.dependencies.slice(0, MAX_VISIBLE)
  const selectedDependency = filtered.dependencies.find(
    (file) => file.path === selectedPath,
  )
  if (
    selectedDependency &&
    !visibleDependencies.some((file) => file.path === selectedPath)
  ) {
    visibleDependencies.unshift(selectedDependency)
  }
  return (
    <div className="file-list">
      {filtered.project.slice(0, MAX_VISIBLE).map(item)}
      {filtered.project.length > MAX_VISIBLE && (
        <p className="sidebar-empty file-count">
          Showing {MAX_VISIBLE} of {filtered.project.length} files. Use the
          filter to find more.
        </p>
      )}
      {filtered.dependencies.length > 0 && (
        <>
          <button
            className="dependency-toggle"
            onClick={() => setLibrariesOpen((value) => !value)}
            aria-expanded={showDependencies}
          >
            <Icon
              name="chevron"
              size={11}
              style={{
                transform: showDependencies ? 'rotate(90deg)' : undefined,
              }}
            />
            <span>Dependencies</span>
            <span>{filtered.dependencies.length}</span>
          </button>
          {showDependencies && (
            <div className="dependency-files">
              {visibleDependencies.map(item)}
              {filtered.dependencies.length > MAX_VISIBLE && (
                <p className="sidebar-empty file-count">
                  Showing {MAX_VISIBLE} files. Filter by module or file name to
                  find others.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {ready && files.length === 0 && (
        <p className="sidebar-empty">
          No source files yet.
          <br />
          Use + to create one.
        </p>
      )}
      {files.length > 0 &&
        !filtered.project.length &&
        !filtered.dependencies.length && (
          <p className="sidebar-empty">No files match this filter.</p>
        )}
    </div>
  )
})
