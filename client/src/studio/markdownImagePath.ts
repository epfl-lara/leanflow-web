import { isImageFile } from '../../../shared/file-previews.mjs'
import { chatFileLink } from './chatFileLink'
import { markdownProjectPath } from './fileReading'

// Image sources are resolved into the current project, never as browser URLs.
export function markdownImagePath(
  source: string,
  currentPath?: string,
): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(source)) return null
  const path =
    currentPath && !source.startsWith('/workspace/')
      ? markdownProjectPath(currentPath, source)
      : chatFileLink(source)?.path
  if (!path || !isImageFile(path) || !chatFileLink(path)) return null
  return path
}
