import { memo, useEffect, useMemo, useState } from 'react'
import type { FileEntry } from './api'
import { Icon } from './Icons'
import { parentFolders } from './projectPaths'

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

function folderTree(files: FileEntry[], folders: string[]): FolderNode {
  const root: FolderNode = { path: '', name: '', folders: new Map(), files: [] }
  function addFolder(path: string) {
    let parent = root
    for (const name of path.split('/').filter(Boolean)) {
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
    return parent
  }
  for (const folder of folders) addFolder(folder)
  for (const file of files) {
    const parent = parentFolders(file.path).at(-1) || ''
    addFolder(parent).files.push(file)
  }
  return root
}

function addAncestors(folders: Set<string>, path: string) {
  for (const folder of parentFolders(path)) folders.add(folder)
}

export const FileBrowser = memo(function FileBrowser({
  files,
  folders,
  projectName,
  revealFolder,
  selectedPath,
  dirty,
  disabled,
  filter,
  ready,
  onSelect,
  onDelete,
}: {
  files: FileEntry[]
  folders: string[]
  projectName?: string
  revealFolder: string | null
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
    return {
      project,
      dependencies,
      folders: folders.filter(
        (folder) => !query || folder.toLowerCase().includes(query),
      ),
    }
  }, [files, folders, filter])
  const projectTree = useMemo(() => {
    const visibleFolders = filtered.folders.slice(0, MAX_VISIBLE)
    if (
      revealFolder &&
      filtered.folders.includes(revealFolder) &&
      !visibleFolders.includes(revealFolder)
    )
      visibleFolders[visibleFolders.length - 1] = revealFolder
    return folderTree(
      visibleFiles(
        [
          ...filtered.project.filter((file) => !file.path.includes('/')),
          ...filtered.project.filter((file) => file.path.includes('/')),
        ],
        selectedPath,
      ),
      visibleFolders,
    )
  }, [filtered.project, filtered.folders, selectedPath, revealFolder])

  useEffect(() => {
    if (!revealFolder) return
    setOpenFolders((current) => {
      const next = new Set(current)
      addAncestors(next, `${revealFolder}/`)
      return next
    })
  }, [revealFolder])

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
      for (const folder of filtered.folders) addAncestors(next, `${folder}/`)
      return next.size === current.size ? current : next
    })
  }, [filter, filtered.project, filtered.folders])

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
              {open &&
                (folder.folders.size || folder.files.length ? (
                  folderRows(folder, depth + 1)
                ) : (
                  <p
                    className="sidebar-empty empty-folder"
                    style={{ paddingLeft: (depth + 1) * 12 + 9 }}
                  >
                    {files.some((file) =>
                      file.path.startsWith(folder.path + '/'),
                    )
                      ? 'Filter to find files'
                      : 'Empty folder'}
                  </p>
                ))}
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
      {projectName && (
        <div
          className="project-root-label"
          title={`Project root — ${projectName}`}
        >
          <Icon name="folder" size={15} />
          <strong>{projectName}</strong>
          <span>Project root</span>
        </div>
      )}
      {folderRows(projectTree, projectName ? 1 : 0)}
      {filtered.project.length > MAX_VISIBLE && (
        <p className="sidebar-empty file-count">
          Showing up to {MAX_VISIBLE} files. Filter by folder or file name to
          find more.
        </p>
      )}
      {filtered.folders.length > MAX_VISIBLE && (
        <p className="sidebar-empty file-count">
          Showing up to {MAX_VISIBLE} folders. Filter by folder name to find
          more.
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
      {ready && files.length === 0 && folders.length === 0 && (
        <p className="sidebar-empty">
          No source files yet.
          <br />
          Use New file or New folder to get started.
        </p>
      )}
      {(files.length > 0 || folders.length > 0) &&
        !filtered.project.length &&
        !filtered.folders.length &&
        !filtered.dependencies.length && (
          <p className="sidebar-empty">
            No files or folders match this filter.
          </p>
        )}
    </div>
  )
})
