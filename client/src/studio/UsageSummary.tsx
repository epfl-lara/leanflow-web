import { pretty } from './api'

const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Reflect.get(value, key)
    : undefined
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
const format = (value: number) => new Intl.NumberFormat().format(value)

export function UsageSummary({ value }: { value: unknown }) {
  if (value == null) return null
  const total = field(value, 'total'),
    last = field(value, 'last')
  const metrics = [
    ['Input (including cached)', count(field(total, 'inputTokens'))],
    ['Output', count(field(total, 'outputTokens'))],
    ['Cached input', count(field(total, 'cachedInputTokens'))],
    ['Cache write', count(field(total, 'cacheWriteInputTokens'))],
    ['Reasoning output', count(field(total, 'reasoningOutputTokens'))],
    ['Total tokens', count(field(total, 'totalTokens'))],
  ] as const
  const input = count(field(last, 'inputTokens')),
    window = count(field(value, 'modelContextWindow'))
  return (
    <section className="usage-details readable-usage" aria-label="Usage">
      <p className="usage-context">
        {input === null ? (
          'Current context was not reported.'
        ) : (
          <>
            Current context: {format(input)}
            {window !== null && window > 0 ? (
              <>
                {' / '}
                {format(window)} tokens
                {input <= window &&
                  ` (${((100 * input) / window).toFixed(1)}%)`}
              </>
            ) : (
              ' tokens'
            )}
            . Based on the latest model call.
          </>
        )}
      </p>
      <details className="usage-request">
        <summary>Totals for this request</summary>
        <p className="field-help">
          Processing across all model calls for this request. Repeated context
          counts each time; these totals are not the current context size.
          Cached input is included in Input.
        </p>
        {metrics.some(([, value]) => value !== null) ? (
          <dl className="usage-totals">
            {metrics.map(
              ([label, value]) =>
                value !== null && (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{format(value)}</dd>
                  </div>
                ),
            )}
          </dl>
        ) : (
          <p className="field-help">Token totals were not reported.</p>
        )}
        <details className="usage-raw">
          <summary>Raw data</summary>
          <pre>{pretty(value)}</pre>
        </details>
      </details>
    </section>
  )
}
