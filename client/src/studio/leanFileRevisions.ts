import type { FileEntry } from './api'
import { PROJECT_CONFIGURATION_FILES } from '../../../shared/project-configuration.mjs'

const configurationFiles = new Set<string>(PROJECT_CONFIGURATION_FILES)
export const affectsLean = (path: string) =>
  path.endsWith('.lean') || configurationFiles.has(path)

// Listings carry revisions from stat, without reading or hashing every source.
// Unknown revisions (including older servers) require conservative invalidation.
export function changedLeanFiles(
  before: readonly FileEntry[] | undefined,
  after: readonly FileEntry[],
): string[] | null {
  if (!before) return null
  const previous = new Map(
    before
      .filter((file) => affectsLean(file.path))
      .map((file) => [file.path, file.revision]),
  )
  const current = new Map(
    after
      .filter((file) => affectsLean(file.path))
      .map((file) => [file.path, file.revision]),
  )
  if ([...previous.values(), ...current.values()].some((revision) => !revision))
    return null
  return [...new Set([...previous.keys(), ...current.keys()])].filter(
    (path) => previous.get(path) !== current.get(path),
  )
}
