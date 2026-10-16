import { Uri, type CancellationToken, editor } from 'monaco-editor'
import { createModelReference } from 'vscode/monaco'
import type { OpenFile } from './api'
import type { RenameSource } from './workspaceBuffers'

type Reference = Awaited<ReturnType<typeof createModelReference>>
type Entry = { reference: Reference; subscription: { dispose(): void } }

// Keep native models for the workspace edit and its multi-resource undo group.
// These are browser buffers; persistence happens through the app's batch Save.
export class RenameModels {
  private entries = new Map<string, Entry>()
  private disposed = false
  private revision = 0
  private pending: Promise<void> = Promise.resolve()
  constructor(
    private currentModel: () => editor.ITextModel | null,
    private register: (sources: RenameSource[]) => void,
    private changed: (path: string, content: string) => void,
  ) {}
  prepare(sources: RenameSource[], token: CancellationToken) {
    const task = this.pending.then(() => this.load(sources, token))
    this.pending = task.catch(() => {})
    return task
  }
  private async load(sources: RenameSource[], token: CancellationToken) {
    const revision = this.revision
    const check = () => {
      if (
        this.disposed ||
        token.isCancellationRequested ||
        revision !== this.revision
      )
        throw new Error('Rename cancelled.')
    }
    if (
      new Set([...this.entries.keys(), ...sources.map((source) => source.path)])
        .size > 1000
    )
      throw new Error(
        'Save your changes and reopen the project before loading more rename buffers.',
      )
    const units =
      [...this.entries.values()].reduce(
        (total, entry) =>
          total +
          (entry.reference.object.textEditorModel?.getValueLength() ?? 0),
        0,
      ) +
      sources
        .filter((source) => !this.entries.has(source.path))
        .reduce((total, source) => total + source.content.length, 0)
    if (units > 32 * 1024 * 1024)
      throw new Error(
        'Save all changes and reopen this project before loading more rename buffers.',
      )
    for (const source of sources) {
      check()
      let entry = this.entries.get(source.path)
      const current = this.currentModel()
      const owned =
        entry?.reference.object.textEditorModel ??
        (current?.uri.toString() === source.uri
          ? current
          : editor.getModel(Uri.parse(source.uri)))
      if (owned && owned.getValue() !== source.content)
        throw new Error(
          `${source.path} changed while Lean prepared the rename. Try again.`,
        )
      if (!entry) {
        // Passing content writes the virtual file. Never do that for an owned
        // model: a reload would cancel rename or overwrite an unsaved buffer.
        const reference = await createModelReference(
          Uri.parse(source.uri),
          owned ? undefined : source.content,
        )
        const model = reference.object.textEditorModel
        if (!model || this.disposed) {
          reference.dispose()
          if (this.disposed && model && !model.isDisposed()) model.dispose()
          throw new Error('Rename cancelled.')
        }
        entry = {
          reference,
          subscription: model.onDidChangeContent(() =>
            this.changed(source.path, model.getValue()),
          ),
        }
        this.entries.set(source.path, entry)
      }
      check()
      if (entry.reference.object.textEditorModel?.getValue() !== source.content)
        throw new Error(
          `${source.path} changed while Lean prepared the rename. Try again.`,
        )
    }
    check()
    this.register(sources)
  }
  synchronize(buffers: ReadonlyMap<string, OpenFile>) {
    for (const [path, entry] of this.entries) {
      const file = buffers.get(path),
        model = entry.reference.object.textEditorModel
      if (file && model && model.getValue() !== file.content)
        model.setValue(file.content)
    }
  }
  paths() {
    return [...this.entries.keys()]
  }
  async remove(paths: readonly string[]) {
    this.revision++
    await this.pending
    for (const path of paths) {
      const entry = this.entries.get(path)
      if (!entry) continue
      const model = entry.reference.object.textEditorModel
      entry.subscription.dispose()
      entry.reference.dispose()
      if (model && !model.isDisposed()) model.dispose()
      this.entries.delete(path)
    }
  }
  async dispose() {
    this.disposed = true
    // A pending reference uses the same global /workspace URI as the next
    // project. Finish releasing it before that project's models can start.
    await this.pending
    for (const entry of this.entries.values()) {
      const model = entry.reference.object.textEditorModel
      entry.subscription.dispose()
      entry.reference.dispose()
      // VS Code otherwise retains dirty models after releasing references. No
      // buffer from this project may be announced to a different project's LSP.
      if (model && !model.isDisposed()) model.dispose()
    }
    this.entries.clear()
  }
}
