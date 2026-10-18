import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeDiagnosticHandler } from '../native-diagnostics.mjs'

function fixture() {
  const messages = [],
    handle = createNativeDiagnosticHandler((message) => messages.push(message))
  return { messages, handle }
}

test('native diagnostics never publish split credentials, raw provider bodies or long-line excerpts', () => {
  const { handle, messages } = fixture()
  const secret = 'unregistered-private-fixture-provider-key'
  handle(Buffer.from('ERROR ' + secret.slice(0, 20)))
  handle(Buffer.from(secret.slice(20) + '\n'))
  handle('ERROR ' + 'x'.repeat(1980) + secret + '\n')
  handle('ERROR https://provider.example/private?token=other-unknown-secret\n')
  assert.equal(messages.length, 1)
  assert.match(messages[0], /internal diagnostic/)
  for (const raw of [
    secret,
    secret.slice(0, 20),
    secret.slice(20),
    'other-unknown-secret',
    'provider.example',
    'xxxx',
  ])
    assert(!messages.join('').includes(raw))
})

test('diagnostic categories remain actionable when tokens cross stream chunks', () => {
  const { handle, messages } = fixture()
  handle('unauthor')
  handle('ized\n')
  handle('rate_li')
  handle('mit reached\n')
  handle('ENO')
  handle('TFOUND private-host.example\n')
  handle('model missing-model is not found\n')
  handle('MCP startup failed\n')
  assert.equal(messages.length, 5)
  assert(messages.some((message) => message.includes('API key')))
  assert(messages.some((message) => message.includes('limiting requests')))
  assert(messages.some((message) => message.includes('could not connect')))
  assert(messages.some((message) => message.includes('selected model')))
  assert(messages.some((message) => message.includes('tool could not start')))
  assert(!messages.join('').includes('private-host.example'))
  assert(!messages.join('').includes('missing-model'))
})

test('diagnostic floods produce at most one fixed message per category and ignore informational output', () => {
  const { handle, messages } = fixture()
  handle('INFO app-server started\n')
  assert.deepEqual(messages, [])
  handle('INFO ' + 'x'.repeat(1024 * 1024) + '\nERROR model not found\n')
  for (let index = 0; index < 1000; index++)
    handle('ERROR 401 429 ECONNRESET model not found MCP failed\n')
  handle('ERROR internal failure\n')
  assert(messages.length <= 6)
  assert(messages.join('').length < 1200)
  assert(messages.every((message) => message.length < 200))
})
