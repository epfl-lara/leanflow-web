import path from 'node:path'
import { PROJECT_CONFIGURATION_FILES } from '../shared/project-configuration.mjs'

export const CONFIGURATION_FILES = new Set(PROJECT_CONFIGURATION_FILES)
const SECRET_PARTS = new Set([
  '.git',
  '.lemex',
  '.codex',
  '.ssh',
  '.aws',
  '.azure',
  '.config',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials',
  'credentials.json',
  'auth.json',
])

export class WorkspaceError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'WorkspaceError'
    this.status = this.statusCode = status
  }
}

export function fail(message, status = 400, code) {
  const error = new WorkspaceError(message, status)
  if (code) error.code = code
  throw error
}

export function isSecret(part) {
  const p = part.toLowerCase()
  return (
    SECRET_PARTS.has(p) ||
    p === '.env' ||
    p.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx)$/.test(p) ||
    p === 'settings.local.json'
  )
}

export function relativeFile(value, { write = false } = {}) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    value.includes('\\') ||
    /[\x00-\x1f]/.test(value) ||
    path.posix.isAbsolute(value)
  )
    fail('Invalid file path')
  const parts = value.split('/')
  if (
    parts.length > 64 ||
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        Buffer.byteLength(p) > 255 ||
        isSecret(p),
    )
  )
    fail('File path is not permitted')
  if (parts.includes('node_modules'))
    fail('Dependency installation directories are not accessible')
  if (write && parts.length > 1 && CONFIGURATION_FILES.has(parts[0]))
    fail(
      'Project setup files cannot be used as folders. Choose another location.',
    )
  if (
    parts.includes('.lake') &&
    (parts[0] !== '.lake' ||
      parts[1] !== 'packages' ||
      parts.length < 4 ||
      write)
  )
    fail('Dependency files are read only')
  return parts.join('/')
}

export function validateWorkspaceFilePath(value) {
  return relativeFile(value)
}
