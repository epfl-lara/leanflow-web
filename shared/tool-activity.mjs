export const MAX_TOOL_STEPS = 80
const DETAIL_BUDGET = 48_000

// Bound both history rows and retained bodies. Old step labels remain useful
// after their larger request/result previews have been dropped.
export function mergeToolStep(steps, step) {
  const previous = steps.find((item) => item.id === step.id)
  const next = previous
    ? steps.map((item) => (item.id === step.id ? { ...item, ...step } : item))
    : [...steps, step].slice(-MAX_TOOL_STEPS)
  let remaining = DETAIL_BUDGET
  return next
    .toReversed()
    .map((item) => {
      const size = (item.input?.length || 0) + (item.output?.length || 0)
      if (size <= remaining) {
        remaining -= size
        return item
      }
      const { input: _input, output: _output, ...summary } = item
      return { ...summary, detailsOmitted: true }
    })
    .reverse()
}

export function isToolStep(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    ['command', 'read', 'search', 'check', 'edit', 'tool'].includes(
      value.kind,
    ) &&
    ['running', 'completed', 'failed', 'declined', 'finished'].includes(
      value.status,
    ) &&
    Number.isSafeInteger(value.messageOffset) &&
    value.messageOffset >= 0 &&
    Number.isSafeInteger(value.afterFollowups) &&
    value.afterFollowups >= 0
  )
}
