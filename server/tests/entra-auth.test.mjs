import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { installEntraAuthRoutes, loadEntraConfig } from '../entra-auth.mjs'
import { sameOrigin } from '../auth.mjs'
import { createStudio } from '../studio.mjs'

const tenantId = '11111111-1111-1111-1111-111111111111'
const clientId = '22222222-2222-2222-2222-222222222222'
const objectId = '33333333-3333-3333-3333-333333333333'
const env = {
  STUDIO_ENTRA_ENABLED: 'true',
  STUDIO_ORIGIN: 'https://leanflow.example.org',
  STUDIO_ENTRA_TENANT_ID: tenantId,
  STUDIO_ENTRA_CLIENT_ID: clientId,
  STUDIO_ENTRA_CLIENT_SECRET: 'fixture-secret-never-send-to-browser',
}
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'fixture',
  alg: 'RS256',
  use: 'sig',
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const jwt = (claims, privateKey = keys.privateKey, algorithm = 'RS256') => {
  const header = Buffer.from(
    JSON.stringify({ alg: algorithm, kid: 'fixture', typ: 'JWT' }),
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signed = `${header}.${payload}`
  const signature =
    algorithm === 'HS256'
      ? createHmac('sha256', env.STUDIO_ENTRA_CLIENT_SECRET)
          .update(signed)
          .digest()
      : sign('RSA-SHA256', Buffer.from(signed), privateKey)
  return `${signed}.${signature.toString('base64url')}`
}

async function fixture(t, options = {}) {
  let timestamp = Date.now()
  const config = options.disabled
    ? null
    : { ...loadEntraConfig(env), allowSignup: true }
  const calls = { fetch: [], signIn: [], link: [], failures: [] }
  const codes = new Map()
  const auth = {
    identify(request) {
      if ((request.headers.cookie || '').includes('lemex_web=other'))
        return { id: 'other' }
      return (request.headers.cookie || '').includes('lemex_web=existing')
        ? { id: 'existing' }
        : null
    },
    async signInEntra(identity, settings) {
      calls.signIn.push({ identity, settings })
      if (settings.expectedUserId && settings.expectedUserId !== 'existing')
        throw Object.assign(
          new Error(
            'Sign in with the EPFL account connected to this workspace.',
          ),
          { status: 409 },
        )
      if (options.signInError) throw options.signInError
      return { id: 'existing' }
    },
    async linkEntra(actor, identity) {
      calls.link.push({ actor, identity })
      return { id: actor.id }
    },
    cookie(user, secure) {
      assert.equal(secure, true)
      return `lemex_web=${user.id}; Path=/; HttpOnly; Secure; SameSite=Strict`
    },
  }
  let releaseDiscovery
  let markDiscoveryReached
  const discoveryReached = new Promise((resolve) => {
    markDiscoveryReached = resolve
  })
  const discoveryGate = options.blockDiscovery
    ? new Promise((resolve) => {
        releaseDiscovery = resolve
      })
    : Promise.resolve()
  const providerFetch = async (input, init) => {
    const url = new URL(input)
    calls.fetch.push(url.href)
    assert.equal(url.origin, 'https://login.microsoftonline.com')
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      assert.equal(url.searchParams.get('appid'), clientId)
      markDiscoveryReached()
      await discoveryGate
      if (options.failDiscovery)
        throw new Error(
          `Private discovery error: ${env.STUDIO_ENTRA_CLIENT_SECRET}`,
        )
      return json({
        issuer: options.wrongMetadataIssuer || config.issuer,
        authorization_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        jwks_uri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys?appid=${clientId}`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.pathname.endsWith('/keys')) {
      assert.equal(url.searchParams.get('appid'), clientId)
      return json({ keys: [jwk] })
    }
    assert(url.pathname.endsWith('/token'))
    await options.beforeToken?.()
    if (options.failToken)
      return json(
        {
          error: 'invalid_client',
          error_description: env.STUDIO_ENTRA_CLIENT_SECRET,
          error_codes: [7000215, env.STUDIO_ENTRA_CLIENT_SECRET],
        },
        400,
      )
    const body = new URLSearchParams(init.body)
    const entry = codes.get(body.get('code'))
    assert(
      entry,
      'Only fixture authorization codes may reach the token endpoint',
    )
    codes.delete(body.get('code'))
    assert.equal(body.get('client_secret'), env.STUDIO_ENTRA_CLIENT_SECRET)
    assert.equal(body.get('redirect_uri'), config.callbackUrl)
    assert.equal(body.get('grant_type'), 'authorization_code')
    assert.equal(
      createHash('sha256')
        .update(body.get('code_verifier'))
        .digest('base64url'),
      entry.challenge,
    )
    const current = Math.floor(Date.now() / 1000)
    return json({
      access_token: 'fixture-access-token-not-for-browser',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: jwt(
        {
          iss: config.issuer,
          aud: clientId,
          sub: 'fixture-subject',
          iat: current,
          exp: current + 3600,
          nonce: entry.nonce,
          tid: tenantId,
          oid: objectId,
          name: 'EPFL Tester',
          ...entry.claims,
        },
        entry.wrongSignature ? wrongKeys.privateKey : keys.privateKey,
        entry.algorithm,
      ),
    })
  }
  let server, routes, studio, dataDir
  if (options.studio) {
    const previousOrigin = process.env.STUDIO_ORIGIN
    process.env.STUDIO_ORIGIN = env.STUDIO_ORIGIN
    t.after(() => {
      if (previousOrigin === undefined) delete process.env.STUDIO_ORIGIN
      else process.env.STUDIO_ORIGIN = previousOrigin
    })
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'leanflow-entra-studio-'))
    studio = await createStudio({
      dataDir,
      entraConfig: config,
      entraProviderFetch: providerFetch,
      runtime: {
        async init() {},
        async shutdown() {},
        info: () => ({ ready: true }),
        templates: () => [],
      },
      config: {
        defaultModel: 'fixture',
        models: [],
        provider: {},
        redact: String,
        lemex: {},
      },
    })
    server = studio.server
  } else {
    const app = express()
    app.use((request, response, next) => {
      if (request.method === 'POST' && !sameOrigin(request, env.STUDIO_ORIGIN))
        return response.status(403).json({ error: 'Wrong origin' })
      next()
    })
    app.use(express.json({ limit: '16kb' }))
    routes = installEntraAuthRoutes(app, {
      auth,
      config,
      providerFetch,
      reportFailure: (diagnostic) => calls.failures.push(diagnostic),
      now: () => timestamp,
      ...options.limits,
    })
    app.use((error, _request, response, _next) => {
      response.status(error.status || 500).json({ error: error.message })
    })
    server = createServer(app)
  }
  if (options.onRequest)
    server.on('request', (req, res) =>
      options.onRequest(req.url.split('?')[0], res),
    )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    releaseDiscovery?.()
    if (studio) await studio.close()
    else {
      routes.close()
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true })
  })
  const request = (endpoint, init) =>
    fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, init)
  const start = async (body = {}, headers = {}) => {
    const response = await request('/api/auth/entra/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: env.STUDIO_ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    return {
      response,
      result,
      url: result.url ? new URL(result.url) : undefined,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    }
  }
  const callback = async (
    started,
    {
      claims,
      wrongSignature,
      algorithm,
      state,
      cookie = started.cookie,
      signal,
      extra = '',
    } = {},
  ) => {
    const code = `fixture-code-${codes.size}-${calls.fetch.length}`
    codes.set(code, {
      nonce: started.url.searchParams.get('nonce'),
      challenge: started.url.searchParams.get('code_challenge'),
      claims,
      wrongSignature,
      algorithm,
    })
    return request(
      `/api/auth/entra/callback?code=${code}&state=${state ?? started.url.searchParams.get('state')}${extra}`,
      {
        headers: cookie ? { Cookie: cookie } : {},
        signal,
      },
    )
  }
  const finalize = (token, bindingCookie, headers = {}) =>
    request('/api/auth/entra/link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: env.STUDIO_ORIGIN,
        Cookie: `lemex_web=existing; ${bindingCookie}`,
        'X-Leanflow-User': 'existing',
        ...headers,
      },
      body: JSON.stringify({ token }),
    })
  return {
    request,
    start,
    callback,
    finalize,
    calls,
    config,
    studio,
    dataDir,
    releaseDiscovery,
    discoveryReached,
    closeRoutes: () => routes.close(),
    advance: (ms) => {
      timestamp += ms
    },
  }
}

test('EPFL sign-in is opt-in and enabled configuration requires an exact HTTPS origin and tenant credentials', () => {
  assert.equal(loadEntraConfig({}), null)
  assert.equal(loadEntraConfig({ ...env, STUDIO_ENTRA_ENABLED: 'false' }), null)
  assert.equal(loadEntraConfig(env).allowSignup, false)
  assert.equal(
    loadEntraConfig({ ...env, STUDIO_ENTRA_ALLOW_SIGNUP: 'true' }).allowSignup,
    true,
  )
  for (const key of [
    'STUDIO_ORIGIN',
    'STUDIO_ENTRA_TENANT_ID',
    'STUDIO_ENTRA_CLIENT_ID',
    'STUDIO_ENTRA_CLIENT_SECRET',
  ]) {
    assert.throws(() => loadEntraConfig({ ...env, [key]: '' }), new RegExp(key))
  }
  for (const origin of [
    'http://leanflow.example.org',
    'https://leanflow.example.org/',
    'https://leanflow.example.org/path',
    'https://user@leanflow.example.org',
    'https://leanflow.example.org?x=1',
  ]) {
    assert.throws(
      () => loadEntraConfig({ ...env, STUDIO_ORIGIN: origin }),
      /exact HTTPS origin/,
    )
  }
  for (const key of ['STUDIO_ENTRA_TENANT_ID', 'STUDIO_ENTRA_CLIENT_ID'])
    assert.throws(
      () => loadEntraConfig({ ...env, [key]: 'common' }),
      /valid tenant and application IDs/,
    )
})

test('disabled status and routes never contact Microsoft or expose configuration', async (t) => {
  const { request, start, calls } = await fixture(t, { disabled: true })
  const status = await request('/api/auth/entra')
  assert.deepEqual(await status.json(), { enabled: false })
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.equal((await start()).response.status, 404)
  assert.equal((await request('/api/auth/entra/callback')).status, 404)
  assert.equal(
    (await request('/api/auth/entra/link', { method: 'POST' })).status,
    404,
  )
  assert.deepEqual(calls.fetch, [])
})

test('a signed EPFL response exchanges a PKCE code and establishes only the existing secure session', async (t) => {
  const { request, start, callback, calls, config } = await fixture(t)
  const status = await request('/api/auth/entra')
  assert.deepEqual(await status.json(), { enabled: true })
  const started = await start()
  assert.equal(started.response.status, 200)
  assert.match(
    started.response.headers.get('set-cookie'),
    /__Host-leanflow_entra=.*HttpOnly; Secure; SameSite=Lax/,
  )
  assert.equal(started.url.origin, 'https://login.microsoftonline.com')
  assert.equal(started.url.searchParams.get('redirect_uri'), config.callbackUrl)
  assert.equal(started.url.searchParams.get('scope'), 'openid profile email')
  assert.equal(started.url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(started.url.searchParams.get('prompt'), 'select_account')
  assert.equal(started.url.searchParams.get('response_mode'), 'query')
  assert(!started.result.url.includes(env.STUDIO_ENTRA_CLIENT_SECRET))
  const response = await callback(started)
  const html = await response.text()
  assert.match(html, /"ok":true/)
  assert.match(html, /postMessage/)
  assert.match(
    response.headers.get('content-security-policy'),
    /default-src 'none'/,
  )
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert(
    response.headers
      .getSetCookie()
      .some((value) =>
        /^lemex_web=existing;.*Secure; SameSite=Strict/.test(value),
      ),
  )
  assert(!html.includes('fixture-access-token'))
  assert(!html.includes('id_token'))
  assert(!html.includes(env.STUDIO_ENTRA_CLIENT_SECRET))
  assert.deepEqual(calls.signIn, [
    {
      identity: { tenantId, objectId, name: 'EPFL Tester' },
      settings: { allowSignup: true, expectedUserId: undefined },
    },
  ])
  assert.equal(
    calls.fetch.filter((url) => new URL(url).pathname.endsWith('/keys')).length,
    1,
  )
})

test('state, browser binding, expiration, and replay checks reject before token exchange', async (t) => {
  const { start, callback, calls, advance } = await fixture(t)
  const started = await start()
  for (const options of [
    { state: 'wrong-state' },
    { cookie: '' },
    {
      cookie:
        '__Host-leanflow_entra=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    { cookie: `${started.cookie}; ${started.cookie}` },
    { extra: '&state=duplicate' },
  ]) {
    const response = await callback(started, options)
    assert.match(await response.text(), /"ok":false/)
    assert(
      !response.headers
        .getSetCookie()
        .some((value) => value.startsWith('lemex_web=')),
    )
  }
  assert.equal(calls.fetch.length, 1)
  assert.match(await (await callback(started)).text(), /"ok":true/)
  const exchanged = calls.fetch.length
  assert.match(await (await callback(started)).text(), /"ok":false/)
  assert.equal(calls.fetch.length, exchanged)
  const expired = await start()
  advance(10 * 60_000 + 1)
  assert.match(await (await callback(expired)).text(), /"ok":false/)
  assert.equal(calls.fetch.length, exchanged)
})

test('unusual or long Microsoft display names cannot prevent an otherwise valid sign-in', async (t) => {
  const { start, callback, calls } = await fixture(t)
  for (const [name, expected] of [
    ['User (EPFL / visiting)', 'User EPFL visiting'],
    ['A'.repeat(100), 'A'.repeat(80)],
    ['😃 / ()', 'EPFL user'],
    [null, 'EPFL user'],
  ]) {
    const response = await callback(await start(), { claims: { name } })
    assert.match(await response.text(), /"ok":true/)
    assert.equal(calls.signIn.at(-1).identity.name, expected)
  }
})

test('EPFL name claims supply display names while tenant and object IDs remain the account identity', async (t) => {
  const { start, callback, calls } = await fixture(t)
  const epflClaims = {
    given_name: 'John',
    family_name: 'Doe',
    uniqueid: '123456',
    gaspar: 'jdoe',
    mail: 'john.doe@example.org',
  }
  for (const name of [undefined, '', '  ', null, 42, ['Wrong name'], '😃']) {
    const response = await callback(await start(), {
      claims: { ...epflClaims, name },
    })
    assert.match(await response.text(), /"ok":true/)
    assert.deepEqual(calls.signIn.at(-1).identity, {
      tenantId,
      objectId,
      name: 'John Doe',
    })
  }
  for (const [claims, expected] of [
    [{ ...epflClaims, name: 'Preferred Name' }, 'Preferred Name'],
    [{ name: undefined, given_name: 'John', family_name: 42 }, 'John'],
    [{ name: undefined, given_name: {}, family_name: 'Doe' }, 'Doe'],
    [{ name: undefined, given_name: [], family_name: null }, 'EPFL user'],
  ]) {
    const response = await callback(await start(), { claims })
    assert.match(await response.text(), /"ok":true/)
    assert.equal(calls.signIn.at(-1).identity.name, expected)
  }
})

test('provider failures return actionable errors without exposing provider details or credentials', async (t) => {
  const unavailable = await fixture(t, { failDiscovery: true })
  const started = await unavailable.start()
  assert.equal(started.response.status, 503)
  assert.match(started.result.error, /unavailable/)
  assert(
    !JSON.stringify(started.result).includes(env.STUDIO_ENTRA_CLIENT_SECRET),
  )
  assert.deepEqual(unavailable.calls.failures, [
    { stage: 'start', errorClass: 'ClientError' },
  ])

  const denied = await fixture(t, { failToken: true })
  const response = await denied.callback(await denied.start())
  const body = await response.text()
  assert.match(body, /"ok":false/)
  assert(!body.includes(env.STUDIO_ENTRA_CLIENT_SECRET))
  assert(!body.includes('invalid_client'))
  assert.equal(denied.calls.signIn.length, 0)
  assert.deepEqual(denied.calls.failures, [
    {
      stage: 'exchange',
      errorClass: 'ResponseBodyError',
      code: 'OAUTH_RESPONSE_BODY_ERROR',
      oauthCode: 'invalid_client',
      aadstsCode: 7000215,
    },
  ])
  assert(
    !JSON.stringify(denied.calls.failures).includes(
      env.STUDIO_ENTRA_CLIENT_SECRET,
    ),
  )
  assert(
    !response.headers
      .getSetCookie()
      .some((value) => value.startsWith('lemex_web=')),
  )
})

test('account failure diagnostics omit unexpected class names, codes and private error fields', async (t) => {
  const secret = env.STUDIO_ENTRA_CLIENT_SECRET
  const failure = Object.assign(new Error(secret), {
    name: secret,
    code: secret,
    error: secret,
    error_description: secret,
    cause: {
      error_codes: [secret, -3, 1.5],
      callback: `https://private.example/${secret}`,
    },
  })
  const { start, callback, calls } = await fixture(t, { signInError: failure })
  const response = await callback(await start())
  assert.match(await response.text(), /"ok":false/)
  assert.deepEqual(calls.failures, [{ stage: 'account', errorClass: 'Error' }])
  assert(!JSON.stringify(calls.failures).includes(secret))
})

test('an access_denied callback produces a safe diagnostic without exchanging a token', async (t) => {
  const { request, start, calls } = await fixture(t)
  const started = await start()
  const query = new URLSearchParams({
    state: started.url.searchParams.get('state'),
    error: 'access_denied',
    error_description: env.STUDIO_ENTRA_CLIENT_SECRET,
  })
  const response = await request(`/api/auth/entra/callback?${query}`, {
    headers: { Cookie: started.cookie },
  })
  const body = await response.text()
  assert.match(body, /"ok":false/)
  assert(!body.includes(env.STUDIO_ENTRA_CLIENT_SECRET))
  assert.equal(calls.fetch.length, 1)
  assert.deepEqual(calls.signIn, [])
  assert.deepEqual(calls.failures, [
    {
      stage: 'exchange',
      errorClass: 'AuthorizationResponseError',
      code: 'OAUTH_AUTHORIZATION_RESPONSE_ERROR',
      oauthCode: 'access_denied',
    },
  ])
  assert(
    !JSON.stringify(calls.failures).includes(env.STUDIO_ENTRA_CLIENT_SECRET),
  )
})

test('app-specific discovery retains exact issuer validation', async (t) => {
  const { start, calls } = await fixture(t, {
    wrongMetadataIssuer: 'https://attacker.example/v2.0',
  })
  const result = await start()
  assert.equal(result.response.status, 503)
  assert.equal(new URL(calls.fetch[0]).searchParams.get('appid'), clientId)
  assert.equal(calls.fetch.length, 1)
  assert.deepEqual(calls.signIn, [])
  assert(!JSON.stringify(result.result).includes('attacker.example'))
  assert.deepEqual(calls.failures, [
    {
      stage: 'start',
      errorClass: 'ClientError',
      code: 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED',
    },
  ])
})

test('invalid signature, HS256 downgrade, issuer, audience, expiration, nonce, tenant, or object ID cannot create a session', async (t) => {
  const invalid = [
    { algorithm: 'HS256' },
    { wrongSignature: true },
    { claims: { iss: 'https://attacker.example' } },
    { claims: { aud: '44444444-4444-4444-4444-444444444444' } },
    { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } },
    { claims: { nonce: 'wrong-nonce' } },
    { claims: { tid: '44444444-4444-4444-4444-444444444444' } },
    { claims: { tid: undefined } },
    { claims: { oid: 'not-an-object-id' } },
    { claims: { oid: undefined } },
  ]
  for (const options of invalid) {
    const { start, callback, calls } = await fixture(t)
    const response = await callback(await start(), options)
    const body = await response.text()
    assert.match(body, /"ok":false/, JSON.stringify(options))
    assert(
      !response.headers
        .getSetCookie()
        .some((value) => value.startsWith('lemex_web=')),
    )
    assert.equal(calls.signIn.length, 0)
    assert(!body.includes('attacker.example'))
    assert(!body.includes(env.STUDIO_ENTRA_CLIENT_SECRET))
  }
})

test('linking requires same-origin finalization by the bound current account and preserves its session', async (t) => {
  const { start, callback, finalize, calls } = await fixture(t)
  assert.equal((await start({ mode: 'link' })).response.status, 401)
  assert.equal(
    (await start({ mode: 'link' }, { Cookie: 'lemex_web=existing' })).response
      .status,
    428,
  )
  assert.equal(
    (
      await start(
        { mode: 'link' },
        { Cookie: 'lemex_web=existing', 'X-Leanflow-User': 'other' },
      )
    ).response.status,
    401,
  )
  const started = await start(
    { mode: 'link', expectedUserId: 'existing' },
    {
      Cookie: 'lemex_web=existing',
      'X-Leanflow-User': 'existing',
    },
  )
  assert.equal(started.url.searchParams.get('prompt'), 'login')
  const response = await callback(started)
  const body = await response.text()
  assert.match(body, /"ok":true/)
  const token = /"linkToken":"([A-Za-z0-9_-]{43})"/.exec(body)?.[1]
  assert(token)
  assert.deepEqual(calls.link, [])
  const bindingCookie = response.headers.getSetCookie()[0].split(';')[0]
  const linked = await finalize(token, bindingCookie)
  assert.equal(linked.status, 200)
  assert.deepEqual(await linked.json(), { ok: true })
  assert.match(
    linked.headers.get('set-cookie'),
    /__Host-leanflow_entra=;.*Max-Age=0/,
  )
  assert(
    !response.headers
      .getSetCookie()
      .some((value) => value.startsWith('lemex_web=')),
  )
  assert(
    !linked.headers
      .getSetCookie()
      .some((value) => value.startsWith('lemex_web=')),
  )
  assert.deepEqual(calls.link, [
    {
      actor: { id: 'existing' },
      identity: { tenantId, objectId, name: 'EPFL Tester' },
    },
  ])
  assert.deepEqual(calls.signIn, [])
  assert.equal((await finalize(token, bindingCookie)).status, 409)
  assert.equal(calls.link.length, 1)
})

test('logout, account switching, and missing browser binding cannot finalize a pending link', async (t) => {
  const { start, callback, finalize, calls } = await fixture(t)
  const started = await start(
    { mode: 'link' },
    {
      Cookie: 'lemex_web=existing',
      'X-Leanflow-User': 'existing',
    },
  )
  const response = await callback(started)
  const token = /"linkToken":"([A-Za-z0-9_-]{43})"/.exec(
    await response.text(),
  )?.[1]
  assert(token)
  const bindingCookie = response.headers.getSetCookie()[0].split(';')[0]
  assert.equal(
    (await finalize(token, bindingCookie, { Cookie: bindingCookie })).status,
    401,
  )
  assert.equal(
    (
      await finalize(token, bindingCookie, {
        Cookie: `lemex_web=other; ${bindingCookie}`,
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await finalize(token, bindingCookie, {
        Cookie: `lemex_web=other; ${bindingCookie}`,
        'X-Leanflow-User': 'other',
      })
    ).status,
    401,
  )
  assert.equal(
    (await finalize(token, '', { Cookie: 'lemex_web=existing' })).status,
    409,
  )
  assert.equal((await finalize(token, started.cookie)).status, 409)
  assert.deepEqual(calls.link, [])
  // Reauthenticating as the original account still allows the valid, bound link.
  assert.equal((await finalize(token, bindingCookie)).status, 200)
  assert.equal(calls.link.length, 1)
})

test('pending link tokens expire and share the global transaction capacity', async (t) => {
  const { start, callback, finalize, advance, calls } = await fixture(t, {
    limits: { maxTransactions: 1 },
  })
  const response = await callback(
    await start(
      { mode: 'link' },
      {
        Cookie: 'lemex_web=existing',
        'X-Leanflow-User': 'existing',
      },
    ),
  )
  const token = /"linkToken":"([A-Za-z0-9_-]{43})"/.exec(
    await response.text(),
  )?.[1]
  assert(token)
  const bindingCookie = response.headers.getSetCookie()[0].split(';')[0]
  assert.equal((await start()).response.status, 429)
  advance(2 * 60_000 + 1)
  assert.equal((await finalize(token, bindingCookie)).status, 409)
  assert.equal((await start()).response.status, 200)
  assert.deepEqual(calls.link, [])
})

test('recovery carries the expected workspace identity and cannot replace it with another account', async (t) => {
  const { start, callback, calls } = await fixture(t)
  const response = await callback(
    await start({ expectedUserId: 'another-account' }),
  )
  assert.match(await response.text(), /"ok":false/)
  assert.equal(calls.signIn[0].settings.expectedUserId, 'another-account')
  assert(
    !response.headers
      .getSetCookie()
      .some((value) => value.startsWith('lemex_web=')),
  )
  assert.equal(
    (
      await start(
        { expectedUserId: 'other' },
        { 'X-Leanflow-User': 'existing' },
      )
    ).response.status,
    400,
  )
})

test('malformed options and cross-origin starts never reach the identity provider', async (t) => {
  const { start, calls } = await fixture(t)
  for (const input of [
    null,
    [],
    { mode: 'bad' },
    { mode: 'login', token: 'secret' },
    { expectedUserId: 3 },
    { expectedUserId: 'a b' },
  ])
    assert.equal((await start(input)).response.status, 400)
  assert.equal(
    (await start({}, { Origin: 'https://attacker.example' })).response.status,
    403,
  )
  assert.deepEqual(calls.fetch, [])
})

test('pending transaction and per-IP attempt bounds reject excess starts', async (t) => {
  const bounded = await fixture(t, { limits: { maxTransactions: 1 } })
  assert.equal((await bounded.start()).response.status, 200)
  assert.equal((await bounded.start()).response.status, 429)
  const limited = await fixture(t, { limits: { maxStartsPerWindow: 1 } })
  const first = await limited.start()
  await (await limited.callback(first)).text()
  assert.equal((await limited.start()).response.status, 429)
  limited.advance(5 * 60_000 + 1)
  assert.equal((await limited.start()).response.status, 200)
})

test('25 participants can open EPFL sign-in together while provider discovery is cold', async (t) => {
  let arrivals = 0
  const arrived = Promise.withResolvers()
  const f = await fixture(t, {
    studio: true,
    blockDiscovery: true,
    onRequest: (url) => {
      if (url.endsWith('/start') && ++arrivals === 25) arrived.resolve()
    },
  })
  const opens = Promise.all(Array.from({ length: 25 }, () => f.start()))
  await Promise.all([arrived.promise, f.discoveryReached])
  f.releaseDiscovery()
  const started = await opens
  assert.equal(
    started.filter((item) => item.response.status === 200).length,
    25,
  )
  assert.equal(
    f.calls.fetch.filter((url) => url.includes('openid-configuration')).length,
    1,
  )
})

test('25 simultaneous bound EPFL returns finish with at most eight active exchanges', async (t) => {
  let arrivals = 0,
    exchanging = 0,
    peak = 0
  const arrived = Promise.withResolvers(),
    eight = Promise.withResolvers(),
    hold = Promise.withResolvers()
  const f = await fixture(t, {
    studio: true,
    onRequest: (url) => {
      if (url.endsWith('/callback') && ++arrivals === 25) arrived.resolve()
    },
    beforeToken: async () => {
      peak = Math.max(peak, ++exchanging)
      if (exchanging === 8) eight.resolve()
      await hold.promise
      exchanging--
    },
  })
  const started = []
  for (let i = 0; i < 25; i++) started.push(await f.start())
  const returning = Promise.all(
    started.map((item, index) =>
      f.callback(item, {
        claims: {
          oid: '33333333-3333-3333-3333-' + String(index).padStart(12, '0'),
        },
      }),
    ),
  )
  await Promise.all([arrived.promise, eight.promise])
  hold.resolve()
  const responses = await returning
  const cookies = responses
    .flatMap((response) => response.headers.getSetCookie())
    .filter((value) => value.startsWith('lemex_web='))
  assert.equal(cookies.length, 25)
  const sessions = await Promise.all(
    cookies.map(async (value) => {
      const response = await f.request('/api/session', {
        headers: { Cookie: value.split(';')[0] },
      })
      assert.equal(response.status, 200)
      return (await response.json()).user
    }),
  )
  assert.equal(new Set(sessions.map((user) => user.id)).size, 25)
  assert(sessions.every((user) => user.role === 'user' && user.entraLinked))
  assert.equal(peak, 8)
})

test('full and timed-out exchange queues preserve each bound return URL for one retry', async (t) => {
  const active = Promise.withResolvers(),
    queued = Promise.withResolvers(),
    release = Promise.withResolvers()
  let arrivals = 0
  const f = await fixture(t, {
    limits: { maxConcurrent: 1, maxQueuedExchanges: 1, exchangeWaitMs: 100 },
    beforeToken: async () => {
      active.resolve()
      await release.promise
    },
    onRequest: (path) => {
      if (path.endsWith('/callback') && ++arrivals === 2) queued.resolve()
    },
  })
  const starts = await Promise.all([f.start(), f.start(), f.start()])
  const first = f.callback(starts[0])
  await active.promise
  const second = f.callback(starts[1])
  await queued.promise
  const third = await f.callback(starts[2])
  const timedOut = await second
  release.resolve()
  assert.match(await (await first).text(), /"ok":true/)
  for (const [response, started] of [
    [third, starts[2]],
    [timedOut, starts[1]],
  ]) {
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('retry-after'), '5')
    assert.equal(response.headers.get('set-cookie'), null)
    const url = new URL(response.url)
    const retry = () =>
      f.request(url.pathname + url.search, {
        headers: { Cookie: started.cookie },
      })
    assert.match(await (await retry()).text(), /"ok":true/)
    assert.match(await (await retry()).text(), /"ok":false/)
  }
  assert.equal(f.calls.signIn.length, 3)
})

test('disconnect and shutdown clear waiting EPFL callbacks without exchanging their codes', async (t) => {
  const active = Promise.withResolvers(),
    queued = Promise.withResolvers(),
    disconnected = Promise.withResolvers(),
    next = Promise.withResolvers(),
    release = Promise.withResolvers()
  let arrivals = 0
  const f = await fixture(t, {
    limits: { maxConcurrent: 1, maxQueuedExchanges: 1 },
    beforeToken: async () => {
      active.resolve()
      await release.promise
    },
    onRequest: (path, response) => {
      if (!path.endsWith('/callback')) return
      arrivals++
      if (arrivals === 2) {
        response.once('close', disconnected.resolve)
        queued.resolve()
      }
      if (arrivals === 3) next.resolve()
    },
  })
  const starts = await Promise.all([f.start(), f.start(), f.start()])
  const first = f.callback(starts[0])
  await active.promise
  const abort = new AbortController()
  const cancelled = assert.rejects(
    f.callback(starts[1], { signal: abort.signal }),
    { name: 'AbortError' },
  )
  await queued.promise
  abort.abort()
  await Promise.all([cancelled, disconnected.promise])
  const last = f.callback(starts[2])
  await next.promise
  f.closeRoutes()
  const response = await last
  release.resolve()
  assert.match(await (await first).text(), /"ok":false/)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /expired/)
  assert.equal(f.calls.fetch.filter((url) => url.endsWith('/token')).length, 1)
  assert.equal(f.calls.signIn.length, 0)
})

test('cold sign-in starts are bounded while discovery is pending', async (t) => {
  const { start, releaseDiscovery, discoveryReached } = await fixture(t, {
    blockDiscovery: true,
    limits: { maxConcurrentStarts: 1 },
  })
  const pending = start()
  await discoveryReached
  assert.equal((await start()).response.status, 429)
  releaseDiscovery()
  assert.equal((await pending).response.status, 200)
})

test('enabled EPFL sign-in provisions a regular account through the real studio middleware and session', async (t) => {
  const { start, callback, request, studio } = await fixture(t, {
    studio: true,
  })
  const response = await callback(await start())
  assert.match(await response.text(), /"ok":true/)
  const sessionCookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('lemex_web='))
    ?.split(';')[0]
  assert(sessionCookie)
  const sessionResponse = await request('/api/session', {
    headers: { Cookie: sessionCookie },
  })
  assert.equal(sessionResponse.status, 200)
  const session = await sessionResponse.json()
  assert.equal(session.user.name, 'EPFL Tester')
  assert.equal(session.user.role, 'user')
  assert.equal(session.user.entraLinked, true)
  assert.equal(session.lemex.configured, false)
  const stored = studio.auth.users.find((user) => user.id === session.user.id)
  assert.deepEqual(stored.entra, { tenantId, objectId })
  assert.equal(stored.tokenHash, undefined)
  const headers = {
    Cookie: sessionCookie,
    'X-Leanflow-User': session.user.id,
    'Content-Type': 'application/json',
    Origin: env.STUDIO_ORIGIN,
  }
  const renewed = await request('/api/session/activity', {
    method: 'POST',
    headers,
    body: '{}',
  })
  assert.equal(renewed.status, 200)
  assert.equal((await request('/api/projects', { headers })).status, 200)
  assert.equal(
    (
      await request('/api/projects', {
        headers: { ...headers, 'X-Leanflow-User': 'another-account' },
      })
    ).status,
    401,
  )
})

test('real studio linking requires the current bound user and preserves the existing account and cookie', async (t) => {
  const { start, callback, finalize, request, studio } = await fixture(t, {
    studio: true,
  })
  const { user: existing, token } = await studio.auth.createUser(
    studio.auth.users[0],
    {
      name: 'Existing collaborator',
      role: 'user',
    },
  )
  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: env.STUDIO_ORIGIN },
    body: JSON.stringify({ token }),
  })
  assert.equal(login.status, 200)
  const sessionCookie = login.headers.get('set-cookie').split(';')[0]
  const headers = { Cookie: sessionCookie, 'X-Leanflow-User': existing.id }
  const mismatched = await start(
    { mode: 'link' },
    {
      ...headers,
      'X-Leanflow-User': 'another-account',
    },
  )
  assert.equal(mismatched.response.status, 401)
  const started = await start(
    { mode: 'link', expectedUserId: existing.id },
    headers,
  )
  assert.equal(started.response.status, 200)
  assert.equal(started.url.searchParams.get('prompt'), 'login')
  const response = await callback(started)
  const proof = /"linkToken":"([A-Za-z0-9_-]{43})"/.exec(
    await response.text(),
  )?.[1]
  assert(proof)
  const bindingCookie = response.headers.getSetCookie()[0].split(';')[0]
  assert.equal(
    studio.auth.users.find((user) => user.id === existing.id).entra,
    undefined,
  )
  const denied = await finalize(proof, bindingCookie, {
    Cookie: `${sessionCookie}; ${bindingCookie}`,
    'X-Leanflow-User': 'another-account',
  })
  assert.equal(denied.status, 401)
  const linked = await finalize(proof, bindingCookie, {
    Cookie: `${sessionCookie}; ${bindingCookie}`,
    'X-Leanflow-User': existing.id,
  })
  assert.equal(linked.status, 200)
  assert(
    !linked.headers
      .getSetCookie()
      .some((value) => value.startsWith('lemex_web=')),
  )
  const sessionResponse = await request('/api/session', { headers })
  assert.equal(sessionResponse.status, 200)
  const { user } = await sessionResponse.json()
  assert.equal(user.id, existing.id)
  assert.equal(user.name, existing.name)
  assert.equal(user.role, existing.role)
  assert.equal(user.entraLinked, true)
  assert.equal((await studio.auth.login(token, 'fixture-ip')).id, existing.id)
})
