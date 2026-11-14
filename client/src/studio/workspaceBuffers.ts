import type { Dispatch, SetStateAction } from 'react'
import type { OpenFile } from './api'

export interface RenameSource {
  uri: string
  path: string
  content: string
  hash: string
  unsaved: boolean
}

// Identity is per visit, so a response from A cannot apply after A → B → A.
export interface WorkspaceScope {
  readonly projectId: string | null
}

export function renameSources(value: unknown): RenameSource[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000)
    throw new Error('Lean returned an invalid set of rename files.')
  const seen = new Set<string>()
  return value.map((source: unknown) => {
    if (
      !source ||
      typeof source !== 'object' ||
      !('uri' in source) ||
      typeof source.uri !== 'string' ||
      !('path' in source) ||
      typeof source.path !== 'string' ||
      !source.path.endsWith('.lean') ||
      source.path.startsWith('/') ||
      source.path.startsWith('.lake/') ||
      source.path
        .split('/')
        .some((part) => !part || part === '..' || part === '.') ||
      !('content' in source) ||
      typeof source.content !== 'string' ||
      !('hash' in source) ||
      typeof source.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(source.hash) ||
      !('unsaved' in source) ||
      typeof source.unsaved !== 'boolean' ||
      seen.has(source.path)
    )
      throw new Error('Lean returned an invalid rename file.')
    const expected =
      'file:///workspace/' +
      source.path.split('/').map(encodeURIComponent).join('/')
    if (new URL(source.uri).href !== expected)
      throw new Error('Lean returned a rename outside this project.')
    seen.add(source.path)
    return {
      uri: source.uri,
      path: source.path,
      content: source.content,
      hash: source.hash,
      unsaved: source.unsaved,
    }
  })
}

// One store owns visible and retained native editor models. A multi-file rename
// is saved as one batch by autosave or Save; Discard resets every dirty buffer.
export class WorkspaceBuffers {
  private state: {
    scope: WorkspaceScope
    file: OpenFile | null
    buffers: ReadonlyMap<string, OpenFile>
    openPaths: readonly string[]
    previewPath: string | null
    recentPreviewPaths: readonly string[]
    discardVersion: number
    saveVersion: number
    savedPaths: readonly string[]
    removeVersion: number
    removedPaths: readonly string[]
  } = {
    scope: { projectId: null },
    file: null,
    buffers: new Map(),
    openPaths: [],
    previewPath: null,
    recentPreviewPaths: [],
    discardVersion: 0,
    saveVersion: 0,
    savedPaths: [],
    removeVersion: 0,
    removedPaths: [],
  }
  private retained = new Set<string>()
  private listeners = new Set<() => void>()
  selectProject = (projectId: string | null) => {
    if (this.state.scope.projectId === projectId) return
    this.retained.clear()
    this.state = {
      ...this.state,
      scope: { projectId },
      openPaths: [],
      previewPath: null,
      recentPreviewPaths: [],
      savedPaths: [],
      removedPaths: [],
    }
    this.publish(null, new Map())
  }
  isCurrent = (scope: WorkspaceScope) => this.state.scope === scope
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private publish(
    file: OpenFile | null,
    buffers: ReadonlyMap<string, OpenFile>,
  ) {
    const openPaths =
      file && !this.state.openPaths.includes(file.path)
        ? [...this.state.openPaths, file.path]
        : this.state.openPaths
    const preview = this.state.previewPath
    const previewBuffer = preview ? buffers.get(preview) : undefined
    // Pin on the first local change, before autosave can make the buffer clean.
    const previewPath =
      preview &&
      (this.retained.has(preview) ||
        (previewBuffer && previewBuffer.content !== previewBuffer.savedContent))
        ? null
        : preview
    this.state = { ...this.state, file, buffers, openPaths, previewPath }
    for (const listener of this.listeners) listener()
  }
  setFile: Dispatch<SetStateAction<OpenFile | null>> = (update) => {
    const previous = this.state.file
    const file = typeof update === 'function' ? update(previous) : update
    this.selectFile(file)
  }
  openFile = (file: OpenFile, { preview = true } = {}) => {
    this.selectFile(file, preview)
  }
  keepOpen = (path: string) => {
    if (this.state.previewPath !== path) return
    this.state = { ...this.state, previewPath: null }
    this.publish(this.state.file, this.state.buffers)
  }
  private selectFile(file: OpenFile | null, preview?: boolean) {
    const previous = this.state.file
    if (file && file === previous && preview === undefined) return
    if (!file) {
      this.retained.clear()
      this.state = {
        ...this.state,
        openPaths: [],
        previewPath: null,
        recentPreviewPaths: [],
      }
      this.publish(null, new Map())
      return
    }
    const buffers = new Map(this.state.buffers)
    let { openPaths, previewPath, recentPreviewPaths } = this.state
    recentPreviewPaths = recentPreviewPaths.filter((path) => path !== file.path)
    if (preview === false && previewPath === file.path) previewPath = null
    if (preview === true && !openPaths.includes(file.path)) {
      if (previewPath) {
        const replaced = previewPath
        const buffer = buffers.get(replaced)
        if (
          !this.retained.has(replaced) &&
          (!buffer || buffer.content === buffer.savedContent)
        ) {
          openPaths = openPaths.map((path) =>
            path === replaced ? file.path : path,
          )
          buffers.delete(replaced)
          // Keep only enough metadata to reuse the bounded Lean/view-state cache.
          recentPreviewPaths = [
            ...recentPreviewPaths.filter((path) => path !== replaced),
            replaced,
          ].slice(-2)
        }
      }
      previewPath = file.path
    }
    if (
      previous &&
      previous.path !== file.path &&
      previous.content === previous.savedContent &&
      !this.retained.has(previous.path)
    )
      buffers.delete(previous.path)
    buffers.set(file.path, file)
    this.state = { ...this.state, openPaths, previewPath, recentPreviewPaths }
    this.publish(file, buffers)
  }
  // Closing a tab is navigation, never a discard or a filesystem deletion.
  closeFile = (path: string) => {
    const buffer = this.state.buffers.get(path)
    if (buffer && buffer.content !== buffer.savedContent)
      throw new Error('Save or discard this file’s changes before closing it.')
    const buffers = new Map(this.state.buffers)
    buffers.delete(path)
    this.retained.delete(path)
    this.state = {
      ...this.state,
      openPaths: this.state.openPaths.filter((name) => name !== path),
      previewPath:
        this.state.previewPath === path ? null : this.state.previewPath,
      recentPreviewPaths: this.state.recentPreviewPaths.filter(
        (name) => name !== path,
      ),
    }
    this.publish(
      this.state.file?.path === path ? null : this.state.file,
      buffers,
    )
  }
  register = (sources: RenameSource[]) => {
    // Validate the whole set before registering any buffer. Stale tabs and edits
    // from another browser must never acquire a newer hash for older source.
    for (const source of sources) {
      const current = this.state.buffers.get(source.path)
      if (current?.unavailable)
        throw new Error(
          `${source.path} was deleted or moved while Lean prepared the rename. Choose a saved file before renaming again.`,
        )
      if (
        current
          ? current.content !== source.content || current.hash !== source.hash
          : source.unsaved
      )
        throw new Error(
          `${source.path} changed while Lean prepared the rename. Save or reload it, then rename again.`,
        )
    }
    const buffers = new Map(this.state.buffers)
    for (const source of sources) {
      this.retained.add(source.path)
      if (!buffers.has(source.path))
        buffers.set(source.path, {
          path: source.path,
          content: source.content,
          savedContent: source.content,
          hash: source.hash,
          generation: 0,
        })
    }
    this.publish(this.state.file, buffers)
  }
  change = (path: string, content: string) => {
    const current = this.state.buffers.get(path)
    if (!current || current.unavailable || current.content === content) return
    const file = { ...current, content }
    const buffers = new Map(this.state.buffers)
    buffers.set(path, file)
    this.publish(
      this.state.file?.path === path ? file : this.state.file,
      buffers,
    )
  }
  dirty = () =>
    [...this.state.buffers.values()].filter(
      (file) => !file.readOnly && file.content !== file.savedContent,
    )
  // Permission changes cannot erase a local draft. Autosave uses dirty();
  // leaving, status and downloads must include drafts that are now read-only.
  drafts = () =>
    [...this.state.buffers.values()].filter(
      (file) => file.content !== file.savedContent,
    )
  saved = (snapshots: OpenFile[], files: { path: string; hash: string }[]) => {
    const hashes = new Map(files.map((file) => [file.path, file.hash]))
    const buffers = new Map(this.state.buffers)
    for (const snapshot of snapshots) {
      const current = buffers.get(snapshot.path),
        hash = hashes.get(snapshot.path)
      if (
        current &&
        !current.unavailable &&
        hash &&
        current.hash === snapshot.hash
      )
        buffers.set(snapshot.path, {
          ...current,
          hash,
          savedContent: snapshot.content,
        })
    }
    this.state = {
      ...this.state,
      saveVersion: this.state.saveVersion + 1,
      savedPaths: snapshots.map((file) => file.path),
    }
    this.publish(
      this.state.file
        ? (buffers.get(this.state.file.path) ?? this.state.file)
        : null,
      buffers,
    )
  }
  // Shared document updates carry both the converged local source (which can
  // include unacknowledged typing) and the durable server baseline.
  collaborated = (
    path: string,
    content: string,
    savedContent: string,
    hash: string,
  ) => {
    const current = this.state.buffers.get(path)
    if (!current || current.unavailable) return
    if (
      current.content === content &&
      current.savedContent === savedContent &&
      current.hash === hash
    )
      return
    const file = { ...current, content, savedContent, hash }
    const buffers = new Map(this.state.buffers)
    buffers.set(path, file)
    this.state = {
      ...this.state,
      saveVersion: this.state.saveVersion + 1,
      savedPaths: [path],
    }
    this.publish(
      this.state.file?.path === path ? file : this.state.file,
      buffers,
    )
  }
  permissions = (readOnly: boolean) => {
    const buffers = new Map(this.state.buffers)
    let changed = false
    for (const [path, file] of buffers) {
      const restricted =
        readOnly ||
        file.unavailable ||
        path.startsWith('.lake/') ||
        !!file.preview
      if (!!file.readOnly !== restricted) {
        buffers.set(path, { ...file, readOnly: restricted })
        changed = true
      }
    }
    if (changed)
      this.publish(
        this.state.file
          ? (buffers.get(this.state.file.path) ?? this.state.file)
          : null,
        buffers,
      )
  }
  detach = (path: string) => {
    const current = this.state.buffers.get(path)
    if (!current) {
      if (this.state.openPaths.includes(path)) this.closeFile(path)
      return
    }
    if (current.unavailable) return
    const file = { ...current, unavailable: true, readOnly: true }
    const buffers = new Map(this.state.buffers)
    buffers.set(path, file)
    this.publish(
      this.state.file?.path === path ? file : this.state.file,
      buffers,
    )
  }
  remove = (path: string) => {
    const matches = (name: string) =>
      name === path || name.startsWith(path + '/')
    const removedPaths = [...this.state.buffers.keys()].filter(matches)
    const buffers = new Map(this.state.buffers)
    for (const name of removedPaths) {
      buffers.delete(name)
      this.retained.delete(name)
    }
    this.state = {
      ...this.state,
      removeVersion: this.state.removeVersion + 1,
      removedPaths,
      openPaths: this.state.openPaths.filter((name) => !matches(name)),
      previewPath:
        this.state.previewPath && matches(this.state.previewPath)
          ? null
          : this.state.previewPath,
      recentPreviewPaths: this.state.recentPreviewPaths.filter(
        (name) => !matches(name),
      ),
    }
    this.publish(
      this.state.file && !matches(this.state.file.path)
        ? this.state.file
        : null,
      buffers,
    )
  }
  // A server-side rename keeps file bytes and hashes. Re-key every buffer under
  // the old path, including unsaved text typed while the request was running,
  // and report the old paths as removed so stale editor models are released.
  move = (from: string, to: string, generation?: number) => {
    const matches = (name: string) =>
      name === from || name.startsWith(from + '/')
    const target = (name: string) => to + name.slice(from.length)
    // A removed draft belongs to the former file at this path. A later move
    // can refer to a replacement file and must never revive that old draft.
    const moving = [...this.state.buffers].filter(
      ([name, file]) => matches(name) && !file.unavailable,
    )
    const openPaths = [
      ...new Set(
        this.state.openPaths.map((name) =>
          matches(name) && !this.state.buffers.get(name)?.unavailable
            ? target(name)
            : name,
        ),
      ),
    ]
    const recentPreviewPaths = this.state.recentPreviewPaths.filter(
      (name) => !matches(name),
    )
    if (
      !moving.length &&
      recentPreviewPaths.length === this.state.recentPreviewPaths.length &&
      openPaths.length === this.state.openPaths.length &&
      openPaths.every((name, index) => name === this.state.openPaths[index])
    )
      return
    const movingPaths = new Set(moving.map(([name]) => name))
    const destinations = new Set(moving.map(([name]) => target(name)))
    for (const destination of destinations) {
      const existing = this.state.buffers.get(destination)
      if (
        existing &&
        !movingPaths.has(destination) &&
        existing.content !== existing.savedContent
      )
        throw new Error(
          `A draft already uses ${destination}. Your drafts are preserved. Download or discard them, then reopen the moved file.`,
        )
    }
    const previous = this.state.file
    const activePath = previous
      ? movingPaths.has(previous.path)
        ? target(previous.path)
        : previous.path
      : null
    const removedPaths = new Set(moving.map(([name]) => name))
    const buffers = new Map<string, OpenFile>()
    for (const [name, file] of this.state.buffers) {
      if (movingPaths.has(name)) continue
      if (destinations.has(name)) removedPaths.add(name)
      else buffers.set(name, file)
    }
    for (const [name, file] of moving) {
      const renamed = target(name)
      buffers.set(renamed, {
        ...file,
        path: renamed,
        unavailable: false,
        // A new generation makes live editors and models bind to the new path.
        generation:
          renamed === activePath
            ? Math.max(
                generation ?? 0,
                (previous?.generation ?? 0) + 1,
                file.generation + 1,
              )
            : file.generation + 1,
      })
      if (this.retained.delete(name)) this.retained.add(renamed)
    }
    this.state = {
      ...this.state,
      removeVersion: this.state.removeVersion + 1,
      removedPaths: [...removedPaths],
      openPaths,
      previewPath:
        this.state.previewPath &&
        matches(this.state.previewPath) &&
        !this.state.buffers.get(this.state.previewPath)?.unavailable
          ? this.state.openPaths.includes(target(this.state.previewPath))
            ? null
            : target(this.state.previewPath)
          : this.state.previewPath,
      recentPreviewPaths,
    }
    this.publish(activePath ? (buffers.get(activePath) ?? null) : null, buffers)
  }
  discardFile = (path: string, generation: number) => {
    const current = this.state.buffers.get(path)
    if (!current || current.content === current.savedContent) return
    const buffers = new Map(this.state.buffers)
    const file = { ...current, content: current.savedContent, generation }
    buffers.set(path, file)
    // Its new generation resets only this document's history. The workspace
    // discard version would also retire other files' unacknowledged live edits.
    this.publish(
      this.state.file?.path === path ? file : this.state.file,
      buffers,
    )
  }
  discard = (generation: number) => {
    const buffers = new Map(
      [...this.state.buffers].map(([path, file]) => [
        path,
        {
          ...file,
          content: file.savedContent,
          generation:
            file.path === this.state.file?.path ? generation : file.generation,
        },
      ]),
    )
    this.state = {
      ...this.state,
      discardVersion: this.state.discardVersion + 1,
    }
    this.publish(
      this.state.file ? (buffers.get(this.state.file.path) ?? null) : null,
      buffers,
    )
  }
}
