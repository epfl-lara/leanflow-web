import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class Settings {
  constructor(dataDir) { this.dir = path.join(dataDir, 'settings') }
  async get(owner) {
    const defaults = { extraInstructions: '', tools: { lean: true, lean_explore: true, exa: true } }
    try { return { ...defaults, ...JSON.parse(await fs.readFile(this.filename(owner), 'utf8')) } } catch (error) { if (error.code !== 'ENOENT') throw error; return defaults }
  }
  filename(owner) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(owner)) throw new Error('Invalid settings owner.')
    return path.join(this.dir, owner + '.json')
  }
  async save(owner, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Invalid settings.'), { status: 400 })
    if (typeof input.extraInstructions !== 'string' || input.extraInstructions.length > 20_000) throw Object.assign(new Error('Additional instructions must be text of up to 20,000 characters.'), { status: 400 })
    if (!input.tools || ['lean', 'lean_explore', 'exa'].some(key => typeof input.tools[key] !== 'boolean')) throw Object.assign(new Error('Choose the tools to enable.'), { status: 400 })
    const settings = { extraInstructions: input.extraInstructions, tools: Object.fromEntries(['lean', 'lean_explore', 'exa'].map(key => [key, input.tools[key]])) }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    const target = this.filename(owner), temporary = target + '.' + randomUUID() + '.tmp'
    await fs.writeFile(temporary, JSON.stringify(settings), { mode: 0o600 }); await fs.rename(temporary, target)
    return settings
  }
}
