import { markdownImagePath } from './markdownImagePath'

export interface LeanCommentImage {
  lineNumber: number
  path: string
  alt: string
}

export const MAX_LEAN_COMMENT_IMAGES = 20
export const MAX_LEAN_COMMENT_SOURCE_LENGTH = 512 * 1024

// This display-only scan never changes source text or asks Lean to evaluate it.
// Keep work bounded while an editor is typing or receiving streamed changes.
export function leanCommentImages(
  source: string,
  currentPath: string,
): LeanCommentImage[] {
  if (
    !/\.lean$/i.test(currentPath) ||
    source.length > MAX_LEAN_COMMENT_SOURCE_LENGTH
  )
    return []
  const result: LeanCommentImage[] = []
  const strings: { interpolated: boolean; expressionDepth: number }[] = []
  let index = 0
  let lineNumber = 1
  const advance = (end: number) => {
    while (index < end) if (source[index++] === '\n') lineNumber++
  }
  const links =
    /!?\[([^[\]\r\n]{0,256})\]\([ \t]*(?:<([^>\r\n]{1,1024})>|([^\s)\r\n]{1,1024}))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[ \t]*\)/g
  const comment = (start: number, end: number) => {
    links.lastIndex = 0
    const text = source.slice(start, end)
    for (let match = links.exec(text); match; match = links.exec(text)) {
      let backslashes = 0
      for (let at = match.index - 1; text[at] === '\\'; at--) backslashes++
      if (backslashes % 2) continue
      const path = markdownImagePath(match[2] || match[3], currentPath)
      if (!path) continue
      result.push({ lineNumber, path, alt: match[1] || path })
      if (result.length === MAX_LEAN_COMMENT_IMAGES) break
    }
  }
  const rawString = /r(#{0,})"/y
  const character = /'(?:\\(?:u\{[0-9a-fA-F]+\}|[^\r\n])|[^'\\\r\n])'/uy
  while (index < source.length && result.length < MAX_LEAN_COMMENT_IMAGES) {
    const string = strings.at(-1)
    if (string && !string.expressionDepth) {
      if (source[index] === '\\') advance(Math.min(index + 2, source.length))
      else if (source[index] === '"') {
        strings.pop()
        index++
      } else if (string.interpolated && source[index] === '{') {
        if (source[index + 1] === '{') index += 2
        else {
          string.expressionDepth++
          index++
        }
      } else advance(index + 1)
      continue
    }
    if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index + 2)
      const boundary = end < 0 ? source.length : end
      comment(index + 2, boundary)
      advance(boundary)
    } else if (source.startsWith('/-', index)) {
      let depth = 1
      index += 2
      let start = index
      while (index < source.length && depth) {
        if (source.startsWith('/-', index)) {
          depth++
          index += 2
        } else if (source.startsWith('-/', index)) {
          depth--
          if (!depth) comment(start, index)
          index += 2
        } else if (source[index] === '\n') {
          comment(start, index)
          if (result.length === MAX_LEAN_COMMENT_IMAGES) return result
          index++
          lineNumber++
          start = index
        } else index++
      }
      if (depth) comment(start, index)
    } else if (
      source[index] === 'r' &&
      !/[\p{L}\p{N}_']/u.test(source[index - 1] || '')
    ) {
      rawString.lastIndex = index
      const match = rawString.exec(source)
      if (!match) index++
      else {
        const closing = '"' + match[1]
        const end = source.indexOf(closing, rawString.lastIndex)
        advance(end < 0 ? source.length : end + closing.length)
      }
    } else if (source[index] === '"') {
      strings.push({
        interpolated: source.slice(Math.max(0, index - 2), index) === 's!',
        expressionDepth: 0,
      })
      index++
    } else if (source[index] === '«') {
      const end = source.indexOf('»', index + 1)
      advance(end < 0 ? source.length : end + 1)
    } else if (
      source[index] === "'" &&
      !/[\p{L}\p{N}_']/u.test(source[index - 1] || '')
    ) {
      character.lastIndex = index
      const match = character.exec(source)
      advance(match ? character.lastIndex : index + 1)
    } else if (string && source[index] === '{') {
      string.expressionDepth++
      index++
    } else if (string && source[index] === '}') {
      string.expressionDepth--
      index++
    } else advance(index + 1)
  }
  return result
}
