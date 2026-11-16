import { PROJECT_CONFIGURATION_FILES } from '../shared/project-configuration.mjs'
import { changedDependencyPin } from './pinned-lake.mjs'

const configurationFiles = new Set(PROJECT_CONFIGURATION_FILES)
const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status })
}

export function setupRequestPurpose(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('Send the assistant task as a JSON object.', 400)
  if (input.purpose === undefined) return undefined
  if (input.purpose !== 'setup') fail('Choose a supported assistant task.', 400)
  if (input.mode !== 'search' || input.liveEdits !== false)
    fail(
      'Setup help uses Ask & Search with review-first changes. Start an ordinary chat for other file work.',
      400,
    )
  return 'setup'
}

function manifest(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Setup help cannot quietly repair a build by changing mathematics or moving
// the project to another environment. Ordinary requested file work has its own
// existing review/live-edit policy and does not use this restricted purpose.
export function assertSetupRequestChanges(changes) {
  for (const change of changes) {
    if (!configurationFiles.has(change.path))
      fail(
        'Setup help can change only the root Lean and Lake configuration. Your source files are preserved. Use an ordinary chat to request source changes.',
      )
    if (change.path === 'lean-toolchain' && typeof change.before === 'string') {
      const pin = change.before.trim()
      if (/^[^/\s]+\/[^:\s]+:[^\s]+$/.test(pin) && change.after?.trim() !== pin)
        fail(
          'Setup help preserves the pinned Lean release. Use an ordinary chat to explicitly request a version change.',
        )
    }
    if (
      change.path === 'lake-manifest.json' &&
      changedDependencyPin(manifest(change.before), manifest(change.after))
    )
      fail(
        'Setup help preserves existing dependency sources and revisions. Use an ordinary chat to explicitly request dependency changes.',
      )
  }
}
