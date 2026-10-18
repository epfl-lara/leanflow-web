import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import profiles from './lemex-models.json' with { type: 'json' }

const invalid = (message) => Object.assign(new Error(message), { status: 400 })
const validIds = (value) =>
  Array.isArray(value) &&
  value.length <= 100 &&
  value.every(
    (id) => typeof id === 'string' && id.length > 0 && id.length <= 512,
  )

// Picker preferences never grant access or replace the session's selected model.
export class ModelPreferences {
  constructor(dataDir) {
    this.directory = path.join(dataDir, 'model-preferences')
  }
  filename(owner) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(owner)) throw invalid('Invalid account.')
    return path.join(this.directory, owner + '.json')
  }
  async get(owner, { models, defaultModel }) {
    try {
      const value = JSON.parse(await fs.readFile(this.filename(owner), 'utf8'))
      if (!validIds(value.savedModels))
        throw new Error('Invalid saved model list.')
      return [...new Set(value.savedModels)]
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const available = new Set(models.map((model) => model.id))
    return [
      ...new Set([defaultModel, ...profiles.models.map((model) => model.slug)]),
    ]
      .filter((id) => available.has(id))
      .slice(0, 6)
  }
  async save(owner, input, access) {
    if (!validIds(input))
      throw invalid('Choose up to 100 models from the available list.')
    const existing = await this.get(owner, access)
    const allowed = new Set([
      ...access.models.map((model) => model.id),
      ...existing,
    ])
    const savedModels = [...new Set(input)]
    if (savedModels.some((id) => !allowed.has(id)))
      throw invalid(
        'A selected model is unavailable with your API key. Refresh models and try again.',
      )
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const target = this.filename(owner)
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, JSON.stringify({ savedModels }), {
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
