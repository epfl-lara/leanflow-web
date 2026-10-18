import type { ModelAccess, Session } from './api'
import { useId, useState } from 'react'
import { HelpTip } from './HelpTip'
import { ModelLibrary } from './ModelLibrary'

export function ChatOptions({
  models,
  savedModels,
  onModelsUpdated,
  model,
  onModel,
  effort,
  onEffort,
  liveEdits,
  onLiveEdits,
  active,
}: {
  models: Session['models']
  savedModels?: string[]
  onModelsUpdated: (access: ModelAccess) => void
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
  const [libraryOpen, setLibraryOpen] = useState(false)
  const saved = savedModels ?? models.slice(0, 6).map((item) => item.id)
  const choices = [...new Set([...saved, ...(model ? [model] : [])])]
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
            disabled={!models.length}
          >
            {!model && (
              <option value="" disabled>
                {models.length ? 'Choose a saved model' : 'No model available'}
              </option>
            )}
            {choices.map((id) => {
              const item = models.find((item) => item.id === id)
              return (
                <option key={id} value={id} disabled={!item}>
                  {item
                    ? `${item.name || id}${!saved.includes(id) ? ' (current)' : ''}`
                    : `Unavailable: ${id}`}
                </option>
              )
            })}
          </select>
          <button
            type="button"
            className="chat-add-models"
            disabled={!models.length}
            onClick={() => setLibraryOpen(true)}
          >
            Add models…
          </button>
        </div>
        <div>
          <div className="help-label">
            <label htmlFor={effortId}>Reasoning effort</label>
            <HelpTip label="Reasoning effort">
              Choose how much reasoning the model uses for the next run. Higher
              levels can take longer. Ask &amp; Search starts at high; Proofs,
              Formalize, and Optimize start at max when supported. Otherwise,
              the model’s default is used. Your choice is remembered separately
              for each mode and model while this assistant is open. Default lets
              the provider choose.
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
      {libraryOpen && (
        <ModelLibrary
          models={models}
          savedModels={saved}
          onSaved={onModelsUpdated}
          onClose={() => setLibraryOpen(false)}
        />
      )}
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
