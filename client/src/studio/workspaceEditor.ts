import { Uri, editor } from 'monaco-editor'
import { createModelReference } from 'vscode/monaco'

// Own the browser model separately from project persistence. Passing contents
// to createModelReference writes a virtual file, which read-only sources reject.
export class WorkspaceEditor {
  editor!: editor.IStandaloneCodeEditor
  modelRef!: Awaited<ReturnType<typeof createModelReference>>
  disposed = false

  async start(
    element: HTMLElement,
    uri: string,
    content: string,
    readOnly = false,
  ) {
    if (this.disposed) return
    try {
      const resource = Uri.parse(uri)
      // Read-only files resolve through the project's authenticated source
      // provider. Its lifetime also covers previews and retained VS Code models.
      this.modelRef = await createModelReference(
        resource,
        readOnly || editor.getModel(resource) ? undefined : content,
      )
      this.editor = editor.create(element, {
        model: this.modelRef.object.textEditorModel,
        automaticLayout: true,
        contextmenu: true,
        lineNumbersMinChars: 1,
        lineDecorationsWidth: 5,
        readOnly,
      })
      const document = element.ownerDocument
      const focused = document.activeElement
      // Loading Lean can finish after the user starts a message or opens a
      // dialog. Only take focus from an idle page or explicit file navigation.
      if (
        element.isConnected &&
        !document.querySelector('dialog[open]') &&
        (!focused ||
          focused === document.body ||
          element.contains(focused) ||
          focused.matches('.file-item'))
      )
        this.editor.focus()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    try {
      this.editor?.dispose()
    } finally {
      this.modelRef?.dispose()
    }
  }
}
