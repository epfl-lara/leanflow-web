export const MAX_MARKDOWN_PREVIEW_BYTES = 512 * 1024

export const isMarkdownPath = (path?: string) =>
  !!path &&
  /\.(?:md|mkd|mdwn|mdown|markdown|markdn|mdtxt|mdtext|workbook)$/i.test(path)

export function markdownProjectPath(
  currentPath: string,
  href: string,
): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(href.split(/[?#]/)[0])
  } catch {
    return null
  }
  if (!decoded || decoded.includes('\\') || decoded.includes('\0')) return null
  const parts = decoded.startsWith('/')
    ? []
    : currentPath.split('/').slice(0, -1)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/') || null
}
