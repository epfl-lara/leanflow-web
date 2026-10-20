/* eslint-disable no-control-regex -- Control characters must not become file paths. */
import type { RunProofTarget } from './api'

/** Chat file citations are relative to the project, not the page URL. */
export function chatFileLink(href: string): RunProofTarget | null {
  let value: string
  try {
    value = decodeURIComponent(href)
  } catch {
    return null
  }
  const match = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?::\d+)?)?$/.exec(value)
  if (!match) return null
  const path = match[1].replace(/^\/workspace\//, '').replace(/^\.\//, '')
  if (
    !path ||
    /[?#\\\x00-\x1f]/.test(path) ||
    path.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.split('/').some((part) => !part || part === '..' || part === '.')
  )
    return null
  const line = Number(match[2] || match[4] || 1)
  const end = Number(match[3] || line)
  if (
    !Number.isSafeInteger(line) ||
    !Number.isSafeInteger(end) ||
    line < 1 ||
    end < line
  )
    return null
  return { path, startLine: line, endLine: end }
}
