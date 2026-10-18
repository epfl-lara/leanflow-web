import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import express from 'express'
import {
  authRequestJson,
  isPublicAuthRequest,
  MAX_AUTH_JSON_BYTES,
} from '../auth-request-limits.mjs'

async function fixture(t, options) {
  const app = express(),
    parsed = []
  app.use(authRequestJson(options))
  app.use('/api', (request, response, next) => {
    if (!isPublicAuthRequest(request)) return response.sendStatus(401)
    next()
  })
  for (const action of ['login', 'logout'])
    app.post(`/api/${action}`, (request, response) => {
      parsed.push(request.body)
      response.json({ ok: true })
    })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const post = (endpoint, body, headers = {}) =>
    fetch(base + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  const pending = () => {
    const request = http.request(base + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const result = new Promise((resolve, reject) => {
      request.on('response', (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      })
      request.once('error', reject)
    })
    // The parser holds this incomplete body until it ends or times out.
    request.write('{')
    t.after(() => request.destroy())
    return { request, result }
  }
  return { post, pending, parsed }
}

test('account JSON accepts the longest key, provider URL and recovery identity without using the source limit', async (t) => {
  const f = await fixture(t)
  const body = {
    token: 'a'.repeat(199),
    expectedUserId: 'owner',
    provider: 'custom',
    apiKey: '\\'.repeat(4096),
    baseUrl: 'https://api.example.com/' + 'a'.repeat(2024),
  }
  assert(Buffer.byteLength(JSON.stringify(body)) < MAX_AUTH_JSON_BYTES)
  assert.equal((await f.post('/api/login', JSON.stringify(body))).status, 200)
  assert.deepEqual(f.parsed, [body])
  assert.equal((await f.post('/api/logout', '{}')).status, 200)
  // Express routes are case insensitive and accept a trailing slash.
  assert.equal((await f.post('/API/LOGIN/', '{}')).status, 200)
  assert.equal((await f.post('/api/projects', '{}')).status, 401)
})

test('oversized and compressed public bodies stop before credential handling; errors never echo submitted secrets', async (t) => {
  const f = await fixture(t)
  const oversized = JSON.stringify({ token: 'x'.repeat(MAX_AUTH_JSON_BYTES) })
  for (const [body, headers] of [
    [oversized, {}],
    [gzipSync(oversized), { 'Content-Encoding': 'gzip' }],
  ]) {
    const response = await f.post('/api/login', body, headers)
    assert.equal(response.status, 413)
    assert.match((await response.json()).error, /too large/)
  }
  const secret = 'unregistered-fixture-login-secret'
  const malformed = await f.post('/api/login', `{"token":"${secret}"`)
  assert.equal(malformed.status, 400)
  assert(!(await malformed.text()).includes(secret))
  assert.deepEqual(f.parsed, [])
  // Parsing failures must release admission for the next account request.
  assert.equal((await f.post('/api/login', '{}')).status, 200)
})

test('concurrent incomplete public bodies are bounded and disconnects release their slots', async (t) => {
  const f = await fixture(t, { maxConcurrent: 1 })
  const held = f.pending()
  // Attach the expected rejection before disconnecting the raw request.
  const disconnected = assert.rejects(held.result, /socket hang up/)
  let busy
  for (let attempt = 0; attempt < 20; attempt++) {
    busy = await f.post('/api/login', '{}')
    if (busy.status === 429) break
  }
  assert.equal(busy.status, 429)
  assert.equal(busy.headers.get('retry-after'), '1')
  held.request.destroy()
  await disconnected
  let accepted
  for (let attempt = 0; attempt < 20; attempt++) {
    accepted = await f.post('/api/login', '{}')
    if (accepted.status === 200) break
  }
  assert.equal(accepted.status, 200)
})

test('slow public bodies time out and release admission without credential handling', async (t) => {
  const f = await fixture(t, { maxConcurrent: 1, timeoutMs: 50 })
  const held = f.pending()
  assert.equal(await held.result, 408)
  assert.deepEqual(f.parsed, [])
  assert.equal((await f.post('/api/logout', '{}')).status, 200)
})
