import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import https from 'node:https'

export const RCP_BASE_URL = 'https://inference.rcp.epfl.ch/v1'
const invalid = () =>
  Object.assign(
    new Error(
      'Enter a public HTTPS API base URL without credentials, a query, or a fragment.',
    ),
    { status: 400 },
  )

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  if (isIP(address) === 6) {
    const groups = address.toLowerCase().split(':')
    const first = parseInt(groups[0], 16),
      second = parseInt(groups[1] || '0', 16)
    return (
      first >= 0x2000 &&
      first <= 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
      first !== 0x2002
    )
  }
  return false
}

export function providerEndpoint(input) {
  try {
    if (
      typeof input !== 'string' ||
      input.length > 2048 ||
      /[\s\p{Cc}]/u.test(input)
    )
      throw invalid()
    const url = new URL(input)
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      (!host.includes('.') && !isIP(host)) ||
      (isIP(host) && !publicAddress(host))
    )
      throw invalid()
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw invalid()
  }
}

export const isRcpEndpoint = (base) => providerEndpoint(base) === RCP_BASE_URL

// Pin the validated DNS result to this socket. Redirects, private addresses,
// oversized bodies and unbounded requests cannot turn account settings into
// server-side network access. TLS still verifies the original provider host.
export async function fetchProvider(
  url,
  options = {},
  { resolve = lookup, request = https.request } = {},
) {
  const parsed = new URL(providerEndpoint(String(url)))
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  const signal = options.signal || AbortSignal.timeout(15000)
  signal.throwIfAborted()
  let abortDns
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await Promise.race([
        resolve(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => {
          abortDns = () => reject(signal.reason)
          signal.addEventListener('abort', abortDns, { once: true })
        }),
      ]).finally(() => signal.removeEventListener('abort', abortDns))
  // EPFL's official RCP host resolves to RFC1918 inside its network. Trust
  // only that exact TLS origin and API prefix, never arbitrary private hosts.
  const trustedRcp =
    parsed.origin === 'https://inference.rcp.epfl.ch' &&
    parsed.pathname.startsWith('/v1/')
  const rcpInternal = (address) => {
    if (!trustedRcp || isIP(address) !== 4) return false
    const [a, b] = address.split('.').map(Number)
    return (
      a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    )
  }
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) => !publicAddress(address) && !rcpInternal(address),
    )
  )
    throw invalid()
  signal.throwIfAborted()
  const selected = addresses[0]
  return new Promise((resolveResponse, reject) => {
    const req = request(
      parsed,
      {
        method: options.method || 'GET',
        headers: options.headers,
        signal,
        agent: false,
        lookup: (_host, lookupOptions, callback) =>
          callback(
            null,
            lookupOptions.all ? [selected] : selected.address,
            selected.family,
          ),
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 1024 * 1024)
            req.destroy(new Error('Provider response is too large.'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('aborted', () =>
          reject(new Error('Provider response was interrupted.')),
        )
        response.on('end', () =>
          resolveResponse(
            new Response(
              [204, 205, 304].includes(response.statusCode)
                ? null
                : Buffer.concat(chunks),
              { status: response.statusCode },
            ),
          ),
        )
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

export function providerToml(provider) {
  const base = providerEndpoint(provider.LEMEX_BASE_URL || RCP_BASE_URL)
  const id = isRcpEndpoint(base) ? 'rcp' : 'leanflow'
  return [
    `model_provider = "${id}"`,
    // Inline table keeps following model/context options at the TOML root.
    `model_providers.${id} = { name = "${id === 'rcp' ? 'RCP' : 'Custom provider'}", base_url = ${JSON.stringify(base)}, env_key = "LEMEX_API_KEY", wire_api = "responses", requires_openai_auth = false, supports_websockets = false, supports_standalone_web_search = false }`,
  ]
}
