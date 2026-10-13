import { pretty, type Change } from './api'
import { Icon } from './Icons'

export function Verification({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind === 'search')
    return (
      <div className="verification-card verified">
        <strong>
          <Icon name="search" size={16} />
          Search complete
        </strong>
        <p>{String(v.reason || 'No project files changed.')}</p>
      </div>
    )
  const hasDetails = (item: unknown) =>
    Array.isArray(item)
      ? item.length > 0
      : !!item && (typeof item !== 'object' || Object.keys(item).length > 0)
  return (
    <div
      className={`verification-card ${v.complete === true ? 'verified' : 'unverified'}`}
    >
      <strong>
        {v.complete === true ? (
          <>
            <Icon name="check" size={16} />
            Lean verification passed
          </>
        ) : v.compiled === true ? (
          'Compiles with unfinished proof obligations'
        ) : (
          'Lean verification has not passed'
        )}
      </strong>
      {!!v.reason && <p>{String(v.reason)}</p>}
      {hasDetails(v.errors) && (
        <details>
          <summary>Verification errors</summary>
          <pre>{pretty(v.errors)}</pre>
        </details>
      )}
      {hasDetails(v.warnings) && (
        <details>
          <summary>Warnings</summary>
          <pre>{pretty(v.warnings)}</pre>
        </details>
      )}
      {!!v.axioms && (
        <details>
          <summary>Axiom audit</summary>
          <pre>{pretty(v.axioms)}</pre>
        </details>
      )}
    </div>
  )
}

export function ChangeDiff({ change }: { change: Change }) {
  const before = (change.before || '').split('\n')
  const after = (change.after || '').split('\n')
  let start = 0
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++
  const contextStart = Math.max(0, start - 3)
  const beforeEnd = before.length - end
  const afterEnd = after.length - end
  return (
    <div className="change-diff">
      <div className="change-file">
        <Icon name="file" size={15} />
        <strong>{change.path}</strong>
        <span className="diff-count removed-text">−{beforeEnd - start}</span>
        <span className="diff-count added-text">+{afterEnd - start}</span>
      </div>
      <div className="diff-lines">
        {contextStart > 0 && (
          <div className="diff-context">… {contextStart} unchanged lines</div>
        )}
        {before.slice(contextStart, start).map((line, i) => (
          <div key={`context-${i}`} className="diff-line">
            <span className="line-number">{contextStart + i + 1}</span>
            <span className="line-sign"> </span>
            <code>{line || ' '}</code>
          </div>
        ))}
        {before.slice(start, beforeEnd).map((line, i) => (
          <div key={`before-${i}`} className="diff-line removed">
            <span className="line-number">{start + i + 1}</span>
            <span className="line-sign">−</span>
            <code>{line || ' '}</code>
          </div>
        ))}
        {after.slice(start, afterEnd).map((line, i) => (
          <div key={`after-${i}`} className="diff-line added">
            <span className="line-number">{start + i + 1}</span>
            <span className="line-sign">+</span>
            <code>{line || ' '}</code>
          </div>
        ))}
        {after.slice(afterEnd, afterEnd + 3).map((line, i) => (
          <div key={`suffix-${i}`} className="diff-line">
            <span className="line-number">{afterEnd + i + 1}</span>
            <span className="line-sign"> </span>
            <code>{line || ' '}</code>
          </div>
        ))}
        {end > 3 && (
          <div className="diff-context">… {end - 3} unchanged lines</div>
        )}
      </div>
    </div>
  )
}
