import { randomUUID } from 'node:crypto'
import { DeferredEditor } from './editor-stream.mjs'
import { clusterError } from './state.mjs'
import { editorSource } from './worker-editor.mjs'

// Auth, collaboration and canonical writes stay on the coordinator. Only a
// disposable mirror of an eligible single-file workspace crosses this boundary.
export function clusterEditor(checks, { project, actor, workspaces }, local) {
  if (
    checks.closing ||
    checks.mode !== 'serve' ||
    checks.editorsReady?.() === false ||
    checks.editorCapacity?.() === 0 ||
    project.kind !== 'single-file' ||
    !checks.controller.canRun('lean.session', 'Main.lean')
  )
    return local()
  return new DeferredEditor(async (signal) => {
    let child,
      dirty = true,
      syncTask = null,
      revision = 0,
      stopped = false
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
        value.kind !== 'single-file'
      )
        throw new Error('Editor workspace changed.')
      return value
    }
    const sync = () => {
      if (!child) return Promise.resolve()
      if (syncTask) return syncTask
      syncTask = Promise.resolve().then(async () => {
        try {
          while (dirty && !stopped) {
            dirty = false
            combined.throwIfAborted()
            current()
            const source = await workspaces.readFile(
              project.id,
              actor,
              'Main.lean',
            )
            combined.throwIfAborted()
            current()
            await child.syncMain(source.content, ++revision)
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
          event.paths.some((filename) => filename !== 'Main.lean')
        )
          return stop()
        if (event.paths.includes('Main.lean')) {
          dirty = true
          void sync()
        }
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
    let fallback
    try {
      current()
      const input = await checks.captureEditor(project.root, combined)
      combined.throwIfAborted()
      const warm = checks.editorWarmup?.environment
      if (
        !input ||
        (warm &&
          (input.toolchain?.version !== warm.toolchain.version ||
            input.toolchain?.manifest !== warm.toolchain.manifest ||
            input.dependencies !== warm.dependencies ||
            input.editorSource !== warm.editorSource)) ||
        !editorSource(
          await checks.inputs.blobs.manifest(input.sourceManifest, 'source'),
        )
      ) {
        fallback = { unsupported: true }
      } else {
        combined.throwIfAborted()
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
        dirty = true
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
    } finally {
      clearTimeout(timer)
    }
    unsubscribe()
    return local(fallback)
  })
}
