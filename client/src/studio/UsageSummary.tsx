import { pretty } from './api'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
const format = (value: number) => new Intl.NumberFormat().format(value)

export function UsageSummary({ value }: { value: unknown }) {
  if (value == null) return null
  const usage = record(value),
    total = record(usage.total),
    last = record(usage.last)
  const metrics = [
    ['Input', count(total.inputTokens)],
    ['Output', count(total.outputTokens)],
    ['Cached input', count(total.cachedInputTokens)],
    ['Cache write', count(total.cacheWriteInputTokens)],
    ['Reasoning output', count(total.reasoningOutputTokens)],
    ['Total reported', count(total.totalTokens)],
  ] as const
  const input = count(last.inputTokens),
    window = count(usage.modelContextWindow)
  return (
    <details className="usage-details readable-usage">
      <summary>Usage</summary>
      {metrics.some(([, value]) => value !== null) ? (
        <dl className="usage-totals">
          {metrics
            .filter(([, value]) => value !== null)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{format(value!)}</dd>
              </div>
            ))}
        </dl>
      ) : (
        <p className="field-help">Token totals were not reported.</p>
      )}
      {input !== null && window !== null && window > 0 && input <= window && (
        <p className="usage-context">
          Latest input: {format(input)} of {format(window)} reported
          context-window tokens ({((100 * input) / window).toFixed(1)}%).
        </p>
      )}
      <p className="field-help">
        Reported counters; cache and reasoning fields are shown separately
        without estimating charges.
      </p>
      <details className="usage-raw">
        <summary>Raw data</summary>
        <pre>{pretty(value)}</pre>
      </details>
    </details>
  )
}
