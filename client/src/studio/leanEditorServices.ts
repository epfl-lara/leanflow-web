import { initialize } from 'vscode/services'
import getBulkEditServiceOverride from '@codingame/monaco-vscode-bulk-edit-service-override'
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import { Uri } from 'monaco-editor'

let ready: Promise<void> | undefined

// Initialize the services used by LeanMonaco, including VS Code's native
// multi-resource edits and undo. LeanMonaco skips its default initialization
// once MonacoEnvironment exists.
export function initializeLeanEditor(element: HTMLElement | undefined) {
  return (ready ??= (async () => {
    window.MonacoEnvironment = {
      getWorker(_moduleId, label) {
        if (label === 'editorWorkerService')
          return new Worker(
            new URL(
              'monaco-editor/esm/vs/editor/editor.worker.js',
              import.meta.url,
            ),
            { type: 'module' },
          )
        if (label === 'textMateWorker')
          return new Worker(
            new URL(
              '@codingame/monaco-vscode-textmate-service-override/worker',
              import.meta.url,
            ),
            { type: 'module' },
          )
        throw new Error(`Unsupported editor worker: ${label}`)
      },
    }
    await initialize(
      {
        ...getTextmateServiceOverride(),
        ...getThemeServiceOverride(),
        ...getConfigurationServiceOverride(),
        ...getLanguagesServiceOverride(),
        ...getModelServiceOverride(),
        ...getBulkEditServiceOverride(),
      },
      element,
      {
        workspaceProvider: {
          trusted: true,
          workspace: { workspaceUri: Uri.file('/workspace.code-workspace') },
          async open() {
            return false
          },
        },
      },
    )
  })())
}
