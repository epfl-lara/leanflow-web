import { HelpTip } from './HelpTip'

interface Measurement {
  available?: boolean
  compiled?: boolean | null
  proofTokens?: number
  totalTokens?: number
  heartbeats?: number
  totalHeartbeatsRaw?: number
  reason?: string
}
export function OptimizationSummary({
  value,
  active,
}: {
  value: unknown
  active: boolean
}) {
  if (!value || typeof value !== 'object') return null
  const result = value as {
    baseline?: Measurement
    candidate?: Measurement
    reductions?: {
      proofTokensPercent?: number | null
      heartbeatsPercent?: number | null
    }
  }
  const before = result.baseline,
    after = result.candidate
  const tokens = (item?: Measurement) =>
    item?.available ? String(item.proofTokens ?? item.totalTokens ?? '—') : '—'
  const heartbeats = (item?: Measurement) =>
    item?.available && Number.isFinite(item.totalHeartbeatsRaw)
      ? ((item.totalHeartbeatsRaw || 0) / 1000).toLocaleString(undefined, {
          maximumFractionDigits: 3,
        })
      : '—'
  const reduction = (number?: number | null) =>
    typeof number === 'number' && Number.isFinite(number)
      ? `${number.toFixed(1)}%`
      : '—'
  return (
    <div className="optimization-summary">
      <strong>Proof optimization measurements</strong>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Before</th>
            <th>After</th>
            <th>Reduction</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>
              <span className="help-label">
                Proof tokens
                <HelpTip label="Proof tokens">
                  Measure the size of the proof text. Optimize can try to reduce
                  this count while preserving the theorem statement and checking
                  the proof in Lean.
                </HelpTip>
              </span>
            </th>
            <td>{tokens(before)}</td>
            <td>{tokens(after)}</td>
            <td>{reduction(result.reductions?.proofTokensPercent)}</td>
          </tr>
          <tr>
            <th>
              <span className="help-label">
                Heartbeats
                <HelpTip label="Heartbeats">
                  Lean’s measure of work spent checking a proof. Fewer
                  heartbeats mean less checking work in the same Lean
                  environment; they do not measure seconds or model usage.
                </HelpTip>
              </span>
            </th>
            <td>{heartbeats(before)}</td>
            <td>{heartbeats(after)}</td>
            <td>{reduction(result.reductions?.heartbeatsPercent)}</td>
          </tr>
        </tbody>
      </table>
      {before?.reason && !before.available && <p>Baseline: {before.reason}</p>}
      {after?.reason && !after.available && <p>Candidate: {after.reason}</p>}
      {!after && (
        <p>
          {active
            ? 'Checking the candidate before measuring its cost…'
            : 'The candidate was not measured for this run.'}
        </p>
      )}
      <p className="field-help">
        Measured in this project’s pinned Lean environment. Heartbeats measure
        elaboration work; these values are separate from elapsed time and model
        usage.
      </p>
    </div>
  )
}
