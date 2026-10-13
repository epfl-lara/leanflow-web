import type { Session } from './api'

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
  return (
    <details className="chat-options">
      <summary>
        Options <span>{selected?.name || 'Choose model'}</span>
      </summary>
      <div className="chat-options-fields">
        <label>
          Model
          <select
            value={model}
            onChange={(event) => onModel(event.target.value)}
          >
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reasoning effort
          <select
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
        </label>
      </div>
      <label className="chat-live-choice">
        <input
          type="checkbox"
          checked={liveEdits}
          onChange={(event) => onLiveEdits(event.target.checked)}
        />
        <span>Edit files live</span>
      </label>
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
