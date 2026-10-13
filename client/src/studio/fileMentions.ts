import type { FileEntry } from './api'

export interface FileMentionQuery {
  start: number
  end: number
  query: string
}

export function fileMentionQuery(
  text: string,
  caret: number,
): FileMentionQuery | null {
  if (caret < 0 || caret > text.length) return null
  const match = /(?:^|[\s(])@(?:"([^"\n]*)|([^\s@"']*))$/.exec(
    text.slice(0, caret),
  )
  if (!match) return null
  const at = match.index + match[0].indexOf('@')
  return { start: at, end: caret, query: match[1] ?? match[2] ?? '' }
}

export function matchingProjectFiles(files: FileEntry[], query: string) {
  const normalized = query.toLowerCase()
  return files
    .filter(
      (file) =>
        !file.readOnly &&
        !file.path.startsWith('.lake/') &&
        file.path.toLowerCase().includes(normalized),
    )
    .sort(
      (a, b) =>
        Number(!a.path.toLowerCase().startsWith(normalized)) -
          Number(!b.path.toLowerCase().startsWith(normalized)) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, 8)
}

export function insertFileMention(
  text: string,
  query: FileMentionQuery,
  path: string,
) {
  const reference =
    '@' + (/\s|"/.test(path) ? JSON.stringify(path) : path) + ' '
  return {
    text: text.slice(0, query.start) + reference + text.slice(query.end),
    caret: query.start + reference.length,
  }
}
