import {
  editorAdmissionReasons,
  REPOSITORY_TREE_CHANGED,
} from '../../../shared/editor-queue.mjs'

export const leanConnectionFailed =
  'Lean could not connect. Check your connection and use Restart Lean to retry. You can keep editing.'

// Startup errors may include internal worker details. Only show recognized
// server messages. The server limits startup close reasons to 100 bytes.
const startupReasons = [
  ...Object.values(editorAdmissionReasons),
  'Account access changed. Sign in again.',
  'This project is not ready for a Lean connection.',
  'This project is stopping. Wait a moment.',
  'Lean connection is busy. Reopen the project to reconnect.',
]

export function transientLeanStartupClose(code: number, reason: string) {
  if (code === 1006 || code === 1011) return true
  if (code === 1012)
    return reason !== 'Project configuration changed. Retry setup.'
  if (code !== 1013) return false
  return !startupReasons.some(
    (message) =>
      message !== editorAdmissionReasons.closing &&
      message !== 'Lean connection is busy. Reopen the project to reconnect.' &&
      reason === message.slice(0, 100),
  )
}

export function leanConnectionCloseMessage(code: number, reason: string) {
  switch (code) {
    case 1000:
      return ''
    case 1001:
      return reason === 'Project archived.'
        ? 'This project was archived. Restore it to reconnect to Lean.'
        : leanConnectionFailed
    case 1008:
      return reason === 'Account access changed. Sign in again.' ||
        reason === 'Project access changed. Reopen the project.'
        ? reason
        : leanConnectionFailed
    case 1009:
      return /^Lean source files must be at most \d+ MiB\. Reduce the file or split Lean sources into smaller modules\.$/.test(
        reason,
      )
        ? reason
        : 'The Lean message is too large. Reduce the source or split it into smaller modules.'
    case 1012:
      if (reason === REPOSITORY_TREE_CHANGED)
        return 'Project files changed. Use Restart Lean to check your current draft.'
      return reason === 'Project configuration changed. Retry setup.'
        ? reason
        : 'LeanFlow is restarting. Wait a moment, then use Restart Lean.'
    case 1013:
      return (
        startupReasons.find((message) => reason === message.slice(0, 100)) ??
        'Lean is temporarily unavailable. Wait a moment, then use Restart Lean.'
      )
    case 1011:
      if (reason === 'Lean could not start.')
        return 'Lean could not start. Use Restart Lean to retry. You can keep editing.'
      return 'The Lean server stopped. Use Restart Lean to reconnect. You can keep editing.'
    default:
      return leanConnectionFailed
  }
}
