import { Uri, editor } from 'monaco-editor'
import { createModelReference } from 'vscode/monaco'
import type { OpenFile } from './api'

type Reference = Awaited<ReturnType<typeof createModelReference>>
type Entry = {
  reference: Reference
  path: string
  source?: OpenFile
  timer?: ReturnType<typeof setTimeout>
}
const configurationFiles = new Set([
  'lean-toolchain',
  'lakefile.lean',
  'lakefile.toml',
  'lake-manifest.json',
])
const affectsLean = (path: string) =>
  path.endsWith('.lean') || configurationFiles.has(path)

// Keep the current model and one recently visited project file alive. Retaining
// the native document lets Lean keep its elaboration snapshots and versions.
// Text limits bound retained source size, not Lean's imported environment RAM.
export class LeanModelCache {
  private entries = new Map<string, Entry>()
  private active: string | null = null
  private disposed = false
  private buffers: ReadonlyMap<string, OpenFile> | undefined
  private pending = new Map<string, Promise<void>>()
  private generation = 0

  constructor(
    private released: () => void,
    private options = { idleMs: 60_000, maxTextLength: 256 * 1024 },
  ) {}

  has(uri: string) {
    return this.entries.has(uri)
  }

  select(uri: string | null) {
    if (this.disposed) return
    if (uri !== this.active) this.cancelPending()
    this.active = uri
    const selected = uri ? this.entries.get(uri) : undefined
    if (selected && uri) {
      clearTimeout(selected.timer)
      selected.timer = undefined
      this.entries.delete(uri)
      this.entries.set(uri, selected)
    }
    for (const [key, entry] of this.entries) {
      if (key === uri) continue
      if (
        !uri ||
        !entry.reference.object.textEditorModel ||
        entry.reference.object.textEditorModel.getValueLength() >
          this.options.maxTextLength
      ) {
        this.remove(key)
        continue
      }
      entry.timer ??= setTimeout(() => this.remove(key), this.options.idleMs)
    }
    const hidden = [...this.entries.keys()].filter((key) => key !== uri)
    for (const key of hidden.slice(0, -1)) this.remove(key)
  }

  async retain(uri: string) {
    const resource = Uri.parse(uri)
    if (
      this.disposed ||
      uri !== this.active ||
      this.entries.has(uri) ||
      !resource.path.startsWith('/workspace/') ||
      resource.path.startsWith('/workspace/.lake/') ||
      !resource.path.endsWith('.lean')
    )
      return
    const pending = this.pending.get(uri)
    if (pending) return pending
    const model = editor.getModel(resource)
    if (!model || model.getValueLength() > this.options.maxTextLength) return
    // Never seed a virtual file here: that would reload the model whose Lean
    // worker we are trying to preserve, or replace an unsaved browser buffer.
    const generation = this.generation
    const task = (async () => {
      const reference = await createModelReference(resource)
      if (
        this.disposed ||
        generation !== this.generation ||
        uri !== this.active ||
        !reference.object.textEditorModel ||
        reference.object.textEditorModel.getValueLength() >
          this.options.maxTextLength
      ) {
        reference.dispose()
        return
      }
      const path = resource.path.slice('/workspace/'.length)
      this.entries.set(uri, {
        reference,
        path,
        source: this.buffers?.get(path),
      })
    })().finally(() => {
      if (this.pending.get(uri) === task) this.pending.delete(uri)
    })
    this.pending.set(uri, task)
    return task
  }

  reconcile(
    buffers: ReadonlyMap<string, OpenFile>,
    activePath?: string | null,
  ) {
    if (this.disposed) return
    if (activePath !== undefined)
      this.select(
        activePath
          ? `file:///workspace/${activePath.split('/').map(encodeURIComponent).join('/')}`
          : null,
      )
    if (
      activePath &&
      (buffers.get(activePath)?.content.length ?? 0) >
        this.options.maxTextLength
    )
      this.clear()
    for (const [path, current] of buffers) {
      if (!affectsLean(path)) continue
      const previous =
        this.buffers?.get(path) ??
        [...this.entries.values()].find((entry) => entry.path === path)?.source
      if (
        (previous &&
          (current.hash !== previous.hash ||
            (current.content !== previous.content &&
              (configurationFiles.has(path) ||
                path !== this.entries.get(this.active ?? '')?.path)))) ||
        (!previous && configurationFiles.has(path))
      ) {
        // The visible worker receives unsaved edits incrementally. Importers
        // still read the saved module, so they need invalidation only on save.
        this.invalidate()
        break
      }
    }
    // The app drops clean buffers on a file switch; that is not a deletion.
    // Keep only the two cached source revisions to recognize later disk changes.
    for (const entry of this.entries.values())
      entry.source = buffers.get(entry.path) ?? entry.source
    this.buffers = buffers
  }

  removePaths(paths: readonly string[]) {
    for (const [uri, entry] of this.entries)
      if (
        paths.some(
          (path) => entry.path === path || entry.path.startsWith(path + '/'),
        )
      )
        this.remove(uri)
    this.invalidate()
  }

  invalidate() {
    this.cancelPending()
    for (const key of this.entries.keys())
      if (key !== this.active) this.remove(key)
  }

  clear() {
    this.cancelPending()
    for (const key of this.entries.keys()) this.remove(key)
  }

  private cancelPending() {
    // A delayed acquisition must not revive a deleted/reloaded file, even if
    // the user has already switched back to the same URI in the meantime.
    this.generation++
    this.pending.clear()
  }

  private remove(uri: string) {
    const entry = this.entries.get(uri)
    if (!entry) return
    this.entries.delete(uri)
    clearTimeout(entry.timer)
    entry.reference.dispose()
    if (!this.disposed) this.released()
  }

  dispose() {
    this.disposed = true
    this.clear()
    this.buffers = undefined
  }
}
