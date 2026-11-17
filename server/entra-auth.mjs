import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as oidc from 'openid-client'
import {
  expectedSessionUser,
  requireBrowserSessionBinding,
  requireSessionUser,
} from './session-identity.mjs'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COOKIE = '__Host-leanflow_entra'
const CALLBACK = '/api/auth/entra/callback'
const providerError =
  'EPFL sign-in could not be completed. Try again, or sign in with your access token.'
const expiredError =
  'This EPFL sign-in expired. Close this window and try again.'
const hash = (value) => createHash('sha256').update(value).digest()

function displayName(claims) {
  const fullName = [claims.given_name, claims.family_name]
    .filter((value) => typeof value === 'string')
    .join(' ')
  for (const value of [claims.name, fullName]) {
    if (typeof value !== 'string') continue
    const name = value
      .normalize('NFC')
      .replace(/[^\p{L}\p{M}\p{N} ._'’-]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 80)
      .replace(/\p{Cs}/gu, '')
      .trim()
    if (name) return name
  }
  return 'EPFL user'
}

export function loadEntraConfig(env = process.env) {
  if (env.STUDIO_ENTRA_ENABLED !== 'true') return null
  const required = (key) => {
    const value = env[key]
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`${key} is required when EPFL sign-in is enabled.`)
    return value.trim()
  }
  const rawOrigin = required('STUDIO_ORIGIN')
  let origin
  try {
    const url = new URL(rawOrigin)
    if (url.protocol !== 'https:' || rawOrigin !== url.origin)
      throw new Error('Invalid origin')
    origin = url.origin
  } catch {
    throw new Error(
      'STUDIO_ORIGIN must be an exact HTTPS origin for EPFL sign-in.',
    )
  }
  const tenantId = required('STUDIO_ENTRA_TENANT_ID').toLowerCase()
  const clientId = required('STUDIO_ENTRA_CLIENT_ID').toLowerCase()
  if (!GUID.test(tenantId) || !GUID.test(clientId))
    throw new Error('EPFL sign-in requires valid tenant and application IDs.')
  return {
    origin,
    tenantId,
    clientId,
    clientSecret: required('STUDIO_ENTRA_CLIENT_SECRET'),
    allowSignup: env.STUDIO_ENTRA_ALLOW_SIGNUP === 'true',
    callbackUrl: `${origin}${CALLBACK}`,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  }
}

function cookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}

function bindingFrom(request) {
  const matches = (request.headers.cookie || '')
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${COOKIE}=`))
  if (matches.length !== 1) return null
  const value = matches[0].slice(COOKIE.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? hash(value) : null
}

function complete(response, config, ok, error, linkToken) {
  const nonce = randomBytes(24).toString('base64url')
  const message = JSON.stringify({
    type: 'leanflow-entra-complete',
    ok,
    ...(!ok && { error }),
    ...(linkToken && { linkToken }),
  }).replace(/</g, '\\u003c')
  const origin = JSON.stringify(config.origin).replace(/</g, '\\u003c')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  )
  response
    .type('html')
    .send(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EPFL sign-in</title><body><p>You can close this window and return to LeanFlow.</p><a href="/">Return to LeanFlow</a><script nonce="${nonce}">if (window.opener && !window.opener.closed) { window.opener.postMessage(${message}, ${origin}); window.close(); } else { window.location.replace('/?entra=${ok && !linkToken ? 'success' : 'error'}'); }</script></body></html>`,
    )
}

function linkActor(request, auth) {
  const actor = auth.identify(request)
  if (!actor)
    throw Object.assign(
      new Error('Sign in before connecting your EPFL account.'),
      { status: 401 },
    )
  const expected = expectedSessionUser(request)
  requireSessionUser(actor, expected)
  requireBrowserSessionBinding(request, expected)
  return actor
}

function startInput(request) {
  const body = request.body
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !['mode', 'expectedUserId'].includes(key),
    ) ||
    (body.mode !== undefined && !['login', 'link'].includes(body.mode)) ||
    (body.expectedUserId !== undefined &&
      (typeof body.expectedUserId !== 'string' ||
        !body.expectedUserId ||
        body.expectedUserId.length > 200 ||
        /[\p{Cc}\s]/u.test(body.expectedUserId)))
  )
    throw Object.assign(new Error('Send valid EPFL sign-in options.'), {
      status: 400,
    })
  const expected = expectedSessionUser(request)
  if (
    expected !== undefined &&
    body.expectedUserId !== undefined &&
    expected !== body.expectedUserId
  )
    throw Object.assign(
      new Error('The workspace account binding is invalid.'),
      { status: 400 },
    )
  return {
    mode: body.mode || 'login',
    expectedUserId: body.expectedUserId ?? expected,
  }
}

// Only the fetch implementation and clock are injectable; tests still exercise
// discovery, token exchange, claim checks, and signature verification.
export function installEntraAuthRoutes(
  app,
  {
    auth,
    config,
    providerFetch,
    now = Date.now,
    transactionTtlMs = 10 * 60_000,
    maxTransactions = 256,
    maxConcurrent = 8,
    // A reverse proxy can give many EPFL users the same socket address.
    maxStartsPerWindow = 120,
    rateWindowMs = 5 * 60_000,
  },
) {
  const pending = new Map()
  const pendingLinks = new Map()
  const attempts = new Map()
  let active = 0
  let discovery
  let closed = false
  const prune = () => {
    const timestamp = now()
    for (const [state, transaction] of pending)
      if (transaction.expires <= timestamp) pending.delete(state)
    for (const [token, transaction] of pendingLinks)
      if (transaction.expires <= timestamp) pendingLinks.delete(token)
    for (const [ip, attempt] of attempts)
      if (attempt.expires <= timestamp) attempts.delete(ip)
  }
  const provider = () => {
    if (!discovery)
      discovery = oidc
        .discovery(
          new URL(config.issuer),
          config.clientId,
          {
            client_secret: config.clientSecret,
            id_token_signed_response_alg: 'RS256',
          },
          undefined,
          {
            timeout: 10,
            execute: [oidc.enableNonRepudiationChecks],
            ...(providerFetch && { [oidc.customFetch]: providerFetch }),
          },
        )
        .catch((error) => {
          discovery = undefined
          throw error
        })
    return discovery
  }
  const busy = (response) => {
    response.setHeader('Retry-After', '5')
    response
      .status(429)
      .json({ error: 'EPFL sign-in is busy. Wait a moment and try again.' })
  }
  app.get('/api/auth/entra', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.json({ enabled: !!config && !closed })
  })
  app.post('/api/auth/entra/start', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!config || closed)
      return response
        .status(404)
        .json({ error: 'EPFL sign-in is not enabled.' })
    const { mode, expectedUserId } = startInput(request)
    let actor
    if (mode === 'link') {
      actor = linkActor(request, auth)
      requireSessionUser(actor, expectedUserId)
    }
    prune()
    const ip = request.socket.remoteAddress || 'unknown'
    let attempt = attempts.get(ip)
    if (!attempt) {
      if (attempts.size >= 1024) return busy(response)
      attempt = { count: 0, expires: now() + rateWindowMs }
      attempts.set(ip, attempt)
    }
    if (
      ++attempt.count > maxStartsPerWindow ||
      pending.size + pendingLinks.size >= maxTransactions ||
      active >= maxConcurrent
    )
      return busy(response)
    active++
    try {
      const client = await provider()
      if (closed)
        return response
          .status(503)
          .json({ error: 'EPFL sign-in is unavailable. Try again.' })
      const state = oidc.randomState()
      const nonce = oidc.randomNonce()
      const verifier = oidc.randomPKCECodeVerifier()
      const browserBinding = randomBytes(32).toString('base64url')
      const url = oidc.buildAuthorizationUrl(client, {
        redirect_uri: config.callbackUrl,
        scope: 'openid profile email',
        response_type: 'code',
        response_mode: 'query',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      })
      // Discovery and PKCE calculation yield; recheck before reserving a slot.
      if (closed || pending.size + pendingLinks.size >= maxTransactions)
        return busy(response)
      pending.set(state, {
        mode,
        expectedUserId,
        actorId: actor?.id,
        nonce,
        verifier,
        binding: hash(browserBinding),
        expires: now() + transactionTtlMs,
      })
      response.append(
        'Set-Cookie',
        cookie(browserBinding, Math.ceil(transactionTtlMs / 1000)),
      )
      response.json({ url: url.href })
    } catch {
      response.status(503).json({
        error:
          'EPFL sign-in is unavailable. Try again, or use your access token.',
      })
    } finally {
      active--
    }
  })
  app.post('/api/auth/entra/link', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!config || closed)
      return response
        .status(404)
        .json({ error: 'EPFL sign-in is not enabled.' })
    const body = request.body
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.token)
    )
      return response
        .status(400)
        .json({ error: 'Send valid EPFL account connection details.' })
    const actor = linkActor(request, auth)
    prune()
    const transaction = pendingLinks.get(body.token)
    const binding = bindingFrom(request)
    if (
      !transaction ||
      !binding ||
      !timingSafeEqual(binding, transaction.binding)
    )
      return response.status(409).json({
        error: 'This EPFL account connection expired. Try connecting again.',
      })
    // The callback cannot see a Strict session cookie after a cross-site login.
    // Finish on the app origin, where the current account must still match.
    requireSessionUser(actor, transaction.actorId)
    pendingLinks.delete(body.token)
    response.append('Set-Cookie', cookie('', 0))
    await auth.linkEntra(actor, transaction.identity)
    response.json({ ok: true })
  })
  app.get(CALLBACK, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (!config || closed)
      return response
        .status(404)
        .json({ error: 'EPFL sign-in is not enabled.' })
    prune()
    const callback = new URL(config.callbackUrl)
    const received = new URL(request.originalUrl, config.origin)
    callback.search = received.search
    const states = callback.searchParams.getAll('state')
    const state = states.length === 1 ? states[0] : ''
    const transaction = pending.get(state)
    const binding = bindingFrom(request)
    if (
      !transaction ||
      !binding ||
      !timingSafeEqual(binding, transaction.binding)
    )
      return complete(response, config, false, expiredError)
    pending.delete(state)
    if (active >= maxConcurrent) {
      response.append('Set-Cookie', cookie('', 0))
      return complete(
        response,
        config,
        false,
        'EPFL sign-in is busy. Close this window and try again.',
      )
    }
    active++
    let identity
    try {
      const tokens = await oidc.authorizationCodeGrant(
        await provider(),
        callback,
        {
          expectedState: state,
          expectedNonce: transaction.nonce,
          pkceCodeVerifier: transaction.verifier,
          idTokenExpected: true,
        },
      )
      const claims = tokens.claims()
      if (
        closed ||
        !claims ||
        typeof claims.tid !== 'string' ||
        claims.tid.toLowerCase() !== config.tenantId ||
        typeof claims.oid !== 'string' ||
        !GUID.test(claims.oid)
      )
        throw new Error('Unexpected EPFL identity')
      identity = {
        tenantId: config.tenantId,
        objectId: claims.oid.toLowerCase(),
        name: displayName(claims),
      }
    } catch {
      response.append('Set-Cookie', cookie('', 0))
      return complete(response, config, false, providerError)
    } finally {
      active--
    }
    try {
      if (transaction.mode === 'link') {
        if (pending.size + pendingLinks.size >= maxTransactions)
          throw new Error('Too many account connections')
        const linkToken = randomBytes(32).toString('base64url')
        const browserBinding = randomBytes(32).toString('base64url')
        const lifetime = Math.min(transactionTtlMs, 2 * 60_000)
        pendingLinks.set(linkToken, {
          identity,
          actorId: transaction.actorId,
          binding: hash(browserBinding),
          expires: now() + lifetime,
        })
        response.append(
          'Set-Cookie',
          cookie(browserBinding, Math.ceil(lifetime / 1000)),
        )
        return complete(response, config, true, undefined, linkToken)
      } else {
        response.append('Set-Cookie', cookie('', 0))
        const user = await auth.signInEntra(identity, {
          allowSignup: config.allowSignup,
          expectedUserId: transaction.expectedUserId,
        })
        response.append('Set-Cookie', auth.cookie(user, true))
      }
      complete(response, config, true)
    } catch (error) {
      response.append('Set-Cookie', cookie('', 0))
      const message = [400, 401, 403, 409].includes(error.status)
        ? error.message
        : 'Your EPFL account could not be connected. Try again or contact the administrator.'
      complete(response, config, false, message)
    }
  })
  return {
    close() {
      closed = true
      pending.clear()
      pendingLinks.clear()
      attempts.clear()
      discovery = undefined
    },
  }
}
