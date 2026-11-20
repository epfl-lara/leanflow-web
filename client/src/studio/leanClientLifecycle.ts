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
  let sleeping = false
  let requestedSleep = false
  let transition: Promise<void> = Promise.resolve()
  let generation = 0
  let recovery: Promise<void> | undefined
  const enqueue = (action: () => Promise<void>) => {
    const next = transition.then(action)
    transition = next.catch(() => undefined)
    return next
  }
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
    if (closing || sleeping) return Promise.resolve([false, undefined])
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
  type ClientUri = Parameters<LeanClientProvider['ensureClient']>[0]
  const connect = async (uri?: ClientUri, restart = false) => {
    const clients = provider.getClients()
    if (clients.length)
      await Promise.all(
        clients
          .filter((client) => restart || !client.isRunning())
          .map((client) => client.restart()),
      )
    else if (uri) await provider.ensureClient(uri)
    else return
    if (closing || requestedSleep) await stop()
    else if (!provider.getClients().some((client) => client.isRunning()))
      throw new Error('Lean could not reconnect. Use Restart Lean to retry.')
  }
  const activate = (uri?: ClientUri, restart = false) => {
    if (closing) return Promise.resolve()
    requestedSleep = false
    const requestedGeneration = ++generation
    return enqueue(async () => {
      await Promise.allSettled([...starts, ...factories])
      if (closing || requestedSleep || requestedGeneration !== generation)
        return
      // Let pending starts and prior shutdown finish before trying to connect.
      sleeping = false
      await connect(uri, restart)
    })
  }
  return {
    get sleeping() {
      return sleeping
    },
    suspend() {
      if (closing || requestedSleep) return transition
      requestedSleep = true
      sleeping = true
      generation++
      // Freeze new starts before draining an existing one. Keep the editor and
      // its models mounted; only the independent Lean connection goes away.
      return enqueue(async () => {
        await Promise.allSettled([...starts, ...factories])
        await stop()
      })
    },
    resume(uri: ClientUri, startIfMissing = true) {
      return activate(startIfMissing ? uri : undefined)
    },
    restart(uri: ClientUri) {
      return activate(uri, !sleeping && !recovery)
    },
    recover(visible: () => boolean) {
      if (
        closing ||
        sleeping ||
        !visible() ||
        !provider.getClients().some((client) => !client.isRunning())
      )
        return Promise.resolve()
      if (recovery) return recovery
      const pending = enqueue(async () => {
        await Promise.allSettled([...starts, ...factories])
        if (closing || sleeping || !visible()) return
        // An unopened file is started by the provider. Here we repair only the
        // cached client that can no longer open the visible document.
        await connect()
      })
      recovery = pending
      const forget = () => {
        recovery = undefined
      }
      void pending.then(forget, forget)
      return pending
    },
    async close() {
      closing = true
      requestedSleep = true
      sleeping = true
      generation++
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
      await wait(Promise.allSettled([...starts, ...factories, transition]))
      // A failed transport can also strand shutdown. Keep one deadline for
      // startup and stop so a project switch cannot wait on that socket forever.
      await wait(stop())
    },
  }
}
