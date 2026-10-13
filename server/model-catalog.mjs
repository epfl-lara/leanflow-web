export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash'

// RCP serves these models through vLLM. A generic low/medium/high catalog
// incorrectly offers levels that their prompt encoders ignore or reject.
// DeepSeek V4.1: https://docs.vllm.ai/en/v0.31.0/api/vllm/tokenizers/deepseek_v41/
// Other entries: the model owner's chat_template.jinja / encoding on Hugging Face.
const rcpReasoning = new Map([
  [DEFAULT_MODEL, { levels: ['low', 'high', 'xhigh', 'max'], default: 'max' }],
  [
    'deepseek-ai/DeepSeek-V4-Flash-0731',
    { levels: ['low', 'high', 'max'], default: 'low' },
  ],
  [
    'Qwen/Qwen3.8-Flash-Next',
    { levels: ['low', 'medium', 'xhigh'], default: 'xhigh' },
  ],
  [
    'Qwen/Qwen3.8-27B',
    { levels: ['low', 'medium', 'xhigh'], default: 'xhigh' },
  ],
  ['zai-org/GLM-5.2', { levels: ['high', 'max'], default: 'max' }],
  ['zai-org/GLM-5.3-Flash', { levels: ['low', 'high', 'max'], default: 'max' }],
  ...[
    'moonshotai/Kimi-K2.7-Code',
    'Qwen/Qwen3.5-397B-A17B',
    'Qwen/Qwen3-VL-235B-A22B-Thinking',
    'Qwen/Qwen3.6-35B-A3B',
  ].map((id) => [id, { levels: [], default: null }]),
])

// Keep all other native metadata intact. This same catalog is passed to Lemex
// so its fallback effort cannot reintroduce an unsupported selection.
export function rcpModelCatalog(catalog) {
  const models = Array.isArray(catalog) ? catalog : catalog.models || []
  return {
    ...(Array.isArray(catalog) ? {} : catalog),
    models: models.map((model) => {
      const reasoning = rcpReasoning.get(model.slug || model.id)
      if (!reasoning) return model
      return {
        ...model,
        default_reasoning_level: reasoning.default,
        supported_reasoning_levels: reasoning.levels.map((effort) => ({
          effort,
          description: `${effort} reasoning effort`,
        })),
      }
    }),
  }
}
