export const REPOSITORY_TREE_CHANGED =
  'Project files were added, removed or renamed.'
export const EDITOR_QUEUE_METHOD = '$/leanflow/editorQueue'

export const editorAdmissionReasons = {
  queueFull:
    'Lean editors are busy and the waiting list is full. Close unused editor tabs or try again shortly.',
  accountQueueFull:
    'You already have the most Lean editor tabs allowed to wait. Close one or wait for an editor to start.',
  expired:
    'No Lean editor became free in time. Reopen the file to join the waiting list again.',
  closing: 'LeanFlow is restarting. Reopen the file in a moment.',
}

export function editorQueueNotice(value) {
  if (!value || typeof value !== 'object') return null
  if (value.state === 'starting' || value.state === 'active')
    return { state: value.state }
  if (
    value.state !== 'waiting' ||
    !Number.isSafeInteger(value.position) ||
    value.position < 1 ||
    !Number.isSafeInteger(value.total) ||
    value.total < value.position ||
    value.total > 10000
  )
    return null
  return { state: 'waiting', position: value.position, total: value.total }
}
