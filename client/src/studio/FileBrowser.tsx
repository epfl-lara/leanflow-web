import { memo, useEffect, useMemo, useState } from 'react'
import type { FileEntry } from './api'
import { Icon } from './Icons'

const MAX_VISIBLE = 200

interface FolderNode {
  path: string
  name: string
  folders: Map<string, FolderNode>
  files: FileEntry[]
}

function visibleFiles(files: FileEntry[], selectedPath?: string) {
  const visible = files.slice(0, MAX_VISIBLE)
  const selected = files.find((file) => file.path === selectedPath)
  if (selected && !visible.some((file) => file.path === selectedPath)) {
    visible[visible.length - 1] = selected
  }
  return visible
}

function folderTree(files: FileEntry[]): FolderNode {
  const root: FolderNode = { path: '', name: '', folders: new Map(), files: [] }
  for (const file of files) {
    const segments = file.path.split('/')
    segments.pop()
    let parent = root
    for (const name of segments) {
      let folder = parent.folders.get(name)
      if (!folder) {
        folder = {
          path: parent.path ? `${parent.path}/${name}` : name,
          name,
          folders: new Map(),
          files: [],
        }
        parent.folders.set(name, folder)
      }
      parent = folder
    }
    parent.files.push(file)
  }
  return root
}

function addAncestors(folders: Set<string>, path: string) {
  const segments = path.split('/')
  segments.pop()
  for (let index = 1; index <= segments.length; index++) {
    folders.add(segments.slice(0, index).join('/'))
  }
}

export const FileBrowser = memo(function FileBrowser({
  files,
  selectedPath,
  dirty,
  disabled,
  filter,
  ready,
  onSelect,
  onDelete,
}: {
  files: FileEntry[]
  selectedPath?: string
  dirty: boolean
  disabled: boolean
  filter: string
  ready: boolean
  onSelect: (path: string) => void
  onDelete: (path: string, kind: 'file' | 'folder') => void
}) {
  const [librariesOpen, setLibrariesOpen] = useState(false)
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase()
    const project: FileEntry[] = []
    const dependencies: FileEntry[] = []
    for (const file of files) {
      if (query && !file.path.toLowerCase().includes(query)) continue
      if (file.readOnly || file.path.startsWith('.lake/'))
        dependencies.push(file)
      else project.push(file)
    }
    return { project, dependencies }
  }, [files, filter])
  const projectTree = useMemo(
    () =>
      folderTree(
        visibleFiles(
          [
            ...filtered.project.filter((file) => !file.path.includes('/')),
            ...filtered.project.filter((file) => file.path.includes('/')),
          ],
          selectedPath,
        ),
      ),
    [filtered.project, selectedPath],
  )

  useEffect(() => {
    if (
      selectedPath?.startsWith('.lake/') ||
      files.some((file) => file.path === selectedPath && file.readOnly)
    )
      setLibrariesOpen(true)
    setOpenFolders((current) => {
      const next = new Set(current)
      if (selectedPath) addAncestors(next, selectedPath)
      return next.size === current.size ? current : next
    })
  }, [selectedPath, files])

  useEffect(() => {
    if (!filter.trim()) return
    setOpenFolders((current) => {
      const next = new Set(current)
      for (const file of filtered.project) addAncestors(next, file.path)
      return next.size === current.size ? current : next
    })
  }, [filter, filtered.project])

  function toggleFolder(path: string) {
    setOpenFolders((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const fileItem = (file: FileEntry, depth = 0, dependency = false) => (
    <div
      key={file.path}
      className={`file-row ${selectedPath === file.path ? 'selected' : ''}`}
      style={depth ? { paddingLeft: depth * 12 } : undefined}
    >
      <button
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
          {dependency && file.path.includes('/') && (
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
      {!dependency && !file.readOnly && !file.path.startsWith('.lake/') && (
        <button
          className="icon-button file-delete"
          title={`Move ${file.path} to trash`}
          aria-label={`Move file ${file.path} to trash`}
          disabled={disabled || !ready}
          onClick={() => onDelete(file.path, 'file')}
        >
          <Icon name="trash" size={14} />
        </button>
      )}
    </div>
  )

  function folderRows(parent: FolderNode, depth = 0) {
    const folders = [...parent.folders.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    const entries = [...parent.files].sort((a, b) =>
      a.path.localeCompare(b.path),
    )
    return (
      <>
        {folders.map((folder) => {
          const open = openFolders.has(folder.path)
          return (
            <div key={folder.path} className="folder-group">
              <div
                className="folder-row"
                style={depth ? { paddingLeft: depth * 12 } : undefined}
              >
                <button
                  className="folder-toggle"
                  disabled={disabled}
                  aria-expanded={open}
                  title={folder.path}
                  onClick={() => toggleFolder(folder.path)}
                >
                  <Icon
                    name="chevron"
                    size={11}
                    style={{ transform: open ? 'rotate(90deg)' : undefined }}
                  />
                  <Icon name="folder" size={15} />
                  <span>{folder.name}</span>
                </button>
                <button
                  className="icon-button file-delete"
                  title={`Move ${folder.path} to trash`}
                  aria-label={`Move folder ${folder.path} to trash`}
                  disabled={disabled || !ready}
                  onClick={() => onDelete(folder.path, 'folder')}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
              {open && folderRows(folder, depth + 1)}
            </div>
          )
        })}
        {entries.map((file) => fileItem(file, depth))}
      </>
    )
  }

  const showDependencies = librariesOpen || !!filter.trim()
  const visibleDependencies = visibleFiles(filtered.dependencies, selectedPath)
  return (
    <div className="file-list">
      {folderRows(projectTree)}
      {filtered.project.length > MAX_VISIBLE && (
        <p className="sidebar-empty file-count">
          Showing up to {MAX_VISIBLE} files. Filter by folder or file name to
          find more.
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
              {visibleDependencies.map((file) => fileItem(file, 0, true))}
              {filtered.dependencies.length > MAX_VISIBLE && (
                <p className="sidebar-empty file-count">
                  Showing up to {MAX_VISIBLE} files. Filter by module or file
                  name to find others.
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
