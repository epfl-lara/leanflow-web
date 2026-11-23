import type { FileEntry } from './api'
import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'

const configurationFiles = new Set<string>(PROJECT_CONFIGURATION_FILES)
export const affectsLean = (path: string) =>
  path.endsWith('.lean') || configurationFiles.has(path)

export interface WorkspaceFileListing {
  files: FileEntry[]
  // A null signal means a file change or reconnect with unknown paths.
  reportedChanges?: readonly string[] | null
}

// Keep uncertainty separate from evidence that an open proof used older imports.
export function changedLeanFiles(
  before: readonly FileEntry[],
  { files, reportedChanges }: WorkspaceFileListing,
) {
  const previous = new Map(
    before
      .filter((file) => affectsLean(file.path))
      .map((file) => [file.path, file]),
  )
  const changed = new Set<string>()
  const unverifiedReports = new Set(reportedChanges?.filter(affectsLean))
  let uncertain = false
  for (const file of files) {
    if (!affectsLean(file.path)) continue
    const old = previous.get(file.path)
    if (
      !old ||
      old.size !== file.size ||
      (old.revision && file.revision && old.revision !== file.revision)
    )
      changed.add(file.path)
    if (!file.revision || (old && !old.revision)) uncertain = true
    if (old?.revision && file.revision) unverifiedReports.delete(file.path)
    previous.delete(file.path)
  }
  for (const [path, old] of previous) {
    changed.add(path)
    if (!old.revision) uncertain = true
  }
  if (uncertain) for (const path of unverifiedReports) changed.add(path)
  return {
    changed,
    uncertain,
    unknownChange: uncertain && reportedChanges === null,
  }
}
