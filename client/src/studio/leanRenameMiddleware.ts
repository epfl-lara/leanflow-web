import type {
  BaseLanguageClient,
  Middleware,
} from 'vscode-languageclient/browser'
import type { CancellationToken } from 'monaco-editor'
import { CancellationToken as ProtocolCancellationToken } from 'vscode-languageserver-protocol'
import { lean } from 'lean4monaco/dist/vscode-lean4/vscode-lean4/src/utils/leanEditorProvider'
import type { RenameSource } from './workspaceBuffers'
import { VisibleLeanDocuments } from './visibleLeanDocuments'
import {
  LEAN_EDIT_DISABLED_MESSAGE,
  isDisabledLeanEditMethod,
} from '../../../shared/lean-edit-policy.mjs'

export function installLeanRenameMiddleware(
  client: BaseLanguageClient,
  context: () => {
    uri: string | null
    hiddenDirty: boolean
    retained?: (uri: string) => boolean
  },
  issue: (message: string) => void,
  _prepare: (
    sources: RenameSource[],
    token: CancellationToken,
  ) => Promise<void>,
) {
  const previous = client.clientOptions.middleware
  const documents = new VisibleLeanDocuments(
    client,
    () => context().uri,
    () => lean.leanDocuments.map((entry) => entry.doc),
    issue,
    (uri) => context().retained?.(uri) ?? false,
  )
  const disabled = () => {
    issue(LEAN_EDIT_DISABLED_MESSAGE)
    throw new Error(LEAN_EDIT_DISABLED_MESSAGE)
  }
  const middleware: Middleware = {
    ...previous,
    ...documents.middleware,
    prepareRename(_document, _position, token) {
      if (token.isCancellationRequested) return null
      // null would open Monaco's fallback word-renaming box.
      return disabled()
    },
    provideRenameEdits(_document, _position, _newName, token) {
      if (!token.isCancellationRequested) issue(LEAN_EDIT_DISABLED_MESSAGE)
      return null
    },
    provideCodeActions: () => [],
    resolveCodeAction: () => disabled(),
    executeCommand: () => disabled(),
    async handleRegisterCapability(params, next) {
      const safe = {
        ...params,
        registrations: params.registrations.filter(
          (entry) => !isDisabledLeanEditMethod(entry.method),
        ),
      }
      if (!safe.registrations.length) return Promise.resolve()
      if (previous?.handleRegisterCapability)
        await previous.handleRegisterCapability(safe, next)
      else {
        const result = await next(safe, ProtocolCancellationToken.None)
        if (result) throw result
      }
    },
  }
  client.clientOptions.middleware = middleware
  void documents.show().catch(() => {})
  return {
    closeHidden: () => documents.closeHidden(),
    showVisible: () => documents.show(),
    refreshVisible: () => documents.show(undefined, true),
  }
}
