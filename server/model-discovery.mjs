import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { AgentRpc } from './rpc.mjs'
import { catalogModels } from './config.mjs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  RCP_BASE_URL,
  providerEndpoint,
  isRcpEndpoint,
  fetchProvider,
} from './provider-endpoint.mjs'

const failure = (message, status = 503) =>
  Object.assign(new Error(message), { status })

function endpoint(base) {
  try {
    const url = new URL(base)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw failure('The Lemex provider endpoint needs server configuration.')
  }
}

// Use the installed Lemex discovery implementation, including its current
// provider metadata and reasoning profiles. Each invocation starts with an
// empty private home, so one account can never inherit another key's catalog.
export async function discoverNativeModels({
  config,
  provider,
  directory,
  signal,
  fetchImpl = fetchProvider,
}) {
  const base = endpoint(provider.LEMEX_BASE_URL)
  const home = await fs.mkdtemp(path.join(directory, 'catalog-'))
  let child, stopped, rpc, catalogServer
  try {
    const rcp = isRcpEndpoint(base)
    let catalogUrl
    if (!rcp) {
      // Fetch custom catalogs through the server's DNS-pinned public-HTTPS
      // transport. Let the installed Lemex normalize the exact bytes through
      // its catalog endpoint, without giving native discovery a second DNS
      // lookup or access to an unvalidated provider URL.
      const response = await fetchImpl(base + '/models', {
        headers: { authorization: `Bearer ${provider.LEMEX_API_KEY}` },
        redirect: 'error',
        signal,
      })
      if (!response.ok) throw new Error('Provider model discovery failed')
      const body = Buffer.from(await response.arrayBuffer())
      if (body.length > 1024 * 1024)
        throw new Error('Provider catalog is too large')
      catalogServer = createServer((req, res) => {
        if (
          new URL(req.url, 'http://127.0.0.1').pathname !== '/models' ||
          req.method !== 'GET' ||
          req.headers.authorization !== `Bearer ${provider.LEMEX_API_KEY}`
        ) {
          res.writeHead(404).end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        })
        res.end(body)
      })
      catalogServer.listen(0, '127.0.0.1')
      await once(catalogServer, 'listening')
      catalogUrl = `http://127.0.0.1:${catalogServer.address().port}/models`
    }
    const id = rcp ? 'rcp' : 'leanflow'
    await fs.writeFile(
      path.join(home, 'config.toml'),
      [
        `model_provider = "${id}"`,
        `model = ${JSON.stringify(rcp ? config.defaultModel : 'discovery')}`,
        ...(rcp
          ? [
              `model_catalog_json = ${JSON.stringify(path.join(config.lemexHome, 'models.json'))}`,
            ]
          : []),
        `[model_providers.${id}]`,
        `name = "${rcp ? 'RCP' : 'Custom provider'}"`,
        `base_url = ${JSON.stringify(base)}`,
        'env_key = "LEMEX_API_KEY"',
        'wire_api = "responses"',
        'requires_openai_auth = false',
        'supports_websockets = false',
        ...(catalogUrl
          ? [`model_catalog_url = ${JSON.stringify(catalogUrl)}`]
          : []),
        '[analytics]',
        'enabled = false',
        '[feedback]',
        'enabled = false',
        '[features]',
        'daemon_auto_start = false',
      ].join('\n') + '\n',
      { mode: 0o600 },
    )
    // Deliberately avoid inherited provider/auth overrides and the operator's
    // home. Keys travel only in this child's environment, never argv or files.
    child = spawn(
      path.join(config.lemexHome, 'bin/lemex'),
      ['app-server', '--stdio', '--strict-config'],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          LEMEX_HOME: home,
          LEMEX_API_KEY: provider.LEMEX_API_KEY,
          LEMEX_BASE_URL: base,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal,
      },
    )
    stopped = new Promise((resolve) => {
      child.once('close', resolve)
      child.once('error', resolve)
    })
    // Native diagnostics may contain transport details; never surface them.
    child.stderr.resume()
    rpc = new AgentRpc(child)
    await rpc.call(
      'initialize',
      { clientInfo: { name: 'leanflow_models', version: '0.1.0' } },
      15000,
    )
    rpc.notify('initialized')
    await rpc.call('model/list', { includeHidden: true }, 15000)
    // Lemex can fall back to its bundled picker when discovery fails. Only a
    // freshly written live cache proves this key's available models.
    const cache = JSON.parse(
      await fs.readFile(path.join(home, 'models_cache.json'), 'utf8'),
    )
    if (
      !Array.isArray(cache.models) ||
      !cache.models.length ||
      !cache.identity ||
      !cache.fetched_at ||
      !Number.isFinite(Date.parse(cache.fetched_at)) ||
      Math.abs(Date.now() - Date.parse(cache.fetched_at)) > 60000
    )
      throw new Error('No live model catalog')
    return { models: cache.models }
  } catch (cause) {
    throw Object.assign(
      failure(
        'Could not load models for your API key. Refresh models in Assistant settings, or check your key and provider access.',
      ),
      { cause },
    )
  } finally {
    rpc?.close()
    if (child) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
      await stopped
      clearTimeout(timer)
    }
    await fs.rm(home, { recursive: true, force: true })
    if (catalogServer) {
      catalogServer.closeAllConnections()
      await new Promise((resolve) => catalogServer.close(resolve))
    }
  }
}

export class ModelDiscovery {
  constructor({
    dataDir,
    config,
    providers,
    discover = discoverNativeModels,
    ttlMs = 300000,
  }) {
    Object.assign(this, { config, providers, discover, ttlMs })
    this.directory = path.join(dataDir, 'model-discovery')
    this.cache = new Map()
    this.pending = new Map()
    this.tasks = new Set()
    this.controllers = new Set()
    this.running = 0
    this.stopping = false
  }
  async get(owner, { refresh = false } = {}) {
    if (!this.providers.status(owner).configured)
      return {
        models: [],
        defaultModel: null,
        modelCatalog: { models: [] },
        modelsUpdatedAt: null,
      }
    const provider = this.providers.provider(owner)
    const identity = createHash('sha256')
      .update(provider.LEMEX_API_KEY + '\0' + provider.LEMEX_BASE_URL)
      .digest('hex')
    const previous = this.cache.get(owner)
    if (
      !refresh &&
      previous?.identity === identity &&
      Date.now() - previous.at < this.ttlMs
    )
      return previous.value
    const pending = this.pending.get(owner)
    if (pending?.identity === identity) return pending.task
    if (this.stopping)
      throw failure('The server is restarting. Try again shortly.')
    if (this.running >= 2)
      throw failure('Model discovery is busy. Try again shortly.', 429)
    this.running++
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 35000)
    const task = (async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const modelCatalog = await this.discover({
        config: this.config,
        provider,
        directory: this.directory,
        signal: controller.signal,
      })
      controller.signal.throwIfAborted()
      if (
        this.providers.provider(owner).LEMEX_API_KEY !==
          provider.LEMEX_API_KEY ||
        this.providers.provider(owner).LEMEX_BASE_URL !==
          provider.LEMEX_BASE_URL
      )
        throw failure(
          'Your provider or API key changed while loading models. Refresh models again.',
          409,
        )
      modelCatalog.models.sort(
        (a, b) =>
          (a.priority ?? 100) - (b.priority ?? 100) ||
          String(a.slug).localeCompare(String(b.slug)),
      )
      const models = catalogModels(modelCatalog).filter(
        (model) => typeof model.id === 'string' && model.id.length <= 512,
      )
      if (!models.length)
        throw failure(
          'This API key has no available Responses-compatible text models. Check its permissions with your provider.',
          403,
        )
      const rcp = isRcpEndpoint(provider.LEMEX_BASE_URL || RCP_BASE_URL)
      const preferred = rcp ? this.config.defaultModel : null
      const defaultModel = models.some((model) => model.id === preferred)
        ? preferred
        : models[0].id
      const value = {
        models,
        defaultModel,
        modelCatalog,
        modelsUpdatedAt: new Date().toISOString(),
        providerId: rcp
          ? 'rcp'
          : createHash('sha256')
              .update(providerEndpoint(provider.LEMEX_BASE_URL))
              .digest('hex'),
        providerBaseUrl: provider.LEMEX_BASE_URL,
        isRcp: rcp,
      }
      this.cache.set(owner, { identity, at: Date.now(), value })
      return value
    })()
      .catch((error) => {
        if (this.cache.get(owner)?.identity === identity)
          this.cache.delete(owner)
        throw error
      })
      .finally(() => {
        clearTimeout(timer)
        this.controllers.delete(controller)
        if (this.pending.get(owner)?.task === task) this.pending.delete(owner)
        this.tasks.delete(task)
        this.running--
      })
    this.pending.set(owner, { identity, task })
    this.tasks.add(task)
    return task
  }
  async close() {
    this.stopping = true
    for (const controller of this.controllers) controller.abort()
    // A key change replaces the account's pending entry while its old child
    // may still be stopping. Wait for every child and private-home cleanup.
    await Promise.allSettled([...this.tasks])
  }
}

export async function modelConfigFor(config, owner) {
  return config.modelsForUser
    ? { ...config, ...(await config.modelsForUser(owner)) }
    : config
}
