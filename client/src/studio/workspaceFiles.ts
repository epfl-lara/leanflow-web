import { ApiError, type OpenFile } from './api'
import type { WorkspaceBuffers, WorkspaceScope } from './workspaceBuffers'

/** Refresh affected ordinary-save buffers without replacing drafts or newer saves. */
export async function refreshChangedBuffers(
  store: WorkspaceBuffers,
  scope: WorkspaceScope,
  paths: readonly string[],
  readFile: (path: string) => Promise<Pick<OpenFile, 'content' | 'hash'>>,
  manages: (path: string) => boolean = () => false,
) {
  const result: { pendingPaths: string[]; failedPaths: string[] } = {
    pendingPaths: [],
    failedPaths: [],
  }
  if (!store.isCurrent(scope)) return result
  const affected = new Set(paths)
  const candidates = [...store.getSnapshot().buffers.values()].filter(
    (file) =>
      affected.has(file.path) &&
      !file.unavailable &&
      !file.preview &&
      !manages(file.path),
  )
  for (const previous of candidates) {
    if (!store.isCurrent(scope)) return result
    if (manages(previous.path)) continue
    if (previous.content !== previous.savedContent) {
      result.pendingPaths.push(previous.path)
      continue
    }
    let latest: Pick<OpenFile, 'content' | 'hash'>
    try {
      latest = await readFile(previous.path)
    } catch {
      const current = store.getSnapshot().buffers.get(previous.path)
      if (
        store.isCurrent(scope) &&
        !manages(previous.path) &&
        current?.generation === previous.generation &&
        current.hash === previous.hash
      )
        result.failedPaths.push(previous.path)
      continue
    }
    const current = store.getSnapshot().buffers.get(previous.path)
    if (
      !store.isCurrent(scope) ||
      manages(previous.path) ||
      !current ||
      current.unavailable ||
      current.generation !== previous.generation ||
      current.hash !== previous.hash ||
      current.savedContent !== previous.savedContent
    )
      continue
    if (current.content !== current.savedContent) {
      result.pendingPaths.push(previous.path)
      continue
    }
    if (latest.hash !== current.hash)
      store.collaborated(
        previous.path,
        latest.content,
        latest.content,
        latest.hash,
      )
  }
  return result
}

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
  const snapshot = store.getSnapshot()
  let expectedOpenPaths = snapshot.openPaths
  const candidates = [
    ...new Set([...snapshot.openPaths, ...snapshot.buffers.keys()]),
  ]
    .map((path) => ({ path, previous: snapshot.buffers.get(path) }))
    .filter(
      ({ path, previous }) =>
        !previous?.unavailable &&
        !path.startsWith('.lake/') &&
        previous?.preview !== 'pdf' &&
        !listed.has(path),
    )
  for (const { path, previous } of candidates) {
    if (!store.isCurrent(scope)) return
    try {
      await readFile(path)
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        error.status !== 404 ||
        !store.isCurrent(scope)
      )
        continue
      const latest = store.getSnapshot()
      const current = latest.buffers.get(path)
      if (
        previous
          ? current &&
            current.generation === previous.generation &&
            current.hash === previous.hash
          : !current && latest.openPaths === expectedOpenPaths
      ) {
        store.detach(path)
        expectedOpenPaths = store.getSnapshot().openPaths
      }
    }
  }
}
