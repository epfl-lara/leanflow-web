import type { Session } from './api'
import { useId } from 'react'
import { HelpTip } from './HelpTip'

export function ChatOptions({
  models,
  model,
  onModel,
  effort,
  onEffort,
  liveEdits,
  onLiveEdits,
  active,
}: {
  models: Session['models']
  model: string
  onModel: (value: string) => void
  effort: string
  onEffort: (value: string) => void
  liveEdits: boolean
  onLiveEdits: (value: boolean) => void
  active: boolean
}) {
  const selected = models.find((item) => item.id === model)
  const levels = selected?.reasoningEfforts || []
  const modelId = useId()
  const effortId = useId()
  return (
    <details className="chat-options">
      <summary>
        Options <span>{selected?.name || 'Choose model'}</span>
      </summary>
      <div className="chat-options-fields">
        <div>
          <div className="help-label">
            <label htmlFor={modelId}>Model</label>
          </div>
          <select
            id={modelId}
            value={model}
            onChange={(event) => onModel(event.target.value)}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className="help-label">
            <label htmlFor={effortId}>Reasoning effort</label>
            <HelpTip label="Reasoning effort">
              Choose how much reasoning the model uses for the next run. Higher
              levels can take longer. Available levels depend on the selected
              model; Default uses that model’s default.
            </HelpTip>
          </div>
          <select
            id={effortId}
            aria-label="Reasoning effort"
            aria-describedby={
              !levels.length ? 'reasoning-effort-help' : undefined
            }
            value={levels.some((level) => level.id === effort) ? effort : ''}
            onChange={(event) => onEffort(event.target.value)}
            disabled={!levels.length}
          >
            <option value="">
              Default
              {selected?.defaultReasoningEffort
                ? ` (${selected.defaultReasoningEffort})`
                : ''}
            </option>
            {levels.map((level) => (
              <option key={level.id} value={level.id} title={level.description}>
                {level.id}
              </option>
            ))}
          </select>
          {!levels.length && (
            <span id="reasoning-effort-help" className="field-help">
              This model has no adjustable reasoning effort.
            </span>
          )}
        </div>
      </div>
      <div className="chat-live-choice">
        <label className="help-label">
          <input
            type="checkbox"
            checked={liveEdits}
            onChange={(event) => onLiveEdits(event.target.checked)}
          />
          <span>Edit files live</span>
        </label>
        <HelpTip label="Edit files live">
          When on, Lemex saves edits as it works; stop the run to undo its
          edits. Turn this off to review changes before applying them. This
          choice applies to the next run.
        </HelpTip>
      </div>
      <p className="field-help">
        {active
          ? 'Options apply to the next run. Updates guide the current run.'
          : liveEdits
            ? 'Edits are saved as Lemex works; you can undo them after stopping.'
            : 'Keep edits separate until you review and apply them.'}{' '}
        Runs continue until done or stopped.
      </p>
    </details>
  )
}
