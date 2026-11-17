#!/usr/bin/env node
// Exercise login with closed account APIs; no real credentials, providers or Lean.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chatBrowserFixture, until } from './lib/chat-browser-fixture.mjs'

const directory = new URL('../.runtime/login-ui/', import.meta.url)
await fs.mkdir(directory, { recursive: true })
const base = process.env.STUDIO_TEST_URL || 'http://127.0.0.1:8090'
const origin = new URL(base).origin
const fixture = await chatBrowserFixture({
  base,
  viewport: { width: 1440, height: 1000 },
  session: {
    user: {
      id: 'login-fixture-user',
      name: 'Invited user',
      role: 'user',
      profileComplete: false,
    },
    templates: [],
    models: [],
    runtime: { ready: true },
    lemex: { configured: false },
  },
  projects: [
    { id: 'login-fixture-project', name: 'Login fixture', status: 'ready' },
  ],
  files: {
    'login-fixture-project': { 'Main.lean': 'example : True := by trivial\n' },
  },
  chats: [
    {
      id: 'login-fixture-chat',
      projectId: 'login-fixture-project',
      title: 'Login fixture',
    },
  ],
  runs: [],
})
const { page, browser, state } = fixture
const context = page.context()
const result = {
  passed: false,
  checks: [],
  screenshots: [],
  layouts: [],
  unexpectedRequests: [],
}
let metadata = 'disabled'
let metadataRequests = 0
let authenticated = false
let loginAttempts = 0
let holdLogin = false
let releaseLogin

// Page routes below override the fixture. Other windows can never reach APIs or
// external sites, even if a future login render accidentally starts a request.
await context.route('**/*', (route) => {
  const url = new URL(route.request().url())
  if (url.origin === origin) return route.continue()
  result.unexpectedRequests.push(
    `${route.request().method()} ${url.origin}${url.pathname}`,
  )
  return route.abort('blockedbyclient')
})
await context.route('**/api/**', (route) => {
  result.unexpectedRequests.push(
    `Unexpected popup API: ${new URL(route.request().url()).pathname}`,
  )
  return route.fulfill({
    status: 503,
    json: { error: 'Unexpected popup API request.' },
  })
})
await page.route('**/api/**', async (route) => {
  const request = route.request()
  const endpoint = new URL(request.url()).pathname
  const respond = (json, status = 200) => route.fulfill({ status, json })
  if (endpoint === '/api/auth/entra') {
    assert.equal(request.method(), 'GET')
    metadataRequests++
    return metadata === 'unavailable'
      ? respond({ error: 'Fixture sign-in service unavailable.' }, 503)
      : respond({ enabled: metadata === 'enabled' })
  }
  if (endpoint === '/api/session')
    return authenticated
      ? respond(structuredClone(state.session))
      : respond({ error: 'Please sign in.' }, 401)
  if (endpoint === '/api/login') {
    assert.equal(request.method(), 'POST')
    assert.equal(request.headers()['x-leanflow-user'], undefined)
    const body = request.postDataJSON()
    assert.deepEqual(Object.keys(body), ['token'])
    loginAttempts++
    if (holdLogin)
      await new Promise((resolve) => {
        releaseLogin = resolve
      })
    if (body.token !== 'fixture-invitation-token')
      return respond(
        { error: 'Fixture invitation token was not recognized.' },
        401,
      )
    authenticated = true
    return respond({ user: state.session.user })
  }
  if (endpoint.startsWith('/api/auth/entra/')) {
    result.unexpectedRequests.push(`${request.method()} ${endpoint}`)
    return respond(
      { error: 'This check does not start EPFL authentication.' },
      503,
    )
  }
  return route.fallback()
})

const tokenInput = () => page.getByLabel('Access token', { exact: true })
const tokenButton = () =>
  page.getByRole('button', { name: 'Open workspace', exact: true })
const epflButton = () =>
  page.getByRole('button', { name: 'Sign in with EPFL', exact: true })

async function loadLogin(status) {
  metadata = status
  const previous = metadataRequests
  await page.goto(base)
  await page.getByRole('main').waitFor()
  await page.getByRole('heading', { level: 1 }).first().waitFor()
  await tokenInput().waitFor()
  await until(
    () => metadataRequests > previous,
    `${status} EPFL metadata request`,
  )
  await page.waitForLoadState('networkidle')
  assert.equal(await tokenInput().getAttribute('type'), 'password')
  assert(await tokenButton().isVisible())
}

async function captureLogin(name, viewport, theme) {
  await page.setViewportSize(viewport)
  // The shared fixture initializes its stored theme to dark. Exercise both
  // existing document themes without changing that fixture or application state.
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value
  }, theme)
  await page.evaluate(() => document.fonts.ready)
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    height: document.documentElement.scrollHeight,
    theme: getComputedStyle(document.documentElement).colorScheme,
  }))
  assert.equal(layout.theme, theme)
  assert(
    Math.max(layout.documentWidth, layout.bodyWidth) <= layout.width + 1,
    `${name} has horizontal overflow: ${JSON.stringify(layout)}`,
  )
  for (const control of [tokenInput(), tokenButton(), epflButton()]) {
    assert(await control.isVisible(), `${name} login control is hidden`)
    const box = await control.boundingBox()
    assert(
      box &&
        box.width > 0 &&
        box.x >= -1 &&
        box.x + box.width <= viewport.width + 1,
      `${name} login control extends outside the viewport`,
    )
  }
  const screenshot = `${name}.png`
  await page.screenshot({
    path: new URL(screenshot, directory).pathname,
    fullPage: true,
    animations: 'disabled',
  })
  result.screenshots.push(screenshot)
  result.layouts.push({ name, viewport, ...layout })
}

try {
  await loadLogin('disabled')
  assert.equal(await epflButton().count(), 0)
  assert(await tokenButton().isDisabled())
  result.checks.push(
    'Disabled EPFL sign-in leaves the labeled access-token form available.',
  )

  await loadLogin('unavailable')
  assert.equal(await epflButton().count(), 0)
  await tokenInput().fill('fixture-invitation-token')
  assert(await tokenButton().isEnabled())
  result.checks.push(
    'Unavailable EPFL metadata leaves access-token sign-in usable.',
  )

  await loadLogin('enabled')
  await epflButton().waitFor()
  assert(await epflButton().isEnabled())
  assert(await tokenButton().isDisabled())
  result.checks.push(
    'Enabled EPFL sign-in appears alongside access-token sign-in.',
  )

  for (const [size, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 375, height: 812 }],
  ]) {
    for (const theme of ['dark', 'light'])
      await captureLogin(`${size}-${theme}`, viewport, theme)
  }
  result.checks.push(
    'Desktop and mobile login fit the viewport in both existing themes.',
  )

  await page.setViewportSize({ width: 1440, height: 1000 })
  await tokenInput().fill('fixture-invalid-token')
  holdLogin = true
  await tokenButton().click()
  await until(() => !!releaseLogin, 'held token sign-in')
  assert(await tokenInput().isDisabled())
  assert(await epflButton().isDisabled())
  holdLogin = false
  releaseLogin()
  releaseLogin = undefined
  await page
    .getByRole('alert')
    .filter({ hasText: 'Fixture invitation token was not recognized.' })
    .waitFor()
  assert(await tokenInput().isEnabled())
  assert(await tokenButton().isEnabled())
  assert(await epflButton().isEnabled())
  await tokenInput().fill('fixture-invitation-token')
  await tokenButton().click()
  await page.getByLabel('Display name', { exact: true }).waitFor()
  assert.equal(loginAttempts, 2)
  assert.equal(await tokenInput().count(), 0)
  result.checks.push(
    'A rejected token shows its error, releases sign-in controls and accepts a successful retry.',
  )

  assert.equal(
    result.unexpectedRequests.length,
    0,
    JSON.stringify(result.unexpectedRequests),
  )
  fixture.assertClean()
  result.passed = true
} catch (error) {
  result.error = error.stack || String(error)
  process.exitCode = 1
} finally {
  releaseLogin?.()
  await fs.writeFile(
    new URL('result.json', directory),
    JSON.stringify(result, null, 2) + '\n',
  )
  console.log(
    JSON.stringify({
      passed: result.passed,
      checks: result.checks,
      error: result.error,
    }),
  )
  await browser.close()
}
