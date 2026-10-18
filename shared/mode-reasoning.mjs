// Use the workflow's preferred level only when the current provider advertises
// it. A missing level falls back to the model's supported default, then to no
// override so the provider can choose its own default.
export function modeReasoningEffort(mode, model) {
  const supported = model?.reasoningEfforts || []
  const preferred = mode === 'search' || mode === 'ask' ? 'high' : 'max'
  if (supported.some((level) => level.id === preferred)) return preferred
  const fallback = model?.defaultReasoningEffort
  return fallback && supported.some((level) => level.id === fallback)
    ? fallback
    : null
}

export function reasoningPreferenceKey(provider, model, mode) {
  return JSON.stringify([provider, model, mode])
}

// Only deliberate selector changes belong in preferences. Automatic defaults
// remain derived from live model metadata, so discovery can update them safely.
export function selectedReasoningEffort(preferences, provider, model, mode) {
  const key = reasoningPreferenceKey(provider, model?.id || '', mode)
  return Object.hasOwn(preferences, key)
    ? preferences[key]
    : modeReasoningEffort(mode, model)
}
