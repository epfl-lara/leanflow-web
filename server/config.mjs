import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MODEL, rcpModelCatalog } from './model-catalog.mjs'

export function catalogModels(catalog, defaultModel) {
  const list = Array.isArray(catalog) ? catalog : catalog.models || []
  const models = list
    .filter((model) => !model.hidden)
    .map((model) => {
      const reasoningEfforts = (
        Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels
          : []
      )
        .filter((level) => level && typeof level.effort === 'string')
        .map((level) => ({
          id: level.effort,
          description:
            typeof level.description === 'string'
              ? level.description
              : level.effort,
        }))
      const defaultReasoningEffort = reasoningEfforts.some(
        (level) => level.id === model.default_reasoning_level,
      )
        ? model.default_reasoning_level
        : null
      return {
        id: model.slug || model.id,
        name: model.display_name || model.displayName || model.slug || model.id,
        reasoningEfforts,
        defaultReasoningEffort,
      }
    })
    .filter((model) => model.id)
  if (!models.some((model) => model.id === defaultModel))
    models.unshift({
      id: defaultModel,
      name: defaultModel,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    })
  return models
}

export async function loadConfig(
  dataDir,
  {
    env = process.env,
    packagedHome = new URL('../.runtime/lemex/', import.meta.url),
  } = {},
) {
  // The packaged catalog is what the isolated workers run. Do not display
  // different capabilities from a newer host installation.
  const packagedAvailable = await fs
    .access(new URL('config.toml', packagedHome))
    .then(
      () => true,
      () => false,
    )
  const installedHome =
    env.LEMEX_HOME ||
    (packagedAvailable
      ? fileURLToPath(packagedHome)
      : path.join(os.homedir(), '.lemex'))
  let text = ''
  try {
    text = await fs.readFile(path.join(installedHome, 'config.toml'), 'utf8')
  } catch {}
  const value = (name) =>
    new RegExp(`^${name}\\s*=\\s*"([^"\\n]+)"`, 'm').exec(text)?.[1]
  const defaultModel = env.STUDIO_MODEL || DEFAULT_MODEL
  let catalog
  const catalogFile = value('model_catalog_json') || 'models.json'
  try {
    catalog = JSON.parse(
      await fs.readFile(path.resolve(installedHome, catalogFile), 'utf8'),
    )
  } catch {
    catalog = { models: [] }
  }
  catalog = rcpModelCatalog(catalog)
  const models = catalogModels(catalog, defaultModel)
  const providerFile = path.join(dataDir, 'provider.json')
  let stored = {}
  try {
    stored = JSON.parse(await fs.readFile(providerFile, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const provider = {
    LEMEX_API_KEY: undefined,
    LEMEX_BASE_URL: env.LEMEX_BASE_URL || stored.LEMEX_BASE_URL,
  }
  const redact = (text) => {
    let result = String(text)
    for (const secret of [env.LEMEX_API_KEY, stored.LEMEX_API_KEY].filter(
      Boolean,
    ))
      result = result.split(secret).join('[redacted]')
    return result
  }
  let provenance = {}
  try {
    provenance = JSON.parse(
      await fs.readFile(
        new URL('../.runtime/lemex/lemex-install.json', import.meta.url),
        'utf8',
      ),
    )
  } catch {}
  let mcp = {}
  try {
    mcp = JSON.parse(await fs.readFile(path.join(dataDir, 'mcp.json'), 'utf8'))
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp))
      throw new Error(
        'Expected a server-name-to-configuration object in mcp.json.',
      )
    for (const [name, server] of Object.entries(mcp)) {
      if (
        !/^[A-Za-z0-9_-]{1,60}$/.test(name) ||
        ['lean', 'lean_probe', 'lean_explore', 'exa'].includes(name)
      )
        throw new Error(`Invalid or reserved MCP server name: ${name}`)
      if (
        !server ||
        typeof server !== 'object' ||
        Array.isArray(server) ||
        (!server.url && !server.command)
      )
        throw new Error(`MCP server ${name} needs a url or worker command.`)
      if (server.url && !server.url.startsWith('https://'))
        throw new Error(`MCP server ${name} must use HTTPS.`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return {
    defaultModel,
    models,
    modelCatalog: catalog,
    provider,
    redact,
    mcp,
    lemex: {
      revision:
        provenance.source_commit || provenance.native_build_commit || null,
      configured: !!provider.LEMEX_API_KEY,
    },
  }
}
