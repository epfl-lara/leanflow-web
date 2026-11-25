import * as fs from 'node:fs/promises'
import path from 'node:path'
import { providerToml } from './provider-endpoint.mjs'
import { providerRequestConfig } from './provider-requests.mjs'

// Synced from Lemmy00/lemex config/models.json at 787a20eec.
// Native Lemex enriches these profiles with the authenticated live RCP list.
export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
export const KIMI_K31_PRO = 'moonshotai/Kimi-K3.1-Pro'

// This published model accepts image inputs. Older native RCP discovery starts
// from a text-only bundled profile, which blocks Lemex's view_image tool.
// Keep this correction exact: unknown models retain provider capabilities.
const RCP_VISION_MODELS = new Set([DEFAULT_MODEL])

export function rcpModelCatalog(catalog) {
  const value = Array.isArray(catalog) ? { models: catalog } : catalog
  return {
    ...value,
    models: (value.models || []).map((model) => {
      const id = model.slug || model.id
      // Lemex may discover this RCP model without its documented effort levels.
      // https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart
      if (id === KIMI_K31_PRO && !model.supported_reasoning_levels?.length)
        return {
          ...model,
          default_reasoning_level: 'max',
          supported_reasoning_levels: [
            { effort: 'low', description: 'Lighter reasoning effort' },
            { effort: 'high', description: 'High reasoning effort' },
            { effort: 'max', description: 'Maximum reasoning effort' },
          ],
        }
      if (RCP_VISION_MODELS.has(id))
        return {
          ...model,
          input_modalities: [
            ...new Set([...(model.input_modalities || ['text']), 'image']),
          ],
        }
      return model
    }),
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

export function workerModelConfig(provider, catalog, selected) {
  // The native RCP provider refreshes its catalog and can drop Kimi's effort
  // levels. Reuse the account's catalog after LeanFlow has validated access.
  const useAccountCatalog =
    selected === KIMI_K31_PRO &&
    catalog?.models?.some((model) => (model.slug || model.id) === selected)
  return [
    ...providerToml(provider, { useAccountCatalog }),
    ...providerRequestConfig(provider),
    `model = ${JSON.stringify(selected)}`,
    'model_catalog_json = "models.json"',
    'web_search = "disabled"',
    ...modelContextConfig(catalog, selected),
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
