export interface ReasoningModel {
  id?: string
  reasoningEfforts?: { id: string }[]
  defaultReasoningEffort?: string | null
}
export function modeReasoningEffort(
  mode: string,
  model?: ReasoningModel,
): string | null
export function reasoningPreferenceKey(
  provider: string,
  model: string,
  mode: string,
): string
export function selectedReasoningEffort(
  preferences: Record<string, string | null>,
  provider: string,
  model: ReasoningModel | undefined,
  mode: string,
): string | null
