import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  isRcpEndpoint,
  providerEndpoint,
  RCP_BASE_URL,
} from './provider-endpoint.mjs'

export const RCP_WAIT_MESSAGE =
  'Waiting for another request using this RCP key. LeanFlow runs one RCP task at a time per key so free keys work reliably. This task will start automatically; you can stop it while it waits.'

export function usesRcp(provider) {
  return (
    !!provider?.LEMEX_API_KEY &&
    isRcpEndpoint(provider.LEMEX_BASE_URL || RCP_BASE_URL)
  )
}

const fingerprint = (provider) =>
  createHash('sha256')
    .update(providerEndpoint(provider?.LEMEX_BASE_URL || RCP_BASE_URL))
    .update('\0')
    .update(provider?.LEMEX_API_KEY || '')
    .digest('hex')

// Reservations contain only a one-way fingerprint, never a credential. They
// stay in memory and are shared by chats, naming and automatic setup repair.
// The main agent queue tries reservations before consuming a worker slot.
export class ProviderRequests extends EventEmitter {
  #keys = new Map()
  #backgroundActive = 0
  constructor({ maxPendingPerKey = 48, maxBackground = 2 } = {}) {
    super()
    this.maxPendingPerKey = maxPendingPerKey
    this.maxBackground = maxBackground
    this.setMaxListeners(64)
  }
  reserve(provider, { background = false } = {}) {
    const limited = usesRcp(provider)
    const key = fingerprint(provider)
    let state,
      acquired = false,
      released = false
    if (limited) {
      state = this.#keys.get(key)
      if (!state) {
        state = { active: null, pending: [] }
        this.#keys.set(key, state)
      }
      if (state.pending.length >= this.maxPendingPerKey)
        throw Object.assign(
          new Error(
            'Too many tasks are waiting for this RCP key. Stop a waiting task or try again later.',
          ),
          { status: 429 },
        )
    }
    const reservation = {
      limited,
      background,
      matches: (current) => fingerprint(current) === key,
      tryAcquire: () => {
        if (released) return false
        if (acquired) return true
        if (background && this.#backgroundActive >= this.maxBackground)
          return false
        if (limited) {
          const next =
            state.pending.find((item) => !item.background) || state.pending[0]
          if (state.active || next !== reservation) return false
          state.pending.splice(state.pending.indexOf(reservation), 1)
          state.active = reservation
        }
        acquired = true
        if (background) this.#backgroundActive++
        return true
      },
      release: () => {
        if (released) return
        released = true
        if (background && acquired) this.#backgroundActive--
        if (limited) {
          if (state.active === reservation) state.active = null
          const index = state.pending.indexOf(reservation)
          if (index >= 0) state.pending.splice(index, 1)
          if (!state.active && !state.pending.length) this.#keys.delete(key)
        }
        if (limited || background) this.emit('available')
      },
      wait: (signal, onQueued) =>
        new Promise((resolve, reject) => {
          const finish = () => {
            this.off('available', ready)
            signal?.removeEventListener('abort', abort)
          }
          const abort = () => {
            finish()
            reservation.release()
            reject(
              signal.reason || new Error('The waiting request was cancelled.'),
            )
          }
          const ready = () => {
            if (signal?.aborted) return abort()
            if (released) {
              finish()
              reject(new Error('The waiting request was cancelled.'))
              return
            }
            if (reservation.tryAcquire()) {
              finish()
              resolve()
            }
          }
          if (signal?.aborted) return abort()
          this.on('available', ready)
          signal?.addEventListener('abort', abort, { once: true })
          ready()
          if (!acquired && !released) {
            try {
              onQueued?.(RCP_WAIT_MESSAGE)
            } catch (error) {
              finish()
              reservation.release()
              reject(error)
            }
          }
        }),
    }
    if (limited) state.pending.push(reservation)
    return reservation
  }
}

const coordinators = new WeakMap()
export function providerRequestsFor(config) {
  let requests = coordinators.get(config)
  if (!requests) {
    requests = new ProviderRequests()
    coordinators.set(config, requests)
  }
  return requests
}

// An isolated native agent can otherwise spawn subagents using the same key.
// Tools may still run in parallel; model requests must remain serial on RCP.
export function providerRequestConfig(provider) {
  return usesRcp(provider)
    ? [
        'features.multi_agent = false',
        'features.multi_agent_v2 = false',
        'features.concurrent_reasoning_summaries = false',
      ]
    : []
}

// Provider error bodies are untrusted and can contain secrets. Match only to
// select fixed guidance; never interpolate the raw text into these messages.
export function providerLimitMessage(
  error,
  provider,
  { retrying = false } = {},
) {
  if (!usesRcp(provider)) return null
  const message =
    typeof error === 'string' ? error : String(error?.message || '')
  const code = typeof error === 'object' ? error?.codexErrorInfo : null
  const evidence = message + ' ' + JSON.stringify(code || '')
  if (
    /insufficient[_ -]?quota|usage[_ -]?limit|quota.{0,30}(?:exceed|exhaust)|(?:credit|budget|balance).{0,30}(?:exhaust|insufficient)/i.test(
      evidence,
    )
  )
    return 'RCP reports that this key has reached its usage quota. Check the key’s limits in the RCP portal or choose another saved provider/key, then send the request again.'
  if (
    /\b429\b|too many requests|rate[_ -]?limit|concurren(?:t|cy).{0,35}(?:limit|exceed|request)|(?:limit|exceed).{0,35}concurren(?:t|cy)/i.test(
      evidence,
    )
  )
    return retrying
      ? 'RCP is busy or this key is already handling another request. Lemex is retrying automatically. If you use this key in another app, let that request finish; you can stop this task at any time.'
      : 'RCP could not accept another request for this key. Free RCP keys allow one model request at a time, including requests from other apps. Wait for that request to finish, or check the key’s limits in the RCP portal, then send your request again.'
  return null
}
