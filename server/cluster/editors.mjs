import { randomUUID } from 'node:crypto'
import { DeferredEditor } from './editor-stream.mjs'
import { clusterError } from './state.mjs'
import { editableRepositoryModule, editorSource } from './worker-editor.mjs'

// Auth, collaboration and canonical writes stay on the coordinator. Only a
// disposable mirror of the selected project's validated inputs reaches the worker.
export function clusterEditor(checks, { project, actor, workspaces }, local) {
  const repository = project.kind !== 'single-file'
  const editorKind = repository ? 'repository' : undefined
  if (
    checks.closing ||
    checks.mode !== 'serve' ||
    (!repository &&
      (checks.editorsReady?.() === false || checks.editorCapacity?.() === 0)) ||
    !checks.controller.canRun(
      'lean.session',
      repository ? undefined : 'Main.lean',
      editorKind,
    )
  )
    return local()
  return new DeferredEditor(async (signal) => {
    let child,
      sources,
      syncTask = null,
      revision = 0,
      stopped = false
    // Subscribe before capture. Saves during capture or remote startup must
    // reach the worker before the first browser message can use its mirror.
    const dirty = new Set(repository ? [] : ['Main.lean'])
    const abort = new AbortController()
    const combined = AbortSignal.any([signal, abort.signal])
    const stop = () => {
      stopped = true
      unsubscribe()
      abort.abort(
        clusterError(
          'Remote editor source changed. Reopen the project.',
          'editor_source_changed',
          409,
        ),
      )
      child?.kill()
    }
    const current = () => {
      const value = workspaces.get(project.id, actor)
      if (
        value.root !== project.root ||
        value.status !== 'ready' ||
        value.kind !== project.kind ||
        value.toolchain !== project.toolchain
      )
        throw new Error('Editor workspace changed.')
      return value
    }
    const sync = () => {
      if (!child) return Promise.resolve()
      if (syncTask) return syncTask
      syncTask = Promise.resolve().then(async () => {
        try {
          while (dirty.size && !stopped) {
            const filename = dirty.values().next().value
            dirty.delete(filename)
            combined.throwIfAborted()
            current()
            const source = await workspaces.readFile(
              project.id,
              actor,
              filename,
            )
            combined.throwIfAborted()
            current()
            if (repository) {
              if (!sources.has(filename))
                throw new Error('Source tree changed.')
              if (source.hash && sources.get(filename) === source.hash) continue
              await child.syncFile(filename, source.content, ++revision)
              sources.set(filename, source.hash)
            } else {
              await child.syncMain(source.content, ++revision)
            }
          }
        } catch {
          stop()
        } finally {
          syncTask = null
        }
        combined.throwIfAborted()
      })
      // Workspace listeners schedule sync without awaiting a socket callback.
      syncTask.catch(() => {})
      return syncTask
    }
    const unsubscribe = workspaces.subscribeChanges((event) => {
      if (event.projectId !== project.id || stopped) return
      try {
        current()
        // Dependency/configuration changes and added, removed or renamed modules
        // require a fresh environment. Never serve a stale mirror silently.
        if (
          event.removedPaths?.length ||
          event.moves?.length ||
          (repository && event.kind === 'files' && !event.paths.length) ||
          (repository && event.kind === 'editor-imports') ||
          event.paths.some((filename) =>
            repository
              ? !editableRepositoryModule(filename) ||
                (sources && !sources.has(filename))
              : filename !== 'Main.lean',
          )
        )
          return stop()
        for (const filename of event.paths) dirty.add(filename)
        if (dirty.size) void sync()
      } catch {
        stop()
      }
    })
    combined.addEventListener(
      'abort',
      () => {
        unsubscribe()
        child?.kill()
      },
      { once: true },
    )
    const timer = setTimeout(
      () =>
        abort.abort(
          clusterError(
            'Remote editor preparation timed out.',
            'editor_timeout',
            504,
          ),
        ),
      120000,
    )
    timer.unref?.()
    let fallback,
      attemptedRemote = false
    try {
      current()
      const capture = () =>
        checks.captureEditor(project.root, combined, editorKind)
      const input = await capture().catch((error) => {
        // A collaborator can commit a normal save between fingerprint reads.
        // Try one fresh capture before falling back during sustained writes.
        if (!repository || error.code !== 'source_changed') throw error
        combined.throwIfAborted()
        current()
        return capture()
      })
      combined.throwIfAborted()
      const manifest =
        input &&
        (await checks.inputs.blobs.manifest(input.sourceManifest, 'source'))
      combined.throwIfAborted()
      current()
      const warm = !repository && checks.editorWarmup?.environment
      if (
        !input ||
        (warm &&
          (input.toolchain?.version !== warm.toolchain.version ||
            input.toolchain?.manifest !== warm.toolchain.manifest ||
            input.dependencies !== warm.dependencies ||
            input.editorSource !== warm.editorSource)) ||
        !editorSource(manifest, editorKind)
      ) {
        fallback = { unsupported: true }
      } else if (repository && !checks.controller.canOpenEditor(input)) {
        if (!checks.controller.editorCapacity?.(input))
          fallback = { unsupported: true }
      } else {
        if (repository) {
          sources = new Map(
            manifest.entries
              .filter(
                (entry) =>
                  entry.type === 'file' && editableRepositoryModule(entry.path),
              )
              .map((entry) => [entry.path, entry.hash]),
          )
          if ([...dirty].some((filename) => !sources.has(filename))) stop()
        }
        combined.throwIfAborted()
        attemptedRemote = true
        child = await checks.controller.openEditor(input, {
          actor,
          projectId: project.id,
          jobId: randomUUID(),
          signal: combined,
          timeoutMs: 6 * 60 * 60 * 1000,
        })
      }
      combined.throwIfAborted()
      if (child) {
        child.once('close', unsubscribe)
        child.beforeInput = sync
        await sync()
        combined.throwIfAborted()
        return child
      }
    } catch (error) {
      unsubscribe()
      child?.kill()
      const released = child?.workerReleased ?? error.workerReleased
      // A possibly running remote process keeps its grant until cleanup is
      // confirmed; launching a second copy could exceed the shared boundary.
      if (
        signal.aborted ||
        checks.closing ||
        child ||
        error.workerCleanup ||
        error.code === 'worker_cleanup' ||
        stopped
      ) {
        const reason = signal.aborted ? signal.reason : error
        throw released
          ? Object.assign(
              new Error(reason.message, { cause: reason }),
              reason,
              { workerReleased: released },
            )
          : reason
      }
      if (repository && !attemptedRemote) fallback = { unsupported: true }
    } finally {
      clearTimeout(timer)
    }
    unsubscribe()
    return local(fallback)
  })
}
