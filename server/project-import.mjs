import * as fs from 'node:fs/promises'
import path from 'node:path'
import {
  sourceFileByteLimit,
  MAX_SOURCE_UPLOAD_BYTES,
} from '../shared/source-limits.mjs'
import { isPdfFile } from '../shared/file-previews.mjs'
import { decodePdfUpload } from './pdf-preview.mjs'

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status })
}
const excluded = new Set([
  '.git',
  '.lake',
  '.lemex',
  '.codex',
  'node_modules',
  '__MACOSX',
])

export function projectDirectory(value = '') {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    value.includes('\\') ||
    /[\x00-\x1f]/.test(value)
  )
    fail('Invalid project subdirectory.')
  if (!value) return ''
  const parts = value.split('/')
  if (
    parts.length > 32 ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.startsWith('.') ||
        Buffer.byteLength(part) > 255 ||
        excluded.has(part),
    )
  )
    fail(
      'Choose a relative project subdirectory without hidden or parent folders.',
    )
  return parts.join('/')
}

export function repositoryLocation(value, { revision, subdirectory } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail('Enter an HTTPS Git repository or GitHub project link.')
  }
  let inferredRevision,
    inferredDirectory = ''
  if (url.hostname.toLowerCase() === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length > 2) {
      if (parts[2] !== 'tree' || parts.length < 4)
        fail(
          'Use a GitHub repository or folder link, not a file or pull request link.',
        )
      const tail = parts.slice(3).map((part) => {
        try {
          return decodeURIComponent(part)
        } catch {
          fail('Invalid encoded GitHub path.')
        }
      })
      // An explicit branch disambiguates GitHub links to branches containing '/'.
      const explicit = revision?.split('/')
      const length = explicit?.every((part, index) => part === tail[index])
        ? explicit.length
        : 1
      inferredRevision = tail.slice(0, length).join('/')
      inferredDirectory = tail.slice(length).join('/')
      url.pathname = '/' + parts.slice(0, 2).join('/')
    }
  }
  if (url.hostname.toLowerCase() === 'github.com') {
    url.search = ''
    url.hash = ''
  }
  return {
    repository: url.href,
    revision: revision || inferredRevision,
    subdirectory: projectDirectory(subdirectory ?? inferredDirectory),
  }
}

export function uploadedFiles(input, validatePath) {
  if (!Array.isArray(input) || !input.length || input.length > 5000)
    fail('Choose between 1 and 5,000 project files.')
  let bytes = 0
  const seen = new Set()
  return input
    .map((file) => {
      if (
        !file ||
        typeof file.path !== 'string' ||
        typeof file.content !== 'string'
      )
        fail('Upload text or PDF files with relative paths.')
      const name = validatePath(file.path)
      if (seen.has(name)) fail(`The upload contains duplicate paths: ${name}`)
      let content
      if (file.encoding === 'base64') {
        content = decodePdfUpload(name, file.content)
      } else {
        if (file.encoding !== undefined)
          fail(`Unsupported upload encoding: ${name}`, 415)
        if (isPdfFile(name))
          fail(`Upload ${name} as a PDF file, rather than text.`, 415)
        if (!file.content.isWellFormed())
          fail(`Invalid UTF-8 text in ${name}`, 415)
        if (file.content.includes('\0'))
          fail(`Binary files cannot be uploaded: ${name}`, 415)
        if (Buffer.byteLength(file.content) > sourceFileByteLimit(name))
          fail(
            `Files must be at most ${sourceFileByteLimit(name) / (1024 * 1024)} MiB: ${name}`,
            413,
          )
        content = file.content
      }
      const size = Buffer.byteLength(content)
      bytes += size
      if (bytes > MAX_SOURCE_UPLOAD_BYTES)
        fail(
          'The upload exceeds 32 MiB of project files. Import the Git repository or upload fewer files.',
          413,
        )
      seen.add(name)
      return { path: name, content }
    })
    .map((file) => {
      const parts = file.path.split('/')
      for (let index = 1; index < parts.length; index++)
        if (seen.has(parts.slice(0, index).join('/')))
          fail('An uploaded file also appears as a parent folder.')
      return file
    })
}

export async function detectProjectDirectory(root) {
  const candidates = []
  let visited = 0
  const visit = async (directory, prefix = '', depth = 0) => {
    if (++visited > 2500 || depth > 5) return
    const entries = await fs.readdir(directory, { withFileTypes: true })
    if (
      entries.some((entry) => entry.name === 'lean-toolchain' && entry.isFile())
    ) {
      candidates.push(prefix)
      return
    }
    for (const entry of entries)
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !excluded.has(entry.name)
      )
        await visit(
          path.join(directory, entry.name),
          prefix ? `${prefix}/${entry.name}` : entry.name,
          depth + 1,
        )
  }
  await visit(root)
  if (candidates.length > 1)
    fail(
      `Several Lean projects were found: ${candidates.slice(0, 8).join(', ')}. Choose a project subdirectory in the import options.`,
      409,
    )
  return candidates[0] || ''
}
