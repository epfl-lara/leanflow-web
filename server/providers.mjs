import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  RCP_BASE_URL,
  providerEndpoint,
  isRcpEndpoint,
  fetchProvider,
} from './provider-endpoint.mjs'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto'

const fail = (message, status = 400) =>
  Object.assign(new Error(message), { status })

// Version 1 records contain an RCP key. Version 2 encrypts the key and endpoint
// together so changing connection metadata cannot redirect somebody else's key.
export class Providers {
  constructor(dataDir, sessionKey, baseUrl, redact = String) {
    this.dir = path.join(dataDir, 'providers')
    this.key = createHash('sha256')
      .update('leanflow-provider-v1\0' + sessionKey)
      .digest()
    this.baseUrl = baseUrl || RCP_BASE_URL
    this.legacyRedact = redact
    this.secrets = new Set()
    this.records = new Map()
  }
  filename(owner) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(owner)) throw fail('Invalid account.')
    return path.join(this.dir, owner + '.json')
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    for (const name of await fs.readdir(this.dir)) {
      if (!/^[a-zA-Z0-9_-]{1,80}\.json$/.test(name)) continue
      const owner = name.slice(0, -5)
      try {
        const record = JSON.parse(
          await fs.readFile(this.filename(owner), 'utf8'),
        )
        const connection = this.unlock(owner, record)
        providerEndpoint(connection.baseUrl)
        this.secrets.add(connection.apiKey)
        this.records.set(owner, record)
      } catch {
        // A rotated session key or one damaged record must not lock everybody
        // out. Keep the ciphertext until this account saves a replacement.
        console.warn(
          `Saved Lemex key for ${owner} could not be unlocked; re-enter it in Assistant settings.`,
        )
      }
    }
    return this
  }
  unlock(owner, record) {
    if (![1, 2].includes(record.version))
      throw new Error('Unknown saved provider format')
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(record.iv, 'base64'),
    )
    decipher.setAAD(Buffer.from(record.version === 2 ? owner + '\0v2' : owner))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.value, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    if (record.version !== 2)
      return { apiKey: plaintext, baseUrl: this.baseUrl }
    const connection = JSON.parse(plaintext)
    this.parseKey(connection.apiKey)
    providerEndpoint(connection.baseUrl)
    return connection
  }
  decrypt(owner, record) {
    return this.unlock(owner, record).apiKey
  }
  baseFor(owner, record = this.records.get(owner)) {
    return providerEndpoint(
      record ? this.unlock(owner, record).baseUrl : this.baseUrl,
    )
  }
  selection(owner, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw fail('Choose a provider.')
    if (input.provider === undefined && input.baseUrl === undefined)
      return this.baseFor(owner)
    if (input.provider === 'rcp') return providerEndpoint(this.baseUrl)
    if (input.provider !== 'custom')
      throw fail('Choose RCP or another provider.')
    return providerEndpoint(input.baseUrl)
  }
  redact = (text) => {
    let value = this.legacyRedact(String(text))
    for (const secret of this.secrets)
      value = value.split(secret).join('[redacted]')
    return value
  }
  status(owner) {
    const record = this.records.get(owner)
    const baseUrl = this.baseFor(owner)
    return {
      configured: !!record,
      updatedAt: record?.updatedAt || null,
      provider: isRcpEndpoint(baseUrl) ? 'rcp' : 'custom',
      baseUrl,
      defaultBaseUrl: providerEndpoint(this.baseUrl),
    }
  }
  provider(owner) {
    const record = this.records.get(owner)
    if (!record)
      throw fail(
        'Add your Lemex API key in Assistant settings before starting Lemex.',
        428,
      )
    return {
      LEMEX_BASE_URL: this.baseFor(owner, record),
      LEMEX_API_KEY: this.decrypt(owner, record),
    }
  }
  async validate(input, fetchImpl = fetchProvider, baseUrl = this.baseUrl) {
    const key = this.parseKey(input)
    // Register before any transport operation, including failed validation.
    this.secrets.add(key)
    let url
    try {
      url = new URL(providerEndpoint(baseUrl))
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error()
      url.pathname = url.pathname.replace(/\/+$/, '') + '/models'
    } catch {
      throw fail('The Lemex provider endpoint needs server configuration.', 503)
    }
    let response
    try {
      response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      })
      await response.body?.cancel().catch(() => {})
    } catch {
      throw fail(
        'Could not validate the API key with Lemex. Try again shortly.',
        502,
      )
    }
    if (response.status === 401 || response.status === 403)
      throw fail('Lemex did not accept this API key.', 400)
    if (!response.ok)
      throw fail('Lemex is unavailable. Your saved key has not changed.', 502)
    return key
  }
  parseKey(input) {
    if (
      typeof input !== 'string' ||
      !/^[\x21-\x7e]{8,4096}$/.test(input.trim())
    )
      throw fail(
        'Enter a valid Lemex API key (8–4096 characters without spaces).',
      )
    return input.trim()
  }
  async save(owner, input, selection) {
    const target = this.filename(owner),
      key = this.parseKey(input)
    const baseUrl =
      selection === undefined
        ? this.baseFor(owner)
        : providerEndpoint(selection)
    this.secrets.add(key)
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(owner + '\0v2'))
    const value = Buffer.concat([
      cipher.update(JSON.stringify({ apiKey: key, baseUrl }), 'utf8'),
      cipher.final(),
    ])
    const record = {
      version: 2,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      value: value.toString('base64'),
      updatedAt: new Date().toISOString(),
    }
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, JSON.stringify(record), {
        mode: 0o600,
        flag: 'wx',
      })
      await fs.rename(temporary, target)
      this.records.set(owner, record)
    } finally {
      await fs.rm(temporary, { force: true })
    }
    return this.status(owner)
  }
}

export async function providerFor(config, owner) {
  return config.providerForUser
    ? config.providerForUser(owner)
    : config.provider
}
