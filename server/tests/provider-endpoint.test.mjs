import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  fetchProvider,
  providerEndpoint,
  providerToml,
  publicAddress,
  RCP_BASE_URL,
} from '../provider-endpoint.mjs'

test('provider endpoints require public HTTPS without credentials or hidden network targets', () => {
  assert.equal(providerEndpoint(RCP_BASE_URL + '/'), RCP_BASE_URL)
  assert.equal(
    providerEndpoint('https://api.example.com/v1/'),
    'https://api.example.com/v1',
  )
  for (const input of [
    null,
    {},
    '',
    'http://api.example.com/v1',
    'https://user:secret@api.example.com',
    'https://api.example.com?key=secret',
    'https://api.example.com#secret',
    'https://localhost/v1',
    'https://test.local/v1',
    'https://127.1/v1',
    'https://0x7f000001/v1',
    'https://10.0.0.1/v1',
    'https://169.254.169.254/v1',
    'https://[::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'https://api.example.com/\n',
  ])
    assert.throws(() => providerEndpoint(input), { status: 400 })
  for (const address of [
    '0.0.0.0',
    '100.64.0.1',
    '172.31.2.3',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::',
  ])
    assert.equal(publicAddress(address), false, address)
  assert(publicAddress('8.8.8.8'))
  assert(publicAddress('2606:4700:4700::1111'))
})

test('public DNS is pinned for the TLS socket and redirects are returned without following them', async () => {
  let lookups = 0,
    requests = 0
  const body = '{"data":[{"id":"provider/model"}]}'
  const response = await fetchProvider(
    'https://api.example.com/v1/models',
    { headers: { authorization: 'Bearer fixture-key' } },
    {
      resolve: async () => {
        lookups++
        return [{ address: '8.8.8.8', family: 4 }]
      },
      request: (url, options, reply) => {
        requests++
        assert.equal(url.hostname, 'api.example.com')
        assert.equal(options.headers.authorization, 'Bearer fixture-key')
        assert.equal(options.agent, false)
        options.lookup('api.example.com', { all: true }, (error, values) => {
          assert.equal(error, null)
          assert.deepEqual(values, [{ address: '8.8.8.8', family: 4 }])
        })
        const req = new EventEmitter()
        req.end = () => {
          const stream = new PassThrough()
          stream.statusCode = 302
          reply(stream)
          stream.end(body)
        }
        return req
      },
    },
  )
  assert.equal(response.status, 302)
  assert.equal(await response.text(), body)
  assert.equal(lookups, 1)
  assert.equal(requests, 1)
})

test('the official RCP TLS origin supports EPFL internal DNS without opening other private endpoints', async () => {
  let requests = 0
  const transport = {
    resolve: async () => [{ address: '10.92.7.102', family: 4 }],
    request: (url, _options, reply) => {
      requests++
      assert.equal(url.origin, 'https://inference.rcp.epfl.ch')
      const req = new EventEmitter()
      req.end = () => {
        const stream = new PassThrough()
        stream.statusCode = 401
        reply(stream)
        stream.end('{}')
      }
      return req
    },
  }
  assert.equal(
    (await fetchProvider(RCP_BASE_URL + '/models', {}, transport)).status,
    401,
  )
  await assert.rejects(
    () => fetchProvider('https://custom.example/v1/models', {}, transport),
    { status: 400 },
  )
  await assert.rejects(
    () => fetchProvider('https://inference.rcp.epfl.ch/private', {}, transport),
    { status: 400 },
  )
  assert.equal(requests, 1)
})

test('mixed/private DNS, oversized responses and cancellation fail before returning provider data', async () => {
  let requests = 0
  await assert.rejects(
    () =>
      fetchProvider(
        'https://api.example.com/models',
        {},
        {
          resolve: async () => [
            { address: '8.8.8.8', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ],
          request: () => {
            requests++
          },
        },
      ),
    { status: 400 },
  )
  assert.equal(requests, 0)
  const controller = new AbortController()
  const waiting = fetchProvider(
    'https://api.example.com/models',
    { signal: controller.signal },
    {
      resolve: () => new Promise(() => {}),
      request: () => {
        requests++
      },
    },
  )
  controller.abort(new Error('Fixture cancelled'))
  await assert.rejects(waiting, /Fixture cancelled/)
  assert.equal(requests, 0)
  await assert.rejects(
    () =>
      fetchProvider(
        'https://api.example.com/models',
        {},
        {
          resolve: async () => [{ address: '8.8.8.8', family: 4 }],
          request: (_url, _options, reply) => {
            const req = new EventEmitter()
            req.destroy = (error) => req.emit('error', error)
            req.end = () => {
              const stream = new PassThrough()
              stream.statusCode = 200
              reply(stream)
              stream.end(Buffer.alloc(1024 * 1024 + 1))
            }
            return req
          },
        },
      ),
    /too large/,
  )
})

test('worker provider definitions use explicit endpoints and Responses; only RCP gets the RCP identity', () => {
  assert.match(
    providerToml({ LEMEX_BASE_URL: RCP_BASE_URL }).join('\n'),
    /model_provider = "rcp"/,
  )
  const custom = providerToml({
    LEMEX_BASE_URL: 'https://api.example.com/v1',
    LEMEX_API_KEY: 'fixture-secret',
  }).join('\n')
  assert.match(custom, /model_provider = "leanflow"/)
  assert.match(custom, /wire_api = "responses"/)
  assert.match(custom, /base_url = "https:\/\/api.example.com\/v1"/)
  assert(!custom.includes('fixture-secret'))
  assert(!custom.includes('inference.rcp.epfl.ch'))
})

test('malformed asynchronous provider responses reject without escaping event callbacks', async () => {
  const replyWith = (status, body = Buffer.from('{}')) =>
    fetchProvider(
      'https://api.example.com/v1/models',
      {},
      {
        resolve: async () => [{ address: '8.8.8.8', family: 4 }],
        request: (_url, _options, reply) => {
          const request = new EventEmitter()
          request.end = () =>
            setImmediate(() => {
              const response = new EventEmitter()
              response.statusCode = status
              reply(response)
              response.emit('data', body)
              response.emit('end')
            })
          return request
        },
      },
    )
  for (const status of [199, 700, undefined, NaN])
    await assert.rejects(replyWith(status), {
      message: 'Provider returned an invalid HTTP response.',
    })
  // Unexpected transport data can also make Buffer.concat/Response throw.
  // The generic failure must not reveal the upstream object's contents.
  await assert.rejects(replyWith(200, { length: 0, secret: 'fixture-only' }), {
    message: 'Provider returned an invalid HTTP response.',
  })
  assert.equal((await replyWith(204)).status, 204)
  assert.equal((await replyWith(599)).status, 599)
})
