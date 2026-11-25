import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import profiles from './lemex-models.json' with { type: 'json' }
import { KIMI_K31_PRO } from './model-catalog.mjs'

const MAX_SAVED_MODELS = 100
const invalid = (message) => Object.assign(new Error(message), { status: 400 })
const validIds = (value) =>
  Array.isArray(value) &&
  value.length <= MAX_SAVED_MODELS + 1 &&
  (value.length <= MAX_SAVED_MODELS || value.includes(KIMI_K31_PRO)) &&
  value.every(
    (id) => typeof id === 'string' && id.length > 0 && id.length <= 512,
  )

async function readPreferences(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

function savedModelIds(
  value,
  { models, defaultModel, providerId = 'rcp', isRcp = true },
) {
  const preferences = value.providers?.[providerId]
  const selected =
    preferences?.savedModels ?? (isRcp ? value.savedModels : undefined)
  if (selected !== undefined && !validIds(selected))
    throw new Error('Invalid saved model list.')
  const available = new Set(models.map((model) => model.id))
  const saved =
    selected === undefined
      ? [
          ...new Set([
            defaultModel,
            ...(isRcp ? profiles.models.map((model) => model.slug) : []),
          ]),
        ]
          .filter((id) => available.has(id))
          .slice(0, 6)
      : [...new Set(selected)]
  if (
    !preferences?.kimiK31ProOptOut &&
    available.has(KIMI_K31_PRO) &&
    !saved.includes(KIMI_K31_PRO)
  )
    saved.push(KIMI_K31_PRO)
  return saved
}

// Picker preferences never grant access or replace the session's selected model.
export class ModelPreferences {
  #writes = new Map()

  constructor(dataDir) {
    this.directory = path.join(dataDir, 'model-preferences')
  }
  filename(owner) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(owner)) throw invalid('Invalid account.')
    return path.join(this.directory, owner + '.json')
  }
  async get(owner, access) {
    return savedModelIds(await readPreferences(this.filename(owner)), access)
  }
  async save(owner, input, access) {
    if (!validIds(input))
      throw invalid(
        `Choose up to ${MAX_SAVED_MODELS} models, plus Kimi K3.1 Pro.`,
      )
    const target = this.filename(owner)
    const write = (this.#writes.get(target) || Promise.resolve())
      .catch(() => {})
      .then(() => this.#save(target, input, access))
    this.#writes.set(target, write)
    try {
      return await write
    } finally {
      if (this.#writes.get(target) === write) this.#writes.delete(target)
    }
  }
  async #save(target, input, access) {
    const current = await readPreferences(target)
    const existing = savedModelIds(current, access)
    const allowed = new Set([
      ...access.models.map((model) => model.id),
      ...existing,
    ])
    const savedModels = [...new Set(input)]
    if (savedModels.some((id) => !allowed.has(id)))
      throw invalid(
        'A selected model is unavailable with your API key. Refresh models and try again.',
      )
    const { providerId = 'rcp', isRcp = true } = access
    const preferences = { savedModels }
    // Omission only opts out when Kimi was already in the account's picker.
    if (
      !savedModels.includes(KIMI_K31_PRO) &&
      (current.providers?.[providerId]?.kimiK31ProOptOut ||
        existing.includes(KIMI_K31_PRO))
    )
      preferences.kimiK31ProOptOut = true
    const value = {
      ...current,
      providers: { ...current.providers, [providerId]: preferences },
    }
    if (isRcp) value.savedModels = savedModels
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, JSON.stringify(value), {
        mode: 0o600,
        flag: 'wx',
      })
      await fs.rename(temporary, target)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return savedModels
  }
}
