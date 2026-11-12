import { createHash } from 'node:crypto'
import {
  fetchProvider,
  isRcpEndpoint,
  providerEndpoint,
  RCP_BASE_URL,
} from './provider-endpoint.mjs'

export const providerFingerprint = (provider) =>
  createHash('sha256')
    .update(providerEndpoint(provider?.LEMEX_BASE_URL || RCP_BASE_URL))
    .update('\0')
    .update(provider?.LEMEX_API_KEY || '')
    .digest('hex')

// RCP's key-info route reports the actual allowance, independent of account
// names or subscription labels. Keep only its numeric limit and a fingerprint.
export class RcpKeyLimits {
  #cache = new Map()
  #pending = new Map()
  constructor({
    fetchImpl = fetchProvider,
    ttlMs = 300_000,
    retryMs = 30_000,
    maxEntries = 256,
    now = Date.now,
  } = {}) {
    this.fetch = fetchImpl
    this.ttlMs = ttlMs
    this.retryMs = retryMs
    this.maxEntries = maxEntries
    this.now = now
  }
  current(identity) {
    return this.#cache.get(identity)?.limit ?? 1
  }
  async get(provider) {
    if (
      !provider?.LEMEX_API_KEY ||
      !isRcpEndpoint(provider.LEMEX_BASE_URL || RCP_BASE_URL)
    )
      return null
    const identity = providerFingerprint(provider)
    const previous = this.#cache.get(identity)
    if (previous && previous.expires > this.now()) return previous.limit
    if (this.#pending.has(identity)) return this.#pending.get(identity)
    if (this.#pending.size >= this.maxEntries) {
      this.#cache.delete(identity)
      return 1
    }
    const task = this.#load(provider)
      .then((reported) => {
        for (const [key, entry] of this.#cache)
          if (entry.expires <= this.now()) this.#cache.delete(key)
        this.#cache.delete(identity)
        while (this.#cache.size >= this.maxEntries)
          this.#cache.delete(this.#cache.keys().next().value)
        const limit = reported ?? 1
        this.#cache.set(identity, {
          limit,
          expires: this.now() + (reported === null ? this.retryMs : this.ttlMs),
        })
        return limit
      })
      .finally(() => this.#pending.delete(identity))
    this.#pending.set(identity, task)
    return task
  }
  async #load(provider) {
    try {
      // Send credentials only to this fixed HTTPS origin, in the header.
      // This is metadata, never an inference or a query containing the key.
      const response = await this.fetch(new URL('/key/info', RCP_BASE_URL), {
        headers: { authorization: `Bearer ${provider.LEMEX_API_KEY}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return null
      }
      const value = await response.json()
      const limit = value?.info?.max_parallel_requests
      return Number.isSafeInteger(limit) && limit > 0 ? limit : null
    } catch {
      // Missing permissions, malformed replies and outages retain serial
      // admission. Never surface a provider body that may contain credentials.
      return null
    }
  }
}
