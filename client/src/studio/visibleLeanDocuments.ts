import type {
  BaseLanguageClient,
  Middleware,
} from 'vscode-languageclient/browser'
export type LeanTextDocument = Parameters<NonNullable<Middleware['didOpen']>>[0]

// Hidden rename/preview models never launch Lean workers. The visible document
// and a bounded recent-file cache may retain workers for incremental reuse.
export class VisibleLeanDocuments {
  private opened = new Map<
    string,
    { document: LeanTextDocument; version: number }
  >()
  private pending: Promise<void> = Promise.resolve()
  private previous: Middleware | undefined
  readonly middleware: Middleware
  constructor(
    private client: BaseLanguageClient,
    private visible: () => string | null,
    private documents: () => readonly LeanTextDocument[],
    issue: (message: string) => void,
    private retained: (uri: string) => boolean = () => false,
  ) {
    this.previous = client.clientOptions.middleware
    this.middleware = {
      didOpen: (document) =>
        this.visible() === document.uri.toString()
          ? this.show(document)
          : Promise.resolve(),
      didClose: (document) =>
        this.enqueue(async () => {
          if (this.opened.get(document.uri.toString())?.document === document)
            await this.close(document)
        }),
      didChange: (event, next) => {
        const version = event.document.version
        return this.enqueue(async () => {
          const uri = event.document.uri.toString(),
            record = this.opened.get(uri)
          if (uri !== this.visible() || !record || version <= record.version)
            return
          const send: typeof next = async (event) => {
            await next(event)
            record.version = version
          }
          await (this.previous?.didChange
            ? this.previous.didChange(event, send)
            : send(event))
        })
      },
      didSave: (document, next) =>
        this.enqueue(async () => {
          if (
            this.visible() !== document.uri.toString() ||
            !this.opened.has(document.uri.toString())
          )
            return
          await (this.previous?.didSave
            ? this.previous.didSave(document, next)
            : next(document))
        }),
    }
    client.onDidChangeState(() => {
      if (!client.isRunning()) {
        this.opened.clear()
        return
      }
      void this.show().catch(() =>
        issue('Lean could not open this file. Use Restart Lean to reconnect.'),
      )
    })
  }
  private enqueue(action: () => Promise<void>) {
    const task = this.pending.then(action)
    this.pending = task.catch(() => {})
    return task
  }
  private async close(document: LeanTextDocument) {
    const send = async (document: LeanTextDocument) => {
      await this.client.sendNotification(
        'textDocument/didClose',
        this.client.code2ProtocolConverter.asCloseTextDocumentParams(document),
      )
    }
    await (this.previous?.didClose
      ? this.previous.didClose(document, send)
      : send(document))
    this.opened.delete(document.uri.toString())
  }
  show(document?: LeanTextDocument, force = false) {
    return this.enqueue(async () => {
      const uri = this.visible()
      for (const [other, record] of this.opened)
        if (other !== uri && !this.retained(other))
          await this.close(record.document)
      if (!uri?.startsWith('file:///workspace/') || !this.client.isRunning())
        return
      const current =
        document?.uri.toString() === uri
          ? document
          : this.documents().find((doc) => doc.uri.toString() === uri)
      if (!current || current.isClosed) return
      const record = this.opened.get(uri)
      if (
        !force &&
        record &&
        record.document === current &&
        record.version === current.version
      )
        return
      if (record) await this.close(record.document)
      else if (this.previous?.didClose) {
        // Reset upstream's bookkeeping if its initial registration preceded
        // this bridge. Its middleware suppresses closes for unopened files.
        await this.previous.didClose(current, async (doc) => {
          await this.client.sendNotification(
            'textDocument/didClose',
            this.client.code2ProtocolConverter.asCloseTextDocumentParams(doc),
          )
        })
      }
      const send = async (document: LeanTextDocument) => {
        const params =
          this.client.code2ProtocolConverter.asOpenTextDocumentParams(document)
        await this.client.sendNotification('textDocument/didOpen', {
          ...params,
          dependencyBuildMode: 'always',
        })
        this.opened.set(uri, { document, version: params.textDocument.version })
      }
      await (this.previous?.didOpen
        ? this.previous.didOpen(current, send)
        : send(current))
    })
  }
  closeHidden() {
    return this.enqueue(async () => {
      for (const [uri, record] of this.opened)
        if (uri !== this.visible() && !this.retained(uri))
          await this.close(record.document)
    })
  }
}
