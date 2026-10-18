import type { Session } from './api'
import { useId, useState } from 'react'
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
  const searchId = useId()
  const [query, setQuery] = useState('')
  const matching = models.filter(
    (item) =>
      item.id === model ||
      `${item.id} ${item.name}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  )
  const effortId = useId()
  return (
    <details className="chat-options">
      <summary>
        Options <span>{selected?.name || 'Choose model'}</span>
      </summary>
      <div className="chat-options-fields">
        {models.length > 10 && (
          <div className="chat-model-search">
            <label className="sr-only" htmlFor={searchId}>
              Search available models
            </label>
            <input
              id={searchId}
              type="search"
              placeholder="Search available models…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}
        <div>
          <div className="help-label">
            <label htmlFor={modelId}>Model</label>
          </div>
          <select
            id={modelId}
            value={model}
            onChange={(event) => onModel(event.target.value)}
            disabled={!models.length}
          >
            {!selected && model ? (
              <option value={model} disabled>
                Unavailable: {model}
              </option>
            ) : (
              !models.length && <option value="">No model available</option>
            )}
            {matching.map((item) => (
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
            value={effort}
            onChange={(event) => onEffort(event.target.value)}
            disabled={!levels.length && !effort}
          >
            <option value="">
              Default
              {selected?.defaultReasoningEffort
                ? ` (${selected.defaultReasoningEffort})`
                : ''}
            </option>
            {effort && !levels.some((level) => level.id === effort) && (
              <option value={effort} disabled>
                Unavailable: {effort}
              </option>
            )}
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
          When on, Lemex saves requested edits as it works; stop the run to undo
          its edits. Turn this off to review changes before applying them. Ask &
          Search starts with live edits off. This choice applies to the next
          run.
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
