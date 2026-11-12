import type {
  BaseLanguageClient,
  LanguageClientOptions,
} from 'vscode-languageclient/browser'
import type { LeanClientProvider } from 'lean4monaco/dist/vscode-lean4/vscode-lean4/src/utils/clientProvider'

type Factory = (options: LanguageClientOptions) => Promise<BaseLanguageClient>
interface FactoryHost {
  setupClient: Factory
  eraseClient: (
    root: Parameters<LeanClientProvider['ensureClient']>[0],
  ) => Promise<void>
}
function factoryHost(value: unknown): value is FactoryHost {
  return (
    !!value &&
    typeof value === 'object' &&
    'setupClient' in value &&
    typeof value.setupClient === 'function' &&
    'eraseClient' in value &&
    typeof value.eraseClient === 'function'
  )
}

// The pinned provider exposes no public setter for its constructor factory.
// Validate its runtime shape, preserve that factory and all provider listeners,
// and track only this instance's pending starts. A dependency change fails with
// an actionable error instead of silently leaving an untracked Lean worker.
export function installLeanClientLifecycle(
  provider: LeanClientProvider,
  root: Parameters<LeanClientProvider['ensureClient']>[0],
  issue: (error: unknown) => void,
  timeoutMs = 4000,
) {
  const host: unknown = provider
  if (!factoryHost(host))
    throw new Error(
      'This Lean editor version cannot safely cancel startup. Restore the pinned editor packages before retrying.',
    )
  let closing = false
  const factories = new Set<Promise<BaseLanguageClient>>()
  const starts = new Set<ReturnType<LeanClientProvider['ensureClient']>>()
  const factory = host.setupClient
  host.setupClient = (options) => {
    const pending = factory.call(provider, options)
    factories.add(pending)
    void pending.then(
      () => factories.delete(pending),
      () => factories.delete(pending),
    )
    return pending
  }
  const ensure = provider.ensureClient
  const stop = async () => {
    const results = await Promise.allSettled(
      provider.getClients().map((client) => client.stop()),
    )
    for (const result of results)
      if (result.status === 'rejected') issue(result.reason)
  }
  provider.ensureClient = function (uri) {
    if (closing) return Promise.resolve([false, undefined])
    const pending = ensure
      .call(this, uri)
      .catch(
        async (
          error,
        ): Promise<Awaited<ReturnType<LeanClientProvider['ensureClient']>>> => {
          // VS Code event emitters do not await their async listeners. Surface the
          // failure through the editor, then clear this failed provider entry so a
          // subsequent reopen can create a fresh client.
          if (!closing) issue(error)
          await host.eraseClient(root)
          return [false, undefined]
        },
      )
    starts.add(pending)
    void pending.then(
      async () => {
        starts.delete(pending)
        if (closing) await stop()
      },
      (error) => {
        starts.delete(pending)
        issue(error)
      },
    )
    return pending
  }
  return {
    async close() {
      closing = true
      const deadline = Date.now() + timeoutMs
      const wait = async (pending: Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            pending,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      await wait(Promise.allSettled([...starts, ...factories]))
      // A failed transport can also strand shutdown. Keep one deadline for
      // startup and stop so a project switch cannot wait on that socket forever.
      await wait(stop())
    },
  }
}
