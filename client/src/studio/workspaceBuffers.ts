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
    discardVersion: number
    saveVersion: number
    savedPaths: readonly string[]
    removeVersion: number
    removedPaths: readonly string[]
  } = {
    scope: { projectId: null },
    file: null,
    buffers: new Map(),
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
    this.state = { ...this.state, file, buffers }
    for (const listener of this.listeners) listener()
  }
  setFile: Dispatch<SetStateAction<OpenFile | null>> = (update) => {
    const previous = this.state.file
    const file = typeof update === 'function' ? update(previous) : update
    if (!file) {
      this.retained.clear()
      this.publish(null, new Map())
      return
    }
    if (file === previous) return
    const buffers = new Map(this.state.buffers)
    if (
      previous &&
      previous.path !== file.path &&
      previous.content === previous.savedContent &&
      !this.retained.has(previous.path)
    )
      buffers.delete(previous.path)
    buffers.set(file.path, file)
    this.publish(file, buffers)
  }
  register = (sources: RenameSource[]) => {
    // Validate the whole set before registering any buffer. Stale tabs and edits
    // from another browser must never acquire a newer hash for older source.
    for (const source of sources) {
      const current = this.state.buffers.get(source.path)
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
    if (!current || current.content === content) return
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
      if (current && hash && current.hash === snapshot.hash)
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
    if (!current) return
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
        readOnly || path.startsWith('.lake/') || file.preview === 'pdf'
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
    const moving = [...this.state.buffers].filter(([name]) => matches(name))
    if (!moving.length) return
    const destinations = new Set(moving.map(([name]) => target(name)))
    for (const destination of destinations) {
      const existing = this.state.buffers.get(destination)
      if (
        existing &&
        !matches(destination) &&
        existing.content !== existing.savedContent
      )
        throw new Error(
          `A draft already uses ${destination}. Your drafts are preserved. Download or discard them, then reopen the moved file.`,
        )
    }
    const previous = this.state.file
    const activePath = previous
      ? matches(previous.path)
        ? target(previous.path)
        : previous.path
      : null
    const removedPaths = new Set(moving.map(([name]) => name))
    const buffers = new Map<string, OpenFile>()
    for (const [name, file] of this.state.buffers) {
      if (matches(name)) continue
      if (destinations.has(name)) removedPaths.add(name)
      else buffers.set(name, file)
    }
    for (const [name, file] of moving) {
      const renamed = target(name)
      buffers.set(renamed, {
        ...file,
        path: renamed,
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
    }
    this.publish(activePath ? (buffers.get(activePath) ?? null) : null, buffers)
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
