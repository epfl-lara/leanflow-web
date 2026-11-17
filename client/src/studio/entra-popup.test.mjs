import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const authorizationUrl =
  'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?state=fixture'

function popupFixture(t, { blocked = false } = {}) {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL('./entraPopup.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
      },
    },
  )
  const module = { exports: {} }
  new Function('module', 'exports', outputText)(module, module.exports)
  const previous = globalThis.window
  const listeners = new Set()
  const calls = []
  const popup = {
    closed: false,
    close() {
      this.closed = true
      calls.push('close')
    },
    location: { replace: (url) => calls.push(['navigate', url]) },
  }
  globalThis.window = {
    location: { origin: 'https://leanflow.example.org' },
    open(url, target, features) {
      calls.push(['open', url, target, features])
      return blocked ? null : popup
    },
    addEventListener: (_name, listener) => listeners.add(listener),
    removeEventListener: (_name, listener) => listeners.delete(listener),
  }
  const controller = new AbortController()
  t.after(() => {
    controller.abort()
    globalThis.window = previous
  })
  return {
    popup,
    calls,
    listeners,
    controller,
    start: (begin = async () => ({ url: authorizationUrl }), options = {}) =>
      module.exports.entraPopup(begin, {
        signal: controller.signal,
        ...options,
      }),
    message(data, options = {}) {
      const event = {
        source: popup,
        origin: 'https://leanflow.example.org',
        data,
        ...options,
      }
      for (const listener of listeners) listener(event)
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('EPFL popup opens during the click and accepts completion only from its own same-origin window', async (t) => {
  const fixture = popupFixture(t)
  let requested = false
  const pending = fixture.start(async () => {
    requested = true
    return { url: authorizationUrl }
  })
  assert.equal(fixture.calls[0][0], 'open')
  assert.equal(requested, false)
  await flush()
  assert.deepEqual(fixture.calls[1], ['navigate', authorizationUrl])
  const success = { type: 'leanflow-entra-complete', ok: true }
  fixture.message(success, { origin: 'https://attacker.example.org' })
  fixture.message(success, { source: {} })
  fixture.message({ type: 'leanflow-entra-complete', ok: 'true' })
  fixture.message({ type: 'leanflow-entra-complete', ok: true, error: {} })
  assert.equal(fixture.listeners.size, 1)
  assert.equal(fixture.popup.closed, false)
  fixture.message(success)
  assert.deepEqual(await pending, {})
  assert.equal(fixture.listeners.size, 0)
  assert.equal(fixture.calls.filter((call) => call === 'close').length, 1)
})

test('EPFL popup passes a link proof only from the verified completion window', async (t) => {
  const fixture = popupFixture(t)
  const pending = fixture.start()
  await flush()
  const linkToken = 'a'.repeat(43)
  const completion = { type: 'leanflow-entra-complete', ok: true, linkToken }
  fixture.message(completion, { source: {} })
  fixture.message(completion, { origin: 'https://attacker.example.org' })
  fixture.message({ ...completion, linkToken: { token: linkToken } })
  assert.equal(fixture.listeners.size, 1)
  fixture.message(completion)
  assert.deepEqual(await pending, { linkToken })
  assert.equal(fixture.listeners.size, 0)
})

test('a rejected EPFL sign-in shows its safe error and cleans up the popup', async (t) => {
  const fixture = popupFixture(t)
  const pending = fixture.start()
  await flush()
  fixture.message({
    type: 'leanflow-entra-complete',
    ok: false,
    error: 'Sign in with the EPFL account linked to this workspace.',
  })
  await assert.rejects(pending, /linked to this workspace/)
  assert.equal(fixture.listeners.size, 0)
  assert.equal(fixture.popup.closed, true)
})

test('blocked popups leave sign-in unstarted with an actionable message', async (t) => {
  const fixture = popupFixture(t, { blocked: true })
  await assert.rejects(
    fixture.start(() => assert.fail('No authentication request when blocked')),
    /Allow pop-ups/,
  )
  assert.equal(fixture.listeners.size, 0)
})

test('closing an EPFL popup releases the pending operation', async (t) => {
  const fixture = popupFixture(t)
  const pending = fixture.start()
  await flush()
  fixture.popup.closed = true
  await assert.rejects(pending, /sign-in was closed/)
  assert.equal(fixture.listeners.size, 0)
})

test('EPFL popup has a bounded wait and ignores late completion', async (t) => {
  const fixture = popupFixture(t)
  const pending = fixture.start(undefined, { timeoutMs: 15 })
  await assert.rejects(pending, /timed out/)
  assert.equal(fixture.listeners.size, 0)
  fixture.message({ type: 'leanflow-entra-complete', ok: true })
  assert.equal(fixture.popup.closed, true)
})

test('aborting popup sign-in prevents late navigation and cleans listeners', async (t) => {
  const fixture = popupFixture(t)
  let respond
  const pending = fixture.start(
    () =>
      new Promise((resolve) => {
        respond = resolve
      }),
  )
  await flush()
  fixture.controller.abort()
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  respond({ url: authorizationUrl })
  await flush()
  assert.equal(
    fixture.calls.some((call) => call[0] === 'navigate'),
    false,
  )
  assert.equal(fixture.listeners.size, 0)
})

test('aborting immediately avoids requesting an authorization URL', async (t) => {
  const fixture = popupFixture(t)
  const pending = fixture.start(() => assert.fail('Aborted before requesting'))
  fixture.controller.abort()
  await assert.rejects(pending, (error) => error.name === 'AbortError')
  assert.equal(fixture.listeners.size, 0)
})

test('EPFL popup refuses malformed or unexpected authorization destinations', async (t) => {
  for (const url of [
    'javascript:alert(1)',
    'https://attacker.example.org/authorize',
    'https://user:secret@login.microsoftonline.com/authorize',
    'not a URL',
    undefined,
  ]) {
    await t.test(String(url), async (t) => {
      const fixture = popupFixture(t)
      await assert.rejects(
        fixture.start(async () => ({ url })),
        /could not be opened/,
      )
      assert.equal(fixture.listeners.size, 0)
      assert.equal(fixture.popup.closed, true)
    })
  }
})
