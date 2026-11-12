import { ApiError } from './api'
import type { WorkspaceBuffers, WorkspaceScope } from './workspaceBuffers'

// Listings can be stale or bounded. Confirm missing source files individually,
// and reject results from a previous visit, reload, move, or acknowledged save.
export async function reconcileMissingBuffers(
  store: WorkspaceBuffers,
  scope: WorkspaceScope,
  listedPaths: readonly string[],
  readFile: (path: string) => Promise<unknown>,
) {
  if (!store.isCurrent(scope)) return
  const listed = new Set(listedPaths)
  const candidates = [...store.getSnapshot().buffers.values()].filter(
    (file) =>
      !file.unavailable &&
      !file.path.startsWith('.lake/') &&
      file.preview !== 'pdf' &&
      !listed.has(file.path),
  )
  for (const previous of candidates) {
    if (!store.isCurrent(scope)) return
    try {
      await readFile(previous.path)
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 404 ||
        !store.isCurrent(scope)
      )
        continue
      const current = store.getSnapshot().buffers.get(previous.path)
      if (
        current &&
        current.generation === previous.generation &&
        current.hash === previous.hash
      )
        store.detach(previous.path)
    }
  }
}
