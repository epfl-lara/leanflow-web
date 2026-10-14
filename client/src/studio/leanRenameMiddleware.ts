import type {
  BaseLanguageClient,
  Middleware,
} from 'vscode-languageclient/browser'
import { RenameRequest } from 'vscode-languageserver-protocol'
import { CancellationTokenSource, type CancellationToken } from 'monaco-editor'
import { lean } from 'lean4monaco/dist/vscode-lean4/vscode-lean4/src/utils/leanEditorProvider'
import { renameSources, type RenameSource } from './workspaceBuffers'
import {
  VisibleLeanDocuments,
  type LeanTextDocument,
} from './visibleLeanDocuments'

export function installLeanRenameMiddleware(
  client: BaseLanguageClient,
  context: () => { uri: string | null; hiddenDirty: boolean },
  issue: (message: string) => void,
  prepare: (sources: RenameSource[], token: CancellationToken) => Promise<void>,
  { indexTimeoutMs = 15000 } = {},
) {
  const previous = client.clientOptions.middleware
  const documents = new VisibleLeanDocuments(
    client,
    () => context().uri,
    () => lean.leanDocuments.map((entry) => entry.doc),
    issue,
  )
  let supportsBarrier = true
  const waitForIndex = async (
    token: CancellationToken,
    requested: LeanTextDocument,
  ) => {
    if (context().hiddenDirty)
      throw new Error('Save all changed files before renaming another symbol.')
    const uri = context().uri
    if (
      !uri?.startsWith('file:///workspace/') ||
      requested.uri.toString() !== uri
    )
      return
    const cancellation = new CancellationTokenSource()
    const parent = token.onCancellationRequested(() => cancellation.cancel())
    if (token.isCancellationRequested) cancellation.cancel()
    let timer: ReturnType<typeof setTimeout> | undefined
    const message =
      'Lean is still processing this file. Try again, or use Restart Lean.'
    try {
      issue('Waiting for Lean to finish indexing this file…')
      await Promise.race([
        documents
          .show(requested)
          .then(() =>
            supportsBarrier
              ? client.sendRequest(
                  '$/lean/waitForILeans',
                  { uri, version: requested.version },
                  cancellation.token,
                )
              : undefined,
          ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(message))
            cancellation.cancel()
          }, indexTimeoutMs)
        }),
      ])
      issue('')
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === -32601
      ) {
        supportsBarrier = false
        issue('')
        return
      }
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === -32801
      )
        throw new Error(
          'Lean refreshed this file while preparing the rename. Try again.',
        )
      throw error
    } finally {
      clearTimeout(timer)
      parent.dispose()
      cancellation.dispose()
      if (token.isCancellationRequested) issue('')
    }
  }
  const middleware: Middleware = {
    ...previous,
    ...documents.middleware,
    async prepareRename(document, position, token, next) {
      issue('')
      try {
        await waitForIndex(token, document)
        if (token.isCancellationRequested) return null
        return await next(document, position, token)
      } catch (error) {
        if (token.isCancellationRequested) return null
        issue(
          error instanceof Error
            ? error.message
            : 'Lean could not prepare this rename.',
        )
        // A rejected preparation closes the native box; null means default word.
        throw error
      }
    },
    async provideRenameEdits(document, position, newName, token) {
      issue('')
      try {
        await waitForIndex(token, document)
        if (token.isCancellationRequested) return null
        const result = await client.sendRequest(
          RenameRequest.type,
          {
            textDocument:
              client.code2ProtocolConverter.asTextDocumentIdentifier(document),
            position: client.code2ProtocolConverter.asPosition(position),
            newName,
          },
          token,
        )
        if (result && 'leanflowSources' in result) {
          const sources = renameSources(result.leanflowSources)
          const uris = new Set(sources.map((source) => source.uri))
          const targets = [
            ...Object.keys(result.changes ?? {}),
            ...(result.documentChanges ?? []).map((change) =>
              'textDocument' in change ? change.textDocument.uri : '',
            ),
          ]
          if (targets.some((uri) => !uris.has(uri)))
            throw new Error(
              'Lean returned rename edits without their original source.',
            )
          await prepare(sources, token)
        }
        if (token.isCancellationRequested) return null
        // The embedded app confirms through the rename box and Save all, rather
        // than upstream's unavailable VS Code modal for multi-resource edits.
        return client.protocol2CodeConverter.asWorkspaceEdit(result, token)
      } catch (error) {
        if (!token.isCancellationRequested)
          issue(
            error instanceof Error
              ? error.message
              : 'Lean could not prepare this rename. Try again.',
          )
        return null
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
