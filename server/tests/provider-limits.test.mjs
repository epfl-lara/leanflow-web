import test from 'node:test'
import assert from 'node:assert/strict'
import { RcpKeyLimits, providerFingerprint } from '../provider-limits.mjs'
import { RCP_BASE_URL } from '../provider-endpoint.mjs'

const rcp = (key = 'fixture-key') => ({
  LEMEX_BASE_URL: RCP_BASE_URL,
  LEMEX_API_KEY: key,
})

test('RCP limits use only authenticated metadata and cache by endpoint and effective key', async () => {
  let calls = 0,
    release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const limits = new RcpKeyLimits({
    fetchImpl: async (url, options) => {
      calls++
      assert.equal(String(url), 'https://inference.rcp.epfl.ch/key/info')
      assert.equal(options.method || 'GET', 'GET')
      assert.equal(options.redirect, 'error')
      assert.equal(options.headers.authorization, 'Bearer fixture-key')
      assert(options.signal instanceof AbortSignal)
      await gate
      return Response.json({
        key: 'sensitive-provider-data',
        info: { max_parallel_requests: 5, metadata: { plan: 'pro' } },
      })
    },
  })
  const first = limits.get(rcp())
  const second = limits.get({ ...rcp(), LEMEX_BASE_URL: RCP_BASE_URL + '/' })
  assert.equal(calls, 1)
  assert.equal(limits.current(providerFingerprint(rcp())), 1)
  release()
  assert.deepEqual(await Promise.all([first, second]), [5, 5])
  assert.equal(await limits.get(rcp()), 5)
  assert.equal(limits.current(providerFingerprint(rcp())), 5)
  assert.equal(limits.current(providerFingerprint(rcp('different-key'))), 1)
  assert.equal(calls, 1)
  assert(!JSON.stringify(limits).includes('sensitive-provider-data'))
  assert.equal(
    await limits.get({
      ...rcp(),
      LEMEX_BASE_URL: 'https://provider.example/v1',
    }),
    null,
  )
  assert.equal(await limits.get({ LEMEX_BASE_URL: RCP_BASE_URL }), null)
  assert.equal(calls, 1)
})

test('missing, malformed and unavailable metadata never grant extra parallel tasks or reveal provider bodies', async () => {
  for (const value of [
    {},
    { info: null },
    { info: { max_parallel_requests: null, metadata: { tier: 'pro' } } },
    ...[0, -1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1].map((limit) => ({
      info: { max_parallel_requests: limit },
    })),
  ]) {
    const limits = new RcpKeyLimits({
      fetchImpl: async () => Response.json(value),
    })
    assert.equal(await limits.get(rcp()), 1)
    assert.equal(limits.current(providerFingerprint(rcp())), 1)
  }
  for (const fetchImpl of [
    async () => new Response('private provider body', { status: 403 }),
    async () => new Response('not JSON'),
    async () => {
      throw new Error('private transport error')
    },
  ]) {
    const limits = new RcpKeyLimits({ fetchImpl })
    assert.equal(await limits.get(rcp()), 1)
    assert.equal(limits.current(providerFingerprint(rcp())), 1)
  }
})

test('allowances refresh after expiry and failed lookups retry sooner without retaining a stale higher limit', async () => {
  let now = 0,
    calls = 0,
    limit = 1
  const limits = new RcpKeyLimits({
    now: () => now,
    fetchImpl: async () => {
      calls++
      return Response.json({ info: { max_parallel_requests: limit } })
    },
  })
  assert.equal(await limits.get(rcp()), 1)
  limit = 5
  now = 299_999
  assert.equal(await limits.get(rcp()), 1)
  assert.equal(calls, 1)
  now++
  assert.equal(await limits.get(rcp()), 5)
  limit = null
  now += 300_000
  assert.equal(await limits.get(rcp()), 1)
  assert.equal(limits.current(providerFingerprint(rcp())), 1)
  limit = 3
  now += 29_999
  assert.equal(await limits.get(rcp()), 1)
  now++
  assert.equal(await limits.get(rcp()), 3)
  assert.equal(calls, 4)
})

test('cached keys remain bounded and replacing a key cannot inherit its previous allowance', async () => {
  let calls = 0
  const limits = new RcpKeyLimits({
    maxEntries: 2,
    fetchImpl: async () => {
      calls++
      return Response.json({ info: { max_parallel_requests: 5 } })
    },
  })
  for (const key of ['first', 'second', 'third'])
    assert.equal(await limits.get(rcp(key)), 5)
  assert.equal(limits.current(providerFingerprint(rcp('first'))), 1)
  assert.equal(limits.current(providerFingerprint(rcp('replacement'))), 1)
  assert.equal(await limits.get(rcp('second')), 5)
  assert.equal(calls, 3)
  assert.equal(await limits.get(rcp('first')), 5)
  assert.equal(calls, 4)
})
