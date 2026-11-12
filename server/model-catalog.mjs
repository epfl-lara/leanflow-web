import * as fs from 'node:fs/promises'
import path from 'node:path'

// Synced from Lemmy00/lemex config/models.json at 787a20eec.
// Native Lemex enriches these profiles with the authenticated live RCP list.
export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

// This published model accepts image inputs. Older native RCP discovery starts
// from a text-only bundled profile, which blocks Lemex's view_image tool.
// Keep this correction exact: unknown models retain provider capabilities.
const RCP_VISION_MODELS = new Set([DEFAULT_MODEL])

export function rcpModelCatalog(catalog) {
  const value = Array.isArray(catalog) ? { models: catalog } : catalog
  return {
    ...value,
    models: (value.models || []).map((model) =>
      RCP_VISION_MODELS.has(model.slug || model.id)
        ? {
            ...model,
            input_modalities: [
              ...new Set([...(model.input_modalities || ['text']), 'image']),
            ],
          }
        : model,
    ),
  }
}

export function modelContextConfig(catalog, selected) {
  const profile = catalog?.models?.find(
    (model) => model.slug === selected || model.id === selected,
  )
  const context = profile?.context_window
  if (!Number.isSafeInteger(context) || context < 4096) return []
  return [
    `model_context_window = ${context}`,
    `model_auto_compact_token_limit = ${context >= 64000 ? context - 20000 : Math.floor(context * 0.9)}`,
  ]
}

export async function writeModelCatalog(home, catalog) {
  if (catalog)
    await fs.writeFile(
      path.join(home, '.lemex/models.json'),
      JSON.stringify(catalog),
      { mode: 0o600 },
    )
}
