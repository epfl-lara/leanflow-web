export const EDITOR_QUEUE_METHOD = '$/leanflow/editorQueue'

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
